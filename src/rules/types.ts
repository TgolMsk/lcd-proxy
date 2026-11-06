/** 一段连续、目标相同、可合并成一条 sing-box 规则的 Clash 规则 */
export interface RuleRun {
  /** Clash 目标名:策略组、节点、DIRECT、REJECT */
  target: string;
  /** sing-box 规则的匹配字段 */
  match: Record<string, unknown>;
  /** 合并进来的原始规则条数 */
  count: number;
  /** 匹配 IP 前要先解析域名(Clash 没写 no-resolve 的 IP 规则) */
  resolve?: boolean;
}

export type GroupType = "select" | "url-test" | "fallback" | "load-balance";

export interface ProxyGroup {
  name: string;
  type: GroupType;
  /** 成员名:节点、策略组、DIRECT、REJECT */
  members: string[];
  url?: string;
  /** 测速间隔,秒 */
  interval?: number;
  tolerance?: number;
}

/** 订阅带来的路由:策略组 + 编译好的规则 */
export interface RuleBundle {
  groups: ProxyGroup[];
  /** 主策略组,映射到内核的 proxy 选择器 */
  primary: string | null;
  runs: RuleRun[];
  /** MATCH 规则的目标 */
  final: string | null;
  /** 导入的规则总数(不含跳过的) */
  total: number;
  /** 跳过的规则:原因 → 条数 */
  skipped: Record<string, number>;
}

export interface RuleProvider {
  behavior: string;
  format?: string;
  /** 规则文件的条目 */
  payload: string[];
}
