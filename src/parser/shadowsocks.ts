import { Node, nodeId } from "./types";
import { tryB64DecodeUtf8 } from "./base64";
import { splitHostPort } from "./vless";

/**
 * Shadowsocks 分享链接解析,兼容两种格式:
 *  - SIP002:ss://base64(method:password)@host:port/?plugin=...#备注
 *    (AEAD-2022 节点的 userinfo 可能是未 base64 的 method:password,需兼容)
 *  - 旧格式:ss://base64(method:password@host:port)#备注
 */
export function parseShadowsocks(uri: string): Node {
  const raw = uri.trim();
  if (!raw.toLowerCase().startsWith("ss://")) {
    throw new Error("不是 ss:// 链接");
  }
  let rest = raw.slice("ss://".length);

  // 备注
  let name = "";
  const hashIdx = rest.indexOf("#");
  if (hashIdx >= 0) {
    name = safeDecode(rest.slice(hashIdx + 1)).trim();
    rest = rest.slice(0, hashIdx);
  }

  let method: string;
  let password: string;
  let host: string;
  let port: number;

  const atIdx = rest.lastIndexOf("@");
  if (atIdx >= 0) {
    // ---- SIP002 格式 ----
    const userinfo = rest.slice(0, atIdx);
    let hostpart = rest.slice(atIdx + 1);
    // 去掉 /?plugin=... 尾巴(plugin 不在支持范围,忽略但不报错)
    const slashIdx = hostpart.search(/[/?]/);
    if (slashIdx >= 0) hostpart = hostpart.slice(0, slashIdx);

    const decoded = tryB64DecodeUtf8(userinfo);
    const cred = decoded && decoded.includes(":") ? decoded : safeDecode(userinfo);
    const colonIdx = cred.indexOf(":");
    if (colonIdx < 0) throw new Error("userinfo 缺少 method:password");
    method = cred.slice(0, colonIdx);
    password = cred.slice(colonIdx + 1); // 密码可含冒号,只切第一个

    ({ host, port } = splitHostPort(hostpart));
  } else {
    // ---- 旧格式:整体 base64 ----
    const decoded = tryB64DecodeUtf8(rest);
    if (!decoded) throw new Error("旧格式 base64 解码失败");
    const at2 = decoded.lastIndexOf("@");
    if (at2 < 0) throw new Error("旧格式缺少 @");
    const cred = decoded.slice(0, at2);
    const colonIdx = cred.indexOf(":");
    if (colonIdx < 0) throw new Error("旧格式缺少 method:password");
    method = cred.slice(0, colonIdx);
    password = cred.slice(colonIdx + 1);
    ({ host, port } = splitHostPort(decoded.slice(at2 + 1)));
  }

  if (!method || !password) throw new Error("method/password 为空");

  return {
    id: nodeId(raw),
    name: name || `${host}:${port}`,
    protocol: "shadowsocks",
    server: host,
    port,
    method,
    password,
    raw,
  };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
