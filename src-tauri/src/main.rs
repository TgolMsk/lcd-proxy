//! LCD Proxy —— Tauri 入口:注册命令、系统托盘、退出清理。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod elevate;
mod fetch;
mod kernel;
mod sysproxy;

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};

// ---------------- 命令 ----------------

#[tauri::command]
async fn start_kernel(app: AppHandle, config_json: String) -> Result<kernel::StartReport, String> {
    kernel::start(app, config_json).await
}

#[tauri::command]
async fn stop_kernel(app: AppHandle) -> Result<(), String> {
    kernel::stop_and_wait(&app.state::<kernel::KernelState>()).await
}

#[tauri::command]
async fn kernel_api(
    app: AppHandle,
    method: String,
    path: String,
    body: Option<String>,
    timeout_ms: u64,
) -> Result<String, String> {
    let state = app.state::<kernel::KernelState>();
    kernel::api_request(&state, &method, &path, body, timeout_ms).await
}

#[tauri::command]
fn kernel_logs(state: State<'_, kernel::KernelState>) -> Vec<String> {
    state.logs()
}

#[tauri::command]
fn set_system_proxy(enable: bool, server: String) -> Result<(), String> {
    sysproxy::set(enable, &server)
}

/// 当前进程是否具管理员权限(TUN 模式前置检查)
#[tauri::command]
fn is_elevated() -> bool {
    elevate::is_elevated()
}

/// 以管理员身份重启自身(开启 TUN 时按需调用)。成功后当前实例即退出。
#[tauri::command]
fn relaunch_as_admin(app: AppHandle) -> Result<(), String> {
    // 提权是硬退出(process::exit),会绕过 Tauri 退出清理。
    // 这里先杀内核 + 清残留 + 清系统代理,避免孤儿内核占住 10808 端口。
    let state = app.state::<kernel::KernelState>();
    let _ = kernel::stop(&state);
    kernel::kill_stray_kernels(&app);
    let _ = sysproxy::set(false, "");
    elevate::relaunch_as_admin()
}

/// TCP 连接测延迟,返回毫秒
#[tauri::command]
async fn tcp_ping(host: String, port: u16, timeout_ms: u64) -> Result<u64, String> {
    let start = Instant::now();
    match tokio::time::timeout(
        Duration::from_millis(timeout_ms.clamp(100, 15_000)),
        tokio::net::TcpStream::connect((host.as_str(), port)),
    )
    .await
    {
        Ok(Ok(_)) => Ok(start.elapsed().as_millis() as u64),
        Ok(Err(e)) => Err(format!("连接失败:{e}")),
        Err(_) => Err("超时".into()),
    }
}

/// 下载订阅或规则文件
#[tauri::command]
async fn fetch_subscription(app: AppHandle, url: String) -> Result<fetch::Fetched, String> {
    let port = app.state::<kernel::KernelState>().proxy_port();
    fetch::fetch(&url, port).await
}

/// 更新前清理:停内核并等它退出,清系统代理。
/// 否则安装包无法覆盖正在运行(被占用)的 sing-box.exe,报 "Error opening file for writing"。
#[tauri::command]
async fn prepare_update(app: AppHandle) -> Result<(), String> {
    let _ = kernel::stop_and_wait(&app.state::<kernel::KernelState>()).await;
    kernel::kill_stray_kernels(&app);
    let _ = sysproxy::set(false, "");
    Ok(())
}

/// 打开应用数据目录(内含 config.json / kernel.log),便于排查
#[tauri::command]
fn reveal_config_dir(app: AppHandle) -> Result<(), String> {
    let dir = config::data_dir(&app)?;
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("explorer").arg(&dir).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&dir).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(&dir).spawn();
    r.map(|_| ()).map_err(|e| format!("打开目录失败:{e}"))
}

// 存储命令放到线程池执行(async):fsync 不能卡住主线程;
// STORE_LOCK 保证同一时刻只有一个写入,临时文件不会互相覆盖。
static STORE_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command(async)]
fn store_read(app: AppHandle, name: String) -> Result<Option<config::StoreFile>, String> {
    let _guard = STORE_LOCK.lock().unwrap();
    config::store_read(&app, &name)
}

#[tauri::command(async)]
fn store_write(app: AppHandle, name: String, json: String) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().unwrap();
    config::store_write(&app, &name, &json)
}

#[tauri::command(async)]
fn store_delete(app: AppHandle, name: String) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().unwrap();
    config::store_delete(&app, &name)
}

#[tauri::command(async)]
fn store_retire(app: AppHandle, name: String, new_name: String) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().unwrap();
    config::store_retire(&app, &name, &new_name)
}

// ---------------- 清理与托盘 ----------------

/// 退出前必做:杀内核 + 清系统代理(避免残留坏代理导致整机断网)
fn cleanup(app: &AppHandle) {
    let state = app.state::<kernel::KernelState>();
    let _ = kernel::stop(&state);
    let _ = sysproxy::set(false, "");
}

#[cfg(target_os = "linux")]
fn setup_exit_signals(app: &AppHandle) {
    use tokio::signal::unix::{signal, SignalKind};
    for kind in [SignalKind::terminate(), SignalKind::interrupt()] {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            match signal(kind) {
                Ok(mut events) => {
                    if events.recv().await.is_some() {
                        cleanup(&app);
                        app.exit(0);
                    }
                }
                Err(error) => eprintln!("无法注册退出信号:{error}"),
            }
        });
    }
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主界面", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "启动代理", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "停止代理", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &start, &stop, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("LCD Proxy")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "start" => {
                let _ = app.emit("tray-start", ());
            }
            "stop" => {
                let _ = app.emit("tray-stop", ());
            }
            "quit" => {
                cleanup(app);
                app.exit(0);
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn main() {
    // Verified on Linux's virtual display: WebKit's DMABUF path can show a
    // white window while the DOM remains active. Use the compatible renderer,
    // preserving an explicit user override for machines with working drivers.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    tauri::Builder::default()
        // 单实例:双开会抢端口和系统代理,直接聚焦已有窗口
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(kernel::KernelState::default())
        .invoke_handler(tauri::generate_handler![
            start_kernel,
            stop_kernel,
            kernel_api,
            kernel_logs,
            set_system_proxy,
            is_elevated,
            relaunch_as_admin,
            reveal_config_dir,
            prepare_update,
            tcp_ping,
            fetch_subscription,
            store_read,
            store_write,
            store_delete,
            store_retire,
        ])
        .setup(|app| {
            #[cfg(target_os = "linux")]
            setup_exit_signals(app.handle());
            // 上次异常退出时恢复用户原来的系统代理
            #[cfg(target_os = "linux")]
            let restored =
                sysproxy::init(config::data_dir(app.handle())?.join("proxy-backup.json"));
            #[cfg(target_os = "windows")]
            let restored = sysproxy::init(
                config::data_dir(app.handle())?.join("proxy-backup.json"),
                &format!("127.0.0.1:{}", config::DEFAULT_PORT),
            );
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            if let Err(error) = restored {
                eprintln!("恢复上次系统代理失败:{error}");
            }
            // 清掉上次异常退出残留的孤儿内核,避免占用端口
            kernel::kill_stray_kernels(app.handle());
            #[cfg(target_os = "linux")]
            if let Err(error) = setup_tray(app.handle()) {
                eprintln!("桌面托盘不可用:{error}");
            }
            #[cfg(not(target_os = "linux"))]
            setup_tray(app.handle())?;
            Ok(())
        })
        // 点关闭 = 最小化到托盘,不退出
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                // Some Linux desktops have no indicator host. Keep the taskbar
                // entry available so closing never makes the app unreachable.
                #[cfg(target_os = "linux")]
                let _ = window.minimize();
                #[cfg(not(target_os = "linux"))]
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("Tauri 应用构建失败")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                cleanup(app);
            }
        });
}
