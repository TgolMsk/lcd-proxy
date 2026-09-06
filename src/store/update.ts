import { Update } from "@tauri-apps/plugin-updater";
import { createStore, useStore } from "./createStore";
import { checkForUpdate, downloadAndInstall } from "../api/updater";

export type UpdateStatus =
  | "idle" // 未检查 / 已忽略
  | "checking" // 检查中
  | "none" // 已是最新
  | "available" // 有新版
  | "downloading" // 下载安装中
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  version: string | null; // 新版本号
  notes: string | null; // 更新说明(Release body)
  progress: number; // 0-100
  message: string;
}

const store = createStore<UpdateState>({
  status: "idle",
  version: null,
  notes: null,
  progress: 0,
  message: "",
});

export const useUpdate = () => useStore(store);

let pending: Update | null = null;

/**
 * 检查更新。
 * silent=true(启动时后台静默):无新版/出错都不弹提示,只在有新版时才亮横幅。
 */
export async function checkUpdate(silent = false): Promise<void> {
  if (store.get().status === "downloading") return;
  if (!silent) store.set({ status: "checking", message: "正在检查更新 …" });
  try {
    const update = await checkForUpdate();
    if (update) {
      pending = update;
      store.set({
        status: "available",
        version: update.version,
        notes: update.body ?? null,
        message: `发现新版本 v${update.version}`,
      });
    } else {
      pending = null;
      store.set({
        status: silent ? "idle" : "none",
        message: silent ? "" : "已是最新版本",
      });
    }
  } catch (e) {
    pending = null;
    store.set({
      status: silent ? "idle" : "error",
      message: silent ? "" : `检查更新失败:${errMsg(e)}`,
    });
  }
}

/** 下载并安装挂起的更新,完成后自动重启 */
export async function installUpdate(): Promise<void> {
  if (!pending) return;
  store.set({ status: "downloading", progress: 0, message: "开始下载更新 …" });
  try {
    await downloadAndInstall(pending, (downloaded, total) => {
      const pct = total ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
      store.set({
        progress: pct,
        message: total
          ? `下载中 ${pct}% (${fmtMB(downloaded)}/${fmtMB(total)})`
          : `下载中 ${fmtMB(downloaded)}`,
      });
    });
    store.set({ message: "更新完成,正在重启 …" }); // relaunch 后一般走不到
  } catch (e) {
    store.set({ status: "error", message: `更新失败:${errMsg(e)}` });
  }
}

/** 忽略本次提示(仅隐藏横幅,下次启动仍会再检查) */
export function dismissUpdate(): void {
  store.set({ status: "idle" });
}

function fmtMB(bytes: number): string {
  return (bytes / 1048576).toFixed(1) + "MB";
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
