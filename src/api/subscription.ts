import { invoke } from "@tauri-apps/api/core";
import { parseUriList, ParseListResult } from "../parser";
import { isSingboxProfile, parseSingboxProfile } from "../parser/singboxProfile";
import { tryB64DecodeUtf8 } from "../parser/base64";

/**
 * 订阅内容解码:
 * 订阅通常是「整体 base64 的多行分享链接」,也有直接明文多行的。
 * 判断:内容里已含 "://" 就当明文;否则尝试整体 base64 解码。
 */
export function decodeSubscriptionContent(rawBody: string): string {
  const body = rawBody.trim();
  if (body.includes("://")) return body;
  const decoded = tryB64DecodeUtf8(body);
  if (decoded && decoded.includes("://")) return decoded;
  throw new Error("订阅内容无法识别(既不是链接列表也不是 base64)");
}

/**
 * 统一订阅解析:自动识别两种格式 ——
 *  1. sing-box 完整配置 profile(JSON,如 Surge Config Center):抽取真实节点
 *  2. base64 / 明文 的分享链接列表(vless:// ss:// ssr://)
 */
export function parseSubscription(rawBody: string): ParseListResult {
  const body = rawBody.trim();
  if (isSingboxProfile(body)) {
    return parseSingboxProfile(body);
  }
  return parseUriList(decodeSubscriptionContent(body));
}

/** 拉取订阅(经 Rust 侧 HTTP,避免 CORS)→ 解析为节点数组 */
export async function fetchSubscription(url: string): Promise<ParseListResult> {
  const body = await invoke<string>("fetch_subscription", { url });
  const result = parseSubscription(body);
  if (result.nodes.length === 0) {
    const hint = result.errors.length
      ? `全部 ${result.errors.length} 条解析失败`
      : "订阅为空";
    throw new Error(`订阅未解析出可用节点(${hint})`);
  }
  return result;
}
