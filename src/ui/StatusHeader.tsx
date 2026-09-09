import { useConnection } from "../store/connection";

const STATE_TEXT: Record<string, string> = {
  off: "未连接",
  connecting: "连接中…",
  on: "已连接",
  fault: "连接失败",
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
          <div className="title">连接状态</div>
          <div className="state-txt">{STATE_TEXT[conn.status]}</div>
        </div>
      </div>
      <div className="readout">
        <span
          className={`digits${err ? " err" : ""}${
            conn.status !== "on" && !err ? " dim" : ""
          }`}
        >
          {digits}
        </span>
        <span className="unit">ms</span>
      </div>
    </div>
  );
}
