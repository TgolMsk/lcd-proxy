//! sing-box 配置文件与本地状态文件的读写。
//! 配置 JSON 由前端 `buildSingBoxConfig` 生成,这里负责校验、落盘、提取端口。

use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub const DEFAULT_PORT: u16 = 10808;

/// 应用数据目录(不存在则创建)
pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录:{e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败:{e}"))?;
    Ok(dir)
}

/// 校验并写入 sing-box config.json,返回文件路径
pub fn write_config(app: &AppHandle, config_json: &str) -> Result<PathBuf, String> {
    serde_json::from_str::<serde_json::Value>(config_json)
        .map_err(|e| format!("配置 JSON 非法:{e}"))?;
    let path = data_dir(app)?.join("config.json");
    fs::write(&path, config_json).map_err(|e| format!("写入配置文件失败:{e}"))?;
    Ok(path)
}

/// 从配置中提取 mixed 入站端口(用于就绪探测与端口占用检查)
pub fn extract_port(config_json: &str) -> u16 {
    let parsed: serde_json::Value = match serde_json::from_str(config_json) {
        Ok(v) => v,
        Err(_) => return DEFAULT_PORT,
    };
    parsed["inbounds"]
        .as_array()
        .and_then(|arr| {
            arr.iter()
                .find(|inb| inb["type"] == "mixed")
                .and_then(|inb| inb["listen_port"].as_u64())
        })
        .map(|p| p as u16)
        .unwrap_or(DEFAULT_PORT)
}

/// 本地状态文件(节点列表、订阅链接等)
pub fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("state.json"))
}

pub fn load_state_file(app: &AppHandle) -> Result<String, String> {
    let path = state_path(app)?;
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&path).map_err(|e| format!("读取状态文件失败:{e}"))
}

pub fn save_state_file(app: &AppHandle, json: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(json)
        .map_err(|e| format!("状态 JSON 非法:{e}"))?;
    let path = state_path(app)?;
    fs::write(&path, json).map_err(|e| format!("写入状态文件失败:{e}"))
}
