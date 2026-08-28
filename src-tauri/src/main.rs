//! LCD Proxy —— Tauri 入口:注册命令、系统托盘、退出清理。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod kernel;
mod sysproxy;

use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};

// ---------------- 命令 ----------------

#[tauri::command]
async fn start_kernel(app: AppHandle, config_json: String) -> Result<(), String> {
    kernel::start(app, config_json).await
}

#[tauri::command]
fn stop_kernel(state: State<'_, kernel::KernelState>) -> Result<(), String> {
    kernel::stop(&state)
}

#[tauri::command]
fn set_system_proxy(enable: bool, server: String) -> Result<(), String> {
    sysproxy::set(enable, &server)
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

/// 拉取订阅内容(在 Rust 侧发请求,避开 WebView 的 CORS 限制)
#[tauri::command]
async fn fetch_subscription(url: String) -> Result<String, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("订阅链接必须以 http:// 或 https:// 开头".into());
    }
    let client = reqwest::Client::builder()
        .user_agent("lcd-proxy/0.1 (sing-box)")
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败:{e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("请求失败:{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("服务器返回 HTTP {}", resp.status().as_u16()));
    }
    resp.text().await.map_err(|e| format!("读取响应失败:{e}"))
}

#[tauri::command]
fn load_state(app: AppHandle) -> Result<String, String> {
    config::load_state_file(&app)
}

#[tauri::command]
fn save_state(app: AppHandle, json: String) -> Result<(), String> {
    config::save_state_file(&app, &json)
}

// ---------------- 清理与托盘 ----------------

/// 退出前必做:杀内核 + 清系统代理(避免残留坏代理导致整机断网)
fn cleanup(app: &AppHandle) {
    let state = app.state::<kernel::KernelState>();
    let _ = kernel::stop(&state);
    let _ = sysproxy::set(false, "");
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
    tauri::Builder::default()
        // 单实例:双开会抢端口和系统代理,直接聚焦已有窗口
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .manage(kernel::KernelState::default())
        .invoke_handler(tauri::generate_handler![
            start_kernel,
            stop_kernel,
            set_system_proxy,
            tcp_ping,
            fetch_subscription,
            load_state,
            save_state,
        ])
        .setup(|app| {
            setup_tray(app.handle())?;
            Ok(())
        })
        // 点关闭 = 最小化到托盘,不退出
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
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
