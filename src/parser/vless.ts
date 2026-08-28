import { Node, nodeId } from "./types";

/**
 * VLESS 分享链接解析。
 * 格式:vless://<uuid>@<host>:<port>?type=ws&security=tls&sni=...&path=...#<备注>
 * 查询参数决定传输层(ws/grpc/tcp)与安全层(tls/reality),需完整解析 query。
 * 不用 new URL():自定义 scheme + IPv6 主机在不同 WebView 下行为不一致,手动拆更稳。
 */
export function parseVless(uri: string): Node {
  const raw = uri.trim();
  if (!raw.toLowerCase().startsWith("vless://")) {
    throw new Error("不是 vless:// 链接");
  }
  let rest = raw.slice("vless://".length);

  // 1. 备注(# 之后)
  let name = "";
  const hashIdx = rest.indexOf("#");
  if (hashIdx >= 0) {
    name = safeDecode(rest.slice(hashIdx + 1)).trim();
    rest = rest.slice(0, hashIdx);
  }

  // 2. query(? 之后)
  let query = "";
  const qIdx = rest.indexOf("?");
  if (qIdx >= 0) {
    query = rest.slice(qIdx + 1);
    rest = rest.slice(0, qIdx);
  }
  rest = rest.replace(/\/+$/, ""); // 容忍尾部斜杠

  // 3. authority:uuid@host:port
  const atIdx = rest.indexOf("@");
  if (atIdx <= 0) throw new Error("缺少 uuid@host 结构");
  const uuid = safeDecode(rest.slice(0, atIdx));
  const { host, port } = splitHostPort(rest.slice(atIdx + 1));

  const params = new URLSearchParams(query);
  const get = (k: string) => params.get(k) ?? undefined;

  const network = (get("type") || "tcp").toLowerCase();
  const security = (get("security") || "none").toLowerCase();

  const node: Node = {
    id: nodeId(raw),
    name: name || `${host}:${port}`,
    protocol: "vless",
    server: host,
    port,
    uuid,
    network,
    security,
    sni: get("sni") || get("peer"),
    host: get("host"),
    path: get("path"),
    flow: get("flow") || undefined,
    publicKey: get("pbk"),
    shortId: get("sid"),
    fingerprint: get("fp"),
    serviceName: get("serviceName") || get("servicename"),
    alpn: get("alpn") ? get("alpn")!.split(",").filter(Boolean) : undefined,
    insecure: get("allowInsecure") === "1" || get("allowInsecure") === "true",
    raw,
  };

  if (!node.uuid) throw new Error("uuid 为空");
  return node;
}

/** host:port 拆分,支持 [IPv6]:port */
export function splitHostPort(input: string): { host: string; port: number } {
  let host: string;
  let portStr: string;
  if (input.startsWith("[")) {
    const end = input.indexOf("]");
    if (end < 0) throw new Error("IPv6 地址缺少 ]");
    host = input.slice(1, end);
    portStr = input.slice(end + 1).replace(/^:/, "");
  } else {
    const idx = input.lastIndexOf(":");
    if (idx < 0) throw new Error("缺少端口");
    host = input.slice(0, idx);
    portStr = input.slice(idx + 1);
  }
  const port = Number(portStr);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`host:port 非法 (${input})`);
  }
  return { host, port };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
