import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { StatusHeader } from "./ui/StatusHeader";
import { SubscriptionBar } from "./ui/SubscriptionBar";
import { NodeList } from "./ui/NodeList";
import { ControlBar } from "./ui/ControlBar";
import { StatusLine } from "./ui/StatusLine";
import {
  useNodes,
  restoreNodes,
  replaceNodes,
  selectedNode,
  nodesStore,
} from "./store/nodes";
import {
  initConnectionEvents,
  connect,
  disconnect,
  connectionStore,
  logStatus,
  errText,
} from "./store/connection";
import { fetchSubscription } from "./api/subscription";

export default function App() {
  const { scanlines } = useNodes();

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    (async () => {
      await initConnectionEvents();

      // 启动:恢复本地状态 → 若有订阅链接,后台异步刷新(失败不影响旧列表)
      await restoreNodes();
      const url = nodesStore.get().subscriptionUrl.trim();
      if (url) {
        fetchSubscription(url)
          .then(({ nodes, errors }) => {
            if (disposed) return;
            replaceNodes(nodes);
            logStatus(
              `订阅已后台刷新 · 共 ${nodes.length} 个节点` +
                (errors.length ? ` · ${errors.length} 条解析失败` : ""),
            );
          })
          .catch((e) => {
            if (disposed) return;
            logStatus(`订阅后台刷新失败:${errText(e)}(使用本地旧列表)`);
          });
      }

      // 托盘菜单:启动 / 停止
      unlisteners.push(
        await listen("tray-start", () => {
          const node = selectedNode();
          if (!node) {
            logStatus("托盘启动:请先在列表中选择一个节点");
            return;
          }
          if (connectionStore.get().status !== "connecting") connect(node);
        }),
        await listen("tray-stop", () => {
          if (connectionStore.get().status === "on") disconnect();
        }),
      );
    })();

    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  return (
    <div className="device">
      <div className="bezel-label">
        <span className="brand">◈ LCD-PROXY</span>
        <span>MODEL&nbsp;VX-01 · MONO&nbsp;GREEN</span>
      </div>
      <div className={`screen${scanlines ? " scan" : ""}`}>
        <StatusHeader />
        <SubscriptionBar />
        <NodeList />
        <ControlBar />
        <StatusLine />
      </div>
    </div>
  );
}
