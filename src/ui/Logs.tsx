import { useEffect, useRef, useState } from "react";
import { clearLogs, syncLogs, useLogs } from "../store/logs";
import { reconnectIfOnline, useConnection } from "../store/connection";
import { updateSettings, useSettings } from "../store/settings";
import { LogLevel } from "../config/singbox";
import { revealConfigDir } from "../api/backend";
import { Empty, PageHeader, Segmented } from "./controls";
import { SearchIcon } from "./icons";

const LEVELS = [
  { value: "warn" as LogLevel, label: "警告" },
  { value: "info" as LogLevel, label: "信息" },
  { value: "debug" as LogLevel, label: "调试" },
];

function levelOf(line: string) {
  if (/\b(FATAL|ERROR)\b/.test(line)) return "error";
  if (/\bWARN\b/.test(line)) return "warn";
  return "";
}

export function Logs() {
  const { lines } = useLogs();
  const { logLevel } = useSettings();
  const { status } = useConnection();
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void syncLogs();
  }, []);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow, query]);

  const needle = query.trim().toLowerCase();
  const shown = needle ? lines.filter((l) => l.toLowerCase().includes(needle)) : lines;

  return (
    <div className="page page-list">
      <PageHeader title="日志">
        <label className="search">
          <SearchIcon />
          <input
            value={query}
            placeholder="搜索"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <Segmented
          label="日志级别"
          value={logLevel}
          options={LEVELS}
          onChange={(level) => {
            updateSettings({ logLevel: level });
            void reconnectIfOnline();
          }}
        />
        <button className="btn" onClick={clearLogs}>
          清空
        </button>
        <button className="btn" onClick={() => void revealConfigDir()}>
          打开目录
        </button>
      </PageHeader>
      {shown.length ? (
        <div
          className="log-box"
          ref={box}
          onScroll={(e) => {
            const el = e.currentTarget;
            setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
          }}
        >
          {shown.map((line, i) => (
            <div key={i} className={`log-line ${levelOf(line)}`}>
              {line}
            </div>
          ))}
        </div>
      ) : (
        <Empty title={status === "on" ? "暂时没有日志" : "连接后这里显示内核日志"}>
          {logLevel === "warn" && "当前只记录警告和错误,改成「信息」可以看到每条连接"}
        </Empty>
      )}
    </div>
  );
}
