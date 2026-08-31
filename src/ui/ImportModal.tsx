import { useState } from "react";
import { parseSubscription } from "../api/subscription";
import { addNodes } from "../store/nodes";
import { logStatus } from "../store/connection";

/** 手动导入弹层:粘贴一条或多条 vless:// ss:// ssr:// 链接 */
export function ImportModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");

  function doImport() {
    const { nodes, errors } = parseSubscription(text);
    if (!nodes.length) {
      logStatus(
        errors.length
          ? `导入失败:${errors.length} 条全部无法解析(${errors[0]})`
          : "没有可导入的内容",
      );
      return;
    }
    const added = addNodes(nodes);
    logStatus(
      `导入完成 · 新增 ${added} 个节点` +
        (nodes.length - added > 0 ? ` · ${nodes.length - added} 个重复已跳过` : "") +
        (errors.length ? ` · ${errors.length} 条解析失败` : ""),
    );
    if (errors.length) console.warn("解析失败的行:", errors);
    onClose();
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>手动导入节点</h3>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"每行一条分享链接:\nvless://...\nss://...\nssr://..."}
          spellCheck={false}
        />
        <div className="actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn" onClick={doImport} disabled={!text.trim()}>
            解析导入
          </button>
        </div>
      </div>
    </div>
  );
}
