import { describe, it, expect } from "vitest";
import { buildOutbound, buildSingBoxConfig, BuildInput, PROXY_PORT } from "../singbox";
import { Node } from "../../parser/types";
import { RuleBundle } from "../../rules/types";

const base = { id: "n1", raw: "test", port: 443, server: "example.com" };

function ss(id: string, name: string): Node {
  return { ...base, id, name, protocol: "shadowsocks", method: "aes-256-gcm", password: "pw" };
}

function build(input: Partial<BuildInput> = {}) {
  const result = buildSingBoxConfig({
    nodes: [ss("a", "节点A"), ss("b", "节点B")],
    selectedId: "b",
    mode: "rule",
    tun: false,
    ...input,
  });
  return { ...result, cfg: result.config as any };
}

const bundle: RuleBundle = {
  groups: [
    { name: "主组", type: "select", members: ["节点A", "节点B", "DIRECT"] },
    { name: "国内", type: "select", members: ["DIRECT", "主组"] },
    { name: "广告", type: "select", members: ["REJECT", "DIRECT"] },
    { name: "自动", type: "url-test", members: ["节点A", "节点B"], interval: 120 },
  ],
  primary: "主组",
  runs: [
    { target: "主组", match: { domain_suffix: ["google.com"] }, count: 1 },
    { target: "国内", match: { domain_suffix: ["baidu.com"] }, count: 1 },
    { target: "广告", match: { domain_keyword: ["ads"] }, count: 1 },
    { target: "主组", match: { ip_cidr: ["8.8.8.8/32"] }, count: 1 },
    { target: "主组", match: { ip_cidr: ["1.1.1.1/32"] }, count: 1, resolve: true },
    { target: "国内", match: { rule_set: ["geoip-cn"] }, count: 1, resolve: true },
  ],
  final: "主组",
  total: 7,
  skipped: {},
};

describe("buildSingBoxConfig 外壳", () => {
  it("mixed 入站 + 主选择器 + 全部节点 + direct/block", () => {
    const { cfg, tags } = build();
    expect(cfg.inbounds[0]).toMatchObject({
      type: "mixed",
      listen: "127.0.0.1",
      listen_port: PROXY_PORT,
    });
    expect(cfg.outbounds[0]).toMatchObject({
      type: "selector",
      tag: "proxy",
      outbounds: ["节点A", "节点B"],
      default: "节点B",
    });
    expect(tags).toEqual({ a: "节点A", b: "节点B" });
    expect(cfg.outbounds.map((o: any) => o.tag)).toEqual([
      "proxy",
      "节点A",
      "节点B",
      "direct",
      "block",
    ]);
  });

  it("重名节点生成不同 tag", () => {
    const { tags } = build({ nodes: [ss("a", "同名"), ss("b", "同名")] });
    expect(tags.a).toBe("同名");
    expect(tags.b).toBe("同名 #2");
  });

  it("节点名和保留 tag 冲突时改名", () => {
    const { tags } = build({ nodes: [ss("a", "proxy")], selectedId: "a" });
    expect(tags.a).toBe("proxy #2");
  });

  it("内核不支持的节点不进配置,全部不可用时报错", () => {
    const bad: Node = { ...ss("c", "坏"), unsupported: "不支持" };
    const { cfg } = build({ nodes: [ss("a", "好"), bad], selectedId: "a" });
    expect(cfg.outbounds.map((o: any) => o.tag)).not.toContain("坏");
    expect(() => build({ nodes: [bad] })).toThrow("没有可用节点");
  });
});

describe("TUN", () => {
  const tun = () => build({ tun: true }).cfg.inbounds.find((i: any) => i.type === "tun");

  it("严格路由 + 只接管 IPv4:修复访问有 AAAA 记录的网站全部失败", () => {
    const { cfg } = build({ tun: true });
    expect(tun().strict_route).toBe(true);
    expect(tun().address).toEqual(["172.19.0.1/30"]);
    expect(cfg.dns.strategy).toBe("ipv4_only");
  });

  it("开启 IPv6 时才带 IPv6 地址", () => {
    const { cfg } = build({ tun: true, ipv6: true });
    const inbound = cfg.inbounds.find((i: any) => i.type === "tun");
    expect(inbound.address).toHaveLength(2);
    expect(cfg.dns.strategy).toBe("prefer_ipv4");
  });

  it("局域网网段不进 TUN", () => {
    expect(tun().route_exclude_address).toEqual(
      expect.arrayContaining(["192.168.0.0/16", "10.0.0.0/8"]),
    );
  });

  it("直连 DNS 始终用明确地址:local 在 TUN 下绕回内核,在 Windows 上要等失效地址超时", () => {
    for (const tun of [true, false]) {
      const { cfg } = build({ tun, directDns: "119.29.29.29" });
      expect(cfg.dns.servers.find((s: any) => s.tag === "dns-direct")).toEqual({
        type: "udp",
        tag: "dns-direct",
        server: "119.29.29.29",
      });
    }
    expect(build().cfg.dns.servers.find((s: any) => s.tag === "dns-direct").server).toBe("223.5.5.5");
  });

  it("内置 DNS、劫持 53 端口、私网直连都在规则最前面", () => {
    const { cfg } = build({ tun: true });
    expect(cfg.route).toMatchObject({ auto_detect_interface: true, final: "proxy" });
    expect(cfg.route.rules[0]).toEqual({ action: "sniff" });
    expect(cfg.route.rules[1].action).toBe("hijack-dns");
    expect(cfg.route.rules[2]).toMatchObject({ ip_is_private: true, outbound: "direct" });
    expect(cfg.route.default_domain_resolver).toBeTruthy();
    // 不能有 DNS 服务器 detour 到空 direct 出站(sing-box 1.12 运行时会 FATAL)
    expect(cfg.dns.servers.every((s: any) => s.detour !== "direct")).toBe(true);
  });
});

describe("订阅规则", () => {
  const withRules = (extra: Partial<BuildInput> = {}) =>
    build({ rules: bundle, selectedId: "a", ...extra });

  it("主策略组映射到 proxy,其余生成选择器和自动测速", () => {
    const { cfg, groupTags } = withRules();
    expect(groupTags.主组).toBe("proxy");
    const domestic = cfg.outbounds.find((o: any) => o.tag === "国内");
    expect(domestic).toMatchObject({ type: "selector", outbounds: ["direct", "proxy"] });
    expect(cfg.outbounds.find((o: any) => o.tag === "广告").outbounds).toEqual([
      "block",
      "direct",
    ]);
    expect(cfg.outbounds.find((o: any) => o.tag === "自动")).toMatchObject({
      type: "urltest",
      interval: "120s",
    });
  });

  it("主选择器保留主组里的非节点成员和其他配置的节点", () => {
    const { cfg } = withRules({ nodes: [ss("a", "节点A"), ss("b", "节点B"), ss("c", "手动")] });
    expect(cfg.outbounds[0].outbounds).toEqual(["direct", "节点A", "节点B", "手动"]);
  });

  it("规则顺序不变,目标换成 tag", () => {
    const { cfg } = withRules();
    const rules = cfg.route.rules.filter((r: any) => r.action === "route" && !r.clash_mode);
    expect(rules.slice(1).map((r: any) => r.outbound)).toEqual([
      "proxy",
      "国内",
      "广告",
      "proxy",
      "proxy",
      "国内",
    ]);
    expect(cfg.route.final).toBe("proxy");
  });

  it("只在第一条需要解析的 IP 规则前解析一次,且用直连 DNS", () => {
    const { cfg } = withRules();
    const list = cfg.route.rules;
    const at = list.findIndex((r: any) => r.action === "resolve");
    expect(list[at]).toEqual({ action: "resolve", server: "dns-direct" });
    expect(list[at + 1].ip_cidr).toEqual(["1.1.1.1/32"]);
    expect(list.filter((r: any) => r.action === "resolve")).toHaveLength(1);
    expect(list[at - 1].ip_cidr).toEqual(["8.8.8.8/32"]);
  });

  it("自定义规则排在订阅规则之前", () => {
    const { cfg } = withRules({ customRules: ["DOMAIN-SUFFIX,mine.dev,DIRECT"] });
    const first = cfg.route.rules.find((r: any) => r.domain_suffix);
    expect(first).toMatchObject({ domain_suffix: ["mine.dev"], outbound: "direct" });
  });

  it("目标不存在的规则跳过,不让内核启动失败", () => {
    const rules = { ...bundle, runs: [{ target: "不存在", match: { domain: ["x.com"] }, count: 1 }] };
    const { cfg } = build({ rules });
    expect(cfg.route.rules.some((r: any) => r.domain)).toBe(false);
  });

  it("全局模式:clash_mode 规则在订阅规则之前", () => {
    const { cfg } = withRules({ mode: "global" });
    expect(cfg.experimental.clash_api.default_mode).toBe("global");
    const list = cfg.route.rules;
    const global = list.findIndex((r: any) => r.clash_mode === "global");
    const first = list.findIndex((r: any) => r.domain_suffix);
    expect(global).toBeGreaterThan(0);
    expect(global).toBeLessThan(first);
    expect(list[global].outbound).toBe("proxy");
  });

  it("策略组互相引用时断开回路", () => {
    const rules: RuleBundle = {
      ...bundle,
      groups: [
        { name: "主组", type: "select", members: ["甲", "节点A"] },
        { name: "甲", type: "select", members: ["乙", "主组"] },
        { name: "乙", type: "select", members: ["甲", "节点B"] },
      ],
      runs: [],
    };
    const { cfg } = build({ rules });
    expect(cfg.outbounds.find((o: any) => o.tag === "甲").outbounds).toEqual(["乙"]);
    expect(cfg.outbounds.find((o: any) => o.tag === "乙").outbounds).toEqual(["节点B"]);
  });

  it("保存的策略组选择成为默认值,不存在的成员被忽略", () => {
    const { cfg } = withRules({ groupChoices: { 国内: "主组", 广告: "不存在" } });
    expect(cfg.outbounds.find((o: any) => o.tag === "国内").default).toBe("proxy");
    expect(cfg.outbounds.find((o: any) => o.tag === "广告").default).toBeUndefined();
  });

  it("直连目标的域名走直连 DNS,随策略组选择变化", () => {
    const direct = withRules().cfg.dns.rules.find((r: any) => r.domain_suffix);
    expect(direct).toMatchObject({ domain_suffix: ["baidu.com"], server: "dns-direct" });
    const proxied = withRules({ groupChoices: { 国内: "主组" } }).cfg.dns.rules;
    expect(proxied.some((r: any) => r.domain_suffix)).toBe(false);
  });

  it("用到的规则集都有声明", () => {
    const { cfg } = withRules();
    expect(cfg.route.rule_set.map((r: any) => r.tag)).toEqual(["geoip-cn", "geosite-cn"]);
    expect(cfg.route.rule_set[0].path).toBe("@rules/geoip-cn.srs");
  });

  describe("国内兜底", () => {
    const foreignOnly: RuleBundle = {
      ...bundle,
      runs: [{ target: "主组", match: { domain_suffix: ["google.com"] }, count: 1 }],
      total: 2,
    };
    const tail = (cfg: any) => {
      const rules = cfg.route.rules;
      const index = rules.findIndex((r: any) => r.domain_suffix?.includes("google.com"));
      return rules.slice(index + 1);
    };

    it("订阅没有国内规则:排在订阅规则之后,海外交给兜底组", () => {
      const { cfg } = build({ rules: foreignOnly });
      expect(tail(cfg)).toEqual([
        { rule_set: ["geosite-cn"], action: "route", outbound: "direct" },
        { rule_set: ["geosite-not-cn"], action: "route", outbound: "proxy" },
        { action: "resolve", server: "dns-direct" },
        { rule_set: ["geoip-cn"], action: "route", outbound: "direct" },
      ]);
      expect(cfg.route.rule_set.map((r: any) => r.tag)).toEqual([
        "geoip-cn",
        "geosite-cn",
        "geosite-not-cn",
      ]);
    });

    it("订阅自带 GEOIP,CN 时不重复添加", () => {
      const { cfg } = build({ rules: bundle });
      expect(cfg.route.rules.some((r: any) => r.rule_set?.includes("geosite-not-cn"))).toBe(false);
    });

    it("订阅兜底是直连时不添加", () => {
      const { cfg } = build({ rules: { ...foreignOnly, final: "DIRECT" } });
      expect(tail(cfg)).toEqual([]);
    });

    it("可以关闭", () => {
      const { cfg } = build({ rules: foreignOnly, cnDirect: false });
      expect(tail(cfg)).toEqual([]);
    });

    it("前面已经解析过时不再解析一次", () => {
      const runs = [
        ...foreignOnly.runs,
        { target: "主组", match: { ip_cidr: ["1.1.1.1/32"] }, count: 1, resolve: true },
      ];
      const { cfg } = build({ rules: { ...foreignOnly, runs } });
      expect(cfg.route.rules.filter((r: any) => r.action === "resolve")).toHaveLength(1);
    });
  });

  it("同名节点时策略组用排在前面的规则来源节点", () => {
    const stale = { ...ss("old", "节点A"), password: "旧密码" };
    const { cfg } = build({
      nodes: [ss("a", "节点A"), ss("b", "节点B"), stale],
      rules: bundle,
      selectedId: "a",
    });
    const auto = cfg.outbounds.find((o: any) => o.tag === "自动");
    expect(auto.outbounds).toEqual(["节点A", "节点B"]);
    expect(cfg.outbounds.find((o: any) => o.tag === "节点A").password).toBe("pw");
  });

  it("同一节点出现在两份配置里时只生成一个出站", () => {
    const node = ss("a", "节点A");
    const { cfg } = build({ nodes: [node, { ...node }], selectedId: "a" });
    expect(cfg.outbounds.filter((o: any) => o.tag === "节点A")).toHaveLength(1);
  });

  it("没有订阅规则时用内置绕过大陆规则", () => {
    const { cfg } = build();
    const tags = cfg.route.rule_set.map((r: any) => r.tag);
    expect(tags).toEqual(["geoip-cn", "geosite-cn", "geosite-not-cn"]);
    expect(cfg.route.final).toBe("proxy");
  });
});

describe("buildOutbound", () => {
  it("VLESS + TLS + WS", () => {
    const node: Node = {
      ...base,
      name: "v",
      protocol: "vless",
      uuid: "u",
      security: "tls",
      sni: "sni.com",
      network: "ws",
      path: "/ws",
      host: "ws.com",
    };
    const out = buildOutbound(node) as any;
    expect(out).toMatchObject({ type: "vless", tag: "proxy", server: "example.com", server_port: 443 });
    expect(out.tls).toMatchObject({ enabled: true, server_name: "sni.com" });
    expect(out.transport).toMatchObject({ type: "ws", path: "/ws", headers: { Host: "ws.com" } });
  });

  it("VLESS + Reality + flow + uTLS", () => {
    const node: Node = {
      ...base,
      name: "r",
      protocol: "vless",
      uuid: "u",
      security: "reality",
      sni: "www.microsoft.com",
      flow: "xtls-rprx-vision",
      publicKey: "PBK",
      shortId: "ab",
      fingerprint: "chrome",
    };
    const out = buildOutbound(node) as any;
    expect(out.flow).toBe("xtls-rprx-vision");
    expect(out.tls.reality).toEqual({ enabled: true, public_key: "PBK", short_id: "ab" });
    expect(out.tls.utls).toEqual({ enabled: true, fingerprint: "chrome" });
  });

  it("已转换的节点只补 tag", () => {
    const node: Node = {
      ...base,
      name: "vm",
      protocol: "vmess",
      outbound: { type: "vmess", server: "x", server_port: 1, uuid: "u" },
    };
    expect(buildOutbound(node, "tag1")).toEqual({
      type: "vmess",
      server: "x",
      server_port: 1,
      uuid: "u",
      tag: "tag1",
    });
  });

  it("SSR 节点明确报错", () => {
    const node: Node = { ...base, name: "s", protocol: "shadowsocksr" };
    expect(() => buildOutbound(node)).toThrow("内核不支持");
  });
});
