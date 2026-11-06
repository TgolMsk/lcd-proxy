import { useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import {
  addSubscription,
  deleteProfile,
  importText,
  LOCAL_ID,
  Profile,
  refreshProfile,
  renameProfile,
  setActiveRules,
  useProfiles,
} from "../store/profiles";
import { reconnectIfOnline, errText } from "../store/connection";
import { notify } from "../store/notice";
import { useSettings } from "../store/settings";
import { Empty, PageHeader } from "./controls";
import { formatAgo, formatBytes, formatDate } from "./format";
import { LinkIcon, PlusIcon, RefreshIcon, TrashIcon } from "./icons";

function ProfileCard({ profile }: { profile: Profile }) {
  const { refreshing } = useProfiles();
  const { activeRules } = useSettings();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const busy = !!refreshing[profile.id];
  const usage = profile.usage;
  const used = usage ? usage.upload + usage.download : 0;
  const percent = usage?.total ? Math.min(100, (used / usage.total) * 100) : 0;
  const local = profile.id === LOCAL_ID;

  const facts = [
    `${profile.nodeCount} 个节点`,
    profile.ruleCount ? `${profile.ruleCount} 条规则` : null,
    profile.updatedAt ? `${formatAgo(profile.updatedAt)}更新` : null,
    usage?.expire ? `${formatDate(usage.expire)} 到期` : null,
  ].filter(Boolean);

  return (
    <li className="profile">
      <div className="profile-main">
        <div className="profile-head">
          {editing ? (
            <input
              className="input profile-rename"
              autoFocus
              defaultValue={profile.name}
              onBlur={(e) => {
                renameProfile(profile.id, e.target.value);
                setEditing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setEditing(false);
              }}
            />
          ) : (
            <button className="profile-name" title="重命名" onClick={() => setEditing(true)}>
              {profile.name}
            </button>
          )}
          {activeRules === profile.id && <span className="tag tag-on">规则生效中</span>}
        </div>
        <div className="profile-facts">{facts.join(" · ")}</div>
        {usage && (
          <div className="profile-usage">
            <div className="meter">
              <span style={{ width: `${percent}%` }} />
            </div>
            <span>
              {formatBytes(used)} / {formatBytes(usage.total)}
            </span>
          </div>
        )}
        {profile.lastError && <div className="profile-error">{profile.lastError}</div>}
      </div>
      <div className="profile-actions">
        {profile.ruleCount > 0 && activeRules !== profile.id && (
          <button
            className="btn"
            onClick={() => void setActiveRules(profile.id).then(reconnectIfOnline)}
          >
            使用规则
          </button>
        )}
        {profile.webPage && (
          <button
            className="icon-btn"
            title="打开官网"
            aria-label="打开官网"
            onClick={() => void open(profile.webPage!)}
          >
            <LinkIcon />
          </button>
        )}
        {profile.url && (
          <button
            className="icon-btn"
            title="更新"
            aria-label={`更新 ${profile.name}`}
            disabled={busy}
            onClick={() => void refreshProfile(profile.id)}
          >
            <span className={busy ? "spin" : ""}>
              <RefreshIcon />
            </span>
          </button>
        )}
        {!local &&
          (confirming ? (
            <button
              className="btn btn-danger"
              onBlur={() => setConfirming(false)}
              autoFocus
              onClick={() => void deleteProfile(profile.id)}
            >
              确认删除
            </button>
          ) : (
            <button
              className="icon-btn"
              title="删除"
              aria-label={`删除 ${profile.name}`}
              onClick={() => setConfirming(true)}
            >
              <TrashIcon />
            </button>
          ))}
      </div>
    </li>
  );
}

function ImportPanel({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      await importText(text);
      onClose();
    } catch (e) {
      notify(errText(e), "error");
    } finally {
      setBusy(false);
    }
  }

  async function pickFile(file: File | undefined) {
    if (file) setText(await file.text());
  }

  return (
    <section className="panel panel-pad">
      <div className="section-title">导入</div>
      <div className="section-hint">
        可以粘贴分享链接、订阅链接、Clash 配置或 sing-box 配置。Clash 配置里的策略组和规则会一起导入。
      </div>
      <textarea
        className="textarea"
        rows={7}
        spellCheck={false}
        autoFocus
        value={text}
        placeholder={"ss://… vmess://… vless://… trojan://… hy2://…"}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="section-foot">
        <label className="btn file-btn">
          选择文件
          <input
            type="file"
            accept=".yaml,.yml,.json,.txt"
            onChange={(e) => void pickFile(e.target.files?.[0])}
          />
        </label>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          取消
        </button>
        <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => void run()}>
          {busy ? "导入中" : "导入"}
        </button>
      </div>
    </section>
  );
}

export function Profiles() {
  const { profiles, refreshing } = useProfiles();
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);

  async function add() {
    const value = url.trim();
    if (!value) return;
    setAdding(true);
    const id = await addSubscription(value);
    setAdding(false);
    if (id) setUrl("");
  }

  const remote = profiles.filter((p) => p.url);
  // 没有手动导入的节点时,本地配置只是一张空卡片
  const shown = profiles.filter((p) => p.id !== LOCAL_ID || p.nodeCount > 0);
  const anyBusy = Object.values(refreshing).some(Boolean);

  return (
    <div className="page">
      <PageHeader title="订阅">
        {remote.length > 0 && (
          <button
            className="btn"
            disabled={anyBusy}
            onClick={() => remote.forEach((p) => void refreshProfile(p.id))}
          >
            <RefreshIcon />
            全部更新
          </button>
        )}
        <button className="btn" onClick={() => setImporting(!importing)}>
          <PlusIcon />
          导入
        </button>
      </PageHeader>

      <form
        className="add-row"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          className="input"
          value={url}
          spellCheck={false}
          placeholder="订阅链接"
          aria-label="订阅链接"
          onChange={(e) => setUrl(e.target.value)}
        />
        <button className="btn btn-primary" disabled={adding || !url.trim()}>
          {adding ? "下载中" : "添加"}
        </button>
      </form>

      {importing && <ImportPanel onClose={() => setImporting(false)} />}

      {shown.length > 0 ? (
        <ul className="profile-list">
          {shown.map((profile) => (
            <ProfileCard key={profile.id} profile={profile} />
          ))}
        </ul>
      ) : (
        <Empty title="还没有订阅" />
      )}
    </div>
  );
}
