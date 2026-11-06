import yaml from "js-yaml";
import { compileRules } from "../rules/compile";
import { GroupType, ProxyGroup, RuleBundle, RuleProvider } from "../rules/types";
import { clashProxyToNode, ClashProxy } from "./outbound";
import { Node } from "./types";

/**
 * Clash / mihomo 订阅解析。
 * 只用字符串 schema:YAML 默认会把 0123、1e5、on 这类密码和节点名改成数字或布尔。
 */
const SCHEMA = yaml.FAILSAFE_SCHEMA.extend({
  implicit: [(yaml as unknown as { types: { merge: yaml.Type } }).types.merge],
});

export type Fetcher = (url: string) => Promise<string>;

export interface ParsedClash {
  nodes: Node[];
  errors: string[];
  rules: RuleBundle;
}

const CLASH_KEYS = /^(proxies|proxy-groups|proxy-providers|rule-providers|rules):/m;

export function looksLikeClash(text: string): boolean {
  return CLASH_KEYS.test(text);
}

function parseYaml(text: string): Record<string, any> {
  const doc = yaml.load(text, { schema: SCHEMA, json: true });
  if (!doc || typeof doc !== "object") throw new Error("不是有效的 YAML 配置");
  return doc as Record<string, any>;
}

function asList(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

function nodesFromProxies(proxies: ClashProxy[], errors: string[]): Node[] {
  const nodes: Node[] = [];
  for (const proxy of proxies) {
    try {
      nodes.push(clashProxyToNode(proxy));
    } catch (e) {
      errors.push(`${proxy?.name ?? "未命名节点"} → ${(e as Error).message}`);
    }
  }
  return nodes;
}

function compilePattern(pattern: string): RegExp {
  const flags = /^\(\?i\)/.test(pattern) ? "iu" : "u";
  return new RegExp(pattern.replace(/^\(\?i\)/, ""), flags);
}

/** Clash 的 filter:可用反引号分隔多个正则,任一命中即保留。写法不兼容时不过滤。 */
function filterNames(names: string[], filter?: string, exclude?: string): string[] {
  let result = names;
  try {
    if (filter) {
      const patterns = filter.split("`").map(compilePattern);
      result = result.filter((name) => patterns.some((p) => p.test(name)));
    }
    if (exclude) {
      const patterns = exclude.split("`").map(compilePattern);
      result = result.filter((name) => !patterns.some((p) => p.test(name)));
    }
  } catch {
    return names;
  }
  return result;
}

interface ProviderNodes {
  [provider: string]: Node[];
}

const GROUP_TYPES: Record<string, GroupType> = {
  select: "select",
  "url-test": "url-test",
  fallback: "fallback",
  "load-balance": "load-balance",
};

const DIRECT_GROUP = /(?<!非)(直连|国内|中国$)|direct|domestic/i;

/** 这类组本来就给国内流量用。有的配置中心导出时把节点排在首项,默认值改回直连 */
function directFirst(name: string, members: string[]): string[] {
  const index = members.findIndex((m) => m.toUpperCase() === "DIRECT");
  if (index <= 0 || !DIRECT_GROUP.test(name)) return members;
  return [members[index], ...members.slice(0, index), ...members.slice(index + 1)];
}

function buildGroups(
  raw: any[],
  ownNodes: Node[],
  providerNodes: ProviderNodes,
  skipped: Record<string, number>,
): ProxyGroup[] {
  const groups: ProxyGroup[] = [];
  for (const group of raw) {
    const type = GROUP_TYPES[String(group.type).toLowerCase()];
    if (!type) {
      skipped[`不支持 ${group.type} 策略组`] = (skipped[`不支持 ${group.type} 策略组`] ?? 0) + 1;
      continue;
    }
    let candidates: string[] = [];
    if (group["include-all"] === "true" || group["include-all-proxies"] === "true") {
      candidates.push(...ownNodes.map((n) => n.name));
    }
    if (group["include-all"] === "true" || group["include-all-providers"] === "true") {
      candidates.push(...Object.values(providerNodes).flat().map((n) => n.name));
    }
    for (const provider of asList(group.use)) {
      candidates.push(...(providerNodes[provider] ?? []).map((n) => n.name));
    }
    candidates = filterNames(candidates, group.filter, group["exclude-filter"]);
    const explicit = asList(group.proxies).map(String);
    const members = [...new Set([...explicit, ...candidates])];
    groups.push({
      name: String(group.name),
      type,
      members: type === "select" ? directFirst(String(group.name), members) : members,
      url: group.url,
      interval: group.interval ? Number(group.interval) : undefined,
      tolerance: group.tolerance ? Number(group.tolerance) : undefined,
    });
  }
  return groups;
}

/**
 * 主策略组:兜底流量走的组,节点页的选择落在这里。
 * 从 MATCH 的目标沿每组的默认成员往下走,取路上最后一个含节点的 select 组。
 * 规则数量说明不了什么:AI、流媒体这类细分组的规则往往比兜底组还多。
 */
function primaryGroup(
  groups: ProxyGroup[],
  nodeNames: Set<string>,
  final: string | null,
): string | null {
  const usable = groups.filter((g) => g.members.some((m) => nodeNames.has(m)));
  const proxied = (g: ProxyGroup) => !/^(DIRECT|REJECT)/i.test(g.members[0] ?? "");
  const byName = new Map(groups.map((g) => [g.name, g]));
  const seen = new Set<string>();
  let found: ProxyGroup | undefined;
  for (let g = byName.get(final ?? ""); g && !seen.has(g.name); g = byName.get(g.members[0])) {
    seen.add(g.name);
    if (g.type === "select" && proxied(g) && usable.includes(g)) found = g;
  }
  found ??= usable.find((g) => g.type === "select" && proxied(g)) ?? usable.find(proxied);
  return (found ?? usable[0])?.name ?? null;
}

function parseProviderBody(text: string, provider: Record<string, any>): string[] {
  const format = String(provider.format ?? "yaml").toLowerCase();
  if (format === "mrs") throw new Error("不支持 mrs 格式");
  if (format === "text") return text.split(/\r?\n/);
  const doc = parseYaml(text);
  return asList(doc.payload).map(String);
}

async function fetchRuleProviders(
  raw: Record<string, any>,
  fetcher: Fetcher,
  errors: string[],
): Promise<Record<string, RuleProvider>> {
  const providers: Record<string, RuleProvider> = {};
  const entries = Object.entries(raw);
  const queue = [...entries];
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) {
      const [name, provider] = queue.shift()!;
      try {
        const payload = provider.payload
          ? asList(provider.payload).map(String)
          : parseProviderBody(await fetcher(String(provider.url)), provider);
        providers[name] = {
          behavior: String(provider.behavior ?? "classical").toLowerCase(),
          format: provider.format,
          payload,
        };
      } catch (e) {
        errors.push(`规则集 ${name} → ${(e as Error).message}`);
      }
    }
  });
  await Promise.all(workers);
  return providers;
}

async function fetchProxyProviders(
  raw: Record<string, any>,
  fetcher: Fetcher,
  parseList: (text: string) => Node[],
  errors: string[],
): Promise<ProviderNodes> {
  const result: ProviderNodes = {};
  for (const [name, provider] of Object.entries(raw)) {
    try {
      const text = await fetcher(String(provider.url));
      const nodes = looksLikeClash(text)
        ? nodesFromProxies(asList(parseYaml(text).proxies), errors)
        : parseList(text);
      const kept = new Set(
        filterNames(nodes.map((n) => n.name), provider.filter, provider["exclude-filter"]),
      );
      result[name] = nodes.filter((n) => kept.has(n.name));
    } catch (e) {
      errors.push(`节点集 ${name} → ${(e as Error).message}`);
    }
  }
  return result;
}

export async function parseClash(
  text: string,
  fetcher: Fetcher,
  parseList: (text: string) => Node[],
): Promise<ParsedClash> {
  const doc = parseYaml(text);
  const errors: string[] = [];

  const ownNodes = nodesFromProxies(asList(doc.proxies), errors);
  const providerNodes = await fetchProxyProviders(
    doc["proxy-providers"] ?? {},
    fetcher,
    parseList,
    errors,
  );
  const ruleProviders = await fetchRuleProviders(doc["rule-providers"] ?? {}, fetcher, errors);

  const seen = new Set<string>();
  const nodes = [...ownNodes, ...Object.values(providerNodes).flat()].filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });

  const compiled = compileRules(asList(doc.rules).map(String), ruleProviders);
  const groups = buildGroups(asList(doc["proxy-groups"]), ownNodes, providerNodes, compiled.skipped);
  const primary = primaryGroup(groups, new Set(nodes.map((n) => n.name)), compiled.final);

  return {
    nodes,
    errors,
    rules: {
      groups,
      primary,
      runs: compiled.runs,
      final: compiled.final,
      total: compiled.total,
      skipped: compiled.skipped,
    },
  };
}
