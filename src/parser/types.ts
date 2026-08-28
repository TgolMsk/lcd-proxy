/** 支持的代理协议 */
export type Protocol = "vless" | "shadowsocks" | "shadowsocksr";

/**
 * 统一的内部节点对象。
 * 三种分享链接(vless:// ss:// ssr://)都解析成这个结构。
 */
export interface Node {
  id: string; // 唯一标识(由原始 URI 哈希得出,重复导入可去重)
  name: string; // 备注名(URI 的 # 之后)
  protocol: Protocol;
  server: string; // 域名 / IP
  port: number;

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

  raw: string; // 原始 URI,便于调试
}

/** 从原始 URI 生成稳定 id(djb2 哈希) */
export function nodeId(raw: string): string {
  let h = 5381;
  for (let i = 0; i < raw.length; i++) {
    h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0;
  }
  return "n" + h.toString(16);
}
