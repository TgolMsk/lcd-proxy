import { LogLevel, ProxyMode, PROXY_PORT, TunStack } from "../config/singbox";
import { createStore, useStore } from "./createStore";
import { flushWrites, queueWrite } from "./persist";

export type Theme = "system" | "light" | "dark";

export interface Settings {
  version: 2;
  theme: Theme;
  mode: ProxyMode;
  tun: boolean;
  ipv6: boolean;
  stack: TunStack;
  port: number;
  logLevel: LogLevel;
  /** TUN 模式下解析直连域名和节点地址的 DNS */
  directDns: string;
  /** 当前节点 id */
  selected: string | null;
  /** 规则来源的配置 id;null 表示内置规则 */
  activeRules: string | null;
  /** 策略组选择:组名 → 成员名 */
  groupChoices: Record<string, string>;
  /** 优先于订阅规则的自定义规则,Clash 格式 */
  customRules: string[];
  /** 订阅规则没有国内分流时,补上国内直连 */
  cnDirect: boolean;
  /** 启动后自动连接 */
  autoConnect: boolean;
  /** 提权重启前处于连接流程,重启后接着连 */
  resumeAfterElevate: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 2,
  theme: "system",
  mode: "rule",
  tun: false,
  ipv6: false,
  stack: "gvisor",
  port: PROXY_PORT,
  logLevel: "warn",
  directDns: "223.5.5.5",
  selected: null,
  activeRules: null,
  groupChoices: {},
  customRules: [],
  cnDirect: true,
  autoConnect: false,
  resumeAfterElevate: false,
};

export const settingsStore = createStore<Settings>(DEFAULT_SETTINGS);
export const useSettings = () => useStore(settingsStore);

function serialize(): string {
  return JSON.stringify(settingsStore.get(), null, 2);
}

export function updateSettings(patch: Partial<Settings>) {
  settingsStore.set(patch);
  queueWrite("settings.json", serialize);
}

/** 写盘后才返回:提权重启会直接结束进程,防抖中的写入来不及执行 */
export async function saveSettingsNow(patch: Partial<Settings>): Promise<void> {
  updateSettings(patch);
  await flushWrites();
}

/** 把主题写到根元素,CSS 变量随之切换 */
export function applyTheme(theme: Theme) {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}
