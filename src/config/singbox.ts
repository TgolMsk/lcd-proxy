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
      strict_route: false, // Windows 上 true 过于激进、易导致整机断网,关掉更稳
      stack: "mixed", // TCP 走 system、UDP 走 gvisor,兼容性好
    });

    // ⚠️ 关键:TUN 会把所有流量(含 DNS 查询)吞进虚拟网卡。若不显式处理 DNS,
    // 域名将全部解析失败,表现为「整机无网络」。这里内置 DNS + 劫持所有 DNS 查询。
    config.dns = {
      servers: [
        // 远端 DNS 走代理(DoH 走 TCP/443,穿透代理最可靠)
        { type: "https", tag: "dns-remote", server: "1.1.1.1", detour: "proxy" },
        // 直连 DNS:解析节点服务器域名、局域网。不写 detour(sing-box 1.12 里
        // detour 到空 direct 出站会报错;不写即走直连,正是所需)
        { type: "udp", tag: "dns-direct", server: "223.5.5.5" },
      ],
      final: "dns-remote",
      strategy: "prefer_ipv4",
    };

    config.route = {
      rules: [
        { action: "sniff" }, // 探测连接的真实域名
        { protocol: "dns", action: "hijack-dns" }, // 劫持所有 DNS 查询到内置解析器
        { ip_is_private: true, action: "route", outbound: "direct" }, // 局域网/内网直连
      ],
      // 节点服务器域名用直连 DNS 解析,避免「解析服务器要先连服务器」的死循环
      default_domain_resolver: { server: "dns-direct" },
      auto_detect_interface: true, // 自动出物理网卡
      final: "proxy", // 其余流量兜底走代理
    };
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
