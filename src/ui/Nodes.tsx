import { useMemo, useState } from "react";
import { Node, unsupportedReason } from "../parser/types";
import { chooseNode, testDelays, useConnection } from "../store/connection";
import { PingResult, usePings } from "../store/pings";
import { allNodes, deleteNode, LOCAL_ID, useProfiles } from "../store/profiles";
import { useSettings } from "../store/settings";
import { NodeName } from "./Badges";
import { Empty, PageHeader } from "./controls";
import { BoltIcon, SearchIcon, TrashIcon } from "./icons";
import { Page } from "./pages";
import { nodeLabel } from "./region";

const PROTOCOL_NAME: Record<string, string> = {
  vless: "VLESS",
  vmess: "VMess",
  trojan: "Trojan",
  shadowsocks: "SS",
  shadowsocksr: "SSR",
  hysteria: "Hysteria",
  hysteria2: "Hy2",
  tuic: "TUIC",
  anytls: "AnyTLS",
  socks: "SOCKS",
  http: "HTTP",
};

function Latency({ value }: { value: PingResult }) {
  if (value === undefined) return <span className="latency">–</span>;
  if (value === "timeout") return <span className="latency bad">超时</span>;
  const level = value < 200 ? "good" : value < 500 ? "fair" : "bad";
  return <span className={`latency ${level}`}>{value} ms</span>;
}

type Sort = "default" | "latency";

export function Nodes({ go }: { go: (page: Page) => void }) {
  const { nodes: byProfile, profiles } = useProfiles();
  const { selected, activeRules } = useSettings();
  const { pings, testing, method } = usePings();
  const { status } = useConnection();
  const [query, setQuery] = useState("");
  const [region, setRegion] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("default");

  const nodes = useMemo(() => allNodes(), [byProfile, profiles, activeRules]);
  const local = useMemo(() => new Set((byProfile[LOCAL_ID] ?? []).map((n) => n.id)), [byProfile]);

  // 同名节点来自不同配置时标出来源,否则分不清
  const sources = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of nodes) counts.set(node.name, (counts.get(node.name) ?? 0) + 1);
    const result = new Map<string, string>();
    for (const profile of profiles) {
      for (const node of byProfile[profile.id] ?? []) {
        if (counts.get(node.name)! > 1) result.set(node.id, profile.name);
      }
    }
    return result;
  }, [nodes, profiles, byProfile]);

  const regions = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const node of nodes) {
      const { code, region: label } = nodeLabel(node.name);
      if (!code) continue;
      const entry = counts.get(code) ?? { label: label ?? code, count: 0 };
      entry.count++;
      counts.set(code, entry);
    }
    return [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [nodes]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = nodes.filter((node) => {
      if (region && nodeLabel(node.name).code !== region) return false;
      return !needle || node.name.toLowerCase().includes(needle);
    });
    if (sort === "default") return filtered;
    const rank = (node: Node) => {
      const value = pings[node.id];
      if (typeof value === "number") return value;
      return value === "timeout" ? 1e7 : 1e8;
    };
    return [...filtered].sort((a, b) => rank(a) - rank(b));
  }, [nodes, query, region, sort, pings]);

  if (!nodes.length) {
    return (
      <div className="page">
        <PageHeader title="节点" />
        <Empty title="还没有节点">
          <button className="btn btn-primary" onClick={() => go("profiles")}>
            添加订阅
          </button>
        </Empty>
      </div>
    );
  }

  return (
    <div className="page page-list">
      <PageHeader title="节点">
        <label className="search">
          <SearchIcon />
          <input
            value={query}
            placeholder="搜索"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button
          className="btn"
          onClick={() => setSort(sort === "latency" ? "default" : "latency")}
          aria-pressed={sort === "latency"}
        >
          {sort === "latency" ? "按延迟" : "默认排序"}
        </button>
        <button className="btn" disabled={testing} onClick={() => void testDelays()}>
          <BoltIcon />
          {testing ? "测速中" : "测速"}
        </button>
      </PageHeader>

      <div className="chips">
        <button className={region ? "chip" : "chip on"} onClick={() => setRegion(null)}>
          全部 {nodes.length}
        </button>
        {regions.map(([code, { label, count }]) => (
          <button
            key={code}
            className={region === code ? "chip on" : "chip"}
            onClick={() => setRegion(region === code ? null : code)}
          >
            {label} {count}
          </button>
        ))}
      </div>

      {method === "tcp" && status !== "on" && (
        <div className="list-note">未连接时只测到服务器的连接,连上后测的才是实际延迟</div>
      )}

      <ul className="node-list">
        {shown.map((node) => {
          const reason = unsupportedReason(node);
          const current = node.id === selected;
          return (
            <li key={node.id} className={current ? "node on" : "node"}>
              <button
                className="node-main"
                disabled={!!reason}
                title={reason}
                onClick={() => void chooseNode(node.id)}
              >
                <NodeName name={node.name} />
                {sources.has(node.id) && (
                  <span className="node-source">{sources.get(node.id)}</span>
                )}
                <span className="node-protocol">
                  {reason ? "不可用" : PROTOCOL_NAME[node.protocol] ?? node.protocol}
                </span>
                <Latency value={pings[node.id]} />
              </button>
              {local.has(node.id) && (
                <button
                  className="icon-btn node-delete"
                  title="删除节点"
                  aria-label={`删除 ${node.name}`}
                  onClick={() => deleteNode(node.id)}
                >
                  <TrashIcon />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {!shown.length && <div className="list-note">没有符合条件的节点</div>}
    </div>
  );
}
