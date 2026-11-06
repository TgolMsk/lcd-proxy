import { Node, unsupportedReason } from "../parser/types";
import { compileRules } from "../rules/compile";
import { ProxyGroup, RuleBundle, RuleRun } from "../rules/types";

/** 本地混合入站端口(SOCKS5 + HTTP 同端口) */
export const PROXY_PORT = 10808;
export const DELAY_TEST_URL = "https://www.gstatic.com/generate_204";

export type ProxyMode = "rule" | "global";
export type TunStack = "gvisor" | "system" | "mixed";
export type LogLevel = "warn" | "info" | "debug";

export interface BuildInput {
  /** 所有配置里的节点 */
  nodes: Node[];
  selectedId: string | null;
  mode: ProxyMode;
  tun: boolean;
  /** 接管 IPv6。节点通常没有 IPv6 出口,默认关闭 */
  ipv6?: boolean;
  stack?: TunStack;
  port?: number;
  logLevel?: LogLevel;
  /** TUN 模式下解析直连域名和节点地址的 DNS */
  directDns?: string;
  /** 当前规则来源;没有时使用内置的绕过大陆规则 */
  rules?: RuleBundle | null;
  /** 优先于订阅规则的自定义规则,Clash 格式 */
  customRules?: string[];
  /** 策略组选择:组名 → 成员名 */
  groupChoices?: Record<string, string>;
  /** 订阅规则没有国内分流时,补上国内直连。默认开启 */
  cnDirect?: boolean;
}

export interface BuildResult {
  config: Record<string, unknown>;
  /** 节点 id → 内核里的出站 tag,切换节点时用 */
  tags: Record<string, string>;
  /** 策略组名 → 内核里的出站 tag */
  groupTags: Record<string, string>;
  /** 策略组成员名 → 内核里的出站 tag,切换成员时用 */
  memberTags: Record<string, string>;
}

const PROXY = "proxy";
const DIRECT = "direct";
const BLOCK = "block";
const DEFAULT_DIRECT_DNS = "223.5.5.5";

/** 这些网段不进 TUN:局域网、打印机发现、组播都要走物理网卡 */
const TUN_EXCLUDED = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "224.0.0.0/4",
  "255.255.255.255/32",
];
const TUN_EXCLUDED_V6 = ["fc00::/7", "fe80::/10", "ff00::/8"];

function uniqueTag(name: string, taken: Set<string>): string {
  let tag = name || "节点";
  for (let i = 2; taken.has(tag); i++) tag = `${name} #${i}`;
  taken.add(tag);
  return tag;
}

/** 节点对象 → sing-box outbound */
export function buildOutbound(node: Node, tag = PROXY): Record<string, unknown> {
  if (node.outbound) return { ...node.outbound, tag };
  switch (node.protocol) {
    case "vless":
      return buildVlessOutbound(node, tag);
    case "shadowsocks":
      return {
        type: "shadowsocks",
        tag,
        server: node.server,
        server_port: node.port,
        method: node.method,
        password: node.password,
      };
    default:
      throw new Error(`节点 ${node.name} 无法使用:内核不支持 ${node.protocol}`);
  }
}

function buildVlessOutbound(node: Node, tag: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: "vless",
    tag,
    server: node.server,
    server_port: node.port,
    uuid: node.uuid,
  };

  if (node.flow) out.flow = node.flow;

  // ---- 安全层 ----
  if (node.security === "tls") {
    out.tls = {
      enabled: true,
      server_name: node.sni || node.host || node.server,
      insecure: node.insecure ?? false,
      ...(node.alpn?.length ? { alpn: node.alpn } : {}),
      ...(node.fingerprint ? { utls: { enabled: true, fingerprint: node.fingerprint } } : {}),
    };
  } else if (node.security === "reality") {
    out.tls = {
      enabled: true,
      server_name: node.sni || node.server,
      utls: { enabled: true, fingerprint: node.fingerprint || "chrome" },
      reality: {
        enabled: true,
        public_key: node.publicKey || "",
        short_id: node.shortId || "",
      },
    };
  }

  // ---- 传输层 ----
  if (node.network === "ws") {
    out.transport = {
      type: "ws",
      path: node.path || "/",
      headers: { Host: node.host || node.sni || node.server },
    };
  } else if (node.network === "grpc") {
    out.transport = {
      type: "grpc",
      service_name: node.serviceName || "",
    };
  }
  // tcp:无 transport 字段

  return out;
}

class Plan {
  /** 策略组 tag → 成员 tag */
  members = new Map<string, string[]>();
  groupTags: Record<string, string> = {};
  nodeTags = new Map<string, string>(); // 节点名 → tag
  primary: string | null;

  constructor(
    readonly bundle: RuleBundle | null | undefined,
    nodes: Node[],
    tags: Record<string, string>,
  ) {
    this.primary = bundle?.primary ?? null;
    // 规则来源的节点排在最前,同名时用它
    for (const node of nodes) {
      if (!this.nodeTags.has(node.name)) this.nodeTags.set(node.name, tags[node.id]);
    }
  }

  target(name: string): string | null {
    const upper = name.toUpperCase();
    if (upper === "DIRECT") return DIRECT;
    if (upper === "REJECT" || upper === "REJECT-DROP") return BLOCK;
    if (name === this.primary) return PROXY;
    return this.groupTags[name] ?? this.nodeTags.get(name) ?? null;
  }
}

/** 策略组互相引用时内核拒绝启动:从主选择器开始遍历,去掉指回路径上的边 */
function breakCycles(members: Map<string, string[]>) {
  const done = new Set<string>();
  const onPath = new Set<string>();
  const visit = (tag: string) => {
    if (done.has(tag)) return;
    onPath.add(tag);
    const list = members.get(tag);
    if (list) {
      members.set(
        tag,
        list.filter((member) => {
          if (onPath.has(member)) return false;
          if (members.has(member)) visit(member);
          return true;
        }),
      );
    }
    onPath.delete(tag);
    done.add(tag);
  };
  visit(PROXY);
  for (const tag of members.keys()) visit(tag);
}

function groupOutbound(group: ProxyGroup, tag: string, members: string[], choice?: string) {
  if (group.type === "select") {
    return {
      type: "selector",
      tag,
      outbounds: members,
      ...(choice && members.includes(choice) ? { default: choice } : {}),
      interrupt_exist_connections: true,
    };
  }
  return {
    type: "urltest",
    tag,
    outbounds: members,
    url: group.url || DELAY_TEST_URL,
    interval: `${Math.max(group.interval ?? 300, 60)}s`,
    tolerance: group.tolerance ?? 50,
  };
}

function directDomains(runs: RuleRun[], isDirect: (target: string) => boolean) {
  const fields = ["domain", "domain_suffix", "domain_keyword", "domain_regex"];
  const collected: Record<string, string[]> = {};
  for (const run of runs) {
    if (!isDirect(run.target)) continue;
    for (const field of fields) {
      const values = run.match[field];
      if (Array.isArray(values)) (collected[field] ??= []).push(...(values as string[]));
    }
  }
  return collected;
}

function usedRuleSets(rules: Record<string, unknown>[], names: Set<string>) {
  for (const rule of rules) {
    const sets = rule.rule_set;
    if (Array.isArray(sets)) for (const name of sets) names.add(String(name));
    if (Array.isArray(rule.rules)) usedRuleSets(rule.rules as Record<string, unknown>[], names);
  }
}

/** 内置规则和订阅规则的国内兜底:国内直连,其余交给 final */
function cnRules(final: string, resolved: boolean): Record<string, unknown>[] {
  return [
    { rule_set: ["geosite-cn"], action: "route", outbound: DIRECT },
    { rule_set: ["geosite-not-cn"], action: "route", outbound: final },
    ...(resolved ? [] : [{ action: "resolve", server: "dns-direct" }]),
    { rule_set: ["geoip-cn"], action: "route", outbound: DIRECT },
  ];
}

/**
 * 生成完整 sing-box 配置。
 * 主选择器 tag 固定为 proxy,包含所有节点:节点和规则互不绑定,
 * 手动添加的节点也能配合订阅规则使用。
 */
export function buildSingBoxConfig(input: BuildInput): BuildResult {
  // 同一节点可能出现在多份配置里:id 相同,tag 也相同,重复 tag 内核拒绝启动
  const usable = input.nodes.filter((node) => !unsupportedReason(node));
  const nodes = [...new Map(usable.map((node) => [node.id, node])).values()];
  if (!nodes.length) throw new Error("没有可用节点");

  const bundle = input.rules ?? null;
  const groups = bundle?.groups ?? [];
  const choices = input.groupChoices ?? {};
  const port = input.port ?? PROXY_PORT;

  // ---- 分配 tag ----
  const taken = new Set([PROXY, DIRECT, BLOCK]);
  const groupTags: Record<string, string> = {};
  for (const group of groups) {
    groupTags[group.name] = group.name === bundle?.primary ? PROXY : uniqueTag(group.name, taken);
  }
  const tags: Record<string, string> = {};
  for (const node of nodes) tags[node.id] = uniqueTag(node.name, taken);

  const plan = new Plan(bundle, nodes, tags);
  plan.groupTags = groupTags;

  // ---- 主选择器 ----
  const nodeTagList = nodes.map((node) => tags[node.id]);
  const primaryGroup = groups.find((group) => group.name === bundle?.primary);
  const extras = (primaryGroup?.members ?? [])
    .map((member) => plan.target(member))
    .filter((tag): tag is string => !!tag && tag !== PROXY && !nodeTagList.includes(tag));
  plan.members.set(PROXY, [...new Set([...extras, ...nodeTagList])]);

  // ---- 其余策略组 ----
  const others = groups.filter((group) => group.name !== bundle?.primary);
  for (const group of others) {
    const members = group.members
      .map((member) => plan.target(member))
      .filter((tag): tag is string => !!tag && tag !== groupTags[group.name]);
    plan.members.set(groupTags[group.name], [...new Set(members)]);
  }
  for (const [tag, members] of plan.members) {
    if (tag !== PROXY && !members.length) members.push(PROXY);
  }
  breakCycles(plan.members);

  const selected = input.selectedId ? tags[input.selectedId] : undefined;
  const primaryChoice = primaryGroup ? plan.target(choices[primaryGroup.name] ?? "") : null;
  const proxyMembers = plan.members.get(PROXY)!;
  const proxyDefault = selected ?? primaryChoice ?? undefined;

  const outbounds: Record<string, unknown>[] = [
    {
      type: "selector",
      tag: PROXY,
      outbounds: proxyMembers,
      ...(proxyDefault && proxyMembers.includes(proxyDefault) ? { default: proxyDefault } : {}),
      interrupt_exist_connections: true,
    },
  ];
  for (const group of others) {
    const tag = groupTags[group.name];
    const members = plan.members.get(tag) ?? [];
    if (!members.length) members.push(BLOCK);
    const choice = plan.target(choices[group.name] ?? "") ?? undefined;
    outbounds.push(groupOutbound(group, tag, members, choice));
  }
  outbounds.push(...nodes.map((node) => buildOutbound(node, tags[node.id])));
  // block 出站在 sing-box 1.13 移除,升级内核时要改成 reject 动作和自定义选择器成员
  outbounds.push({ type: DIRECT, tag: DIRECT }, { type: BLOCK, tag: BLOCK });

  // ---- 规则 ----
  const custom = compileRules(input.customRules ?? []);
  const runs = [...custom.runs, ...(bundle?.runs ?? [])];
  const finalName = custom.final ?? bundle?.final ?? null;
  const finalTag = (finalName && plan.target(finalName)) || PROXY;

  const routeRules: Record<string, unknown>[] = [];
  let resolved = false;
  for (const run of runs) {
    const outbound = plan.target(run.target);
    if (!outbound) continue;
    if (run.resolve && !resolved) {
      // 用直连 DNS:被污染的结果不是国内 IP,照样走代理
      routeRules.push({ action: "resolve", server: "dns-direct" });
      resolved = true;
    }
    routeRules.push({ ...run.match, action: "route", outbound });
  }
  // 有些订阅只列海外服务,国内网站全部落到兜底组,绕节点一圈
  const covered = new Set<string>();
  usedRuleSets(routeRules, covered);
  const needsCn =
    !bundle || (input.cnDirect !== false && finalTag !== DIRECT && !covered.has("geoip-cn"));
  const compiled = needsCn ? [...routeRules, ...cnRules(finalTag, resolved)] : routeRules;

  const isDirect = (target: string) => {
    const tag = plan.target(target);
    if (tag === DIRECT) return true;
    if (!tag || tag === PROXY) return false;
    const members = plan.members.get(tag);
    if (!members) return false;
    const choice = plan.target(choices[target] ?? "");
    return (choice && members.includes(choice) ? choice : members[0]) === DIRECT;
  };

  // ---- DNS ----
  const v6 = !!input.ipv6;
  const dnsRules: Record<string, unknown>[] = [
    { clash_mode: "global", action: "route", server: "dns-remote" },
  ];
  const direct = directDomains(runs, isDirect);
  if (Object.keys(direct).length) {
    dnsRules.push({ ...direct, action: "route", server: "dns-direct" });
  }
  dnsRules.push({ rule_set: ["geosite-cn"], action: "route", server: "dns-direct" });

  const names = new Set<string>();
  usedRuleSets(compiled, names);
  usedRuleSets(dnsRules, names);

  const dns = {
    servers: [
      // 远端 DNS 走代理(DoH 走 TCP/443,穿透代理最可靠)
      { type: "https", tag: "dns-remote", server: "1.1.1.1", detour: PROXY },
      // 直连 DNS:解析节点地址和国内域名。必须写明地址,不能用 local:
      // TUN 下系统 DNS 会绕回内核;Windows 的虚拟网卡带着失效的 fec0:: 地址,
      // local 要等它们超时,每个新域名多花 5 秒
      { type: "udp", tag: "dns-direct", server: input.directDns || DEFAULT_DIRECT_DNS },
    ],
    rules: dnsRules,
    final: "dns-remote",
    // 节点大多没有 IPv6 出口。只保留 IPv4 地址,否则应用优先连 IPv6 后整站打不开
    strategy: v6 ? "prefer_ipv4" : "ipv4_only",
    reverse_mapping: true,
  };

  const route = {
    rules: [
      { action: "sniff" }, // 探测连接的真实域名
      {
        type: "logical",
        mode: "or",
        rules: [{ protocol: "dns" }, { port: 53 }],
        action: "hijack-dns",
      },
      { ip_is_private: true, action: "route", outbound: DIRECT }, // 局域网/内网直连
      // 拦掉 QUIC(UDP 443):节点不支持 UDP 转发时网站会打不开;
      // reject 后浏览器自动回退 TCP/HTTP2
      { network: "udp", port: 443, action: "reject" },
      { clash_mode: "global", action: "route", outbound: PROXY },
      ...compiled,
    ],
    rule_set: [...names].sort().map((name) => ({
      tag: name,
      type: "local",
      format: "binary",
      path: `@rules/${name}.srs`, // 启动时由后端换成安装目录下的路径
    })),
    // 节点地址用直连 DNS 解析,避免「解析服务器要先连服务器」的死循环
    default_domain_resolver: { server: "dns-direct" },
    auto_detect_interface: true, // 自动出物理网卡
    final: finalTag,
  };

  // ---- 入站 ----
  const inbounds: Record<string, unknown>[] = [
    { type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: port },
  ];
  if (input.tun) {
    inbounds.unshift({
      type: "tun",
      tag: "tun-in",
      address: v6 ? ["172.19.0.1/30", "fdfe:dcba:9876::1/126"] : ["172.19.0.1/30"],
      mtu: 9000,
      auto_route: true, // 自动接管系统路由
      // 必须开:Windows 的 DNS 客户端会同时问所有网卡,不拦住物理网卡的 53 端口,
      // 拿到的就是被污染的地址。未配置 IPv6 地址时它也会拦掉全部 IPv6。
      strict_route: true,
      route_exclude_address: v6 ? [...TUN_EXCLUDED, ...TUN_EXCLUDED_V6] : TUN_EXCLUDED,
      stack: input.stack ?? "gvisor", // 不依赖系统防火墙放行
    });
  }

  const memberTags: Record<string, string> = {};
  for (const group of groups) {
    for (const member of group.members) {
      const tag = plan.target(member);
      if (tag) memberTags[member] = tag;
    }
  }

  return {
    config: {
      log: { level: input.logLevel ?? "warn", timestamp: true },
      dns,
      inbounds,
      outbounds,
      route,
      experimental: { clash_api: { default_mode: input.mode } },
    },
    tags,
    groupTags,
    memberTags,
  };
}
