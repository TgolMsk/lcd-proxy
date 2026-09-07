import { useState } from "react";
import { useConnection } from "../store/connection";
import { revealConfigDir } from "../api/backend";

/**
 * 底部状态/日志提示行。单行显示(过长省略),点击可展开完整信息 ——
 * 内核启动失败等长错误在这里能完整查看并复制。
 */
export function StatusLine() {
  const { message, status } = useConnection();
  const [open, setOpen] = useState(false);
  const isFault = status === "fault";

  return (
    <>
      <div
        className={`statusline${isFault ? " fault" : ""}`}
        title="点击查看完整信息"
        onClick={() => setOpen(true)}
      >
        {isFault ? "⚠ " : ""}
        {message}
        <span className="cursor">&nbsp;</span>
      </div>

      {open && (
        <div className="modal-mask" onClick={() => setOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{isFault ? "错误详情" : "状态详情"}</h3>
            <div className="detail-text">{message}</div>
            <div className="actions">
              <button
                className="btn"
                onClick={() => revealConfigDir().catch(() => {})}
                title="打开 config.json / kernel.log 所在目录"
              >
                打开日志目录
              </button>
              <button className="btn" onClick={() => setOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
