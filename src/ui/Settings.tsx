import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { revealConfigDir } from "../api/backend";
import { reconnectIfOnline, useConnection } from "../store/connection";
import { applyTheme, Theme, updateSettings, useSettings } from "../store/settings";
import { checkUpdate, useUpdate } from "../store/update";
import { TunStack } from "../config/singbox";
import { PageHeader, Row, Segmented, Switch } from "./controls";

const THEMES = [
  { value: "system" as Theme, label: "跟随系统" },
  { value: "light" as Theme, label: "浅色" },
  { value: "dark" as Theme, label: "深色" },
];

const STACKS = [
  { value: "gvisor" as TunStack, label: "gVisor" },
  { value: "mixed" as TunStack, label: "混合" },
  { value: "system" as TunStack, label: "系统" },
];

function validPort(value: string) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

function validIp(value: string) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
}

/** 输入框失焦时才保存,改一半的内容不生效 */
function Field({
  value,
  width,
  valid,
  onSave,
  label,
}: {
  value: string;
  width: number;
  valid: (value: string) => boolean;
  onSave: (value: string) => void;
  label: string;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const bad = !valid(text);
  return (
    <input
      className={bad ? "input input-bad" : "input"}
      style={{ width }}
      value={text}
      spellCheck={false}
      aria-label={label}
      aria-invalid={bad}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (bad) setText(value);
        else if (text !== value) onSave(text);
      }}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}

export function Settings() {
  const settings = useSettings();
  const { status } = useConnection();
  const update = useUpdate();
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);
  const online = status === "on";

  /** 改动需要重建内核配置 */
  const apply = (patch: Parameters<typeof updateSettings>[0]) => {
    updateSettings(patch);
    void reconnectIfOnline();
  };

  return (
    <div className="page">
      <PageHeader title="设置" />
      <section className="panel">
        <Row title="外观">
          <Segmented
            label="外观"
            value={settings.theme}
            options={THEMES}
            onChange={(theme) => {
              updateSettings({ theme });
              applyTheme(theme);
            }}
          />
        </Row>
        <Row title="启动后自动连接">
          <Switch
            label="启动后自动连接"
            checked={settings.autoConnect}
            onChange={(autoConnect) => updateSettings({ autoConnect })}
          />
        </Row>
      </section>

      <section className="panel">
        <div className="panel-title">网络{online ? ",修改后自动重连" : ""}</div>
        <Row title="本地端口" hint="HTTP 和 SOCKS5 共用">
          <Field
            label="本地端口"
            value={String(settings.port)}
            width={90}
            valid={validPort}
            onSave={(port) => apply({ port: Number(port) })}
          />
        </Row>
        <Row title="IPv6" hint="节点没有 IPv6 出口时开启会导致部分网站打不开">
          <Switch
            label="IPv6"
            checked={settings.ipv6}
            onChange={(ipv6) => apply({ ipv6 })}
          />
        </Row>
        <Row title="TUN 协议栈" hint="gVisor 兼容性最好;系统栈速度更快,但依赖防火墙放行">
          <Segmented
            label="TUN 协议栈"
            value={settings.stack}
            options={STACKS}
            onChange={(stack) => apply({ stack })}
          />
        </Row>
        <Row title="直连 DNS" hint="TUN 模式下解析国内域名和节点地址">
          <Field
            label="直连 DNS"
            value={settings.directDns}
            width={130}
            valid={validIp}
            onSave={(directDns) => apply({ directDns })}
          />
        </Row>
      </section>

      <section className="panel">
        <Row title="版本" hint={update.message || undefined}>
          <span className="muted">{version}</span>
          <button
            className="btn"
            disabled={update.status === "checking" || update.status === "downloading"}
            onClick={() => void checkUpdate(false)}
          >
            检查更新
          </button>
        </Row>
        <Row title="数据目录" hint="配置、订阅和内核日志">
          <button className="btn" onClick={() => void revealConfigDir()}>
            打开
          </button>
        </Row>
      </section>
    </div>
  );
}
