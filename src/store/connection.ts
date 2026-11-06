import { listen } from "@tauri-apps/api/event";
import {
  isElevated,
  kernelApi,
  relaunchAsAdmin,
  setSystemProxy,
  startKernel,
  stopKernel,
  tcpPing,
} from "../api/backend";
import { BuildResult, buildSingBoxConfig, DELAY_TEST_URL, ProxyMode } from "../config/singbox";
import { Node, unsupportedReason } from "../parser/types";
import { createStore, useStore } from "./createStore";
import { pushLog } from "./logs";
import { notify } from "./notice";
import { pingsStore, setPing } from "./pings";
import { allNodes, loadRules, profilesStore } from "./profiles";
import { saveSettingsNow, settingsStore, updateSettings } from "./settings";
import { pushTraffic, resetTraffic } from "./traffic";
import { checkUpdate } from "./update";

/** off=未连接 connecting=连接中 on=已连接 fault=失败 */
export type ConnStatus = "off" | "connecting" | "on" | "fault";
export type Health = "unknown" | "checking" | "ok" | "bad";

export interface ConnectionState {
  status: ConnStatus;
  /** 连通性:连上后经节点访问测试网址的结果 */
  health: Health;
  latency: number | null;
  /** 失败原因 */
  error: string;
  /** 本次连接时间 */
  since: number | null;
  /** 本次运行用的是 TUN */
  tun: boolean;
}

const OFF: ConnectionState = {
  status: "off",
  health: "unknown",
  latency: null,
  error: "",
  since: null,
  tun: false,
};

export const connectionStore = createStore<ConnectionState>(OFF);
export const useConnection = () => useStore(connectionStore);

/** 运行中配置的 tag 映射 */
let running: BuildResult | null = null;
let updateChecked = false;

function proxyServer() {
  return `127.0.0.1:${settingsStore.get().port}`;
}

/** TUN 需要管理员权限。Windows 上这里会重启应用,重启后接着连接 */
async function ensureTunElevation(): Promise<void> {
  if (await isElevated()) return;
  await saveSettingsNow({ resumeAfterElevate: true });
  try {
    await relaunchAsAdmin();
  } finally {
    // Linux 授权后不重启,走到这里继续连接
    await saveSettingsNow({ resumeAfterElevate: false });
  }
}

async function buildConfig(): Promise<BuildResult> {
  const settings = settingsStore.get();
  const rules = settings.activeRules ? await loadRules(settings.activeRules) : null;
  return buildSingBoxConfig({
    nodes: allNodes(),
    selectedId: settings.selected,
    mode: settings.mode,
    tun: settings.tun,
    ipv6: settings.ipv6,
    stack: settings.stack,
    port: settings.port,
    logLevel: settings.logLevel,
    directDns: settings.directDns,
    rules,
    customRules: settings.customRules,
    groupChoices: settings.groupChoices,
    cnDirect: settings.cnDirect,
  });
}

/**
 * 连接:生成配置 → 拉起内核(后端先停旧进程)→ 设系统代理 → 检查连通性。
 * 任一步失败都回收内核与系统代理,避免留下坏代理导致断网。
 */
export async function connect(): Promise<void> {
  if (connectionStore.get().status === "connecting") return;
  const settings = settingsStore.get();
  connectionStore.set({ ...OFF, status: "connecting" });
  try {
    if (settings.tun) await ensureTunElevation();
    const built = await buildConfig();
    const report = await startKernel(JSON.stringify(built.config));
    running = built;
    if (settings.tun) {
      // TUN 在网络层接管全局流量,不走系统代理;清掉可能残留的系统代理
      await setSystemProxy(false, proxyServer()).catch(() => {});
    } else {
      await setSystemProxy(true, proxyServer());
    }
    resetTraffic();
    connectionStore.set({ status: "on", since: Date.now(), tun: settings.tun });
    if (report.dropped.length) {
      notify(`${report.dropped.length} 个节点内核不接受,已跳过:${report.dropped[0]}`, "error");
    }
    void checkHealth();
    // 启动时 GitHub 可能直连不通,连上后经代理再查一次
    if (!updateChecked) {
      updateChecked = true;
      void checkUpdate(true, `http://${proxyServer()}`);
    }
  } catch (e) {
    running = null;
    await Promise.allSettled([setSystemProxy(false, proxyServer()), stopKernel()]);
    connectionStore.set({ ...OFF, status: "fault", error: errText(e) });
  }
}

export async function disconnect(): Promise<void> {
  connectionStore.set({ status: "connecting" });
  running = null;
  const results = await Promise.allSettled([setSystemProxy(false, proxyServer()), stopKernel()]);
  const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  connectionStore.set(OFF);
  if (failed) notify(`断开时清理失败:${errText(failed.reason)}`, "error");
}

/** 配置改动后重连,让新配置生效 */
export async function reconnectIfOnline(): Promise<void> {
  if (connectionStore.get().status === "on") await connect();
}

/** 经当前节点访问测试网址。端口通了不代表节点能用,这一步才算真的连上 */
export async function checkHealth(): Promise<void> {
  connectionStore.set({ health: "checking" });
  try {
    const ms = await delayOf("proxy", 8000);
    connectionStore.set({ health: "ok", latency: ms });
    const selected = settingsStore.get().selected;
    if (selected) {
      setPing(selected, ms);
    }
  } catch {
    if (connectionStore.get().status === "on") {
      connectionStore.set({ health: "bad", latency: null });
    }
  }
}

async function delayOf(tag: string, timeout: number): Promise<number> {
  const query = `url=${encodeURIComponent(DELAY_TEST_URL)}&timeout=${timeout}`;
  const text = await kernelApi(
    "GET",
    `/proxies/${encodeURIComponent(tag)}/delay?${query}`,
    undefined,
    timeout + 1000,
  );
  return JSON.parse(text).delay as number;
}

async function putSelector(tag: string, member: string) {
  await kernelApi("PUT", `/proxies/${encodeURIComponent(tag)}`, { name: member });
}

/** 选节点。已连接时热切换,不断开内核 */
export async function chooseNode(id: string): Promise<void> {
  const settings = settingsStore.get();
  const groupChoices = { ...settings.groupChoices };
  const primary = settings.activeRules
    ? profilesStore.get().rules[settings.activeRules]?.primary
    : null;
  if (primary) delete groupChoices[primary];
  updateSettings({ selected: id, groupChoices });
  if (connectionStore.get().status !== "on") return;
  const tag = running?.tags[id];
  if (!tag) {
    await connect(); // 订阅刷新后新出现的节点,不在运行中的配置里
    return;
  }
  try {
    await putSelector("proxy", tag);
    await checkHealth();
  } catch (e) {
    notify(`切换节点失败:${errText(e)}`, "error");
  }
}

/** 选策略组成员。已连接时热切换 */
export async function chooseGroupMember(group: string, member: string): Promise<void> {
  const settings = settingsStore.get();
  const primary = settings.activeRules
    ? profilesStore.get().rules[settings.activeRules]?.primary
    : null;
  const patch: Partial<typeof settings> = {
    groupChoices: { ...settings.groupChoices, [group]: member },
  };
  if (group === primary) patch.selected = null;
  updateSettings(patch);
  if (connectionStore.get().status !== "on") return;
  const groupTag = running?.groupTags[group];
  const tag = running?.memberTags[member];
  if (!groupTag || !tag) {
    await connect(); // 刷新订阅后改了分组,运行中的配置里没有
    return;
  }
  try {
    await putSelector(groupTag, tag);
  } catch (e) {
    notify(`切换失败:${errText(e)}`, "error");
  }
}

/** 策略组当前选中的成员,自动测速组的结果只有内核知道 */
export async function fetchGroupStates(): Promise<Record<string, string>> {
  if (!running) return {};
  const text = await kernelApi("GET", "/proxies");
  const { proxies } = JSON.parse(text) as { proxies: Record<string, { now?: string }> };
  const states: Record<string, string> = {};
  for (const [group, tag] of Object.entries(running.groupTags)) {
    const now = proxies[tag]?.now;
    if (!now) continue;
    const member = Object.entries(running.memberTags).find(([, t]) => t === now);
    states[group] = member?.[0] ?? now;
  }
  return states;
}

/** 切换规则 / 全局。已连接时热切换 */
export async function setMode(mode: ProxyMode): Promise<void> {
  updateSettings({ mode });
  if (connectionStore.get().status !== "on") return;
  try {
    await kernelApi("PATCH", "/configs", { mode });
  } catch (e) {
    notify(`切换模式失败:${errText(e)}`, "error");
  }
}

/** 开关 TUN。已连接时立即用新方式重连 */
export async function setTun(on: boolean): Promise<void> {
  await saveSettingsNow({ tun: on });
  await reconnectIfOnline();
}

// ---- 测速 ----

async function runPool<T>(items: T[], size: number, task: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      while (queue.length) await task(queue.shift()!);
    }),
  );
}

/**
 * 已连接时经内核访问测试网址,结果是真实可用的延迟;
 * 未连接时只能测到服务器的 TCP 连接,节点能不能用要连上才知道。
 * TUN 下 TCP 连接被内核就地接管,测出来的数字没有意义,所以必须走内核。
 */
export async function testDelays(): Promise<void> {
  if (pingsStore.get().testing) return;
  const nodes = allNodes().filter((n) => !unsupportedReason(n));
  const live = connectionStore.get().status === "on" ? running : null;
  pingsStore.set({ pings: {}, testing: true, method: live ? "real" : "tcp" });
  try {
    await runPool(nodes, live ? 8 : 12, async (node: Node) => {
      const tag = live?.tags[node.id];
      try {
        const ms = live
          ? tag
            ? await delayOf(tag, 5000)
            : undefined
          : await tcpPing(node.server, node.port, 3000);
        setPing(node.id, ms);
      } catch {
        setPing(node.id, "timeout");
      }
    });
  } finally {
    pingsStore.set({ testing: false });
  }
}

/** 监听 Rust 侧事件:内核意外退出 / 内核日志 / 流量 */
export async function initConnectionEvents(): Promise<void> {
  await listen<{ code: number | null; lastLog: string }>("kernel-exit", (ev) => {
    const s = connectionStore.get();
    if (s.status === "on" || s.status === "connecting") {
      running = null;
      connectionStore.set({
        ...OFF,
        status: "fault",
        error: `内核意外退出(退出码 ${ev.payload.code ?? "未知"})${
          ev.payload.lastLog ? ":" + ev.payload.lastLog : ""
        }`,
      });
    }
  });
  await listen<string>("kernel-log", (ev) => pushLog(ev.payload));
  await listen<{ up: number; down: number }>("kernel-traffic", (ev) => {
    pushTraffic(ev.payload.up, ev.payload.down);
  });
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
