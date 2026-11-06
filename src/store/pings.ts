import { createStore, useStore } from "./createStore";

/** 数字=毫秒;"timeout"=超时/失败;undefined=未测 */
export type PingResult = number | "timeout" | undefined;

interface PingsState {
  pings: Record<string, PingResult>;
  testing: boolean;
  /** real=经节点访问测试网址;tcp=只测到服务器的连接 */
  method: "real" | "tcp" | null;
}

export const pingsStore = createStore<PingsState>({ pings: {}, testing: false, method: null });
export const usePings = () => useStore(pingsStore);

export function setPing(id: string, result: PingResult) {
  pingsStore.set((s) => ({ pings: { ...s.pings, [id]: result } }));
}
