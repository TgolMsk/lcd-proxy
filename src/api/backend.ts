import { invoke } from "@tauri-apps/api/core";

/** Rust 后端命令的类型化封装,集中在一处便于查阅 */

export function startKernel(configJson: string): Promise<void> {
  return invoke("start_kernel", { configJson });
}

export function stopKernel(): Promise<void> {
  return invoke("stop_kernel");
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

export function loadState(): Promise<string> {
  return invoke<string>("load_state");
}

export function saveState(json: string): Promise<void> {
  return invoke("save_state", { json });
}
