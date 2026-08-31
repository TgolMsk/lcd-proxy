//! 管理员权限:检测当前进程是否提权;按需以管理员身份重启自身。
//! TUN 模式在 Windows 上创建虚拟网卡 + auto_route,必须管理员权限。
//! 策略:仅当用户开启 TUN 且当前未提权时,以管理员重启整个应用
//! (提权后 UI 与内核子进程同级,进程管理/杀内核仍正常)。

/// 当前进程是否具有管理员(提权)权限
#[cfg(target_os = "windows")]
pub fn is_elevated() -> bool {
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION {
            TokenIsElevated: 0,
        };
        let mut ret_len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            &mut elevation as *mut _ as *mut _,
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut ret_len,
        );
        CloseHandle(token);
        ok != 0 && elevation.TokenIsElevated != 0
    }
}

/// 以管理员身份重启自身:弹 UAC → 启动提权实例 → 硬退出当前实例(交接单实例锁)。
/// 前置要求:调用方(前端)已先干净断开连接,当前实例无内核/系统代理残留。
/// 成功不返回(进程已退出);用户取消 UAC 则返回 Err。
#[cfg(target_os = "windows")]
pub fn relaunch_as_admin() -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    if is_elevated() {
        return Ok(());
    }

    let exe = std::env::current_exe().map_err(|e| format!("获取自身路径失败:{e}"))?;

    // 宽字符串(UTF-16, null 结尾)
    let verb: Vec<u16> = "runas\0".encode_utf16().collect();
    let file: Vec<u16> = exe
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let params: Vec<u16> = "--elevated\0".encode_utf16().collect();

    let ret = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            params.as_ptr(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW 返回值 > 32 视为成功
    if (ret as isize) <= 32 {
        // 1223 = ERROR_CANCELLED(用户在 UAC 点了否)
        return Err("用户取消了管理员授权,TUN 模式需要管理员权限".into());
    }

    // 交接:硬退出当前(非提权)实例,让提权实例接管单实例锁
    std::process::exit(0);
}

// ---- 非 Windows(macOS/Linux 开发环境)----
// 开发时假装已提权,让 TUN 连接流程能走通做 UI 联调(占位内核会自然失败)。

#[cfg(not(target_os = "windows"))]
pub fn is_elevated() -> bool {
    true
}

#[cfg(not(target_os = "windows"))]
pub fn relaunch_as_admin() -> Result<(), String> {
    Err("以管理员身份重启仅 Windows 支持".into())
}
