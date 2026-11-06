import { useEffect, useState } from "react";
import { selectedNode, useProfiles } from "../store/profiles";
import {
  connect,
  disconnect,
  checkHealth,
  setMode,
  setTun,
  useConnection,
} from "../store/connection";
import { useSettings } from "../store/settings";
import { useTraffic } from "../store/traffic";
import { ProxyMode } from "../config/singbox";
import { NodeName } from "./Badges";
import { Row, Segmented } from "./controls";
import { formatBytes, formatDate, formatDuration, formatSpeed } from "./format";
import { Page } from "./pages";

const MODES = [
  { value: "rule" as ProxyMode, label: "规则" },
  { value: "global" as ProxyMode, label: "全局" },
];

const CAPTURES = [
  { value: "proxy", label: "系统代理" },
  { value: "tun", label: "TUN" },
];

function chartPath(values: number[], max: number, width: number, height: number) {
  if (values.length < 2) return "";
  const step = width / 59;
  const start = width - (values.length - 1) * step;
  return values
    .map((value, i) => {
      const x = start + i * step;
      const y = height - (value / max) * (height - 4);
      return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

function TrafficChart() {
  const { down, up, totalDown, totalUp, downHistory, upHistory } = useTraffic();
  const max = Math.max(64 * 1024, ...downHistory, ...upHistory);
  const width = 600;
  const height = 96;
  const downLine = chartPath(downHistory, max, width, height);
  const upLine = chartPath(upHistory, max, width, height);
  const area = downLine ? `${downLine} L${width} ${height} L${width - (downHistory.length - 1) * (width / 59)} ${height} Z` : "";
  return (
    <section className="panel traffic">
      <div className="traffic-numbers">
        <div>
          <div className="stat-label">下行</div>
          <div className="stat-value">{formatSpeed(down)}</div>
          <div className="stat-sub">本次 {formatBytes(totalDown)}</div>
        </div>
        <div>
          <div className="stat-label">上行</div>
          <div className="stat-value">{formatSpeed(up)}</div>
          <div className="stat-sub">本次 {formatBytes(totalUp)}</div>
        </div>
      </div>
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="最近一分钟的网速"
      >
        <line className="chart-base" x1="0" y1={height - 0.5} x2={width} y2={height - 0.5} />
        {area && <path className="chart-area" d={area} />}
        {downLine && <path className="chart-line" d={downLine} />}
        {upLine && <path className="chart-line-up" d={upLine} />}
      </svg>
    </section>
  );
}

function Usage() {
  const { profiles } = useProfiles();
  const profile = profiles.find((p) => p.usage);
  if (!profile?.usage) return null;
  const { upload, download, total, expire } = profile.usage;
  const used = upload + download;
  const percent = total ? Math.min(100, (used / total) * 100) : 0;
  return (
    <section className="panel usage">
      <div className="usage-head">
        <span className="usage-name">{profile.name}</span>
        <span className="usage-numbers">
          {formatBytes(used)} / {formatBytes(total)}
        </span>
      </div>
      <div className="meter">
        <span style={{ width: `${percent}%` }} />
      </div>
      {expire > 0 && <div className="usage-foot">{formatDate(expire)} 到期</div>}
    </section>
  );
}

function headline(status: string, health: string) {
  if (status === "connecting") return "连接中";
  if (status === "fault") return "连接失败";
  if (status === "off") return "未连接";
  return health === "bad" ? "已连接,节点不通" : "已连接";
}

export function Home({ go }: { go: (page: Page) => void }) {
  const conn = useConnection();
  const settings = useSettings();
  const { profiles, rules } = useProfiles();
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const primary = settings.activeRules ? rules[settings.activeRules]?.primary : null;
  // 主策略组选了自动测速组之类的成员时,这里显示成员名
  const current = selectedNode()?.name ?? (primary ? settings.groupChoices[primary] : undefined);
  const hasNodes = profiles.some((p) => p.nodeCount > 0);
  const busy = conn.status === "connecting";
  const online = conn.status === "on";

  return (
    <div className="page home">
      <section className="hero" data-state={conn.health === "bad" ? "bad" : conn.status}>
        <div className="hero-text">
          <div className="hero-state">
            <i className="dot" />
            {headline(conn.status, conn.health)}
          </div>
          <button className="hero-node" onClick={() => go("nodes")} title="选择节点">
            {current ? <NodeName name={current} /> : <span className="node-name">未选择节点</span>}
          </button>
          <div className="hero-sub">
            {online && conn.since && (
              <>
                {formatDuration(Date.now() - conn.since)}
                {conn.latency !== null && ` · ${conn.latency} ms`}
                {conn.health === "checking" && " · 检测中"}
              </>
            )}
            {conn.health === "bad" && (
              <>
                {" · "}
                <button className="link" onClick={() => void checkHealth()}>
                  重新检测
                </button>
              </>
            )}
          </div>
        </div>
        <button
          className={online ? "btn btn-big" : "btn btn-big btn-primary"}
          aria-label={online ? "断开代理" : "连接代理"}
          disabled={busy || !hasNodes}
          onClick={() => void (online ? disconnect() : connect())}
        >
          {busy ? "请稍候" : online ? "断开" : "连接"}
        </button>
      </section>

      {conn.status === "fault" && <div className="alert">{conn.error}</div>}
      {!hasNodes && (
        <div className="alert alert-plain">
          还没有节点。
          <button className="link" onClick={() => go("profiles")}>
            添加订阅
          </button>
        </div>
      )}

      <section className="panel">
        <Row title="分流" hint={settings.mode === "rule" ? "按规则分流,国内直连" : "全部流量走节点"}>
          <Segmented
            label="分流模式"
            value={settings.mode}
            options={MODES}
            onChange={(mode) => void setMode(mode)}
          />
        </Row>
        <Row
          title="接管"
          hint={settings.tun ? "接管所有程序,需要管理员权限" : "只对遵守系统代理的程序生效"}
        >
          <Segmented
            label="接管方式"
            value={settings.tun ? "tun" : "proxy"}
            options={CAPTURES}
            onChange={(value) => void setTun(value === "tun")}
          />
        </Row>
      </section>

      <TrafficChart />
      <Usage />
    </div>
  );
}
