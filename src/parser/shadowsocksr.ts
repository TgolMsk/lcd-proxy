import { Node, nodeId } from "./types";
import { b64DecodeUtf8, tryB64DecodeUtf8 } from "./base64";

/**
 * SSR 分享链接解析。
 * 格式:ssr://base64( host:port:protocol:method:obfs:base64(password)/?obfsparam=..&protoparam=..&remarks=..&group=.. )
 * 注意:整体一层 base64(URL-safe),密码与各参数内部又各有一层 URL-safe base64,要分层解。
 */
export function parseShadowsocksR(uri: string): Node {
  const raw = uri.trim();
  if (!raw.toLowerCase().startsWith("ssr://")) {
    throw new Error("不是 ssr:// 链接");
  }

  const payload = b64DecodeUtf8(raw.slice("ssr://".length));

  // 拆主体与参数:host:port:protocol:method:obfs:pwd_b64 [/?k=v&...]
  let mainPart = payload;
  let paramPart = "";
  const sepIdx = payload.indexOf("/?");
  if (sepIdx >= 0) {
    mainPart = payload.slice(0, sepIdx);
    paramPart = payload.slice(sepIdx + 2);
  } else {
    mainPart = payload.replace(/\/+$/, "");
  }

  // host 可能是含冒号的 IPv6:从右往左取 5 段,剩余归 host
  const segs = mainPart.split(":");
  if (segs.length < 6) throw new Error("SSR 主体字段不足 6 段");
  const passwordB64 = segs.pop()!;
  const obfs = segs.pop()!;
  const method = segs.pop()!;
  const ssrProtocol = segs.pop()!;
  const portStr = segs.pop()!;
  const host = segs.join(":").replace(/^\[|\]$/g, "");

  const port = Number(portStr);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SSR host:port 非法 (${mainPart})`);
  }

  const password = b64DecodeUtf8(passwordB64);

  // 参数区:值全部是 URL-safe base64
  const params = new URLSearchParams(paramPart);
  const b64Param = (k: string) => {
    const v = params.get(k);
    if (!v) return undefined;
    return tryB64DecodeUtf8(v) ?? undefined;
  };

  const remarks = b64Param("remarks");

  return {
    id: nodeId(raw),
    name: (remarks || "").trim() || `${host}:${port}`,
    protocol: "shadowsocksr",
    server: host,
    port,
    method,
    password,
    ssrProtocol,
    protocolParam: b64Param("protoparam") ?? "",
    obfs,
    obfsParam: b64Param("obfsparam") ?? "",
    raw,
  };
}
