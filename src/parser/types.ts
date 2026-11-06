/** 支持的代理协议 */
export type Protocol =
  | "vless"
  | "vmess"
  | "trojan"
  | "shadowsocks"
  | "shadowsocksr"
  | "hysteria"
  | "hysteria2"
  | "tuic"
  | "anytls"
  | "socks"
  | "http";

/**
 * 统一的内部节点对象。
 * vless:// ss:// ssr:// 解析出的节点用下面的独立字段,其余协议和 Clash 订阅
 * 直接存转换好的 sing-box 出站(outbound),生成配置时只补 tag。
 */
export interface Node {
  id: string; // 唯一标识(由节点内容哈希得出,重复导入可去重)
  name: string; // 备注名
  protocol: Protocol;
  server: string; // 域名 / IP
  port: number;

  /** sing-box 出站配置(不含 tag) */
  outbound?: Record<string, unknown>;
  /** 内核不支持时的原因,这类节点只展示、不能使用 */
  unsupported?: string;
  /** 旧版数据迁移来的节点,订阅刷新后去掉重复项 */
  fromV1?: boolean;

  // ---- vless ----
  uuid?: string;
  network?: string; // ws / tcp / grpc ...
  security?: string; // tls / reality / none
  sni?: string;
  host?: string; // ws Host 头 / http host
  path?: string; // ws path
  flow?: string; // xtls-rprx-vision
  publicKey?: string; // reality pbk
  shortId?: string; // reality sid
  fingerprint?: string; // utls fp
  serviceName?: string; // grpc
  alpn?: string[];
  insecure?: boolean; // allowInsecure

  // ---- ss / ssr ----
  method?: string; // 加密方式
  password?: string;

  // ---- ssr 特有 ----
  ssrProtocol?: string; // origin / auth_aes128_md5 ...
  protocolParam?: string;
  obfs?: string; // plain / http_simple ...
  obfsParam?: string;

  raw?: string; // 原始 URI,便于调试
}

/** 内核用不了这个节点的原因。官方 sing-box 已移除 SSR,旧数据里的节点没有标记 */
export function unsupportedReason(node: Node): string | undefined {
  return node.unsupported ?? (node.protocol === "shadowsocksr" ? "内核不支持 SSR" : undefined);
}

/** 从原始内容生成稳定 id(djb2 哈希) */
export function nodeId(raw: string): string {
  let h = 5381;
  for (let i = 0; i < raw.length; i++) {
    h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0;
  }
  return "n" + h.toString(16);
}
