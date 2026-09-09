import { Node } from "../parser/types";
import { createStore, useStore } from "./createStore";
import { loadState, saveState, tcpPing } from "../api/backend";

/** ping 结果:数字=毫秒;"timeout"=超时/失败;undefined=未测 */
export type PingResult = number | "timeout" | undefined;

export type Theme = "dark" | "light";

export interface NodesState {
  subscriptionUrl: string;
  nodes: Node[];
  selectedId: string | null;
  theme: Theme; // 深色(默认)/ 浅色
  tunMode: boolean; // TUN 模式(预留)
  pings: Record<string, PingResult>; // 不持久化
  loaded: boolean;
}

/** 持久化到本地 JSON 的字段子集 */
interface PersistShape {
  subscriptionUrl: string;
  nodes: Node[];
  selectedId: string | null;
  theme: Theme;
  tunMode: boolean;
}

export const nodesStore = createStore<NodesState>({
  subscriptionUrl: "",
  nodes: [],
  selectedId: null,
  theme: "dark",
  tunMode: false,
  pings: {},
  loaded: false,
});

/** 把主题写到根元素,CSS 变量随之切换 */
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

export const useNodes = () => useStore(nodesStore);

// ---- 持久化 ----
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function snapshot(): string {
  const s = nodesStore.get();
  const data: PersistShape = {
    subscriptionUrl: s.subscriptionUrl,
    nodes: s.nodes,
    selectedId: s.selectedId,
    theme: s.theme,
    tunMode: s.tunMode,
  };
  return JSON.stringify(data, null, 2);
}

/** 防抖写盘(常规操作用) */
function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveState(snapshot()).catch((e) => console.error("保存状态失败:", e));
  }, 400);
}

/** 立即写盘并等待完成(提权重启前必须用它,防止防抖未刷新就退出) */
export async function saveNow(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await saveState(snapshot());
}

/** 启动时从本地 JSON 恢复 */
export async function restoreNodes(): Promise<void> {
  try {
    const json = await loadState();
    if (json) {
      const data = JSON.parse(json) as Partial<PersistShape>;
      nodesStore.set({
        subscriptionUrl: data.subscriptionUrl ?? "",
        nodes: Array.isArray(data.nodes) ? data.nodes : [],
        selectedId: data.selectedId ?? null,
        theme: data.theme === "light" ? "light" : "dark",
        tunMode: data.tunMode ?? false,
      });
    }
    applyTheme(nodesStore.get().theme);
  } catch (e) {
    console.error("读取本地状态失败:", e);
  } finally {
    nodesStore.set({ loaded: true });
  }
}

// ---- 操作 ----

export function setSubscriptionUrl(url: string) {
  nodesStore.set({ subscriptionUrl: url });
  persist();
}

/** 覆盖节点列表(订阅刷新):保留仍存在节点的选中态 */
export function replaceNodes(nodes: Node[]) {
  const { selectedId } = nodesStore.get();
  const stillThere = nodes.some((n) => n.id === selectedId);
  nodesStore.set({ nodes, selectedId: stillThere ? selectedId : null });
  persist();
}

/** 追加节点(手动导入):按 id 去重 */
export function addNodes(newNodes: Node[]): number {
  const { nodes } = nodesStore.get();
  const existing = new Set(nodes.map((n) => n.id));
  const fresh = newNodes.filter((n) => !existing.has(n.id));
  if (fresh.length) {
    nodesStore.set({ nodes: [...nodes, ...fresh] });
    persist();
  }
  return fresh.length;
}

export function selectNode(id: string) {
  nodesStore.set({ selectedId: id });
  persist();
}

export function toggleTheme() {
  const next: Theme = nodesStore.get().theme === "dark" ? "light" : "dark";
  nodesStore.set({ theme: next });
  applyTheme(next);
  persist();
}

/** 设置 TUN 标志并立即落盘(供提权流程在重启前调用) */
export async function setTunMode(on: boolean): Promise<void> {
  nodesStore.set({ tunMode: on });
  await saveNow();
}

export function selectedNode(): Node | null {
  const { nodes, selectedId } = nodesStore.get();
  return nodes.find((n) => n.id === selectedId) ?? null;
}

// ---- 延迟测速:对全部节点做 TCP 连接测时,限制并发 ----
let pinging = false;

export async function pingAllNodes(concurrency = 6): Promise<void> {
  if (pinging) return;
  pinging = true;
  try {
    const nodes = [...nodesStore.get().nodes];
    // 置为测试中(undefined 显示 "---")
    nodesStore.set({ pings: {} });
    const queue = [...nodes];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) {
        const node = queue.shift()!;
        let result: PingResult;
        try {
          result = await tcpPing(node.server, node.port, 3000);
        } catch {
          result = "timeout";
        }
        nodesStore.set((s) => ({ pings: { ...s.pings, [node.id]: result } }));
      }
    });
    await Promise.all(workers);
  } finally {
    pinging = false;
  }
}
