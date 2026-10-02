//! Grant network capabilities to the root-owned .deb sidecar only. The WebView
//! and state files remain in the ordinary user's desktop session.

use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::process::Command;

pub fn core_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let parent = exe.parent().ok_or("无法定位内核目录")?;
    // Rust unit test executables live under target/*/deps.
    let parent = if parent.ends_with("deps") {
        parent.parent().ok_or("无法定位内核目录")?
    } else {
        parent
    };
    Ok(parent.join("lcd-proxy-core"))
}

fn has_network_caps(value: &str) -> bool {
    value.split_whitespace().skip(1).any(|entry| {
        let Some((names, flags)) = entry.split_once('=') else {
            return false;
        };
        names.split(',').any(|name| name == "cap_net_admin")
            && names.split(',').any(|name| name == "cap_net_raw")
            && flags.contains('e')
            && flags.contains('p')
    })
}

pub fn is_elevated() -> bool {
    let Ok(path) = core_path() else {
        return false;
    };
    let Ok(output) = Command::new("/usr/sbin/getcap").arg(path).output() else {
        return false;
    };
    output.status.success() && has_network_caps(&String::from_utf8_lossy(&output.stdout))
}

pub fn relaunch_as_admin() -> Result<(), String> {
    if !std::path::Path::new("/dev/net/tun").exists() {
        return Err("系统缺少 /dev/net/tun,请加载 tun 内核模块后重试".into());
    }
    if is_elevated() {
        return Ok(());
    }
    let path = core_path()?
        .canonicalize()
        .map_err(|e| format!("定位内核失败:{e}"))?;
    let meta = path.metadata().map_err(|e| e.to_string())?;
    if path != std::path::Path::new("/usr/bin/lcd-proxy-core")
        || meta.uid() != 0
        || meta.mode() & 0o022 != 0
    {
        return Err(
            "Linux TUN 授权需要先安装 .deb 包。AppImage 可使用系统代理;不要以 root 启动图形界面"
                .into(),
        );
    }
    let output = Command::new("/usr/bin/pkexec")
        .args(["/usr/sbin/setcap", "cap_net_admin,cap_net_raw=ep"])
        .arg(&path)
        .output()
        .map_err(|e| format!("无法请求网络权限:{e}。请安装 pkexec 和 libcap2-bin"))?;
    if !output.status.success() {
        return Err("网络权限授权未完成或已取消,TUN 模式未开启".into());
    }
    if !is_elevated() {
        return Err("内核网络权限未生效,请确认 /usr 所在文件系统支持文件 capabilities".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_require_both_network_permissions_and_effective_flag() {
        assert!(has_network_caps(
            "/usr/bin/lcd-proxy-core cap_net_admin,cap_net_raw=ep\n"
        ));
        assert!(!has_network_caps(
            "/usr/bin/lcd-proxy-core cap_net_admin,cap_net_raw=p"
        ));
        assert!(!has_network_caps("/usr/bin/lcd-proxy-core cap_net_raw=ep"));
        assert!(!has_network_caps("/usr/bin/lcd-proxy-core"));
    }
}
