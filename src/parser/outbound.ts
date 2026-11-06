import { Node, Protocol, nodeId } from "./types";

/**
 * Clash 格式的节点 → sing-box 出站。
 * Clash 订阅和 vmess:// trojan:// 等分享链接都先整理成这种结构,转换逻辑只写一份。
 * 字段值可能是字符串(YAML 解析时刻意不做类型推断,密码才能原样保留)。
 */
export type ClashProxy = Record<string, any>;
type Json = Record<string, unknown>;

const truthy = (v: unknown) => v === true || v === "true" || v === "1" || v === 1;

function toList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === "string" && v) return v.split(",").map((s) => s.trim()).filter(Boolean);
  return undefined;
}

function toInt(v: unknown): number | undefined {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : undefined;
}

/** "30 Mbps" → 30 */
function toMbps(v: unknown): number | undefined {
  return toInt(v);
}

function compact<T extends Json>(obj: T): T {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value === undefined || value === "" || (Array.isArray(value) && !value.length)) {
      delete obj[key];
    }
  }
  return obj;
}

function tlsOptions(p: ClashProxy, required = false): Json | undefined {
  const reality = p["reality-opts"];
  if (!required && !truthy(p.tls) && !reality) return undefined;
  const tls: Json = compact({
    enabled: true,
    server_name: p.servername || p.sni,
    insecure: truthy(p["skip-cert-verify"]) ? true : undefined,
    alpn: toList(p.alpn),
    disable_sni: truthy(p["disable-sni"]) ? true : undefined,
  });
  const fingerprint = p["client-fingerprint"] || p.fingerprint;
  if (reality) {
    tls.utls = { enabled: true, fingerprint: fingerprint || "chrome" };
    tls.reality = compact({
      enabled: true,
      public_key: reality["public-key"],
      short_id: reality["short-id"],
    });
  } else if (fingerprint) {
    tls.utls = { enabled: true, fingerprint };
  }
  return tls;
}

function firstOf(v: unknown): string | undefined {
  return Array.isArray(v) ? (v[0] === undefined ? undefined : String(v[0])) : (v as string);
}

function transportOptions(p: ClashProxy): Json | undefined {
  const network = String(p.network || "tcp").toLowerCase();
  if (network === "tcp" || network === "") return undefined;
  if (network === "ws") {
    const opts = p["ws-opts"] || {};
    const path = opts.path ?? p["ws-path"] ?? "/";
    const headers = opts.headers ?? p["ws-headers"];
    if (truthy(opts["v2ray-http-upgrade"])) {
      return compact({ type: "httpupgrade", path, host: headers?.Host, headers });
    }
    return compact({
      type: "ws",
      path,
      headers,
      max_early_data: toInt(opts["max-early-data"]),
      early_data_header_name: opts["early-data-header-name"],
    });
  }
  if (network === "httpupgrade") {
    const opts = p["ws-opts"] || p["http-upgrade-opts"] || {};
    return compact({ type: "httpupgrade", path: opts.path ?? "/", host: opts.host, headers: opts.headers });
  }
  if (network === "grpc") {
    const opts = p["grpc-opts"] || {};
    return compact({ type: "grpc", service_name: opts["grpc-service-name"] });
  }
  if (network === "h2") {
    const opts = p["h2-opts"] || {};
    return compact({ type: "http", host: toList(opts.host), path: firstOf(opts.path) });
  }
  if (network === "http") {
    const opts = p["http-opts"] || {};
    const headers = { ...(opts.headers || {}) };
    const host = toList(headers.Host);
    delete headers.Host;
    return compact({
      type: "http",
      method: opts.method,
      path: firstOf(opts.path),
      host,
      headers: Object.keys(headers).length ? headers : undefined,
    });
  }
  throw new Error(`不支持的传输方式 ${network}`);
}

function shadowsocksPlugin(p: ClashProxy, out: Json) {
  if (!p.plugin) return;
  const opts = p["plugin-opts"] || {};
  if (p.plugin === "obfs") {
    out.plugin = "obfs-local";
    out.plugin_opts = [`obfs=${opts.mode || "http"}`, opts.host && `obfs-host=${opts.host}`]
      .filter(Boolean)
      .join(";");
  } else if (p.plugin === "v2ray-plugin") {
    out.plugin = "v2ray-plugin";
    out.plugin_opts = [
      opts.mode && `mode=${opts.mode}`,
      truthy(opts.tls) && "tls",
      opts.host && `host=${opts.host}`,
      opts.path && `path=${opts.path}`,
    ]
      .filter(Boolean)
      .join(";");
  } else {
    throw new Error(`不支持的插件 ${p.plugin}`);
  }
}

const HYSTERIA_PORTS = /^\d+(-\d+)?(,\d+(-\d+)?)*$/;

function hopPorts(p: ClashProxy): string[] | undefined {
  const ports = String(p.ports ?? "");
  if (!HYSTERIA_PORTS.test(ports)) return undefined;
  return ports.split(",").map((part) => {
    const [from, to] = part.split("-");
    return `${from}:${to ?? from}`;
  });
}

function requireField(p: ClashProxy, key: string): string {
  const value = p[key];
  if (value === undefined || value === null || value === "") throw new Error(`缺少 ${key}`);
  return String(value);
}

interface Converted {
  protocol: Protocol;
  outbound: Json;
}

function convert(p: ClashProxy, server: string, port: number): Converted {
  const base = { server, server_port: port };
  const tcpOnly = p.udp !== undefined && !truthy(p.udp) ? { network: "tcp" } : {};
  switch (String(p.type).toLowerCase()) {
    case "ss": {
      const out: Json = {
        type: "shadowsocks",
        ...base,
        method: requireField(p, "cipher"),
        password: requireField(p, "password"),
        ...tcpOnly,
      };
      shadowsocksPlugin(p, out);
      if (truthy(p["udp-over-tcp"])) out.udp_over_tcp = true;
      return { protocol: "shadowsocks", outbound: out };
    }
    case "vmess":
      return {
        protocol: "vmess",
        outbound: compact({
          type: "vmess",
          ...base,
          uuid: requireField(p, "uuid"),
          security: p.cipher || "auto",
          alter_id: toInt(p.alterId) ?? 0,
          ...tcpOnly,
          tls: tlsOptions(p),
          transport: transportOptions(p),
          packet_encoding: p["packet-encoding"],
        }),
      };
    case "vless": {
      if (p.encryption && p.encryption !== "none") throw new Error("不支持 VLESS 加密");
      return {
        protocol: "vless",
        outbound: compact({
          type: "vless",
          ...base,
          uuid: requireField(p, "uuid"),
          flow: p.flow,
          ...tcpOnly,
          tls: tlsOptions(p),
          transport: transportOptions(p),
          packet_encoding: p["packet-encoding"],
        }),
      };
    }
    case "trojan":
      return {
        protocol: "trojan",
        outbound: compact({
          type: "trojan",
          ...base,
          password: requireField(p, "password"),
          ...tcpOnly,
          tls: tlsOptions(p, true),
          transport: transportOptions(p),
        }),
      };
    case "hysteria2":
    case "hy2": {
      const password = p.password ?? p.auth;
      if (!password) throw new Error("缺少 password");
      const ports = hopPorts(p);
      return {
        protocol: "hysteria2",
        outbound: compact({
          type: "hysteria2",
          server,
          server_port: port,
          server_ports: ports,
          hop_interval: p["hop-interval"] ? `${toInt(p["hop-interval"])}s` : undefined,
          password: String(password),
          up_mbps: toMbps(p.up),
          down_mbps: toMbps(p.down),
          obfs: p.obfs
            ? { type: p.obfs, password: requireField(p, "obfs-password") }
            : undefined,
          tls: tlsOptions(p, true),
        }),
      };
    }
    case "hysteria":
      return {
        protocol: "hysteria",
        outbound: compact({
          type: "hysteria",
          ...base,
          auth_str: p["auth-str"] ?? p.auth_str,
          up_mbps: toMbps(p.up) ?? 100,
          down_mbps: toMbps(p.down) ?? 100,
          obfs: p.obfs,
          tls: tlsOptions(p, true),
        }),
      };
    case "tuic":
      return {
        protocol: "tuic",
        outbound: compact({
          type: "tuic",
          ...base,
          uuid: requireField(p, "uuid"),
          password: p.password,
          congestion_control: p["congestion-controller"],
          udp_relay_mode: p["udp-relay-mode"],
          zero_rtt_handshake: truthy(p["reduce-rtt"]) ? true : undefined,
          tls: tlsOptions(p, true),
        }),
      };
    case "anytls":
      return {
        protocol: "anytls",
        outbound: compact({
          type: "anytls",
          ...base,
          password: requireField(p, "password"),
          tls: tlsOptions(p, true),
        }),
      };
    case "socks5":
    case "socks": {
      if (truthy(p.tls)) throw new Error("不支持带 TLS 的 SOCKS");
      return {
        protocol: "socks",
        outbound: compact({
          type: "socks",
          version: "5",
          ...base,
          username: p.username,
          password: p.password,
          ...tcpOnly,
        }),
      };
    }
    case "http":
      return {
        protocol: "http",
        outbound: compact({
          type: "http",
          ...base,
          username: p.username,
          password: p.password,
          tls: tlsOptions(p),
        }),
      };
    default:
      throw new UnsupportedType(String(p.type));
  }
}

class UnsupportedType extends Error {
  constructor(readonly kind: string) {
    super(`不支持的协议 ${kind}`);
  }
}

/** 内部协议名:只用于展示内核用不了的节点 */
const SHOWN_AS: Record<string, Protocol> = { ssr: "shadowsocksr" };

/** Clash 节点 → Node。参数缺失抛错;内核不支持的协议保留成不可用节点,让用户看得见。 */
export function clashProxyToNode(p: ClashProxy): Node {
  const server = String(p.server ?? "").replace(/^\[|\]$/g, "");
  const port = toInt(p.port);
  if (!server || !port || port < 1 || port > 65535) throw new Error("server/port 非法");
  const name = String(p.name || `${server}:${port}`);
  try {
    const { protocol, outbound } = convert(p, server, port);
    return {
      id: nodeId(name + JSON.stringify(outbound)),
      name,
      protocol,
      server,
      port,
      outbound,
    };
  } catch (e) {
    const kind = String(p.type).toLowerCase();
    return {
      id: nodeId(name + server + port + kind),
      name,
      protocol: SHOWN_AS[kind] ?? "http",
      server,
      port,
      unsupported: e instanceof UnsupportedType ? e.message : `${kind}:${(e as Error).message}`,
    };
  }
}
