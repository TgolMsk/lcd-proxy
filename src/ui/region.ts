/**
 * 节点名里的地区和标签。
 * Windows 的 WebView2 不显示国旗 emoji,只会出现两个字母,所以去掉旗帜,改成地区标识。
 * 地区优先看文字:机场常把台湾节点标成中国国旗。
 */
const REGIONS: [string, string, RegExp][] = [
  ["HK", "香港", /香港|\bHK\b|hong ?kong/i],
  ["TW", "台湾", /台湾|臺灣|台灣|\bTW\b|taiwan/i],
  ["JP", "日本", /日本|东京|大阪|\bJP\b|japan|tokyo|osaka/i],
  ["SG", "新加坡", /新加坡|狮城|\bSG\b|singapore/i],
  ["US", "美国", /美国|美國|洛杉矶|硅谷|纽约|\bUS\b|\bUSA\b|united states|america/i],
  ["KR", "韩国", /韩国|韓國|首尔|\bKR\b|korea|seoul/i],
  ["GB", "英国", /英国|英國|伦敦|\bUK\b|\bGB\b|britain|london/i],
  ["DE", "德国", /德国|德國|法兰克福|\bDE\b|germany|frankfurt/i],
  ["FR", "法国", /法国|法國|巴黎|\bFR\b|france|paris/i],
  ["NL", "荷兰", /荷兰|荷蘭|\bNL\b|netherlands|amsterdam/i],
  ["CA", "加拿大", /加拿大|\bCA\b|canada/i],
  ["AU", "澳大利亚", /澳大利亚|澳洲|悉尼|\bAU\b|australia|sydney/i],
  ["IN", "印度", /印度(?!尼)|\bIN\b|india/i],
  ["RU", "俄罗斯", /俄罗斯|俄羅斯|莫斯科|\bRU\b|russia|moscow/i],
  ["TR", "土耳其", /土耳其|\bTR\b|turkey/i],
  ["AR", "阿根廷", /阿根廷|\bAR\b|argentina/i],
  ["BR", "巴西", /巴西|\bBR\b|brazil/i],
  ["UA", "乌克兰", /乌克兰|\bUA\b|ukraine/i],
  ["TH", "泰国", /泰国|曼谷|\bTH\b|thailand/i],
  ["VN", "越南", /越南|\bVN\b|vietnam/i],
  ["MY", "马来西亚", /马来西亚|吉隆坡|\bMY\b|malaysia/i],
  ["PH", "菲律宾", /菲律宾|\bPH\b|philippines/i],
  ["ID", "印尼", /印尼|印度尼西亚|雅加达|\bID\b|indonesia/i],
  ["AE", "阿联酋", /阿联酋|迪拜|\bAE\b|dubai/i],
  ["IL", "以色列", /以色列|\bIL\b|israel/i],
  ["CN", "中国", /中国|中國|回国|\bCN\b|china/i],
];

const FLAG_PAIR = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;
const FLAG = /[\u{1F1E6}-\u{1F1FF}]{2}/u;
const MULTIPLIER = /^(?:x|×)\s*\d+(?:\.\d+)?$|^\d+(?:\.\d+)?\s*(?:x|×|倍)$/i;

function regionOfFlag(name: string): { code: string; label: string } | null {
  const match = FLAG.exec(name);
  if (!match) return null;
  const code = [...match[0]]
    .map((c) => String.fromCharCode(c.codePointAt(0)! - 0x1f1e6 + 65))
    .join("");
  const normalized = code === "UM" ? "US" : code;
  const known = REGIONS.find(([region]) => region === normalized);
  return { code: normalized, label: known?.[1] ?? normalized };
}

/** 内核的内置出站,没有地区,名称显示中文 */
const BUILTIN: Record<string, string> = {
  DIRECT: "直连",
  REJECT: "拦截",
  "REJECT-DROP": "拦截",
};

export function isBuiltin(name: string): boolean {
  return name.toUpperCase() in BUILTIN;
}

export interface NodeLabel {
  /** 地区标识,没有识别出来时为 null */
  code: string | null;
  region: string | null;
  /** 去掉旗帜和标签后的名称 */
  name: string;
  tags: string[];
}

export function nodeLabel(name: string): NodeLabel {
  if (isBuiltin(name)) {
    return { code: null, region: null, name: BUILTIN[name.toUpperCase()], tags: [] };
  }
  const stripped = name.replace(FLAG_PAIR, "").trim();
  const parts = stripped.split("|").map((p) => p.trim()).filter(Boolean);
  const text = REGIONS.find(([, , pattern]) => pattern.test(stripped));
  const region = text ? { code: text[0], label: text[1] } : regionOfFlag(name);
  return {
    code: region?.code ?? null,
    region: region?.label ?? null,
    name: parts[0] ?? stripped,
    tags: parts.slice(1),
  };
}

export function isMultiplier(tag: string): boolean {
  return MULTIPLIER.test(tag);
}

/** 策略组名里的旗帜同样显示不出来 */
export function groupLabel(name: string): string {
  return name.replace(FLAG_PAIR, "").trim();
}
