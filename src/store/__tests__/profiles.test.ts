import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "../../parser/types";

/** 内存里的数据目录,行为和 Rust 侧的 store_* 命令一致 */
const disk = new Map<string, string>();
const backend = vi.hoisted(() => ({
  storeRead: vi.fn(),
  storeWrite: vi.fn(),
  storeDelete: vi.fn(),
  storeRetire: vi.fn(),
  fetchUrl: vi.fn(),
}));

vi.mock("../../api/backend", () => backend);

const CLASH = `
proxies:
  - { name: 香港01, type: ss, server: hk.example.com, port: 443, cipher: aes-128-gcm, password: pw }
  - { name: 日本01, type: ss, server: jp.example.com, port: 443, cipher: aes-128-gcm, password: pw }
proxy-groups:
  - { name: 选择节点, type: select, proxies: [香港01, 日本01] }
rules:
  - DOMAIN-SUFFIX,cn,DIRECT
  - MATCH,选择节点
`;

const OTHER_PASSWORD = CLASH.replaceAll("password: pw", "password: changed");

function v1Node(name: string, server: string): Node {
  return { id: `n-${name}`, name, protocol: "shadowsocks", server, port: 443, raw: "ss://x" };
}

/** 每次 load 都是一份新模块,防抖定时器各管各的 */
const loaded: { flushWrites: () => Promise<void> }[] = [];

async function load() {
  vi.resetModules();
  const profiles = await import("../profiles");
  const settings = await import("../settings");
  const notice = await import("../notice");
  const persist = await import("../persist");
  loaded.push(persist);
  return { ...profiles, ...settings, ...notice, ...persist };
}

function serveSubscription(body: string) {
  backend.fetchUrl.mockResolvedValue({ body, viaProxy: false });
}

function readJson<T>(name: string): T {
  return JSON.parse(disk.get(name)!) as T;
}

beforeEach(() => {
  disk.clear();
  vi.clearAllMocks();
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  backend.storeRead.mockImplementation(async (name: string) => {
    const content = disk.get(name);
    return content === undefined ? null : { content, recovered: false };
  });
  backend.storeWrite.mockImplementation(async (name: string, json: string) => {
    disk.set(name, json);
  });
  backend.storeDelete.mockImplementation(async (name: string) => {
    disk.delete(name);
  });
  backend.storeRetire.mockImplementation(async (name: string, next: string) => {
    disk.set(next, disk.get(name)!);
    disk.delete(name);
  });
});

// 写盘定时器留到下一个用例会写进它的数据,测试环境销毁后触发还会让整轮测试失败
afterEach(async () => {
  await Promise.all(loaded.splice(0).map((persist) => persist.flushWrites()));
});

describe("旧版数据迁移", () => {
  const v1 = {
    subscriptionUrl: "https://example.com/sub",
    nodes: [v1Node("手动节点", "manual.example.com"), v1Node("旧香港", "hk.example.com")],
    selectedId: "n-旧香港",
    theme: "dark",
    tunMode: true,
  };

  it("保留全部节点、选择和设置,旧文件留档", async () => {
    disk.set("state.json", JSON.stringify(v1));
    const app = await load();
    await app.loadAll();

    expect(app.allNodes().map((n) => n.name)).toEqual(["手动节点", "旧香港"]);
    expect(app.settingsStore.get()).toMatchObject({ selected: "n-旧香港", theme: "dark", tun: true });
    expect(app.profilesStore.get().profiles.map((p) => p.id)).toEqual(["local", "sub-v1"]);
    expect(disk.has("state.json")).toBe(false);
    expect(disk.has("state.v1.json")).toBe(true);
    expect(readJson<Node[]>("profiles/local.nodes.json")).toHaveLength(2);
  });

  it("迁移中途崩溃(设置还没写)时重新迁移,不丢数据", async () => {
    disk.set("state.json", JSON.stringify(v1));
    disk.set("profiles.json", '{"version":2,"profiles":[]}');
    const app = await load();
    await app.loadAll();
    expect(app.allNodes()).toHaveLength(2);
  });

  it("首次刷新订阅后去掉重复节点,手动节点留下,选中项跟到订阅里", async () => {
    disk.set("state.json", JSON.stringify(v1));
    serveSubscription(CLASH);
    const app = await load();
    await app.loadAll();
    await app.refreshProfile("sub-v1", true);

    expect(app.allNodes().map((n) => n.name)).toEqual(["香港01", "日本01", "手动节点"]);
    expect(app.selectedNode()?.name).toBe("香港01");
  });

  it("加别的订阅时不动迁移来的节点,哪怕服务器相同", async () => {
    disk.set("state.json", JSON.stringify({ ...v1, subscriptionUrl: undefined }));
    serveSubscription(CLASH);
    const app = await load();
    await app.loadAll();
    await app.addSubscription("https://example.com/other");

    expect(app.allNodes().map((n) => n.name)).toEqual([
      "香港01",
      "日本01",
      "手动节点",
      "旧香港",
    ]);
    expect(app.selectedNode()?.name).toBe("旧香港");
  });

  it("没有旧数据时是全新安装", async () => {
    const app = await load();
    await app.loadAll();
    expect(app.allNodes()).toEqual([]);
    expect(app.profilesStore.get().loaded).toBe(true);
  });
});

describe("读取失败", () => {
  it("文件读不出来时停止保存,不用空数据覆盖", async () => {
    disk.set("profiles/local.nodes.json", '[{"id":"a"}]');
    backend.storeRead.mockRejectedValue("主文件和备份都已损坏");
    const app = await load();
    await app.loadAll();

    app.updateSettings({ port: 12345 });
    await app.flushWrites();
    expect(backend.storeWrite).not.toHaveBeenCalled();
    expect(app.noticeStore.get().notices[0]).toMatchObject({ kind: "error" });
    expect(app.profilesStore.get().loaded).toBe(true);
  });

  it("从备份恢复时提示用户", async () => {
    disk.set("settings.json", JSON.stringify({ version: 2, port: 2000 }));
    backend.storeRead.mockImplementation(async (name: string) => {
      const content = disk.get(name);
      return content === undefined ? null : { content, recovered: name === "settings.json" };
    });
    const app = await load();
    await app.loadAll();
    expect(app.settingsStore.get().port).toBe(2000);
    expect(app.noticeStore.get().notices[0].text).toContain("已从备份恢复");
  });
});

describe("订阅", () => {
  it("第一份带规则的订阅自动启用,节点和规则分文件保存", async () => {
    serveSubscription(CLASH);
    const app = await load();
    await app.loadAll();
    const id = await app.addSubscription("https://example.com/sub");
    await app.flushWrites();

    expect(app.settingsStore.get().activeRules).toBe(id);
    expect(app.selectedNode()?.name).toBe("香港01");
    expect(readJson<Node[]>(`profiles/${id}.nodes.json`)).toHaveLength(2);
    expect(readJson<{ total: number }>(`profiles/${id}.rules.json`).total).toBe(2);
    expect(readJson<{ profiles: unknown[] }>("profiles.json").profiles).toHaveLength(2);
  });

  it("刷新失败时保留旧数据,错误记在配置上", async () => {
    serveSubscription(CLASH);
    const app = await load();
    await app.loadAll();
    const id = (await app.addSubscription("https://example.com/sub"))!;

    backend.fetchUrl.mockRejectedValue("连接超时");
    expect(await app.refreshProfile(id, true)).toBe(false);
    expect(app.allNodes()).toHaveLength(2);
    expect(app.profilesStore.get().profiles.find((p) => p.id === id)?.lastError).toContain("连接超时");
  });

  it("机场换密码后节点 id 变了,选中项按名称跟过去", async () => {
    serveSubscription(CLASH);
    const app = await load();
    await app.loadAll();
    const id = (await app.addSubscription("https://example.com/sub"))!;
    const japan = app.allNodes().find((n) => n.name === "日本01")!;
    app.updateSettings({ selected: japan.id });

    serveSubscription(OTHER_PASSWORD);
    await app.refreshProfile(id, true);
    const selected = app.selectedNode()!;
    expect(selected.name).toBe("日本01");
    expect(selected.id).not.toBe(japan.id);
  });

  it("首次添加失败不留下空配置", async () => {
    backend.fetchUrl.mockRejectedValue("404");
    const app = await load();
    await app.loadAll();
    expect(await app.addSubscription("https://example.com/none")).toBeNull();
    expect(app.profilesStore.get().profiles.map((p) => p.id)).toEqual(["local"]);
  });

  it("删除配置时清掉文件、规则来源和选中项", async () => {
    serveSubscription(CLASH);
    const app = await load();
    await app.loadAll();
    const id = (await app.addSubscription("https://example.com/sub"))!;
    await app.flushWrites();
    await app.deleteProfile(id);

    expect(app.settingsStore.get()).toMatchObject({ activeRules: null, selected: null });
    expect(disk.has(`profiles/${id}.nodes.json`)).toBe(false);
    expect(disk.has(`profiles/${id}.rules.json`)).toBe(false);
  });

  it("到期才刷新", async () => {
    serveSubscription(CLASH);
    const app = await load();
    await app.loadAll();
    await app.addSubscription("https://example.com/sub");
    backend.fetchUrl.mockClear();

    await app.refreshDueProfiles();
    expect(backend.fetchUrl).not.toHaveBeenCalled();

    const later = Date.now() + 25 * 3_600_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    await app.refreshDueProfiles();
    expect(backend.fetchUrl).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});

describe("粘贴导入", () => {
  it("分享链接进本地节点,重复导入不重复", async () => {
    const app = await load();
    await app.loadAll();
    const link = "trojan://secret@example.com:443?security=tls#测试节点";
    await app.importText(link);
    await app.importText(link);
    expect(app.allNodes().map((n) => n.name)).toEqual(["测试节点"]);
    expect(app.selectedNode()?.name).toBe("测试节点");
  });

  it("Clash 配置建一份独立配置,保留策略组和规则", async () => {
    const app = await load();
    await app.loadAll();
    await app.importText(CLASH);
    const profile = app.profilesStore.get().profiles.find((p) => p.id !== "local")!;
    expect(profile).toMatchObject({ nodeCount: 2, ruleCount: 2 });
    expect(app.settingsStore.get().activeRules).toBe(profile.id);
  });

  it("全部无法解析时报错,不改动数据", async () => {
    const app = await load();
    await app.loadAll();
    await expect(app.importText("这不是节点")).rejects.toThrow();
    expect(app.allNodes()).toEqual([]);
  });
});

describe("防抖写盘", () => {
  it("同一文件连续修改只写最后一次,flush 立即写入", async () => {
    const app = await load();
    await app.loadAll();
    app.updateSettings({ port: 2001 });
    app.updateSettings({ port: 2002 });
    await app.flushWrites();
    const writes = backend.storeWrite.mock.calls.filter(([name]) => name === "settings.json");
    expect(writes).toHaveLength(1);
    expect(readJson<{ port: number }>("settings.json").port).toBe(2002);
  });

  it("保存失败时提示,后续写入不受影响", async () => {
    const app = await load();
    await app.loadAll();
    backend.storeWrite.mockRejectedValueOnce("磁盘已满");
    app.updateSettings({ port: 2003 });
    await app.flushWrites();
    expect(app.noticeStore.get().notices[0].text).toContain("磁盘已满");

    app.updateSettings({ port: 2004 });
    await app.flushWrites();
    expect(readJson<{ port: number }>("settings.json").port).toBe(2004);
  });
});
