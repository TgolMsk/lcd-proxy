//! 应用数据目录下的文件读写:sing-box 配置与本地数据。
//!
//! 本地数据分文件存放(settings.json、profiles.json、profiles/*.json)。
//! 每次写入都走「临时文件 → fsync → 旧文件转 .bak → 改名」:写到一半断电或崩溃,
//! 主文件要么是旧内容要么是新内容,读取时还能从 .bak 恢复。
//! 主文件和 .bak 都损坏时返回错误,绝不当成空数据,否则下一次保存会把用户数据覆盖掉。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

pub const DEFAULT_PORT: u16 = 10808;

/// 应用数据目录(不存在则创建)
pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录:{e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败:{e}"))?;
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("保护数据目录失败:{e}"))?;
    }
    Ok(dir)
}

/// 校验并写入 sing-box config.json,返回文件路径
pub fn write_config(app: &AppHandle, config_json: &str) -> Result<PathBuf, String> {
    serde_json::from_str::<serde_json::Value>(config_json)
        .map_err(|e| format!("配置 JSON 非法:{e}"))?;
    let path = data_dir(app)?.join("config.json");
    write_atomic(&path, config_json.as_bytes(), false)
        .map_err(|e| format!("写入配置文件失败:{e}"))?;
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

// ---------------- 本地数据 ----------------

#[derive(Serialize)]
pub struct StoreFile {
    pub content: String,
    /// true 表示主文件缺失或损坏,内容来自 .bak
    pub recovered: bool,
}

/// 校验相对路径:只允许一层子目录,防止前端传入 .. 或绝对路径
fn store_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let parts: Vec<&str> = name.split('/').collect();
    let valid = parts.len() <= 2
        && parts.iter().all(|p| {
            !p.is_empty()
                && !p.starts_with('.')
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        });
    if !valid {
        return Err(format!("非法的数据文件名:{name}"));
    }
    let mut path = data_dir(app)?;
    for part in parts {
        path.push(part);
    }
    Ok(path)
}

fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".bak");
    path.with_file_name(name)
}

fn is_valid_json(content: &str) -> bool {
    serde_json::from_str::<serde::de::IgnoredAny>(content).is_ok()
}

enum Slot {
    Missing,
    Corrupt,
    Valid(String),
}

fn read_slot(path: &Path) -> Slot {
    match fs::read_to_string(path) {
        Ok(content) if is_valid_json(&content) => Slot::Valid(content),
        Ok(_) => Slot::Corrupt,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Slot::Missing,
        Err(_) => Slot::Corrupt,
    }
}

fn read_with_backup(path: &Path) -> Result<Option<StoreFile>, String> {
    let main = read_slot(path);
    if let Slot::Valid(content) = main {
        return Ok(Some(StoreFile {
            content,
            recovered: false,
        }));
    }
    match (main, read_slot(&backup_path(path))) {
        (_, Slot::Valid(content)) => Ok(Some(StoreFile {
            content,
            recovered: true,
        })),
        (Slot::Missing, Slot::Missing) => Ok(None),
        _ => Err(format!(
            "数据文件已损坏,无法读取:{}",
            path.file_name().unwrap_or_default().to_string_lossy()
        )),
    }
}

pub fn store_read(app: &AppHandle, name: &str) -> Result<Option<StoreFile>, String> {
    read_with_backup(&store_path(app, name)?)
}

pub fn store_write(app: &AppHandle, name: &str, json: &str) -> Result<(), String> {
    if !is_valid_json(json) {
        return Err(format!("数据内容不是合法 JSON:{name}"));
    }
    let path = store_path(app, name)?;
    write_atomic(&path, json.as_bytes(), true).map_err(|e| format!("写入 {name} 失败:{e}"))
}

pub fn store_delete(app: &AppHandle, name: &str) -> Result<(), String> {
    let path = store_path(app, name)?;
    for target in [backup_path(&path), path] {
        match fs::remove_file(&target) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("删除 {name} 失败:{e}")),
        }
    }
    Ok(())
}

/// 把旧文件改名保留(迁移完成后用),目标已存在时覆盖
pub fn store_retire(app: &AppHandle, name: &str, new_name: &str) -> Result<(), String> {
    let from = store_path(app, name)?;
    if !from.exists() {
        return Ok(());
    }
    let to = store_path(app, new_name)?;
    rename_with_retry(&from, &to).map_err(|e| format!("保留旧文件失败:{e}"))
}

// Windows 上目标文件被杀毒软件或索引服务短暂占用时,改名会失败,需要重试
fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut last = None;
    for attempt in 0..6 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(Duration::from_millis(20 << attempt));
            }
        }
    }
    Err(last.unwrap())
}

fn write_atomic(path: &Path, contents: &[u8], keep_backup: bool) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    let pending = path.with_file_name(name);

    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&pending)?;
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(contents)?;
    file.sync_all()?;
    drop(file);

    if keep_backup && path.exists() {
        // .bak 只是保险,改名失败不影响本次写入
        let _ = rename_with_retry(path, &backup_path(path));
    }
    rename_with_retry(&pending, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lcd-store-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_keeps_previous_version_as_backup() {
        let dir = temp_dir("backup");
        let path = dir.join("settings.json");
        write_atomic(&path, b"{\"v\":1}", true).unwrap();
        write_atomic(&path, b"{\"v\":2}", true).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"v\":2}");
        assert_eq!(
            fs::read_to_string(backup_path(&path)).unwrap(),
            "{\"v\":1}"
        );
        assert!(!dir.join("settings.json.tmp").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn corrupt_main_recovers_from_backup() {
        let dir = temp_dir("recover");
        let path = dir.join("settings.json");
        write_atomic(&path, b"{\"v\":1}", true).unwrap();
        write_atomic(&path, b"{\"v\":2}", true).unwrap();
        fs::write(&path, "{\"v\":2").unwrap(); // 模拟写到一半
        let file = read_with_backup(&path).unwrap().unwrap();
        assert!(file.recovered);
        assert_eq!(file.content, "{\"v\":1}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_main_recovers_from_backup() {
        let dir = temp_dir("missing");
        let path = dir.join("settings.json");
        fs::write(backup_path(&path), "{\"v\":1}").unwrap();
        assert!(read_with_backup(&path).unwrap().unwrap().recovered);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn nothing_on_disk_is_not_an_error() {
        let dir = temp_dir("empty");
        assert!(read_with_backup(&dir.join("settings.json")).unwrap().is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn both_corrupt_is_an_error_not_empty_data() {
        let dir = temp_dir("corrupt");
        let path = dir.join("settings.json");
        fs::write(&path, "oops").unwrap();
        fs::write(backup_path(&path), "oops").unwrap();
        assert!(read_with_backup(&path).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn credentials_remain_private_after_replacing_existing_state() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("private");
        let path = dir.join("state.json");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        write_atomic(&path, b"new-state", false).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new-state");
        assert_eq!(path.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        fs::remove_dir_all(dir).unwrap();
    }
}
