import { useNodes, selectedNode } from "../store/nodes";
import { useConnection, connect, disconnect, logStatus } from "../store/connection";

/**
 * 底部控制区:启动 / 停止大按钮。
 * 已连接时选了另一个节点 → 按钮变「切换」,点击自动杀旧内核连新节点。
 */
export function ControlBar() {
  const { selectedId } = useNodes();
  const conn = useConnection();

  const busy = conn.status === "connecting";
  const online = conn.status === "on";
  const switching = online && selectedId !== null && selectedId !== conn.activeNodeId;

  const startLabel = busy ? "连接中…" : switching ? "切换节点" : "启动";
  const startDisabled = busy || selectedId === null || (online && !switching);

  async function onStart() {
    const node = selectedNode();
    if (!node) {
      logStatus("请先在列表中选择一个节点");
      return;
    }
    await connect(node);
  }

  return (
    <div className="control">
      <button className="btn btn-start" onClick={onStart} disabled={startDisabled}>
        {startLabel}
      </button>
      <button
        className="btn btn-stop"
        onClick={disconnect}
        disabled={busy || conn.status === "off" || conn.status === "fault"}
      >
        停止
      </button>
    </div>
  );
}
