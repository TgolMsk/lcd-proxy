/**
 * base64 工具:分享链接里的 base64 常见三种变体 ——
 * 标准、URL-safe(-_ 代替 +/)、无 padding。这里统一容错处理。
 */

/** 归一化:去空白、URL-safe 转标准、补齐 padding */
function normalize(input: string): string {
  let s = input.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad === 2) s += "==";
  else if (pad === 3) s += "=";
  else if (pad === 1) throw new Error("非法 base64 长度");
  return s;
}

/** 解码为字节 */
export function b64DecodeBytes(input: string): Uint8Array {
  const bin = atob(normalize(input));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 解码为 UTF-8 字符串 */
export function b64DecodeUtf8(input: string): string {
  return new TextDecoder("utf-8").decode(b64DecodeBytes(input));
}

/** 尝试解码,失败返回 null(用于「可能是 base64 也可能是明文」的场合) */
export function tryB64DecodeUtf8(input: string): string | null {
  try {
    if (!/^[A-Za-z0-9+/\-_]+=*$/.test(input.replace(/\s+/g, ""))) return null;
    return b64DecodeUtf8(input);
  } catch {
    return null;
  }
}

/** 编码(测试与调试用) */
export function b64EncodeUtf8(input: string, urlSafe = false): string {
  const bytes = new TextEncoder().encode(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  let s = btoa(bin);
  if (urlSafe) s = s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return s;
}
