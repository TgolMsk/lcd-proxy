//! sing-box 内核进程管理:拉起 / 杀死 / 意外退出监控。
//! 切换节点 = 杀旧进程 → 重写配置 → 拉新进程(由 start 统一完成)。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::{config, sysproxy};

const LOG_CAP: usize = 50;
const READY_TIMEOUT_MS: u64 = 8_000;

#[cfg(target_os = "linux")]
const SIDECAR_NAME: &str = "lcd-proxy-core";
#[cfg(not(target_os = "linux"))]
const SIDECAR_NAME: &str = "sing-box";

#[derive(Default)]
pub struct KernelState {
    /// 当前内核子进程句柄
    child: Mutex<Option<CommandChild>>,
    /// 代数:主动 stop 时 +1,用于区分「预期退出」与「意外崩溃」
    generation: AtomicU64,
    /// 最近的内核输出(报错时给用户看最后几行)
    logs: Mutex<VecDeque<String>>,
    /// 串行化 start/stop,避免并发操作把进程状态搞乱
    op_lock: tokio::sync::Mutex<()>,
}

impl KernelState {
    pub fn is_running(&self) -> bool {
        self.child.lock().unwrap().is_some()
    }

    fn tail_logs(&self, n: usize) -> String {
        let logs = self.logs.lock().unwrap();
        logs.iter()
            .rev()
            .take(n)
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join(" | ")
    }

    fn push_log(&self, line: String) {
        let mut logs = self.logs.lock().unwrap();
        if logs.len() >= LOG_CAP {
            logs.pop_front();
        }
        logs.push_back(line);
    }
}

/// 杀死当前内核(幂等)。主动停止,不触发「意外退出」事件。
pub fn stop(state: &KernelState) -> Result<(), String> {
    state.generation.fetch_add(1, Ordering::SeqCst);
    let child = state.child.lock().unwrap().take();
    if let Some(child) = child {
        child.kill().map_err(|e| format!("停止内核失败:{e}"))?;
    }
    Ok(())
}

/// 写配置 → 检查端口 → 拉起 sidecar → 等待入站端口就绪。
pub async fn start(app: AppHandle, config_json: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let parsed: serde_json::Value =
            serde_json::from_str(&config_json).map_err(|e| format!("配置 JSON 非法:{e}"))?;
        let tun = parsed["inbounds"]
            .as_array()
            .is_some_and(|inbounds| inbounds.iter().any(|inbound| inbound["type"] == "tun"));
        if tun && !crate::elevate::is_elevated() {
            return Err("TUN 内核尚未获得网络管理权限,请安装 .deb 包并开启 TUN 授权".into());
        }
    }
    let state = app.state::<KernelState>();
    let _guard = state.op_lock.lock().await;

    // 1. 杀旧进程(切换节点场景)
    let had_old = state.is_running();
    stop(&state)?;
    if had_old {
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    // 2. 端口占用检查。若被占,先清掉可能残留的孤儿内核(上次崩溃/提权重启遗留)再重试。
    let port = config::extract_port(&config_json);
    if port_in_use(port).await {
        kill_stray_kernels();
        tokio::time::sleep(Duration::from_millis(600)).await;
        if port_in_use(port).await {
            return Err(format!(
                "端口 {port} 已被占用。若未运行其他代理程序,可能是残留内核未清除——请从托盘退出应用再重新打开;仍不行请重启电脑"
            ));
        }
    }

    // 3. 校验并写入配置
    let config_path = config::write_config(&app, &config_json)?;

    // 4. 拉起 sidecar:sing-box run -c config.json
    let command = app
        .shell()
        .sidecar(SIDECAR_NAME)
        .map_err(|e| format!("定位内核二进制失败:{e}(是否已放置 sing-box?)"))?
        .args(["run", "-c", &config_path.to_string_lossy()]);

    let (mut rx, child) = command
        .spawn()
        .map_err(|e| format!("启动内核进程失败:{e}"))?;

    state.logs.lock().unwrap().clear();
    *state.child.lock().unwrap() = Some(child);
    let spawn_gen = state.generation.load(Ordering::SeqCst);

    // 内核完整日志落盘,便于排查(尤其 TUN 启动失败)
    let log_path = config::data_dir(&app).ok().map(|d| d.join("kernel.log"));

    // 5. 后台任务:转发内核输出;监控意外退出 → 清系统代理 + 通知前端
    let watch_app = app.clone();
    tauri::async_runtime::spawn(async move {
        use std::io::Write;
        // 每次运行覆盖写,只保留本次日志
        let mut log_file = log_path
            .as_ref()
            .and_then(|p| std::fs::File::create(p).ok());
        while let Some(event) = rx.recv().await {
            let st = watch_app.state::<KernelState>();
            match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    for line in String::from_utf8_lossy(&bytes).lines() {
                        let line = line.trim();
                        if line.is_empty() {
                            continue;
                        }
                        if let Some(f) = log_file.as_mut() {
                            let _ = writeln!(f, "{line}");
                        }
                        st.push_log(line.to_string());
                        let _ = watch_app.emit("kernel-log", line);
                    }
                }
                CommandEvent::Error(err) => {
                    st.push_log(format!("process error: {err}"));
                }
                CommandEvent::Terminated(payload) => {
                    let unexpected = st.generation.load(Ordering::SeqCst) == spawn_gen;
                    if unexpected {
                        st.child.lock().unwrap().take();
                        // 内核崩了必须立刻撤掉系统代理,否则整机断网
                        let _ = sysproxy::set(false, "");
                        let _ = watch_app.emit(
                            "kernel-exit",
                            serde_json::json!({
                                "code": payload.code,
                                "lastLog": st.tail_logs(8),
                            }),
                        );
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    // 6. 等待入站端口开始监听(sing-box 配置错误会立即退出,这里能兜住)
    let deadline = tokio::time::Instant::now() + Duration::from_millis(READY_TIMEOUT_MS);
    loop {
        if !state.is_running() {
            let tail = state.tail_logs(8);
            return Err(if tail.is_empty() {
                "内核启动后立即退出(无输出)。请检查节点参数或内核版本".into()
            } else {
                format!("内核启动失败:{tail}")
            });
        }
        if port_in_use(port).await {
            return Ok(()); // 端口已监听 = 就绪
        }
        if tokio::time::Instant::now() >= deadline {
            let _ = stop(&state);
            let tail = state.tail_logs(8);
            return Err(format!(
                "内核启动超时({}s 内未监听端口 {port}){}",
                READY_TIMEOUT_MS / 1000,
                if tail.is_empty() {
                    String::new()
                } else {
                    format!(":{tail}")
                }
            ));
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// 杀掉可能残留的孤儿内核进程(上次崩溃 / 提权硬重启未清理)。按进程名匹配。
/// sidecar 的运行文件名可能带或不带目标三元组后缀,两种都清。
pub fn kill_stray_kernels() {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000; // 不弹黑窗
        for name in ["sing-box.exe", "sing-box-x86_64-pc-windows-msvc.exe"] {
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/IM", name])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("pkill")
            .args(["-f", "sing-box"])
            .output();
    }
    // Linux must not kill sing-box instances owned by other applications. A
    // surviving child is recovered only when its private name, UID and config match us.
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::ffi::OsStrExt;
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return;
        };
        let Some(uid) = process_uid(std::path::Path::new("/proc/self")) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(pid) = name
                .to_str()
                .filter(|name| name.chars().all(|c| c.is_ascii_digit()))
            else {
                continue;
            };
            let path = entry.path();
            if process_uid(&path) != Some(uid) {
                continue;
            }
            let Ok(cmdline) = std::fs::read(path.join("cmdline")) else {
                continue;
            };
            let args: Vec<_> = cmdline.split(|byte| *byte == 0).collect();
            // /proc/PID/exe is not readable after a capability-enabled exec.
            // AppImage mount paths change on every launch. Match the dedicated
            // sidecar name, real UID and our exact private config instead.
            let executable = args
                .first()
                .map(|arg| std::path::Path::new(std::ffi::OsStr::from_bytes(arg)));
            if executable.and_then(|path| path.file_name())
                != Some(std::ffi::OsStr::new(SIDECAR_NAME))
            {
                continue;
            }
            if !args.iter().any(|arg| *arg == b"run") {
                continue;
            }
            let config = args
                .windows(2)
                .find(|pair| pair[0] == b"-c")
                .map(|pair| pair[1]);
            let Some(config) = config.and_then(|bytes| std::str::from_utf8(bytes).ok()) else {
                continue;
            };
            let Some(data_dir) = linux_data_dir() else {
                continue;
            };
            if std::path::Path::new(config) == data_dir.join("config.json") {
                let _ = std::process::Command::new("kill")
                    .args(["-TERM", pid])
                    .output();
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn process_uid(path: &std::path::Path) -> Option<u32> {
    std::fs::read_to_string(path.join("status"))
        .ok()?
        .lines()
        .find(|line| line.starts_with("Uid:"))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

#[cfg(target_os = "linux")]
fn linux_data_dir() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".local/share"))
        })?;
    Some(base.join("com.lcdproxy.app"))
}

/// 探测 127.0.0.1:port 是否有人监听
async fn port_in_use(port: u16) -> bool {
    matches!(
        tokio::time::timeout(
            Duration::from_millis(250),
            tokio::net::TcpStream::connect(("127.0.0.1", port)),
        )
        .await,
        Ok(Ok(_))
    )
}
