import { parseUriList, ParseListResult } from "../parser";
import { Fetcher, looksLikeClash, parseClash } from "../parser/clash";
import { isSingboxProfile, parseSingboxProfile } from "../parser/singboxProfile";
import { tryB64DecodeUtf8 } from "../parser/base64";
import { Node } from "../parser/types";
import { RuleBundle } from "../rules/types";

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
  throw new Error("内容无法识别(不是 Clash 配置、sing-box 配置或分享链接)");
}

/** 只含节点的格式:sing-box 配置,或 base64 / 明文的分享链接列表 */
export function parseSubscription(rawBody: string): ParseListResult {
  const body = rawBody.trim();
  if (isSingboxProfile(body)) {
    return parseSingboxProfile(body);
  }
  return parseUriList(decodeSubscriptionContent(body));
}

export interface ParsedProfile {
  nodes: Node[];
  errors: string[];
  rules: RuleBundle | null;
}

/** 解析订阅或粘贴的内容。Clash 配置里的规则集和节点集通过 fetcher 下载 */
export async function parseProfile(body: string, fetcher: Fetcher): Promise<ParsedProfile> {
  const text = body.replace(/^﻿/, "").trim();
  if (!isSingboxProfile(text) && looksLikeClash(text)) {
    const parsed = await parseClash(text, fetcher, (list) => parseSubscription(list).nodes);
    const hasRules = parsed.rules.runs.length > 0 || parsed.rules.groups.length > 0;
    return { nodes: parsed.nodes, errors: parsed.errors, rules: hasRules ? parsed.rules : null };
  }
  const { nodes, errors } = parseSubscription(text);
  return { nodes, errors, rules: null };
}

export interface Usage {
  upload: number;
  download: number;
  total: number;
  /** 到期时间,毫秒;0 表示不限 */
  expire: number;
}

/** subscription-userinfo: upload=1; download=2; total=3; expire=4 */
export function parseUsage(header: string | null): Usage | undefined {
  if (!header) return undefined;
  const values: Record<string, number> = {};
  for (const part of header.split(";")) {
    const [key, value] = part.split("=").map((s) => s.trim());
    if (key) values[key.toLowerCase()] = Number(value) || 0;
  }
  if (!("total" in values)) return undefined;
  return {
    upload: values.upload ?? 0,
    download: values.download ?? 0,
    total: values.total,
    expire: (values.expire ?? 0) * 1000,
  };
}

function fileNameOf(disposition: string): string | null {
  const encoded = /filename\*\s*=\s*(?:utf-8|UTF-8)''([^;]+)/.exec(disposition);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      return encoded[1].trim();
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(disposition);
  return plain ? plain[1].trim() : null;
}

/** 订阅名:响应头 profile-title → 文件名 → 域名 */
/** 配置中心常用的通用文件名,当名称分不清是哪份订阅 */
const GENERIC_FILE = /^(clash|config|profile|proxies|sing-?box|sub|subscribe|subscription)$/i;

export function profileName(
  url: string,
  title: string | null,
  disposition: string | null,
): string {
  if (title) {
    const decoded = title.startsWith("base64:") ? tryB64DecodeUtf8(title.slice(7)) : title;
    if (decoded) return decoded.trim();
  }
  const file = disposition ? fileNameOf(disposition)?.replace(/\.(ya?ml|json|txt)$/i, "") : null;
  if (file && !GENERIC_FILE.test(file)) return file;
  try {
    return new URL(url).hostname;
  } catch {
    return "订阅";
  }
}

export function parseInterval(header: string | null): number | undefined {
  const hours = Number(header);
  return Number.isFinite(hours) && hours > 0 ? hours : undefined;
}
