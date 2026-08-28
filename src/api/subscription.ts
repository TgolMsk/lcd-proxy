import { invoke } from "@tauri-apps/api/core";
import { parseUriList, ParseListResult } from "../parser";
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

/** 拉取订阅(经 Rust 侧 HTTP,避免 CORS)→ 解码 → 解析为节点数组 */
export async function fetchSubscription(url: string): Promise<ParseListResult> {
  const body = await invoke<string>("fetch_subscription", { url });
  const text = decodeSubscriptionContent(body);
  const result = parseUriList(text);
  if (result.nodes.length === 0) {
    const hint = result.errors.length
      ? `全部 ${result.errors.length} 条解析失败`
      : "订阅为空";
    throw new Error(`订阅未解析出可用节点(${hint})`);
  }
  return result;
}
