import { Node } from "../parser/types";

/** 本地混合入站端口(SOCKS5 + HTTP 同端口) */
export const PROXY_PORT = 10808;
export const PROXY_SERVER = `127.0.0.1:${PROXY_PORT}`;

export interface BuildOptions {
  port?: number;
  tun?: boolean; // TUN 模式(预留):需要管理员权限,接管全局流量
}

/**
 * 选中的节点 → 完整 sing-box 配置(对齐 sing-box 1.x 格式)。
 * outbound tag 固定为 "proxy"。
 */
export function buildSingBoxConfig(node: Node, opts: BuildOptions = {}): object {
  const port = opts.port ?? PROXY_PORT;

  const inbounds: object[] = [
    {
      type: "mixed",
      tag: "mixed-in",
      listen: "127.0.0.1",
      listen_port: port,
    },
  ];

  const config: Record<string, unknown> = {
    log: { level: "warn", timestamp: true },
    inbounds,
    outbounds: [buildOutbound(node), { type: "direct", tag: "direct" }],
  };

  if (opts.tun) {
    // TUN 模式:创建虚拟网卡接管全局流量(Windows 需管理员权限 + wintun 驱动)。
    // 保留 mixed 入站,方便同时用本地端口;tun 放在最前作为主入站。
    inbounds.unshift({
      type: "tun",
      tag: "tun-in",
      address: ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
      mtu: 9000,
      auto_route: true, // 自动接管系统路由
      strict_route: true, // 防流量泄漏
      stack: "mixed", // TCP 走 system、UDP 走 gvisor,兼容性好
    });
    // auto_detect_interface:自动出物理网卡;final:兜底走代理
    config.route = { auto_detect_interface: true, final: "proxy" };
  }

  return config;
}

/** 节点对象 → sing-box outbound(四种协议形态) */
export function buildOutbound(node: Node): object {
  switch (node.protocol) {
    case "vless":
      return buildVlessOutbound(node);
    case "shadowsocks":
      return {
        type: "shadowsocks",
        tag: "proxy",
        server: node.server,
        server_port: node.port,
        method: node.method,
        password: node.password,
      };
    case "shadowsocksr":
      // ⚠️ 需要内核支持 shadowsocksr 出站(官方 sing-box ≥1.6 已移除,详见 README)
      return {
        type: "shadowsocksr",
        tag: "proxy",
        server: node.server,
        server_port: node.port,
        method: node.method,
        password: node.password,
        protocol: node.ssrProtocol || "origin",
        protocol_param: node.protocolParam || "",
        obfs: node.obfs || "plain",
        obfs_param: node.obfsParam || "",
      };
  }
}

function buildVlessOutbound(node: Node): object {
  const out: Record<string, unknown> = {
    type: "vless",
    tag: "proxy",
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
