import { Node } from "./types";
import { parseVless } from "./vless";
import { parseShadowsocks } from "./shadowsocks";
import { parseShadowsocksR } from "./shadowsocksr";

export type { Node, Protocol } from "./types";

/** 单条分享链接 → Node,按 scheme 分发 */
export function parseUri(uri: string): Node {
  const s = uri.trim();
  const lower = s.toLowerCase();
  if (lower.startsWith("vless://")) return parseVless(s);
  if (lower.startsWith("ss://")) return parseShadowsocks(s);
  if (lower.startsWith("ssr://")) return parseShadowsocksR(s);
  throw new Error(`不支持的协议:${s.slice(0, 16)}…`);
}

export interface ParseListResult {
  nodes: Node[];
  errors: string[]; // 解析失败的行 + 原因(跳过,不中断整体)
}

/** 多行文本 → 节点数组。单条失败跳过并记录,不让整个列表中断。 */
export function parseUriList(text: string): ParseListResult {
  const nodes: Node[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const node = parseUri(s);
      if (!seen.has(node.id)) {
        seen.add(node.id);
        nodes.push(node);
      }
    } catch (e) {
      errors.push(`${s.slice(0, 40)}… → ${(e as Error).message}`);
    }
  }
  return { nodes, errors };
}
