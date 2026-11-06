import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Home } from "./ui/Home";
import { Nodes } from "./ui/Nodes";
import { Rules } from "./ui/Rules";
import { Profiles } from "./ui/Profiles";
import { Logs } from "./ui/Logs";
import { Settings } from "./ui/Settings";
import { UpdateBanner } from "./ui/UpdateBanner";
import { Page } from "./ui/pages";
import {
  CloseIcon,
  HomeIcon,
  LogsIcon,
  NodesIcon,
  ProfilesIcon,
  RulesIcon,
  SettingsIcon,
} from "./ui/icons";
import { formatSpeed } from "./ui/format";
import { checkUpdate } from "./store/update";
import { dismissNotice, useNotices } from "./store/notice";
import { ensureSelection, loadAll, refreshDueProfiles, useProfiles } from "./store/profiles";
import {
  applyTheme,
  saveSettingsNow,
  settingsStore,
  useSettings,
} from "./store/settings";
import {
  connect,
  connectionStore,
  disconnect,
  initConnectionEvents,
  useConnection,
} from "./store/connection";
import { useTraffic } from "./store/traffic";
import { isElevated } from "./api/backend";

const HOUR = 3_600_000;

const NAV: { page: Page; label: string; icon: JSX.Element }[] = [
  { page: "home", label: "连接", icon: <HomeIcon /> },
  { page: "nodes", label: "节点", icon: <NodesIcon /> },
  { page: "rules", label: "规则", icon: <RulesIcon /> },
  { page: "profiles", label: "订阅", icon: <ProfilesIcon /> },
  { page: "logs", label: "日志", icon: <LogsIcon /> },
  { page: "settings", label: "设置", icon: <SettingsIcon /> },
];

let booted = false;

async function boot() {
  if (booted) return; // 开发模式的 StrictMode 会执行两次
  booted = true;
  await initConnectionEvents();
  await loadAll();
  ensureSelection();
  const settings = settingsStore.get();
  if (settings.resumeAfterElevate) {
    await saveSettingsNow({ resumeAfterElevate: false });
    if (await isElevated()) void connect();
  } else if (settings.autoConnect) {
    void connect();
  }
  void checkUpdate(true);
  void refreshDueProfiles();
}

function SidebarStatus() {
  const conn = useConnection();
  const { mode } = useSettings();
  const { up, down } = useTraffic();
  const label = {
    off: "未连接",
    connecting: "连接中",
    on: conn.tun ? "TUN" : "系统代理",
    fault: "连接失败",
  }[conn.status];
  return (
    <div className="side-status" data-state={conn.status}>
      <div className="side-state">
        <i className="dot" />
        {label}
        {conn.status === "on" && <span> · {mode === "rule" ? "规则" : "全局"}</span>}
      </div>
      {conn.status === "on" && (
        <div className="side-speed">
          <span>↓ {formatSpeed(down)}</span>
          <span>↑ {formatSpeed(up)}</span>
        </div>
      )}
    </div>
  );
}

function Notices() {
  const { notices } = useNotices();
  return (
    <div className="notices" role="status">
      {notices.map((notice) => (
        <div key={notice.id} className={`notice ${notice.kind}`}>
          <span>{notice.text}</span>
          <button
            className="icon-btn"
            title="关闭"
            aria-label="关闭"
            onClick={() => dismissNotice(notice.id)}
          >
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>("home");
  const { loaded } = useProfiles();
  const { theme } = useSettings();

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let disposed = false;
    void (async () => {
      await boot();
      unlisteners.push(
        await listen("tray-start", () => {
          if (connectionStore.get().status !== "connecting") void connect();
        }),
        await listen("tray-stop", () => {
          if (connectionStore.get().status === "on") void disconnect();
        }),
      );
      if (disposed) unlisteners.forEach((fn) => fn());
    })();
    const timer = setInterval(() => void refreshDueProfiles(), HOUR);
    return () => {
      disposed = true;
      clearInterval(timer);
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="主导航">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          LCD Proxy
        </div>
        <ul>
          {NAV.map((item) => (
            <li key={item.page}>
              <button
                className={page === item.page ? "nav on" : "nav"}
                aria-label={`${item.label}页`}
                aria-current={page === item.page ? "page" : undefined}
                onClick={() => setPage(item.page)}
              >
                {item.icon}
                {item.label}
              </button>
            </li>
          ))}
        </ul>
        <SidebarStatus />
      </nav>
      <main className="content">
        <UpdateBanner />
        {loaded && page === "home" && <Home go={setPage} />}
        {loaded && page === "nodes" && <Nodes go={setPage} />}
        {loaded && page === "rules" && <Rules />}
        {loaded && page === "profiles" && <Profiles />}
        {loaded && page === "logs" && <Logs />}
        {loaded && page === "settings" && <Settings />}
      </main>
      <Notices />
    </div>
  );
}
