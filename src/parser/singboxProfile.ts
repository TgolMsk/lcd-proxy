import { Node, nodeId, Protocol } from "./types";
import { ParseListResult } from "./index";

/**
 * sing-box「完整配置 profile」订阅支持。
 *
 * 有些机场(如 Surge Config Center)的订阅返回的不是 base64 分享链接列表,
 * 而是一份完整的 sing-box 配置 JSON:含 inbounds(通常 tun)、outbounds
 * (真实节点 + 大量 selector 策略分组)、以及成百条 route 规则。
 *
 * 本项目的模型是「从列表里选一个节点 → 生成自己的配置」,不消费 profile 里的
 * 路由规则与分组。所以这里只做一件事:把 outbounds 里的**真实代理节点**
 * (vless / shadowsocks / shadowsocksr)抽成统一的 Node,丢弃 selector /
 * urltest / direct / block / dns 等非节点出站,以及 route/dns/inbounds。
 */

/** sing-box outbound.type → 我们的内部协议名 */
const TYPE_MAP: Record<string, Protocol> = {
  vless: "vless",
  shadowsocks: "shadowsocks",
  shadowsocksr: "shadowsocksr",
};

/** 判断一段文本是否是 sing-box 配置 profile(而非分享链接列表) */
export function isSingboxProfile(text: string): boolean {
  const s = text.trim();
  if (!s.startsWith("{")) return false;
  try {
    const obj = JSON.parse(s);
    return (
      obj && typeof obj === "object" && Array.isArray((obj as any).outbounds)
    );
  } catch {
    return false;
  }
}

/** 解析 profile JSON,抽取真实节点。坏的单个 outbound 跳过并记录,不中断整体。 */
export function parseSingboxProfile(text: string): ParseListResult {
  const nodes: Node[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  let profile: any;
  try {
    profile = JSON.parse(text);
  } catch (e) {
    throw new Error(`sing-box profile 不是合法 JSON:${(e as Error).message}`);
  }
  const outbounds = Array.isArray(profile?.outbounds) ? profile.outbounds : [];

  for (const ob of outbounds) {
    const type = ob?.type;
    if (!TYPE_MAP[type]) continue; // 跳过 selector/urltest/direct/block/dns 等
    try {
      const node = outboundToNode(ob);
      if (!seen.has(node.id)) {
        seen.add(node.id);
        nodes.push(node);
      }
    } catch (e) {
      errors.push(`${ob?.tag ?? type} → ${(e as Error).message}`);
    }
  }

  return { nodes, errors };
}

/** 单个 sing-box outbound 对象 → Node(buildOutbound 的逆过程) */
export function outboundToNode(ob: any): Node {
  const protocol = TYPE_MAP[ob.type];
  if (!protocol) throw new Error(`非节点类型:${ob.type}`);

  const server = String(ob.server ?? "");
  const port = Number(ob.server_port);
  if (!server || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`server/server_port 非法`);
  }

  // raw 用规整后的 JSON,保证同一节点跨刷新 id 稳定、可去重
  const raw = JSON.stringify(ob);
  const name = String(ob.tag || `${server}:${port}`);

  const base: Node = {
    id: nodeId(raw),
    name,
    protocol,
    server,
    port,
    raw,
  };

  if (protocol === "vless") return fillVless(base, ob);
  if (protocol === "shadowsocks") {
    if (!ob.method || ob.password == null) throw new Error("缺 method/password");
    return { ...base, method: String(ob.method), password: String(ob.password) };
  }
  // shadowsocksr
  if (!ob.method || ob.password == null) throw new Error("缺 method/password");
  return {
    ...base,
    method: String(ob.method),
    password: String(ob.password),
    ssrProtocol: str(ob.protocol) || "origin",
    protocolParam: str(ob.protocol_param) ?? "",
    obfs: str(ob.obfs) || "plain",
    obfsParam: str(ob.obfs_param) ?? "",
  };
}

function fillVless(base: Node, ob: any): Node {
  if (!ob.uuid) throw new Error("缺 uuid");
  const n: Node = { ...base, uuid: String(ob.uuid), network: "tcp", security: "none" };
  if (ob.flow) n.flow = String(ob.flow);

  const tls = ob.tls;
  if (tls?.enabled) {
    n.sni = str(tls.server_name);
    n.insecure = !!tls.insecure;
    if (Array.isArray(tls.alpn) && tls.alpn.length) n.alpn = tls.alpn.map(String);
    if (tls.utls?.fingerprint) n.fingerprint = String(tls.utls.fingerprint);
    if (tls.reality?.enabled) {
      n.security = "reality";
      n.publicKey = str(tls.reality.public_key);
      n.shortId = str(tls.reality.short_id);
    } else {
      n.security = "tls";
    }
  }

  const tr = ob.transport;
  if (tr?.type === "ws") {
    n.network = "ws";
    n.path = str(tr.path) || "/";
    n.host = str(tr.headers?.Host) || str(tr.headers?.host);
  } else if (tr?.type === "grpc") {
    n.network = "grpc";
    n.serviceName = str(tr.service_name);
  }
  return n;
}

function str(v: unknown): string | undefined {
  return v == null ? undefined : String(v);
}
