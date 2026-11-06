import { RuleProvider, RuleRun } from "./types";

/**
 * Clash 规则 → 有序的 sing-box 规则段。
 * 规则顺序决定匹配结果,所以只合并相邻、目标相同、类别相同的规则:
 * sing-box 同一条规则里 domain 和 ip_cidr 是「或」,但 port 等其他字段是「与」。
 */

export const BUILTIN_GEOIP: Record<string, string> = { cn: "geoip-cn" };
export const BUILTIN_GEOSITE: Record<string, string> = {
  cn: "geosite-cn",
  "category-ads-all": "geosite-category-ads-all",
  "geolocation-!cn": "geosite-not-cn",
};

type Match = Record<string, unknown>;

interface Condition {
  match: Match;
  /** 合并类别:相同才能并成一条 */
  category: string;
  resolve?: boolean;
}

export interface CompileResult {
  runs: RuleRun[];
  final: string | null;
  total: number;
  skipped: Record<string, number>;
}

class Skip extends Error {}

const CIDR = /^[0-9a-fA-F:.]+\/\d{1,3}$/;

function ports(value: string): Match {
  const port: number[] = [];
  const port_range: string[] = [];
  for (const part of value.split(/[/,]/)) {
    const [from, to] = part.split("-").map((p) => p.trim());
    if (to !== undefined) port_range.push(`${from}:${to}`);
    else if (/^\d+$/.test(from)) port.push(Number(from));
    else throw new Skip("端口格式无效");
  }
  const match: Match = {};
  if (port.length) match.port = port;
  if (port_range.length) match.port_range = port_range;
  return match;
}

function wildcardRegex(value: string): string {
  const body = value.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]+").replace(/\?/g, ".");
  return `^${body}$`;
}

function validRegex(value: string): string {
  try {
    new RegExp(value.replace(/^\(\?[a-z]+\)/, ""));
    return value;
  } catch {
    throw new Skip("正则无效");
  }
}

function condition(type: string, value: string, noResolve: boolean): Condition {
  const domain = (field: string, item: string): Condition => ({
    match: { [field]: [item] },
    category: "domain",
  });
  const ip = (cidr: string): Condition => {
    if (!CIDR.test(cidr)) throw new Skip("IP 段格式无效");
    return noResolve
      ? { match: { ip_cidr: [cidr] }, category: "ip" }
      : { match: { ip_cidr: [cidr] }, category: "ip-resolve", resolve: true };
  };
  switch (type) {
    case "DOMAIN":
      return domain("domain", value);
    case "DOMAIN-SUFFIX":
      return domain("domain_suffix", value);
    case "DOMAIN-KEYWORD":
      return domain("domain_keyword", value);
    case "DOMAIN-REGEX":
      return domain("domain_regex", validRegex(value));
    case "DOMAIN-WILDCARD":
      return domain("domain_regex", wildcardRegex(value));
    case "IP-CIDR":
    case "IP-CIDR6":
      return ip(value);
    case "SRC-IP-CIDR":
      if (!CIDR.test(value)) throw new Skip("IP 段格式无效");
      return { match: { source_ip_cidr: [value] }, category: "source-ip" };
    case "DST-PORT":
      return { match: ports(value), category: "port" };
    case "SRC-PORT": {
      const { port, port_range } = ports(value);
      return {
        match: { ...(port ? { source_port: port } : {}), ...(port_range ? { source_port_range: port_range } : {}) },
        category: "source-port",
      };
    }
    case "NETWORK":
      return { match: { network: [value.toLowerCase()] }, category: "network" };
    case "PROCESS-NAME":
      return { match: { process_name: [value] }, category: "process-name" };
    case "PROCESS-PATH":
      return { match: { process_path: [value] }, category: "process-path" };
    case "PROCESS-PATH-REGEX":
      return { match: { process_path_regex: [validRegex(value)] }, category: "process-regex" };
    case "GEOIP": {
      const name = value.toLowerCase();
      if (name === "lan" || name === "private") {
        return { match: { ip_is_private: true }, category: "private" };
      }
      const set = BUILTIN_GEOIP[name];
      if (!set) throw new Skip(`GEOIP ${value} 没有内置数据`);
      return noResolve
        ? { match: { rule_set: [set] }, category: "geoip" }
        : { match: { rule_set: [set] }, category: "geoip-resolve", resolve: true };
    }
    case "GEOSITE": {
      const set = BUILTIN_GEOSITE[value.toLowerCase()];
      if (!set) throw new Skip(`GEOSITE ${value} 没有内置数据`);
      return { match: { rule_set: [set] }, category: "geosite" };
    }
    default:
      throw new Skip(`不支持 ${type}`);
  }
}

/** 取 "((A,b),(C,d)),TARGET" 开头配平的括号段,返回内容和剩余部分 */
function takeParens(text: string): { body: string; rest: string } {
  if (text[0] !== "(") throw new Skip("逻辑规则格式无效");
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return { body: text.slice(1, i), rest: text.slice(i + 1) };
    }
  }
  throw new Skip("逻辑规则括号不配对");
}

/** "(A,b),(C,d)" → ["A,b", "C,d"] */
function splitTerms(body: string): string[] {
  const terms: string[] = [];
  let rest = body.trim();
  while (rest) {
    const { body: term, rest: after } = takeParens(rest);
    terms.push(term);
    rest = after.replace(/^\s*,\s*/, "");
  }
  return terms;
}

function logicalMatch(type: string, body: string): Match {
  const rules = splitTerms(body).map((term) => termMatch(term));
  if (!rules.length) throw new Skip("逻辑规则没有条件");
  if (type === "NOT") {
    return rules.length === 1
      ? { ...rules[0], invert: true }
      : { type: "logical", mode: "or", rules, invert: true };
  }
  return { type: "logical", mode: type.toLowerCase(), rules };
}

function termMatch(term: string): Match {
  const comma = term.indexOf(",");
  const type = term.slice(0, comma < 0 ? undefined : comma).trim().toUpperCase();
  const rest = comma < 0 ? "" : term.slice(comma + 1).trim();
  if (type === "AND" || type === "OR" || type === "NOT") {
    return logicalMatch(type, takeParens(rest).body);
  }
  const parts = rest.split(",").map((p) => p.trim());
  const noResolve = parts.includes("no-resolve");
  return condition(type, parts[0], noResolve).match;
}

function appendMatch(into: Match, match: Match) {
  for (const [field, value] of Object.entries(match)) {
    if (Array.isArray(value) && Array.isArray(into[field])) {
      (into[field] as unknown[]).push(...value);
    } else {
      into[field] = Array.isArray(value) ? [...value] : value;
    }
  }
}

/** 规则集文件的一条 → 规则文本(不含目标) */
function providerEntry(behavior: string, entry: string): [string, string] | null {
  const item = entry.trim();
  if (!item || item.startsWith("#")) return null;
  if (behavior === "ipcidr") return ["IP-CIDR", item];
  if (behavior === "domain") {
    if (item.startsWith("+.")) return ["DOMAIN-SUFFIX", item.slice(2)];
    if (item.startsWith(".")) return ["DOMAIN-SUFFIX", item];
    if (item.includes("*")) return ["DOMAIN-WILDCARD", item];
    return ["DOMAIN", item];
  }
  const comma = item.indexOf(",");
  if (comma < 0) return null;
  return [item.slice(0, comma).trim().toUpperCase(), item.slice(comma + 1).trim()];
}

class Compiler {
  runs: RuleRun[] = [];
  final: string | null = null;
  total = 0;
  skipped: Record<string, number> = {};
  private lastCategory = "";

  skip(reason: string, count = 1) {
    this.skipped[reason] = (this.skipped[reason] ?? 0) + count;
  }

  push(target: string, item: Condition) {
    this.total++;
    const last = this.runs[this.runs.length - 1];
    if (last && last.target === target && this.lastCategory === item.category && item.category) {
      appendMatch(last.match, item.match);
      last.count++;
      return;
    }
    const match: Match = {};
    appendMatch(match, item.match);
    this.runs.push({
      target,
      match,
      count: 1,
      ...(item.resolve ? { resolve: true } : {}),
    });
    this.lastCategory = item.category;
  }

  line(line: string, providers: Record<string, RuleProvider>) {
    const text = line.trim().replace(/^-\s*/, "").replace(/^['"]|['"]$/g, "");
    if (!text || text.startsWith("#")) return;
    const comma = text.indexOf(",");
    const type = (comma < 0 ? text : text.slice(0, comma)).trim().toUpperCase();
    const rest = comma < 0 ? "" : text.slice(comma + 1);
    try {
      if (type === "MATCH" || type === "FINAL") {
        this.final = rest.trim();
        this.total++;
        return;
      }
      if (type === "AND" || type === "OR" || type === "NOT") {
        const { body, rest: after } = takeParens(rest.trim());
        const target = after.replace(/^\s*,\s*/, "").split(",")[0].trim();
        if (!target) throw new Skip("规则格式无效");
        this.push(target, { match: logicalMatch(type, body), category: "" });
        return;
      }
      const parts = rest.split(",").map((p) => p.trim());
      if (parts.length < 2) throw new Skip("规则格式无效");
      const [value, target, ...options] = parts;
      const noResolve = options.includes("no-resolve");
      if (type === "RULE-SET") {
        this.ruleSet(value, target, noResolve, providers);
        return;
      }
      this.push(target, condition(type, value, noResolve));
    } catch (e) {
      if (!(e instanceof Skip)) throw e;
      this.skip(e.message);
    }
  }

  ruleSet(
    name: string,
    target: string,
    noResolve: boolean,
    providers: Record<string, RuleProvider>,
  ) {
    const provider = providers[name];
    if (!provider) throw new Skip(`规则集 ${name} 不可用`);
    for (const entry of provider.payload) {
      const parsed = providerEntry(provider.behavior, entry);
      if (!parsed) continue;
      const [type, rest] = parsed;
      const parts = rest.split(",").map((p) => p.trim());
      try {
        const unresolved = noResolve || parts.includes("no-resolve");
        this.push(target, condition(type, parts[0], unresolved));
      } catch (e) {
        if (!(e instanceof Skip)) throw e;
        this.skip(e.message);
      }
    }
  }
}

export function compileRules(
  lines: string[],
  providers: Record<string, RuleProvider> = {},
): CompileResult {
  const compiler = new Compiler();
  for (const line of lines) compiler.line(String(line), providers);
  return {
    runs: compiler.runs,
    final: compiler.final,
    total: compiler.total,
    skipped: compiler.skipped,
  };
}

/** 各目标命中的规则数,用来判断主策略组 */
export function ruleCounts(runs: RuleRun[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const run of runs) counts[run.target] = (counts[run.target] ?? 0) + run.count;
  return counts;
}
