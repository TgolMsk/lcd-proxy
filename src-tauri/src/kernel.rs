//! sing-box 内核进程管理:拉起 / 停止 / 意外退出监控 / 本地控制接口。
//! 切换配置 = 停旧进程并等它退出 → 重写配置 → 拉新进程(由 start 统一完成)。
//! 切换节点、模式不用重启内核,走 Clash API 热切换。

use std::collections::VecDeque;
use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::{config, sysproxy};

const LOG_CAP: usize = 1000;
const LOG_FILE_LIMIT: u64 = 5 * 1024 * 1024;
// Windows 上创建 TUN 网卡比普通入站慢得多
const READY_TIMEOUT_MS: u64 = 15_000;
const EXIT_TIMEOUT_MS: u64 = 3_000;

#[cfg(target_os = "linux")]
const SIDECAR_NAME: &str = "lcd-proxy-core";
#[cfg(not(target_os = "linux"))]
const SIDECAR_NAME: &str = "sing-box";

#[derive(Clone)]
struct ApiEndpoint {
    base: String,
    secret: String,
}

#[derive(Default)]
pub struct KernelState {
    /// 当前内核子进程句柄
    child: Mutex<Option<CommandChild>>,
    /// 代数:主动 stop 时 +1,用于区分「预期退出」与「意外崩溃」
    generation: AtomicU64,
    /// 累计拉起次数
    spawned: AtomicU64,
    /// 已确认退出的序号,追上 spawned 说明旧进程已经不在
    exited: AtomicU64,
    /// 最近的内核输出
    logs: Mutex<VecDeque<String>>,
    /// 串行化 start/stop,避免并发操作把进程状态搞乱
    op_lock: tokio::sync::Mutex<()>,
    /// Clash API 地址与口令,每次启动随机生成
    api: Mutex<Option<ApiEndpoint>>,
    /// 运行中内核的本地代理端口,0 表示未运行
    proxy_port: AtomicU16,
}

impl KernelState {
    pub fn is_running(&self) -> bool {
        self.child.lock().unwrap().is_some()
    }

    pub fn proxy_port(&self) -> Option<u16> {
        match self.proxy_port.load(Ordering::SeqCst) {
            0 => None,
            port => Some(port),
        }
    }

    pub fn logs(&self) -> Vec<String> {
        self.logs.lock().unwrap().iter().cloned().collect()
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

    fn clear_running(&self) {
        *self.api.lock().unwrap() = None;
        self.proxy_port.store(0, Ordering::SeqCst);
    }
}

/// 杀死当前内核(幂等)。主动停止,不触发「意外退出」事件。
pub fn stop(state: &KernelState) -> Result<(), String> {
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.clear_running();
    let child = state.child.lock().unwrap().take();
    if let Some(child) = child {
        child.kill().map_err(|e| format!("停止内核失败:{e}"))?;
    }
    Ok(())
}

/// 停止内核并等到进程真正退出。替换二进制、重建 TUN 网卡前都要等这一步。
pub async fn stop_and_wait(state: &KernelState) -> Result<(), String> {
    stop(state)?;
    let target = state.spawned.load(Ordering::SeqCst);
    let deadline = tokio::time::Instant::now() + Duration::from_millis(EXIT_TIMEOUT_MS);
    while state.exited.load(Ordering::SeqCst) < target {
        if tokio::time::Instant::now() >= deadline {
            break; // 后面的端口检查会兜住
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct StartReport {
    /// 内核不接受、已从本次配置里去掉的节点
    pub dropped: Vec<String>,
}

/// 校验配置 → 检查端口 → 拉起 sidecar → 等待入站端口就绪。
pub async fn start(app: AppHandle, config_json: String) -> Result<StartReport, String> {
    let mut config: Value =
        serde_json::from_str(&config_json).map_err(|e| format!("配置 JSON 非法:{e}"))?;
    #[cfg(target_os = "linux")]
    {
        let tun = config["inbounds"]
            .as_array()
            .is_some_and(|inbounds| inbounds.iter().any(|inbound| inbound["type"] == "tun"));
        if tun && !crate::elevate::is_elevated() {
            return Err("TUN 内核尚未获得网络管理权限,请安装 .deb 包并开启 TUN 授权".into());
        }
    }
    let state = app.state::<KernelState>();
    let _guard = state.op_lock.lock().await;

    // 1. 停旧进程并等它退出
    stop_and_wait(&state).await?;

    // 2. 端口占用检查。若被占,先清掉本应用的孤儿内核再重试。
    let port = config::extract_port(&config_json);
    if port_in_use(port).await {
        kill_stray_kernels(&app);
        tokio::time::sleep(Duration::from_millis(600)).await;
        if port_in_use(port).await {
            return Err(format!(
                "端口 {port} 已被占用。请退出占用它的代理软件,或在设置里换一个端口"
            ));
        }
    }

    // 3. 补全运行时才知道的内容,校验后写入
    resolve_rule_sets(&app, &mut config)?;
    let api = inject_api(&mut config)?;
    let (config_path, dropped) = prepare_config(&app, config).await?;

    // 4. 拉起 sidecar:sing-box run -c config.json
    let command = app
        .shell()
        .sidecar(SIDECAR_NAME)
        .map_err(|e| format!("定位内核二进制失败:{e}"))?
        .args(["run", "-c", &config_path.to_string_lossy()]);

    let (mut rx, child) = command
        .spawn()
        .map_err(|e| format!("启动内核进程失败:{e}"))?;

    // 进程随应用一起结束:应用崩溃或提权硬退出时不留孤儿内核
    #[cfg(target_os = "windows")]
    job::attach(child.pid());

    state.logs.lock().unwrap().clear();
    *state.child.lock().unwrap() = Some(child);
    let spawn_id = state.spawned.fetch_add(1, Ordering::SeqCst) + 1;
    let spawn_gen = state.generation.load(Ordering::SeqCst);

    // 内核完整日志落盘,便于排查(尤其 TUN 启动失败)
    let log_path = config::data_dir(&app).ok().map(|d| d.join("kernel.log"));

    // 5. 后台任务:转发内核输出;监控意外退出 → 清系统代理 + 通知前端
    let watch_app = app.clone();
    tauri::async_runtime::spawn(async move {
        // 每次运行覆盖写,只保留本次日志
        let mut log_file = log_path
            .as_ref()
            .and_then(|p| std::fs::File::create(p).ok());
        let mut written = 0u64;
        while let Some(event) = rx.recv().await {
            let st = watch_app.state::<KernelState>();
            match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    for line in String::from_utf8_lossy(&bytes).lines() {
                        let line = strip_ansi(line);
                        let line = line.trim();
                        if line.is_empty() {
                            continue;
                        }
                        if let Some(file) = log_file.as_mut() {
                            written = write_log(file, line, written);
                        }
                        st.push_log(line.to_string());
                        let _ = watch_app.emit("kernel-log", line);
                    }
                }
                CommandEvent::Error(err) => {
                    st.push_log(format!("process error: {err}"));
                }
                CommandEvent::Terminated(payload) => {
                    st.exited.store(spawn_id, Ordering::SeqCst);
                    let unexpected = st.generation.load(Ordering::SeqCst) == spawn_gen;
                    if unexpected {
                        st.child.lock().unwrap().take();
                        st.clear_running();
                        // 内核崩了必须立刻撤掉系统代理,否则整机断网
                        let _ = sysproxy::set(false, "");
                        let _ = watch_app.emit(
                            "kernel-exit",
                            json!({
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
            break; // 端口已监听 = 就绪
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
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    state.proxy_port.store(port, Ordering::SeqCst);
    *state.api.lock().unwrap() = Some(api.clone());
    spawn_traffic_pump(app.clone(), api, spawn_gen);
    Ok(StartReport { dropped })
}

fn write_log(file: &mut std::fs::File, line: &str, written: u64) -> u64 {
    use std::io::{Seek, SeekFrom, Write};
    let mut written = written;
    if written > LOG_FILE_LIMIT {
        let _ = file.set_len(0);
        let _ = file.seek(SeekFrom::Start(0));
        written = 0;
    }
    let _ = writeln!(file, "{line}");
    written + line.len() as u64 + 1
}

fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

// ---------------- 配置补全与校验 ----------------

/// 把内置规则集的占位路径 @rules/x.srs 换成安装目录下的真实路径
fn resolve_rule_sets(app: &AppHandle, config: &mut Value) -> Result<(), String> {
    let Some(sets) = config
        .get_mut("route")
        .and_then(|route| route.get_mut("rule_set"))
        .and_then(Value::as_array_mut)
    else {
        return Ok(());
    };
    for set in sets {
        let Some(name) = set["path"]
            .as_str()
            .and_then(|path| path.strip_prefix("@rules/"))
            .map(str::to_string)
        else {
            continue;
        };
        let path = app
            .path()
            .resolve(format!("rules/{name}"), BaseDirectory::Resource)
            .map_err(|e| format!("定位内置规则集失败:{e}"))?;
        if !path.is_file() {
            return Err(format!("内置规则集缺失:{name}"));
        }
        set["path"] = Value::String(path.to_string_lossy().into_owned());
    }
    Ok(())
}

fn random_secret() -> String {
    let state = std::collections::hash_map::RandomState::new();
    let mut parts = [0u64; 3];
    for (index, part) in parts.iter_mut().enumerate() {
        let mut hasher = state.build_hasher();
        hasher.write_usize(index);
        *part = hasher.finish();
    }
    format!("{:016x}{:016x}{:016x}", parts[0], parts[1], parts[2])
}

/// Clash API 只监听本机,端口和口令每次启动随机生成,其他程序碰不到
fn inject_api(config: &mut Value) -> Result<ApiEndpoint, String> {
    let port = std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map_err(|e| format!("分配控制端口失败:{e}"))?
        .port();
    let secret = random_secret();
    let root = config.as_object_mut().ok_or("配置格式错误")?;
    let experimental = root.entry("experimental").or_insert_with(|| json!({}));
    let api = experimental
        .as_object_mut()
        .ok_or("配置格式错误")?
        .entry("clash_api")
        .or_insert_with(|| json!({}));
    api["external_controller"] = json!(format!("127.0.0.1:{port}"));
    api["secret"] = json!(secret);
    Ok(ApiEndpoint {
        base: format!("http://127.0.0.1:{port}"),
        secret,
    })
}

/// 写配置并用内核校验。某个节点参数不被接受时去掉它再试,一个坏节点不该拖垮整份订阅。
async fn prepare_config(
    app: &AppHandle,
    mut config: Value,
) -> Result<(PathBuf, Vec<String>), String> {
    let mut dropped = Vec::new();
    loop {
        let text = serde_json::to_string(&config).map_err(|e| format!("序列化配置失败:{e}"))?;
        let path = config::write_config(app, &text)?;
        let Err(message) = check_config(app, &path).await else {
            return Ok((path, dropped));
        };
        match failed_outbound(&message).and_then(|index| drop_outbound(&mut config, index)) {
            Some(tag) => dropped.push(tag),
            None => return Err(format!("配置校验失败:{message}")),
        }
    }
}

async fn check_config(app: &AppHandle, path: &Path) -> Result<(), String> {
    let output = app
        .shell()
        .sidecar(SIDECAR_NAME)
        .map_err(|e| format!("定位内核二进制失败:{e}"))?
        .args(["check", "-c", &path.to_string_lossy()])
        .output()
        .await
        .map_err(|e| format!("运行内核失败:{e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let text = strip_ansi(&String::from_utf8_lossy(&output.stderr));
    Err(text.trim().to_string())
}

/// 从内核报错里取出错的出站序号:
/// `initialize outbound[2]: ...` 或 `decode config at x: outbounds[2]: ...`
fn failed_outbound(message: &str) -> Option<usize> {
    let start = message.find("outbound")?;
    let rest = message[start + "outbound".len()..].strip_prefix('s').unwrap_or(&message[start + "outbound".len()..]);
    let rest = rest.strip_prefix('[')?;
    rest[..rest.find(']')?].parse().ok()
}

/// 去掉一个节点并清理所有引用。去掉后主组没有节点时返回 None:
/// 绝不能悄悄退回直连,用户以为流量还在走代理。
fn drop_outbound(config: &mut Value, index: usize) -> Option<String> {
    let outbounds = config.get_mut("outbounds")?.as_array_mut()?;
    let target = outbounds.get(index)?;
    let kind = target["type"].as_str()?;
    if matches!(kind, "direct" | "block" | "dns" | "selector" | "urltest") {
        return None;
    }
    let tag = target["tag"].as_str()?.to_string();
    outbounds.remove(index);

    for outbound in outbounds.iter_mut() {
        let Some(group) = outbound.as_object_mut() else {
            continue;
        };
        if group.get("default").and_then(Value::as_str) == Some(&tag) {
            group.remove("default");
        }
        let group_tag = group.get("tag").and_then(Value::as_str).unwrap_or("").to_string();
        let Some(members) = group.get_mut("outbounds").and_then(Value::as_array_mut) else {
            continue;
        };
        members.retain(|member| member.as_str() != Some(&tag));
        if members.is_empty() {
            if group_tag == "proxy" {
                return None;
            }
            members.push(json!("proxy"));
        }
    }

    if let Some(rules) = config
        .get_mut("route")
        .and_then(|route| route.get_mut("rules"))
        .and_then(Value::as_array_mut)
    {
        for rule in rules {
            if rule["outbound"].as_str() == Some(&tag) {
                rule["outbound"] = json!("proxy");
            }
        }
    }
    if let Some(route) = config.get_mut("route") {
        if route["final"].as_str() == Some(&tag) {
            route["final"] = json!("proxy");
        }
    }
    Some(tag)
}

// ---------------- Clash API ----------------

fn api_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(2))
            .build()
            .expect("创建内核接口客户端失败")
    })
}

/// 请求内核本地接口,返回响应正文
pub async fn api_request(
    state: &KernelState,
    method: &str,
    path: &str,
    body: Option<String>,
    timeout_ms: u64,
) -> Result<String, String> {
    if !path.starts_with('/') {
        return Err("接口路径必须以 / 开头".into());
    }
    let api = state
        .api
        .lock()
        .unwrap()
        .clone()
        .ok_or("内核未运行")?;
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| format!("非法的请求方法:{method}"))?;
    let mut request = api_client()
        .request(method, format!("{}{path}", api.base))
        .bearer_auth(&api.secret)
        .timeout(Duration::from_millis(timeout_ms.clamp(100, 60_000)));
    if let Some(body) = body {
        request = request
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("内核接口请求失败:{}", e.without_url()))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取内核接口响应失败:{}", e.without_url()))?;
    if status.is_success() {
        return Ok(text);
    }
    let message = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|value| value["message"].as_str().map(str::to_string))
        .unwrap_or(text);
    Err(format!("HTTP {}:{message}", status.as_u16()))
}

/// 把内核每秒推送的流量转成前端事件,内核停止后自动结束
fn spawn_traffic_pump(app: AppHandle, api: ApiEndpoint, generation: u64) {
    tauri::async_runtime::spawn(async move {
        let alive = |app: &AppHandle| {
            app.state::<KernelState>().generation.load(Ordering::SeqCst) == generation
        };
        while alive(&app) {
            let response = api_client()
                .get(format!("{}/traffic", api.base))
                .bearer_auth(&api.secret)
                .send()
                .await;
            if let Ok(mut response) = response {
                let mut buffer = Vec::new();
                while let Ok(Some(chunk)) = response.chunk().await {
                    if !alive(&app) {
                        return;
                    }
                    buffer.extend_from_slice(&chunk);
                    while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
                        let line: Vec<u8> = buffer.drain(..=end).collect();
                        if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                            let _ = app.emit("kernel-traffic", value);
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}

// ---------------- 残留进程 ----------------

/// 杀掉本应用残留的孤儿内核。只认本应用的内核,不能碰别的软件自带的 sing-box。
pub fn kill_stray_kernels(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        job::kill_strays();
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(dir) = config::data_dir(app) {
            let pattern = format!("run -c {}", dir.join("config.json").display());
            let _ = std::process::Command::new("pkill")
                .args(["-f", &pattern])
                .output();
        }
    }
    // Linux must not kill sing-box instances owned by other applications. A
    // surviving child is recovered only when its private name, UID and config match us.
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::ffi::OsStrExt;
        let _ = app;
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

#[cfg(target_os = "windows")]
mod job {
    use std::ffi::OsString;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStringExt;
    use std::path::PathBuf;
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_SYNCHRONIZE,
        PROCESS_TERMINATE,
    };

    struct Job(HANDLE);
    // 句柄在进程生命周期内只读使用
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Option<Job>> = OnceLock::new();

    fn job() -> Option<HANDLE> {
        JOB.get_or_init(|| unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(handle);
                return None;
            }
            Some(Job(handle))
        })
        .as_ref()
        .map(|job| job.0)
    }

    /// 只把内核放进作业对象,不放应用自己:否则更新安装程序也会被连带杀掉
    pub fn attach(pid: u32) {
        let Some(job) = job() else {
            return;
        };
        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if !process.is_null() {
                AssignProcessToJobObject(job, process);
                CloseHandle(process);
            }
        }
    }

    fn own_kernel_paths() -> Vec<PathBuf> {
        let Ok(exe) = std::env::current_exe() else {
            return Vec::new();
        };
        let Some(dir) = exe.parent() else {
            return Vec::new();
        };
        vec![
            dir.join("sing-box.exe"),
            dir.join("sing-box-x86_64-pc-windows-msvc.exe"),
        ]
    }

    fn image_path(process: HANDLE) -> Option<PathBuf> {
        let mut buffer = [0u16; 1024];
        let mut length = buffer.len() as u32;
        let ok = unsafe {
            QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length)
        };
        (ok != 0).then(|| PathBuf::from(OsString::from_wide(&buffer[..length as usize])))
    }

    fn same_path(a: &std::path::Path, b: &std::path::Path) -> bool {
        a.to_string_lossy()
            .trim_start_matches(r"\\?\")
            .eq_ignore_ascii_case(b.to_string_lossy().trim_start_matches(r"\\?\"))
    }

    /// 按完整路径匹配,绝不用 taskkill /IM:那会杀掉其他软件自带的 sing-box。
    /// 打不开的进程(比如权限更高的)直接跳过。
    pub fn kill_strays() {
        let targets = own_kernel_paths();
        if targets.is_empty() {
            return;
        }
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return;
            }
            let mut entry: PROCESSENTRY32W = zeroed();
            entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
            let mut more = Process32FirstW(snapshot, &mut entry) != 0;
            while more {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..end]);
                if name.to_ascii_lowercase().starts_with("sing-box") {
                    let process = OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
                        0,
                        entry.th32ProcessID,
                    );
                    if !process.is_null() {
                        if image_path(process)
                            .is_some_and(|path| targets.iter().any(|t| same_path(t, &path)))
                        {
                            TerminateProcess(process, 1);
                            WaitForSingleObject(process, 2000);
                        }
                        CloseHandle(process);
                    }
                }
                more = Process32NextW(snapshot, &mut entry) != 0;
            }
            CloseHandle(snapshot);
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_outbound_index_in_kernel_errors() {
        assert_eq!(
            failed_outbound("FATAL[0000] initialize outbound[2]: unknown method: x"),
            Some(2)
        );
        assert_eq!(
            failed_outbound("FATAL[0000] decode config at c.json: outbounds[12].nope: unknown"),
            Some(12)
        );
        assert_eq!(failed_outbound("FATAL[0000] parse inbound: bad"), None);
        assert_eq!(failed_outbound("outbound missing"), None);
    }

    #[test]
    fn dropping_a_node_cleans_every_reference() {
        let mut config = json!({
            "outbounds": [
                {"type": "selector", "tag": "proxy", "outbounds": ["a", "b"], "default": "b"},
                {"type": "selector", "tag": "steam", "outbounds": ["b"]},
                {"type": "shadowsocks", "tag": "a"},
                {"type": "shadowsocks", "tag": "b"},
                {"type": "direct", "tag": "direct"}
            ],
            "route": {"rules": [{"outbound": "b"}, {"outbound": "a"}], "final": "b"}
        });
        assert_eq!(drop_outbound(&mut config, 3).as_deref(), Some("b"));
        assert_eq!(config["outbounds"][0]["outbounds"], json!(["a"]));
        assert!(config["outbounds"][0].get("default").is_none());
        assert_eq!(config["outbounds"][1]["outbounds"], json!(["proxy"]));
        assert_eq!(config["route"]["rules"][0]["outbound"], "proxy");
        assert_eq!(config["route"]["rules"][1]["outbound"], "a");
        assert_eq!(config["route"]["final"], "proxy");
    }

    #[test]
    fn dropping_the_last_node_fails_instead_of_going_direct() {
        let mut config = json!({
            "outbounds": [
                {"type": "selector", "tag": "proxy", "outbounds": ["a"]},
                {"type": "shadowsocks", "tag": "a"},
                {"type": "direct", "tag": "direct"}
            ]
        });
        assert_eq!(drop_outbound(&mut config, 1), None);
    }

    #[test]
    fn built_in_outbounds_are_never_dropped() {
        let mut config = json!({
            "outbounds": [{"type": "direct", "tag": "direct"}]
        });
        assert_eq!(drop_outbound(&mut config, 0), None);
    }

    #[test]
    fn strips_terminal_colors() {
        assert_eq!(strip_ansi("\u{1b}[31mFATAL\u{1b}[0m[0000] x"), "FATAL[0000] x");
    }

    #[test]
    fn secrets_are_long_and_differ() {
        let (a, b) = (random_secret(), random_secret());
        assert_eq!(a.len(), 48);
        assert_ne!(a, b);
    }
}
