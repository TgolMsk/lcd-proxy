import { listen } from "@tauri-apps/api/event";
import { Node } from "../parser/types";
import { buildSingBoxConfig, PROXY_SERVER } from "../config/singbox";
import { startKernel, stopKernel, setSystemProxy, tcpPing } from "../api/backend";
import { createStore, useStore } from "./createStore";
import { nodesStore } from "./nodes";

/** off=待机 connecting=连接中 on=已连接 fault=失败 */
export type ConnStatus = "off" | "connecting" | "on" | "fault";

export interface ConnectionState {
  status: ConnStatus;
  activeNodeId: string | null; // 当前生效的节点
  latency: number | null; // 顶栏数码管显示的延迟
  message: string; // 状态行提示文字
}

export const connectionStore = createStore<ConnectionState>({
  status: "off",
  activeNodeId: null,
  latency: null,
  message: "就绪。选择一个节点后按「启动」",
});

export const useConnection = () => useStore(connectionStore);

export function logStatus(message: string) {
  connectionStore.set({ message });
}

/**
 * 启动 / 切换连接:
 * 生成配置 → 拉起内核(Rust 侧自动杀旧进程)→ 设系统代理 → ONLINE。
 * 任一步失败:回收内核与系统代理,状态置 fault,给出可读错误。
 */
export async function connect(node: Node): Promise<void> {
  const { status } = connectionStore.get();
  if (status === "connecting") return;

  const switching = status === "on";
  connectionStore.set({
    status: "connecting",
    latency: null,
    message: switching
      ? `切换节点 › ${node.name} … 重启内核`
      : `正在拉起内核 sing-box … 连接 ${node.name}`,
  });

  try {
    const tun = nodesStore.get().tunMode;
    const config = buildSingBoxConfig(node, { tun });
    await startKernel(JSON.stringify(config, null, 2));
    await setSystemProxy(true, PROXY_SERVER);
    connectionStore.set({
      status: "on",
      activeNodeId: node.id,
      message: `系统代理已生效 · ${PROXY_SERVER} › ${node.name}`,
    });
    measureLatency(node);
  } catch (e) {
    // 清理半成品状态,避免留下坏代理导致断网
    await Promise.allSettled([setSystemProxy(false, PROXY_SERVER), stopKernel()]);
    connectionStore.set({
      status: "fault",
      activeNodeId: null,
      latency: null,
      message: `启动失败:${errText(e)}`,
    });
  }
}

/** 停止:清系统代理 → 杀内核 */
export async function disconnect(): Promise<void> {
  connectionStore.set({ status: "connecting", message: "正在断开 …" });
  const results = await Promise.allSettled([
    setSystemProxy(false, PROXY_SERVER),
    stopKernel(),
  ]);
  const failed = results.filter((r) => r.status === "rejected");
  connectionStore.set({
    status: "off",
    activeNodeId: null,
    latency: null,
    message: failed.length
      ? `已断开(部分清理失败:${errText((failed[0] as PromiseRejectedResult).reason)})`
      : "已断开 · 内核进程已停止,系统代理已清除",
  });
}

/** 连上后测一次到节点的 TCP 延迟,更新顶栏数码管 */
async function measureLatency(node: Node) {
  try {
    const ms = await tcpPing(node.server, node.port, 3000);
    const s = connectionStore.get();
    if (s.status === "on" && s.activeNodeId === node.id) {
      connectionStore.set({ latency: ms });
      nodesStore.set((ns) => ({ pings: { ...ns.pings, [node.id]: ms } }));
    }
  } catch {
    /* 测速失败不影响连接状态 */
  }
}

/** 监听 Rust 侧事件:内核意外退出 / 内核日志 */
export async function initConnectionEvents(): Promise<void> {
  await listen<{ code: number | null; lastLog: string }>("kernel-exit", (ev) => {
    const s = connectionStore.get();
    if (s.status === "on" || s.status === "connecting") {
      connectionStore.set({
        status: "fault",
        activeNodeId: null,
        latency: null,
        message: `内核意外退出(code=${ev.payload.code ?? "?"})${
          ev.payload.lastLog ? " · " + ev.payload.lastLog : ""
        }`,
      });
    }
  });
  await listen<string>("kernel-log", (ev) => {
    console.log("[sing-box]", ev.payload);
  });
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
