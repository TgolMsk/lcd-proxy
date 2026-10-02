# Linux Mint 22.3 Cinnamon 客户端

目标架构是 x86_64,构建产物为 `.deb` 与 `.AppImage`,包含 sing-box 1.12.4。
复用现有订阅、VLESS、Shadowsocks、测速、主题、节点持久化与托盘功能。
官方 sing-box 1.12.4 不支持 SSR 出站,既有 SSR 解析功能不代表内核能连接 SSR。

## 安装与使用

已发布的构件见 [Linux Release](https://github.com/TgolMsk/lcd-proxy/releases/tag/v1.0.0)。
构件安装器可直接下载安装包,核对同版本 SHA256SUMS 中的 SHA-256 与包版本、架构,再通过 apt 安装:

```sh
curl -fL https://github.com/TgolMsk/lcd-proxy/releases/latest/download/install-linux.sh -o install-linux.sh
bash install-linux.sh
```

安装器仅在执行 apt 时请求 sudo,安装后从应用菜单启动客户端。
已有本地构件时,无需重新下载客户端:

```sh
bash scripts/install-linux.sh --deb "./artifacts/linux/LCD Proxy_1.0.0_amd64.deb"
# 仅验证构件而不安装:
bash scripts/install-linux.sh --deb "./artifacts/linux/LCD Proxy_1.0.0_amd64.deb" --verify-only
```

推荐 `.deb`,可由 Mint 软件包安装器打开,或运行:

```sh
sudo apt install ./lcd-proxy_1.0.0_amd64.deb
```

应用菜单启动 LCD Proxy → 导入订阅/分享链接 → 选择节点 → 启动。
停止代理后恢复连接前的桌面设置,包括原代理模式、服务器、端口与绕过列表。
用户连接期间手动修改的设置会保留。异常强杀的恢复发生在下次启动应用时。

便携包运行方式:

```sh
chmod +x ./*.AppImage
./lcd-proxy_1.0.0_amd64.AppImage
# 如果系统提示缺少 FUSE,可使用 --appimage-extract-and-run 参数
```

Cinnamon 控制中心与客户端读取相同的 `org.gnome.system.proxy` GSettings。
系统代理涵盖读取桌面设置的程序;终端程序可以显式设置:

```sh
HTTPS_PROXY=http://127.0.0.1:10808 curl https://example.com
curl --proxy socks5h://127.0.0.1:10808 https://example.com
```

Linux 关闭按钮会最小化到任务栏,可从任务栏恢复;也可使用托盘菜单。
退出应用使用托盘的「退出」。桌面不提供托盘时,任务栏仍保留窗口入口。

## TUN 权限

安装 `.deb` 后开启 TUN,系统会通过 Polkit 弹出身份验证窗口。
授权只为 root 所有的 `/usr/bin/lcd-proxy-core` 添加
`cap_net_admin,cap_net_raw=ep`,不会以 root 重启 WebView、改变用户配置目录,
也不会给桌面界面授予管理员权限。

取消授权会回退系统代理模式。更新安装包后内核 capabilities 可能被清除,
再次开启 TUN 即可重新授权。系统须提供 `/dev/net/tun` 和 Polkit 认证代理。

AppImage 位于只读挂载内且没有持久文件 capabilities,因此使用系统代理;
TUN 需要先安装 `.deb`。不要使用 `sudo` 启动图形应用。

## 本地构建

必须在 Linux 环境运行。Mint 22.x/Ubuntu 24.04 的依赖安装命令:

```sh
sudo apt update
sudo apt install build-essential curl wget file pkg-config libwebkit2gtk-4.1-dev \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
  libcap2-bin pkexec patchelf
# 安装 Node.js (>=18) 与 Rust stable 后:
npm run build:linux
```

脚本下载官方内核并比对固定 SHA-256,执行前端测试并构建客户端。
产物与 SHA256SUMS 存在 `artifacts/linux/`,原始产物在
`src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/`。
ARM64 Linux 主机构建时会自动选择 ARM64 内核与目标。

GitHub Actions 的 `Release (Windows + Linux)` 在推送 `v1.0.0` 这样的统一版本标签时,
构建 Windows 与 Linux,验证后发布到同一个 Release。独立的 `Build Linux (Manual)`
仅用于手动构建诊断,产物保存在 Actions artifacts。
Linux 包当前没有发布更新清单,应手动安装新包;Windows 更新配置保留。

## 验证命令

```sh
npm test
cargo test --locked --manifest-path src-tauri/Cargo.toml
# 仅在一次性测试用户/虚拟机运行,该测试实际改写桌面代理:
dbus-run-session -- env XDG_CURRENT_DESKTOP=X-Cinnamon \
  cargo test --locked --manifest-path src-tauri/Cargo.toml \
  desktop_proxy_restores_after_reconnect_and_crash -- --ignored --nocapture
```

## 故障排查

应用数据位于 `${XDG_DATA_HOME:-~/.local/share}/com.lcdproxy.app/`,
包含 `state.json`、`config.json`、`kernel.log` 与活动连接的 `proxy-backup.json`。
UI 中的配置目录入口可打开它。端口占用会阻止启动,不会杀死其他应用的代理内核。

若强杀应用后网络异常,重新打开 LCD Proxy 即可恢复备份。
系统代理写入失败时不会显示「系统代理已生效」,会停止刚启动的内核并给出错误。
不支持自动代理设置的 KDE/Xfce 桌面应使用 `.deb` 的 TUN 模式。

Linux 默认使用 WebKit DMABUF 兼容渲染路径,已验证能解决虚拟显示中的白屏。
如需在已确认驱动正常的机器上恢复 DMABUF,可用
`WEBKIT_DISABLE_DMABUF_RENDERER=0 lcd-proxy` 启动。
相关背景见 [Tauri Linux 图形兼容说明](https://v2.tauri.app/develop/debug/linux-graphics/)。
