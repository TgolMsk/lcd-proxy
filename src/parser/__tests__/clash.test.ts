import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { looksLikeClash, parseClash } from "../clash";
import { parseUri } from "../index";
import { Node } from "../types";

const FIXTURE = readFileSync(join(__dirname, "fixtures/clash-full.yaml"), "utf8");

const FILES: Record<string, string> = {
  "https://example.com/telegram.list":
    "# 注释\nDOMAIN-SUFFIX,t.me\nIP-CIDR,149.154.160.0/20,no-resolve\n\n",
  "https://example.com/private.yaml": "payload:\n  - '+.lan'\n  - '.local'\n  - 'router.asus.com'\n",
  "https://example.com/cncidr.yaml": "payload:\n  - 1.0.1.0/24\n  - 1.0.2.0/23\n",
};

const fetcher = async (url: string) => {
  if (url in FILES) return FILES[url];
  throw new Error("404");
};

const parse = (text = FIXTURE) => parseClash(text, fetcher, () => []);
const byName = (nodes: Node[], name: string) => nodes.find((n) => n.name === name)!;

describe("looksLikeClash", () => {
  it("识别 Clash 配置,不误判分享链接和 base64", () => {
    expect(looksLikeClash(FIXTURE)).toBe(true);
    expect(looksLikeClash("ss://abc@a.com:1#x")).toBe(false);
    expect(looksLikeClash("c3M6Ly9hYmM=")).toBe(false);
  });
});

describe("节点转换", () => {
  it("密码原样保留,不被 YAML 改成数字", async () => {
    const { nodes } = await parse();
    expect(byName(nodes, "🇭🇰 香港01 | IEPL").outbound).toEqual({
      type: "shadowsocks",
      server: "hk.example.com",
      server_port: 20001,
      method: "aes-256-gcm",
      password: "0123456",
    });
  });

  it("VMess:alterId、加密方式、未开 TLS", async () => {
    const { nodes } = await parse();
    expect(byName(nodes, "🇯🇵 日本01 | x2").outbound).toEqual({
      type: "vmess",
      server: "jp.example.com",
      server_port: 20002,
      uuid: "b831381d-6324-4d53-ad4f-8cda48b30811",
      security: "auto",
      alter_id: 1,
    });
  });

  it("传输层:ws / grpc / h2 / http / httpupgrade", async () => {
    const { nodes } = await parse();
    const transport = (name: string) => byName(nodes, name).outbound!.transport as any;
    expect(transport("VMess WS")).toEqual({
      type: "ws",
      path: "/ray",
      headers: { Host: "cdn.example.com" },
    });
    expect(transport("VMess gRPC")).toEqual({ type: "grpc", service_name: "svc" });
    expect(transport("VMess H2")).toEqual({ type: "http", host: ["a.example.com"], path: "/h2" });
    expect(transport("VMess HTTP")).toEqual({
      type: "http",
      method: "GET",
      path: "/",
      host: ["a.example.com"],
    });
    expect(transport("VLESS 升级").type).toBe("httpupgrade");
  });

  it("VLESS Reality 自动带 uTLS", async () => {
    const { nodes } = await parse();
    expect(byName(nodes, "VLESS Reality").outbound!.tls).toEqual({
      enabled: true,
      server_name: "www.microsoft.com",
      utls: { enabled: true, fingerprint: "chrome" },
      reality: {
        enabled: true,
        public_key: "Z84J2IelR9ch3k8VtlVhhs5ycBUlXA7wHBWcBrjqnAw",
        short_id: "6ba85179e30d4fc2",
      },
    });
  });

  it("Trojan 默认开 TLS,alpn 和跳过证书验证", async () => {
    const { nodes } = await parse();
    expect(byName(nodes, "Trojan").outbound!.tls).toEqual({
      enabled: true,
      server_name: "t.example.com",
      insecure: true,
      alpn: ["h2", "http/1.1"],
    });
    expect(byName(nodes, "Trojan WS").outbound!.tls).toEqual({ enabled: true });
  });

  it("SS 插件", async () => {
    const { nodes } = await parse();
    expect(byName(nodes, "SS 混淆").outbound).toMatchObject({
      plugin: "obfs-local",
      plugin_opts: "obfs=http;obfs-host=bing.com",
    });
  });

  it("Hysteria2:端口跳跃、混淆、带宽", async () => {
    const { nodes } = await parse();
    expect(byName(nodes, "Hy2").outbound).toMatchObject({
      type: "hysteria2",
      server_ports: ["20000:30000"],
      password: "pw",
      up_mbps: 30,
      down_mbps: 200,
      obfs: { type: "salamander", password: "ob" },
    });
  });

  it("其余协议", async () => {
    const { nodes } = await parse();
    expect(byName(nodes, "TUIC").outbound).toMatchObject({
      type: "tuic",
      congestion_control: "bbr",
      udp_relay_mode: "native",
    });
    expect(byName(nodes, "AnyTLS").outbound).toMatchObject({ type: "anytls", password: "pw" });
    expect(byName(nodes, "SOCKS").outbound).toMatchObject({ type: "socks", version: "5" });
    expect(byName(nodes, "HTTP代理").outbound).toMatchObject({ type: "http", tls: { enabled: true } });
    expect(byName(nodes, "Hy1").outbound).toMatchObject({ type: "hysteria", auth_str: "pw" });
  });

  it("内核不支持的协议保留成不可用节点,参数缺失的也一样", async () => {
    const { nodes } = await parse();
    expect(byName(nodes, "SSR节点").unsupported).toContain("ssr");
    expect(byName(nodes, "WG节点").unsupported).toContain("wireguard");
    expect(byName(nodes, "缺密码").unsupported).toContain("password");
  });

  it("id 稳定且包含名称:同一内容改名后不互相覆盖", async () => {
    const a = await parse();
    const b = await parse();
    expect(a.nodes.map((n) => n.id)).toEqual(b.nodes.map((n) => n.id));
    expect(new Set(a.nodes.map((n) => n.id)).size).toBe(a.nodes.length);
  });

  it("YAML 合并键(<<)", async () => {
    const text = `proxies:
  - &base {name: a, type: ss, server: x.com, port: 1, cipher: aes-256-gcm, password: p}
  - {<<: *base, name: b, port: 2}
`;
    const { nodes } = await parse(text);
    expect(nodes.map((n) => [n.name, n.port])).toEqual([["a", 1], ["b", 2]]);
    expect(nodes[1].outbound).toMatchObject({ password: "p" });
  });
});

describe("策略组", () => {
  it("主策略组沿 MATCH 的默认成员走到含节点的组", async () => {
    const { rules } = await parse();
    expect(rules.primary).toBe("🔰 选择节点");
  });

  it("规则最多的细分组不会被当成主策略组", async () => {
    const text = `proxies:
  - {name: a, type: ss, server: x.com, port: 1, cipher: aes-256-gcm, password: p}
  - {name: b, type: ss, server: y.com, port: 1, cipher: aes-256-gcm, password: p}
proxy-groups:
  - {name: AI, type: select, proxies: [b, a]}
  - {name: 兜底, type: select, proxies: [a, b]}
rules:
  - DOMAIN,a.com,AI
  - DOMAIN,b.com,AI
  - DOMAIN,c.com,AI
  - MATCH,兜底
`;
    expect((await parse(text)).rules.primary).toBe("兜底");
  });

  it("MATCH 经过自动测速组时,主策略组是它前面的手动选择组", async () => {
    const text = `proxies:
  - {name: a, type: ss, server: x.com, port: 1, cipher: aes-256-gcm, password: p}
proxy-groups:
  - {name: 漏网, type: select, proxies: [选择, DIRECT]}
  - {name: 选择, type: select, proxies: [自动, a]}
  - {name: 自动, type: url-test, proxies: [a]}
rules:
  - MATCH,漏网
`;
    expect((await parse(text)).rules.primary).toBe("选择");
  });

  it("MATCH 默认直连时不改变兜底流量,另找节点组当主策略组", async () => {
    const text = `proxies:
  - {name: a, type: ss, server: x.com, port: 1, cipher: aes-256-gcm, password: p}
proxy-groups:
  - {name: 兜底, type: select, proxies: [DIRECT, a]}
  - {name: 节点, type: select, proxies: [a]}
rules:
  - MATCH,兜底
`;
    expect((await parse(text)).rules.primary).toBe("节点");
  });

  it("策略组互相指向时不会死循环", async () => {
    const text = `proxies:
  - {name: a, type: ss, server: x.com, port: 1, cipher: aes-256-gcm, password: p}
proxy-groups:
  - {name: 甲, type: select, proxies: [乙, a]}
  - {name: 乙, type: select, proxies: [甲, a]}
rules:
  - MATCH,甲
`;
    expect((await parse(text)).rules.primary).toBe("乙");
  });

  it("直连用途的组默认选直连,其他组保持订阅顺序", async () => {
    const text = `proxies:
  - {name: a, type: ss, server: x.com, port: 1, cipher: aes-256-gcm, password: p}
proxy-groups:
  - {name: 🇨🇳 国内直连, type: select, proxies: [a, DIRECT]}
  - {name: 🇨🇳 Apple中国, type: select, proxies: [a, DIRECT]}
  - {name: 🎮 Steam, type: select, proxies: [a, DIRECT]}
  - {name: 🌍 非中国, type: select, proxies: [a, DIRECT]}
rules:
  - MATCH,🎮 Steam
`;
    const { groups } = (await parse(text)).rules;
    const first = (name: string) => groups.find((g) => g.name === name)!.members[0];
    expect(first("🇨🇳 国内直连")).toBe("DIRECT");
    expect(first("🇨🇳 Apple中国")).toBe("DIRECT");
    expect(first("🎮 Steam")).toBe("a");
    expect(first("🌍 非中国")).toBe("a");
  });

  it("首项是 DIRECT 或 REJECT 的组不当主策略组", async () => {
    const text = `proxies:
  - {name: a, type: ss, server: x.com, port: 1, cipher: aes-256-gcm, password: p}
proxy-groups:
  - {name: 广告, type: select, proxies: [REJECT, a]}
  - {name: 国内, type: select, proxies: [DIRECT, a]}
  - {name: 节点, type: select, proxies: [a]}
rules:
  - DOMAIN,a.com,广告
  - DOMAIN,b.com,广告
  - DOMAIN,c.com,国内
  - MATCH,节点
`;
    expect((await parse(text)).rules.primary).toBe("节点");
  });

  it("include-all + filter 展开成员,忽略大小写", async () => {
    const { rules } = await parse();
    const group = rules.groups.find((g) => g.name === "故障转移")!;
    expect(group.members).toEqual(["VMess WS", "VMess gRPC", "VMess H2", "VMess HTTP"]);
    expect(group.type).toBe("fallback");
  });

  it("relay 组不支持,记入跳过", async () => {
    const { rules } = await parse();
    expect(rules.groups.some((g) => g.name === "中转")).toBe(false);
    expect(rules.skipped["不支持 relay 策略组"]).toBe(1);
  });

  it("use 引用的节点集:下载、过滤、合入节点列表", async () => {
    const text = `proxy-providers:
  机场:
    type: http
    url: https://example.com/nodes.yaml
    path: ./nodes.yaml
    filter: 香港
proxy-groups:
  - {name: 节点, type: select, use: [机场]}
rules:
  - MATCH,节点
`;
    const body = `proxies:
  - {name: 香港1, type: ss, server: a.com, port: 1, cipher: aes-256-gcm, password: p}
  - {name: 日本1, type: ss, server: b.com, port: 1, cipher: aes-256-gcm, password: p}
`;
    const { nodes, rules } = await parseClash(text, async () => body, () => []);
    expect(nodes.map((n) => n.name)).toEqual(["香港1"]);
    expect(rules.groups[0].members).toEqual(["香港1"]);
    expect(rules.primary).toBe("节点");
  });
});

describe("规则集", () => {
  it("classical / domain / ipcidr 展开,mrs 和下载失败记错误", async () => {
    const { rules, errors } = await parse();
    const all = JSON.stringify(rules.runs);
    expect(all).toContain('"t.me"');
    expect(all).toContain("149.154.160.0/20");
    expect(all).toContain('"lan"');
    expect(all).toContain('".local"');
    expect(all).toContain('"router.asus.com"');
    expect(all).toContain("1.0.1.0/24");
    expect(errors.some((e) => e.includes("binary"))).toBe(true);
    expect(rules.skipped["规则集 binary 不可用"]).toBe(1);
  });
});

describe("分享链接", () => {
  it("vmess://", () => {
    const body = btoa(
      JSON.stringify({
        v: "2",
        ps: "vm",
        add: "a.com",
        port: "443",
        id: "b831381d-6324-4d53-ad4f-8cda48b30811",
        aid: "0",
        net: "ws",
        host: "h.com",
        path: "/w",
        tls: "tls",
        sni: "s.com",
      }),
    );
    const node = parseUri(`vmess://${body}`);
    expect(node).toMatchObject({ protocol: "vmess", name: "vm", server: "a.com", port: 443 });
    expect(node.outbound).toMatchObject({
      type: "vmess",
      tls: { enabled: true, server_name: "s.com" },
      transport: { type: "ws", path: "/w", headers: { Host: "h.com" } },
    });
  });

  it("trojan://", () => {
    const node = parseUri(
      "trojan://p%40ss@a.com:443?sni=s.com&type=ws&path=%2Fw&host=h.com&allowInsecure=1#T%20J",
    );
    expect(node.name).toBe("T J");
    expect(node.outbound).toMatchObject({
      password: "p@ss",
      tls: { server_name: "s.com", insecure: true },
      transport: { type: "ws", path: "/w" },
    });
  });

  it("hy2:// 和 hysteria2://", () => {
    for (const scheme of ["hy2", "hysteria2"]) {
      const node = parseUri(
        `${scheme}://pw@a.com:443/?sni=s.com&obfs=salamander&obfs-password=o&insecure=1#H`,
      );
      expect(node.outbound).toMatchObject({
        type: "hysteria2",
        password: "pw",
        obfs: { type: "salamander", password: "o" },
        tls: { server_name: "s.com", insecure: true },
      });
    }
  });

  it("tuic://", () => {
    const node = parseUri(
      "tuic://b831381d-6324-4d53-ad4f-8cda48b30811:pw@a.com:443?congestion_control=bbr&alpn=h3&sni=s.com#T",
    );
    expect(node.outbound).toMatchObject({
      type: "tuic",
      uuid: "b831381d-6324-4d53-ad4f-8cda48b30811",
      password: "pw",
      congestion_control: "bbr",
      tls: { alpn: ["h3"] },
    });
  });

  it("anytls:// 和 socks5://", () => {
    expect(parseUri("anytls://pw@a.com:443?sni=s.com#A").outbound).toMatchObject({
      type: "anytls",
      password: "pw",
    });
    expect(parseUri("socks5://u:p@a.com:1080#S").outbound).toMatchObject({
      type: "socks",
      username: "u",
      password: "p",
    });
    expect(parseUri("socks://dTpw@a.com:1080#B").outbound).toMatchObject({
      username: "u",
      password: "p",
    });
    expect(parseUri("socks5://a.com:1080#N").outbound).not.toHaveProperty("username");
  });
});
