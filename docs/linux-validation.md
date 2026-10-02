# Linux 构建与验证记录

以下是 0.1.9 Linux 功能验收基线。当前客户端从 **1.0.0** 开始统一 Windows / Linux 版本与 Release;
版本清单、构建、Windows 更新签名和构件校验在统一发布流程中验证。
当前构件见 [统一 Release v1.0.0](https://github.com/TgolMsk/lcd-proxy/releases/tag/v1.0.0)。
1.0.0 的最终构件、发布流水线和安装验收见 [1.0.0 发布记录](release-1.0.0.md)。

验证日期:2026-10-02。目标为 Linux Mint 22.3 Cinnamon x86_64。
已完成 Linux 平台集成、构建 `.deb`/`.AppImage`,并实际运行两种安装包。

## 构建环境与产物

构建与运行使用独立的 Ubuntu 24.04 x86_64 虚拟机,GUI 使用 Xvfb/Openbox。
桌面代理测试使用隔离 D-Bus/dconf 会话和 `XDG_CURRENT_DESKTOP=X-Cinnamon`。
这验证了 Cinnamon 使用的 GSettings 接口,未代替 Linux Mint 实机验收。

- 客户端版本:LCD Proxy 0.1.9。
- 内核:官方 sing-box 1.12.4,下载时校验固定 SHA-256。
- 工具链:Rust 1.99.0、Node.js 22.23.3、GTK 3.24.41、WebKitGTK 2.52.6。
- 构建命令:`APPIMAGE_EXTRACT_AND_RUN=1 bash scripts/build-linux.sh`。
- 输出:[安装包与校验文件](../artifacts/linux/),[完整构建日志](../artifacts/linux/verification/build.log)。

| 文件 | SHA-256 |
| --- | --- |
| `LCD Proxy_0.1.9_amd64.deb` | `6a6a790a29edc3fc000f4eaa020900ff41d2d4cec00458bfab8cc7024c7edcb3` |
| `LCD Proxy_0.1.9_amd64.AppImage` | `837b25e57dbe9566b850ef48690f36db18600ceff867a9dc6b3cbf879ccc20ec` |

`artifacts/` 为本机构建输出,不进入 Git。两份安装包从 Linux 构建机复制后,
在 macOS 主机重新校验,结果一致。

## 实测结果

| 验证项 | 结果与证据 |
| --- | --- |
| 前端与构建 | 37 个单元测试通过;TypeScript/Vite 生产构建通过;生成两种安装包。 |
| Rust | Linux 常规测试 3 个通过;需要隔离会话的桌面代理测试另行执行并通过,覆盖重连、崩溃恢复、原设置还原及保留用户变更。见 [Rust 日志](../artifacts/linux/verification/rust-tests.log)。 |
| `.deb` 安装运行 | 使用 apt 安装最终包,普通用户启动 GUI、从本地 HTTP 服务拉取真实订阅、解析并保存节点。见 [桌面测试日志](../artifacts/linux/verification/desktop.log)。 |
| 实际代理流量 | 点击启动后 GSettings 指向本地端口;HTTP 和 SOCKS5 请求经客户端、真实 Shadowsocks 上游到达测试 HTTP 服务,核对响应正文与上游日志。 |
| 停止与异常恢复 | 停止恢复原自动代理;强杀内核自动恢复;强杀 GUI 后重启恢复备份并清理自己的孤儿内核,保留使用不同配置的其他代理进程。 |
| 窗口与退出 | Alt+F4 最小化窗口且代理继续运行;SIGTERM 正常退出,恢复桌面设置并停止内核。见 [退出测试日志](../artifacts/linux/verification/exit.log)。 |
| 单实例与文件权限 | 第二个实例聚焦已有实例;配置目录 0700,含凭据的配置与状态文件 0600。 |
| AppImage | 最终包使用 `--appimage-extract-and-run` 启动,通过订阅导入、真实 HTTP/SOCKS5 转发及停止恢复测试。见 [AppImage 日志](../artifacts/linux/verification/appimage.log)。 |
| TUN 转发 | 在临时网络命名空间中,普通用户的内核凭文件 capabilities 创建 TUN;未配置代理的 curl 请求经 TUN、Shadowsocks 到达测试服务;停止后接口删除。配置由项目实际配置生成器生成。见 [TUN 路由结果](../artifacts/linux/verification/tun-routing.txt)。 |
| TUN 授权 | 无认证代理时授权失败并回退开关;临时测试 Polkit 规则下,前端实际调用 pkexec 授权固定内核,GUI PID 保持不变;开关状态持久化。见 [权限测试结果](../artifacts/linux/verification/tun-permission.txt)。 |
| 图形渲染 | 虚拟显示中复现 DMABUF 白屏;加入 Linux 默认兼容设置后,最终安装包无需外部环境变量即可显示完整界面。见 [已连接截图](../artifacts/linux/verification/desktop-connected.png)。 |

测试结束后已删除临时 Polkit 规则、网络命名空间和虚拟网卡,撤销测试内核的 capabilities。
测试授权规则未进入源码或安装包。

## 构件安装入口

`scripts/install-linux.sh` 直接下载已发布的 x86_64 `.deb`,或通过 `--deb` 使用本地构件。
安装前核对脚本内固定的 SHA-256、包名称、版本和架构,校验后交给 apt 安装。
无需 Node.js、Rust 或源码构建。发行构件见
[Linux Release](https://github.com/TgolMsk/lcd-proxy/releases/tag/linux-v0.1.9)。

已验证本地构件校验通过,篡改构件被拒绝且未执行 apt。
随后在同一 Ubuntu 24.04 x86_64 虚拟机内使用安装脚本实际完成 apt 重装,
返回已安装版本 0.1.9。见 [构件安装日志](../artifacts/linux/verification/artifact-install.log)。

## 验证范围

Linux Mint 22.3 Cinnamon 实机上的显卡、托盘、真实密码认证弹窗仍需实机验证。
本次实际网络测试使用本地受控订阅与 Shadowsocks 服务,未验证用户的远程节点服务。
AppImage 测试使用解包运行方式,未验证 FUSE 挂载路径。ARM64 构建脚本已提供,
本次交付与运行测试均为 x86_64。

使用、TUN 权限与重新构建方法见 [Linux 使用与构建](linux.md)。
