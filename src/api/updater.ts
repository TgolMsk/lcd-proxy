import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * 应用自更新(基于 GitHub Release + Tauri updater 插件)。
 * 更新源:tauri.conf.json 的 plugins.updater.endpoints 指向仓库
 * releases/latest/download/latest.json(只认已发布的 Release,草稿不算)。
 * 产物由 CI 用签名私钥签名,客户端用内置公钥校验,防止被篡改。
 */

/** 检查更新:有新版返回 Update 句柄,无则 null */
export async function checkForUpdate(): Promise<Update | null> {
  const update = await check();
  return update ?? null;
}

/**
 * 下载并安装更新。onProgress 回报已下载/总字节;完成后重启应用生效。
 * Windows 上会拉起新版安装包完成替换。
 */
export async function downloadAndInstall(
  update: Update,
  onProgress?: (downloaded: number, total: number | null) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? null;
      onProgress?.(0, total);
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      onProgress?.(downloaded, total);
    } else if (event.event === "Finished") {
      onProgress?.(total ?? downloaded, total);
    }
  });
  await relaunch();
}
