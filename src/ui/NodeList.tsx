import { useNodes, selectNode, PingResult } from "../store/nodes";
import { useConnection } from "../store/connection";

function pingDisplay(p: PingResult): { text: string; cls: string } {
  if (p === undefined) return { text: "---", cls: "pending" };
  if (p === "timeout") return { text: "---", cls: "bad" };
  if (p > 180) return { text: String(p).padStart(3, "0"), cls: "bad" };
  return { text: String(p).padStart(3, "0"), cls: "" };
}

const PROTO_SHORT: Record<string, string> = {
  vless: "vless",
  shadowsocks: "ss",
  shadowsocksr: "ssr",
};

/**
 * 节点列表。
 * 点击行 = 选中(高亮),不立即连接;按「启动」才生效(两步交互)。
 * ◆ 标记当前实际生效的节点。
 */
export function NodeList() {
  const { nodes, selectedId, pings } = useNodes();
  const { activeNodeId } = useConnection();

  if (!nodes.length) {
    return (
      <div className="list">
        <div className="empty">
          NO&nbsp;DATA
          <br />
          粘贴订阅链接后点「刷新」,或点「导入」粘贴分享链接
        </div>
      </div>
    );
  }

  return (
    <div className="list">
      {nodes.map((n) => {
        const sel = n.id === selectedId;
        const active = n.id === activeNodeId;
        const ping = pingDisplay(pings[n.id]);
        return (
          <div
            key={n.id}
            className={`row${sel ? " sel" : ""}${active ? " active" : ""}`}
            onClick={() => selectNode(n.id)}
            title={`${n.server}:${n.port}`}
          >
            <span className="mark">{sel ? "▸" : "·"}</span>
            <span className="name">{n.name}</span>
            <span className="proto">{PROTO_SHORT[n.protocol]}</span>
            <span className={`ping ${ping.cls}`}>{ping.text}</span>
          </div>
        );
      })}
    </div>
  );
}
