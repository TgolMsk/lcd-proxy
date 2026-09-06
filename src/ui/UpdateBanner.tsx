import { useUpdate, installUpdate, dismissUpdate } from "../store/update";

/**
 * 更新横幅:仅在有新版/下载中/出错时显示;其余状态(idle/checking/none)不占位。
 */
export function UpdateBanner() {
  const u = useUpdate();

  if (u.status !== "available" && u.status !== "downloading" && u.status !== "error") {
    return null;
  }

  return (
    <div className={`update-banner ${u.status}`}>
      <span className="ub-msg">
        {u.status === "available" && "▲ "}
        {u.message}
      </span>

      {u.status === "downloading" && (
        <span className="ub-bar">
          <span className="ub-fill" style={{ width: `${u.progress}%` }} />
        </span>
      )}

      <span className="ub-actions">
        {u.status === "available" && (
          <>
            <button className="btn ub-btn" onClick={() => void installUpdate()}>
              立即更新
            </button>
            <button className="btn ub-btn ub-x" onClick={dismissUpdate} title="稍后">
              ✕
            </button>
          </>
        )}
        {u.status === "error" && (
          <button className="btn ub-btn ub-x" onClick={dismissUpdate} title="关闭">
            ✕
          </button>
        )}
      </span>
    </div>
  );
}
