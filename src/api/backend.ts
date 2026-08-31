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

/** 当前进程是否具管理员权限(TUN 前置检查) */
export function isElevated(): Promise<boolean> {
  return invoke<boolean>("is_elevated");
}

/** 以管理员身份重启自身;成功后当前实例会退出 */
export function relaunchAsAdmin(): Promise<void> {
  return invoke("relaunch_as_admin");
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
