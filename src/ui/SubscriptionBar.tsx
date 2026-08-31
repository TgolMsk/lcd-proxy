import { useState } from "react";
import { fetchSubscription } from "../api/subscription";
import {
  useNodes,
  setSubscriptionUrl,
  replaceNodes,
  toggleScanlines,
  pingAllNodes,
} from "../store/nodes";
import { logStatus, errText, toggleTun } from "../store/connection";
import { ImportModal } from "./ImportModal";

/** 订阅栏:订阅地址 + 刷新 / 手动导入 / 测速 / 扫描线开关 */
export function SubscriptionBar() {
  const { subscriptionUrl, scanlines, nodes, tunMode } = useNodes();
  const [refreshing, setRefreshing] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  async function refresh() {
    const url = subscriptionUrl.trim();
    if (!url) {
      logStatus("请先粘贴订阅链接");
      return;
    }
    setRefreshing(true);
    logStatus("正在拉取订阅 … 解码节点列表");
    try {
      const { nodes: parsed, errors } = await fetchSubscription(url);
      replaceNodes(parsed);
      logStatus(
        `订阅已更新 · 共 ${parsed.length} 个节点` +
          (errors.length ? ` · ${errors.length} 条解析失败已跳过` : ""),
      );
      if (errors.length) console.warn("解析失败的行:", errors);
    } catch (e) {
      logStatus(`订阅拉取失败:${errText(e)}(旧列表不受影响)`);
    } finally {
      setRefreshing(false);
    }
  }

  async function pingAll() {
    if (!nodes.length) {
      logStatus("列表为空,先刷新订阅或手动导入节点");
      return;
    }
    logStatus("正在测速 … TCP 连接延迟");
    await pingAllNodes();
    logStatus("测速完成");
  }

  return (
    <>
      <div className="subbar">
        <input
          type="text"
          value={subscriptionUrl}
          placeholder="粘贴订阅链接 https://..."
          spellCheck={false}
          onChange={(e) => setSubscriptionUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && refresh()}
        />
        <button className="btn" onClick={refresh} disabled={refreshing}>
          {refreshing ? "…" : "刷新"}
        </button>
        <button className="btn" onClick={() => setImportOpen(true)}>
          导入
        </button>
        <button className="btn" onClick={pingAll} title="TCP 连接测延迟">
          测速
        </button>
        <button
          className={`btn${tunMode ? " toggled" : ""}`}
          onClick={() => void toggleTun()}
          title="TUN 全局模式(需管理员权限)"
        >
          TUN
        </button>
        <button
          className={`btn${scanlines ? " toggled" : ""}`}
          onClick={toggleScanlines}
          title="扫描线开关"
        >
          SCAN
        </button>
      </div>
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} />}
    </>
  );
}
