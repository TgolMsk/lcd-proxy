import { kernelLogs } from "../api/backend";
import { createStore, useStore } from "./createStore";

const CAP = 1000;

export const logsStore = createStore<{ lines: string[] }>({ lines: [] });
export const useLogs = () => useStore(logsStore);

export function pushLog(line: string) {
  logsStore.set((s) => ({ lines: [...s.lines.slice(-(CAP - 1)), line] }));
}

export function clearLogs() {
  logsStore.set({ lines: [] });
}

/** 打开日志页时同步后端缓冲,防止错过页面加载前的输出 */
export async function syncLogs() {
  logsStore.set({ lines: await kernelLogs() });
}
