//! Windows 系统代理(注册表)读写。
//! 启用:ProxyEnable=1 + ProxyServer=127.0.0.1:10808;停用:ProxyEnable=0。
//! 改完通过 WinINet InternetSetOption 广播设置变更,立即生效。
//! 非 Windows 平台:空实现(开发模式直接放行,便于在 macOS 上调 UI)。

#[cfg(target_os = "windows")]
pub fn set(enable: bool, server: &str) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE};
    use winreg::RegKey;

    const REG_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    /// 直连地址:本机与常见内网段不走代理
    const BYPASS: &str = "localhost;127.*;192.168.*;10.*;172.16.*;172.17.*;<local>";

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey_with_flags(REG_PATH, KEY_SET_VALUE | KEY_QUERY_VALUE)
        .map_err(|e| format!("打开注册表失败:{e}"))?;

    if enable {
        if server.is_empty() {
            return Err("代理地址为空".into());
        }
        key.set_value("ProxyEnable", &1u32)
            .map_err(|e| format!("写 ProxyEnable 失败:{e}"))?;
        key.set_value("ProxyServer", &server)
            .map_err(|e| format!("写 ProxyServer 失败:{e}"))?;
        key.set_value("ProxyOverride", &BYPASS)
            .map_err(|e| format!("写 ProxyOverride 失败:{e}"))?;
    } else {
        key.set_value("ProxyEnable", &0u32)
            .map_err(|e| format!("写 ProxyEnable 失败:{e}"))?;
    }

    broadcast_change();
    Ok(())
}

/// 通知系统「Internet 设置已变更」,否则浏览器等要重启才感知
#[cfg(target_os = "windows")]
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

#[cfg(not(target_os = "windows"))]
pub fn set(enable: bool, _server: &str) -> Result<(), String> {
    // macOS/Linux 开发环境:不改系统代理,仅打日志
    eprintln!(
        "[sysproxy] 非 Windows 平台,跳过系统代理设置(enable={enable})——仅 Windows 正式支持"
    );
    Ok(())
}
