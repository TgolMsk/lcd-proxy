//! Only touch settings owned by this connection; persist the original values before
//! the first write so a crash can be recovered on the next launch.

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

static PROXY: OnceLock<Mutex<DesktopProxy>> = OnceLock::new();

#[derive(Debug, Serialize, Deserialize)]
struct Setting {
    schema: String,
    key: String,
    original: String,
    applied: String,
}

pub struct DesktopProxy {
    backup_path: PathBuf,
}

fn gsettings(args: &[&str]) -> Result<String, String> {
    // This is a host utility. AppImage's bundled GLib must not be used to load
    // the host dconf module (the two versions can have incompatible symbols).
    let mut command = Command::new("/usr/bin/gsettings");
    for variable in [
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
        "GIO_MODULE_DIR",
        "GIO_EXTRA_MODULES",
        "GSETTINGS_SCHEMA_DIR",
        "GTK_PATH",
        "GTK_EXE_PREFIX",
        "GTK_DATA_PREFIX",
        "GDK_PIXBUF_MODULE_FILE",
    ] {
        command.env_remove(variable);
    }
    let output = command
        .args(args)
        .output()
        .map_err(|e| format!("无法运行 gsettings:{e}。请安装 libglib2.0-bin"))?;
    if !output.status.success() {
        return Err(format!(
            "桌面代理设置失败:{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn write_setting(schema: &str, key: &str, value: &str) -> Result<(), String> {
    gsettings(&["set", schema, key, value])?;
    // gsettings can exit successfully even if dconf failed to commit.
    if gsettings(&["get", schema, key])? != value {
        return Err(format!(
            "{schema} {key} 写入后校验失败,请检查桌面 D-Bus/dconf 会话"
        ));
    }
    Ok(())
}

fn proxy_address(server: &str) -> Result<(String, u16), String> {
    let address: std::net::SocketAddr = server
        .parse()
        .map_err(|_| "代理地址必须是回环 IP:端口,例如 127.0.0.1:10808".to_string())?;
    if !address.ip().is_loopback() || address.port() == 0 {
        return Err("系统代理仅允许非零端口的本机回环地址".into());
    }
    Ok((address.ip().to_string(), address.port()))
}

fn desktop_schema() -> Result<&'static str, String> {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .to_lowercase();
    if desktop.contains("kde") || desktop.contains("xfce") {
        return Err("当前桌面暂不支持自动设置系统代理。请使用 .deb 的 TUN 模式".into());
    }
    let schemas = gsettings(&["list-schemas"])?;
    let has = |schema: &str| schemas.lines().any(|line| line == schema);
    if desktop.contains("cinnamon") && has("org.cinnamon.desktop.proxy") {
        return Ok("org.cinnamon.desktop.proxy");
    }
    if has("org.gnome.system.proxy") {
        return Ok("org.gnome.system.proxy");
    }
    if has("org.cinnamon.desktop.proxy") {
        return Ok("org.cinnamon.desktop.proxy");
    }
    Err("缺少 GNOME/Cinnamon 代理设置 schema,请安装 gsettings-desktop-schemas 或使用 .deb 的 TUN 模式".into())
}

impl DesktopProxy {
    pub fn new(backup_path: PathBuf) -> Self {
        Self { backup_path }
    }

    pub fn enable(&self, server: &str) -> Result<(), String> {
        let (host, port) = proxy_address(server)?;
        // A second connection must restore the first snapshot before taking another.
        self.restore()?;
        let schema = desktop_schema()?;
        let mut changes = vec![
            (schema.to_string(), "use-same-proxy", "false".to_string()),
            (
                schema.to_string(),
                "ignore-hosts",
                "['localhost', '127.0.0.0/8', '::1', '*.local', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']".to_string(),
            ),
        ];
        for protocol in ["http", "https", "socks", "ftp"] {
            let child = format!("{schema}.{protocol}");
            // Some newer desktop schemas omit FTP.
            if protocol == "ftp" && gsettings(&["list-keys", &child]).is_err() {
                continue;
            }
            changes.push((child.clone(), "host", format!("'{host}'")));
            changes.push((child, "port", port.to_string()));
        }
        changes.push((
            format!("{schema}.http"),
            "use-authentication",
            "false".into(),
        ));
        // Activate last, after every endpoint is configured.
        changes.push((schema.to_string(), "mode", "'manual'".into()));

        let mut settings = Vec::new();
        for (schema, key, applied) in changes {
            if gsettings(&["writable", &schema, key])? != "true" {
                return Err(format!("系统策略禁止修改 {schema} {key}"));
            }
            settings.push(Setting {
                original: gsettings(&["get", &schema, key])?,
                schema,
                key: key.into(),
                applied,
            });
        }
        let pending = self.backup_path.with_extension("tmp");
        fs::write(
            &pending,
            serde_json::to_vec(&settings).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("保存原代理设置失败:{e}"))?;
        fs::rename(&pending, &self.backup_path).map_err(|e| format!("保存原代理设置失败:{e}"))?;

        for setting in &settings {
            if let Err(error) = write_setting(&setting.schema, &setting.key, &setting.applied) {
                let recovery = self.restore();
                return Err(match recovery {
                    Ok(()) => error,
                    Err(e) => format!("{error};恢复原设置失败:{e}"),
                });
            }
        }
        Ok(())
    }

    pub fn restore(&self) -> Result<(), String> {
        let bytes = match fs::read(&self.backup_path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(format!("读取原代理设置失败:{e}")),
        };
        let settings: Vec<Setting> =
            serde_json::from_slice(&bytes).map_err(|e| format!("原代理备份损坏:{e}"))?;
        let mut errors = Vec::new();
        // Disable/restore the mode first. Do not overwrite changes the user made
        // in desktop settings while the client was connected.
        for setting in settings.iter().rev() {
            let result = (|| {
                if gsettings(&["get", &setting.schema, &setting.key])? == setting.applied {
                    write_setting(&setting.schema, &setting.key, &setting.original)?;
                }
                Ok::<(), String>(())
            })();
            if let Err(error) = result {
                errors.push(error);
            }
        }
        if !errors.is_empty() {
            return Err(errors.join("; "));
        }
        fs::remove_file(&self.backup_path).map_err(|e| format!("移除原代理备份失败:{e}"))
    }
}

pub fn init(backup_path: PathBuf) -> Result<(), String> {
    let proxy = PROXY.get_or_init(|| Mutex::new(DesktopProxy::new(backup_path)));
    proxy.lock().map_err(|e| e.to_string())?.restore()
}

pub fn set(enable: bool, server: &str) -> Result<(), String> {
    let proxy = PROXY.get().ok_or("Linux 系统代理尚未初始化")?;
    let proxy = proxy.lock().map_err(|e| e.to_string())?;
    if enable {
        proxy.enable(server)
    } else {
        proxy.restore()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loopback_endpoints_are_accepted() {
        assert_eq!(proxy_address("127.0.0.1:10808").unwrap().1, 10808);
        assert!(proxy_address("[::1]:10808").is_ok());
        for invalid in [
            "localhost:10808",
            "127.0.0.1:0",
            "192.168.1.1:80",
            "127.0.0.1:1;id",
        ] {
            assert!(proxy_address(invalid).is_err(), "{invalid}");
        }
    }

    // Run explicitly inside a disposable desktop D-Bus session; never change
    // the developer's real proxy settings during ordinary cargo test.
    #[test]
    #[ignore = "requires isolated D-Bus/dconf session"]
    fn desktop_proxy_restores_after_reconnect_and_crash() {
        let schema = desktop_schema().unwrap();
        let original = gsettings(&["get", schema, "mode"]).unwrap();
        gsettings(&["set", schema, "mode", "'auto'"]).unwrap();
        let path = std::env::temp_dir().join(format!("lcd-proxy-test-{}.json", std::process::id()));
        let proxy = DesktopProxy::new(path.clone());
        proxy.enable("127.0.0.1:10808").unwrap();
        let saved: Vec<Setting> = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(gsettings(&["get", schema, "mode"]).unwrap(), "'manual'");
        assert_eq!(
            gsettings(&["get", &format!("{schema}.http"), "port"]).unwrap(),
            "10808"
        );
        proxy.enable("127.0.0.1:10809").unwrap();
        // A fresh manager simulates recovery after the previous process crashed.
        DesktopProxy::new(path.clone()).restore().unwrap();
        assert_eq!(gsettings(&["get", schema, "mode"]).unwrap(), "'auto'");
        assert!(!path.exists());
        for setting in saved {
            assert_eq!(
                gsettings(&["get", &setting.schema, &setting.key]).unwrap(),
                setting.original
            );
        }
        proxy.enable("127.0.0.1:10808").unwrap();
        gsettings(&["set", schema, "mode", "'none'"]).unwrap();
        proxy.restore().unwrap();
        assert_eq!(gsettings(&["get", schema, "mode"]).unwrap(), "'none'");
        proxy.restore().unwrap();
        gsettings(&["set", schema, "mode", &original]).unwrap();
    }
}
