import { useConnection } from "../store/connection";

const STATE_TEXT: Record<string, string> = {
  off: "待机 · STANDBY",
  connecting: "连接中 · LINKING",
  on: "已连接 · ONLINE",
  fault: "失败 · FAULT",
};

const DOT_CLASS: Record<string, string> = {
  off: "off",
  connecting: "link",
  on: "on",
  fault: "fault",
};

/** 顶栏:状态灯 + 标题 + 数码管延迟读数 */
export function StatusHeader() {
  const conn = useConnection();

  let digits = "---";
  let err = false;
  if (conn.status === "connecting") digits = "···";
  else if (conn.status === "fault") {
    digits = "ERR";
    err = true;
  } else if (conn.status === "on") {
    digits = conn.latency == null ? "···" : String(conn.latency).padStart(3, "0");
  }

  return (
    <div className="header">
      <div className="id">
        <span className={`dot ${DOT_CLASS[conn.status]}`} />
        <div>
          <div className="title">LCD&nbsp;PROXY</div>
          <div className="state-txt">{STATE_TEXT[conn.status]}</div>
        </div>
      </div>
      <div className="readout">
        <span className={`digits${err ? " err" : ""}`}>{digits}</span>
        <span className="unit">ms</span>
      </div>
    </div>
  );
}
