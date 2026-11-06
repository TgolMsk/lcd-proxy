import { Node } from "./types";
import { tryB64DecodeUtf8 } from "./base64";
import { clashProxyToNode, ClashProxy } from "./outbound";
import { splitHostPort } from "./vless";

/** vmess:// trojan:// hy2:// tuic:// anytls:// socks:// 分享链接,先转成 Clash 结构 */

interface LinkParts {
  user: string;
  password?: string;
  host: string;
  port: number;
  query: URLSearchParams;
  name: string;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function splitLink(uri: string): LinkParts {
  let rest = uri.slice(uri.indexOf("://") + 3);
  let name = "";
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    name = decode(rest.slice(hash + 1)).trim();
    rest = rest.slice(0, hash);
  }
  let query = "";
  const q = rest.indexOf("?");
  if (q >= 0) {
    query = rest.slice(q + 1);
    rest = rest.slice(0, q);
  }
  rest = rest.replace(/\/+$/, "");
  const at = rest.lastIndexOf("@");
  if (at <= 0) throw new Error("缺少 用户@主机 结构");
  const auth = rest.slice(0, at);
  const colon = auth.indexOf(":");
  const { host, port } = splitHostPort(rest.slice(at + 1));
  return {
    user: decode(colon >= 0 ? auth.slice(0, colon) : auth),
    password: colon >= 0 ? decode(auth.slice(colon + 1)) : undefined,
    host,
    port,
    query: new URLSearchParams(query),
    name,
  };
}

const isInsecure = (q: URLSearchParams) =>
  ["allowInsecure", "insecure", "allow_insecure", "skip-cert-verify"].some(
    (key) => q.get(key) === "1" || q.get(key) === "true",
  );

function transportFromQuery(q: URLSearchParams, p: ClashProxy) {
  const network = (q.get("type") || "tcp").toLowerCase();
  p.network = network;
  const host = q.get("host") || undefined;
  const path = q.get("path") || undefined;
  if (network === "ws" || network === "httpupgrade") {
    p["ws-opts"] = { path, headers: host ? { Host: host } : undefined };
    if (network === "httpupgrade") p["ws-opts"]["v2ray-http-upgrade"] = true;
    p.network = "ws";
  } else if (network === "grpc") {
    p["grpc-opts"] = { "grpc-service-name": q.get("serviceName") || q.get("servicename") };
  } else if (network === "h2") {
    p["h2-opts"] = { host: host ? [host] : undefined, path };
  } else if (network === "http") {
    p["http-opts"] = { path: path ? [path] : undefined, headers: host ? { Host: [host] } : undefined };
  }
}

function parseVmess(uri: string): Node {
  const body = uri.slice("vmess://".length).split("#")[0];
  const text = tryB64DecodeUtf8(body);
  if (!text) throw new Error("vmess 链接不是 base64");
  const v = JSON.parse(text);
  const network = String(v.net || "tcp").toLowerCase();
  const p: ClashProxy = {
    type: "vmess",
    name: v.ps,
    server: v.add,
    port: v.port,
    uuid: v.id,
    alterId: v.aid,
    cipher: v.scy,
    network,
    tls: v.tls === "tls",
    servername: v.sni || (v.tls === "tls" ? v.host : undefined),
    alpn: v.alpn,
    "client-fingerprint": v.fp,
    "skip-cert-verify": v.allowInsecure === true || v.allowInsecure === "1",
  };
  if (network === "ws") p["ws-opts"] = { path: v.path, headers: v.host ? { Host: v.host } : undefined };
  else if (network === "grpc") p["grpc-opts"] = { "grpc-service-name": v.path };
  else if (network === "h2") p["h2-opts"] = { host: v.host ? [v.host] : undefined, path: v.path };
  else if (network === "tcp" && v.type === "http") {
    p.network = "http";
    p["http-opts"] = { path: v.path ? [v.path] : undefined, headers: v.host ? { Host: [v.host] } : undefined };
  }
  return clashProxyToNode(p);
}

function parseTrojan(uri: string): Node {
  const { user, host, port, query: q, name } = splitLink(uri);
  const p: ClashProxy = {
    type: "trojan",
    name,
    server: host,
    port,
    password: user,
    sni: q.get("sni") || q.get("peer"),
    alpn: q.get("alpn"),
    "skip-cert-verify": isInsecure(q),
    "client-fingerprint": q.get("fp"),
  };
  transportFromQuery(q, p);
  return clashProxyToNode(p);
}

function parseHysteria2(uri: string): Node {
  const { user, password, host, port, query: q, name } = splitLink(uri);
  return clashProxyToNode({
    type: "hysteria2",
    name,
    server: host,
    port,
    password: password === undefined ? user : `${user}:${password}`,
    sni: q.get("sni"),
    obfs: q.get("obfs"),
    "obfs-password": q.get("obfs-password"),
    ports: q.get("mport"),
    "skip-cert-verify": isInsecure(q),
    alpn: q.get("alpn"),
  });
}

function parseTuic(uri: string): Node {
  const { user, password, host, port, query: q, name } = splitLink(uri);
  return clashProxyToNode({
    type: "tuic",
    name,
    server: host,
    port,
    uuid: user,
    password,
    sni: q.get("sni"),
    alpn: q.get("alpn"),
    "congestion-controller": q.get("congestion_control"),
    "udp-relay-mode": q.get("udp_relay_mode"),
    "skip-cert-verify": isInsecure(q),
  });
}

function parseAnytls(uri: string): Node {
  const { user, host, port, query: q, name } = splitLink(uri);
  return clashProxyToNode({
    type: "anytls",
    name,
    server: host,
    port,
    password: user,
    sni: q.get("sni"),
    alpn: q.get("alpn"),
    "skip-cert-verify": isInsecure(q),
  });
}

function parseSocks(uri: string): Node {
  // socks://base64(user:pass)@host:port 或 socks5://user:pass@host:port;无认证时没有 @
  let target = uri;
  if (!uri.includes("@")) target = uri.replace("://", "://_@");
  const { user, password, host, port, name } = splitLink(target);
  const decoded = password === undefined ? tryB64DecodeUtf8(user) : null;
  const [username, pass] = decoded?.includes(":")
    ? [decoded.slice(0, decoded.indexOf(":")), decoded.slice(decoded.indexOf(":") + 1)]
    : [user === "_" ? undefined : user, password];
  return clashProxyToNode({ type: "socks5", name, server: host, port, username, password: pass });
}

export function parseExtraLink(uri: string): Node | null {
  const scheme = uri.slice(0, uri.indexOf("://")).toLowerCase();
  switch (scheme) {
    case "vmess":
      return parseVmess(uri);
    case "trojan":
      return parseTrojan(uri);
    case "hy2":
    case "hysteria2":
      return parseHysteria2(uri);
    case "tuic":
      return parseTuic(uri);
    case "anytls":
      return parseAnytls(uri);
    case "socks":
    case "socks5":
      return parseSocks(uri);
    default:
      return null;
  }
}
