import { listen } from "@tauri-apps/api/event";
import { Node } from "../parser/types";
import { buildSingBoxConfig, PROXY_SERVER } from "../config/singbox";
import {
  startKernel,
  stopKernel,
  setSystemProxy,
  tcpPing,
  isElevated,
  relaunchAsAdmin,
} from "../api/backend";
import { createStore, useStore } from "./createStore";
import { nodesStore, setTunMode } from "./nodes";

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

/** 确保 TUN 所需管理员权限;不足则以管理员重启(成功后进程退出),用户取消则抛错 */
async function ensureTunElevation(): Promise<void> {
  if (await isElevated()) return;
  logStatus("TUN 模式需要管理员权限,正在以管理员身份重启 …");
  await relaunchAsAdmin(); // 成功:进程退出;取消:抛错
}

/**
 * 切换 TUN 模式(UI 开关调用)。
 * 开启:先落盘,再检查/申请管理员权限(未提权则以管理员重启当前进程);
 * 关闭:落盘即可。若当前在线,用新模式重连当前节点。
 */
export async function toggleTun(): Promise<void> {
  const turningOn = !nodesStore.get().tunMode;
  const { status, activeNodeId } = connectionStore.get();
  const wasOnline = status === "on";

  // 开启且可能触发提权重启:先干净断开(清系统代理+杀内核),
  // 让当前实例可安全硬退出,不留残留代理
  if (turningOn && wasOnline) await disconnect();

  await setTunMode(turningOn); // 立即落盘,保证提权重启后状态保留

  if (turningOn) {
    try {
      await ensureTunElevation(); // 若需提权:进程在此退出,不再往下
    } catch (e) {
      await setTunMode(false); // 用户取消 UAC → 回退
      logStatus(`未开启 TUN:${errText(e)}`);
      return;
    }
    logStatus("TUN 模式已开启");
  } else {
    logStatus("TUN 模式已关闭");
  }

  // 已提权(或非 Windows / 关闭)且之前在线 → 用新模式重连当前节点
  if (wasOnline && activeNodeId) {
    const node = nodesStore.get().nodes.find((n) => n.id === activeNodeId);
    if (node) await connect(node);
  }
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
    // TUN 需要管理员权限:不足则发起提权重启(成功则进程退出,不再往下走)
    if (tun) await ensureTunElevation();

    const config = buildSingBoxConfig(node, { tun });
    await startKernel(JSON.stringify(config, null, 2));

    if (tun) {
      // TUN 在网络层接管全局流量,不走系统代理;清掉可能残留的系统代理
      await setSystemProxy(false, PROXY_SERVER).catch(() => {});
    } else {
      await setSystemProxy(true, PROXY_SERVER);
    }

    connectionStore.set({
      status: "on",
      activeNodeId: node.id,
      message: tun
        ? `TUN 模式已生效 · 全局流量 › ${node.name}`
        : `系统代理已生效 · ${PROXY_SERVER} › ${node.name}`,
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
