import { invoke } from "@tauri-apps/api/core";

/** Rust 后端命令的类型化封装,集中在一处便于查阅 */

export interface StartReport {
  /** 内核不接受、已从本次配置里去掉的节点 */
  dropped: string[];
}

export function startKernel(configJson: string): Promise<StartReport> {
  return invoke<StartReport>("start_kernel", { configJson });
}

export function stopKernel(): Promise<void> {
  return invoke("stop_kernel");
}

/** 请求内核本地接口(Clash API),返回响应正文 */
export function kernelApi(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 5000,
): Promise<string> {
  return invoke<string>("kernel_api", {
    method,
    path,
    body: body === undefined ? null : JSON.stringify(body),
    timeoutMs,
  });
}

export function kernelLogs(): Promise<string[]> {
  return invoke<string[]>("kernel_logs");
}

export function setSystemProxy(enable: boolean, server: string): Promise<void> {
  return invoke("set_system_proxy", { enable, server });
}

/** TUN 前置检查:Windows 进程提权 / Linux 内核网络 capabilities */
export function isElevated(): Promise<boolean> {
  return invoke<boolean>("is_elevated");
}

/** Windows 提权重启;Linux 只授权 .deb 内核,当前图形实例保持运行 */
export function relaunchAsAdmin(): Promise<void> {
  return invoke("relaunch_as_admin");
}

/** 打开应用数据目录(config.json / kernel.log 所在),便于排查 */
export function revealConfigDir(): Promise<void> {
  return invoke("reveal_config_dir");
}

/** 更新前清理:停内核+杀残留+清代理,让安装包能覆盖 sing-box.exe */
export function prepareUpdate(): Promise<void> {
  return invoke("prepare_update");
}

/** TCP 连接测延迟,返回毫秒;超时/拒绝会 reject */
export function tcpPing(host: string, port: number, timeoutMs = 3000): Promise<number> {
  return invoke<number>("tcp_ping", { host, port, timeoutMs });
}

export interface Fetched {
  body: string;
  userInfo: string | null;
  updateInterval: string | null;
  disposition: string | null;
  webPage: string | null;
  title: string | null;
  viaProxy: boolean;
}

/** 下载订阅或规则文件。直连失败且内核在运行时,后端自动经本地代理重试 */
export function fetchUrl(url: string): Promise<Fetched> {
  return invoke<Fetched>("fetch_subscription", { url });
}

export interface StoreFile {
  content: string;
  /** 主文件缺失或损坏,内容来自备份 */
  recovered: boolean;
}

export function storeRead(name: string): Promise<StoreFile | null> {
  return invoke<StoreFile | null>("store_read", { name });
}

export function storeWrite(name: string, json: string): Promise<void> {
  return invoke("store_write", { name, json });
}

export function storeDelete(name: string): Promise<void> {
  return invoke("store_delete", { name });
}

export function storeRetire(name: string, newName: string): Promise<void> {
  return invoke("store_retire", { name, newName });
}
