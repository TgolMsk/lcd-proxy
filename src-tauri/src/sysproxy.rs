//! 系统代理。
//! Windows:写注册表(ProxyEnable / ProxyServer / ProxyOverride)后广播 WinINet 变更。
//! 启用前把用户原有设置存成快照,停用时还原;进程崩溃后下次启动也能恢复,
//! 不会留下指向已退出内核的代理,也不会覆盖用户自己配置的代理。
//! Linux:GNOME/Cinnamon GSettings,同样保存并恢复原设置。

#[cfg(target_os = "linux")]
#[path = "sysproxy_linux.rs"]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::{init, set};

#[cfg(target_os = "windows")]
mod windows {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::OnceLock;

    use serde::{Deserialize, Serialize};
    use winreg::enums::{HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE};
    use winreg::RegKey;

    const REG_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    /// 直连地址:本机与全部私有网段不走代理
    const BYPASS: &str = "localhost;127.*;10.*;192.168.*;172.16.*;172.17.*;172.18.*;172.19.*;\
172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;\
172.30.*;172.31.*;*.lan;*.local;*.localdomain;*.home.arpa;*.internal;<local>";

    static BACKUP: OnceLock<PathBuf> = OnceLock::new();

    #[derive(Serialize, Deserialize)]
    struct Snapshot {
        enable: u32,
        server: Option<String>,
        bypass: Option<String>,
        pac: Option<String>,
        /// 本应用写入的代理地址,用来判断用户是否在连接期间改过设置
        applied: String,
    }

    fn key() -> Result<RegKey, String> {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(REG_PATH, KEY_SET_VALUE | KEY_QUERY_VALUE)
            .map_err(|e| format!("打开注册表失败:{e}"))
    }

    fn write_str(key: &RegKey, name: &str, value: &Option<String>) -> Result<(), String> {
        match value {
            Some(value) => key
                .set_value(name, value)
                .map_err(|e| format!("写 {name} 失败:{e}")),
            None => match key.delete_value(name) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("删 {name} 失败:{e}")),
            },
        }
    }

    /// 启动时调用:恢复上次异常退出遗留的代理设置
    pub fn init(backup_path: PathBuf, default_server: &str) -> Result<(), String> {
        let _ = BACKUP.set(backup_path);
        if backup()?.exists() {
            return restore();
        }
        // 旧版本没有快照:崩溃后注册表仍指向本机端口,内核已不在,会导致整机断网
        let key = key()?;
        let enabled = key.get_value::<u32, _>("ProxyEnable").unwrap_or(0) == 1;
        let server = key.get_value::<String, _>("ProxyServer").unwrap_or_default();
        if enabled && server == default_server {
            key.set_value("ProxyEnable", &0u32)
                .map_err(|e| format!("写 ProxyEnable 失败:{e}"))?;
            broadcast_change();
        }
        Ok(())
    }

    fn backup() -> Result<&'static PathBuf, String> {
        BACKUP.get().ok_or_else(|| "系统代理尚未初始化".to_string())
    }

    fn restore() -> Result<(), String> {
        let path = backup()?;
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(format!("读取原代理设置失败:{e}")),
        };
        let snapshot: Snapshot =
            serde_json::from_slice(&bytes).map_err(|e| format!("原代理设置已损坏:{e}"))?;
        let key = key()?;
        // 连接期间用户或别的软件改过代理就不覆盖,以现状为准
        let current = key.get_value::<String, _>("ProxyServer").ok();
        if current.as_deref() == Some(snapshot.applied.as_str()) {
            key.set_value("ProxyEnable", &snapshot.enable)
                .map_err(|e| format!("写 ProxyEnable 失败:{e}"))?;
            write_str(&key, "ProxyServer", &snapshot.server)?;
            write_str(&key, "ProxyOverride", &snapshot.bypass)?;
            write_str(&key, "AutoConfigURL", &snapshot.pac)?;
            broadcast_change();
        }
        fs::remove_file(path).map_err(|e| format!("移除原代理设置失败:{e}"))
    }

    fn save_snapshot(path: &PathBuf, snapshot: &Snapshot) -> Result<(), String> {
        let bytes = serde_json::to_vec(snapshot).map_err(|e| e.to_string())?;
        let pending = path.with_extension("tmp");
        fs::write(&pending, bytes).map_err(|e| format!("保存原代理设置失败:{e}"))?;
        fs::rename(&pending, path).map_err(|e| format!("保存原代理设置失败:{e}"))
    }

    pub fn set(enable: bool, server: &str) -> Result<(), String> {
        if !enable {
            return restore();
        }
        if server.is_empty() {
            return Err("代理地址为空".into());
        }
        let path = backup()?;
        let key = key()?;
        // 已有快照说明正在接管中(重连、换端口),不能用自己写的值覆盖用户原设置
        let snapshot = match fs::read(path) {
            Ok(bytes) => {
                let mut snapshot: Snapshot = serde_json::from_slice(&bytes)
                    .map_err(|e| format!("原代理设置已损坏:{e}"))?;
                snapshot.applied = server.to_string();
                snapshot
            }
            Err(_) => Snapshot {
                enable: key.get_value("ProxyEnable").unwrap_or(0),
                server: key.get_value("ProxyServer").ok(),
                bypass: key.get_value("ProxyOverride").ok(),
                pac: key.get_value("AutoConfigURL").ok(),
                applied: server.to_string(),
            },
        };
        save_snapshot(path, &snapshot)?;
        key.set_value("ProxyEnable", &1u32)
            .map_err(|e| format!("写 ProxyEnable 失败:{e}"))?;
        key.set_value("ProxyServer", &server)
            .map_err(|e| format!("写 ProxyServer 失败:{e}"))?;
        key.set_value("ProxyOverride", &BYPASS)
            .map_err(|e| format!("写 ProxyOverride 失败:{e}"))?;
        // PAC 优先于手动代理,不清掉的话系统代理不生效;快照里保留着,停用时还原
        write_str(&key, "AutoConfigURL", &None)?;
        broadcast_change();
        Ok(())
    }

    /// 通知系统「Internet 设置已变更」,否则浏览器等要重启才感知
    fn broadcast_change() {
        use core::ffi::c_void;
        #[link(name = "wininet")]
        extern "system" {
            fn InternetSetOptionW(
                hinternet: *mut c_void,
                dw_option: u32,
                lp_buffer: *mut c_void,
                dw_buffer_length: u32,
            ) -> i32;
        }
        const INTERNET_OPTION_REFRESH: u32 = 37;
        const INTERNET_OPTION_SETTINGS_CHANGED: u32 = 39;
        unsafe {
            InternetSetOptionW(
                core::ptr::null_mut(),
                INTERNET_OPTION_SETTINGS_CHANGED,
                core::ptr::null_mut(),
                0,
            );
            InternetSetOptionW(
                core::ptr::null_mut(),
                INTERNET_OPTION_REFRESH,
                core::ptr::null_mut(),
                0,
            );
        }
    }
}
#[cfg(target_os = "windows")]
pub use windows::{init, set};

// macOS 只用于开发:不动系统代理
#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub fn set(enable: bool, _server: &str) -> Result<(), String> {
    eprintln!("[sysproxy] 当前平台不设置系统代理(enable={enable})");
    Ok(())
}
