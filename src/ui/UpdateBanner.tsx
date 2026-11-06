import { useUpdate, installUpdate, dismissUpdate } from "../store/update";
import { CloseIcon } from "./icons";

/** 更新横幅:仅在有新版/下载中/出错时显示 */
export function UpdateBanner() {
  const u = useUpdate();
  if (u.status !== "available" && u.status !== "downloading" && u.status !== "error") {
    return null;
  }
  return (
    <div className={`update-banner ${u.status}`}>
      <span className="update-text">{u.message}</span>
      {u.status === "downloading" && (
        <span className="meter update-meter">
          <span style={{ width: `${u.progress}%` }} />
        </span>
      )}
      {u.status === "available" && (
        <button className="btn btn-primary" onClick={() => void installUpdate()}>
          立即更新
        </button>
      )}
      {u.status !== "downloading" && (
        <button className="icon-btn" title="关闭" aria-label="关闭" onClick={dismissUpdate}>
          <CloseIcon />
        </button>
      )}
    </div>
  );
}
