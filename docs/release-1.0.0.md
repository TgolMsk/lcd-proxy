# LCD Proxy 1.0.0 发布验收

2026-10-02 起,Windows 与 Linux 使用相同版本号、`v1.0.0` 标签和
[一个公开 Release](https://github.com/TgolMsk/lcd-proxy/releases/tag/v1.0.0)。
旧版本保留为历史记录。后续版本由 `.github/workflows/release.yml` 统一发布;
独立 Linux 工作流仅保留手动构建。

## 发布文件

| 平台 | 构件 | SHA-256 |
| --- | --- | --- |
| Windows x64 | `LCD.Proxy_1.0.0_x64-setup.exe` | `fb256768cf44eeacc1c94d2509797615f2870f0880a0e8335e6367449b33451e` |
| Windows x64 | `LCD.Proxy_1.0.0_x64_en-US.msi` | `484d864b675f78cdc895fbacca66c178760df441c8aa1c61213ca9f1773e8870` |
| Linux x86_64 | `lcd-proxy_1.0.0_amd64.deb` | `8b1ad12bfdb7b1d81c917ac843b47a1dfdd97a8c901364ab145a64d27c2aed5d` |
| Linux x86_64 | `lcd-proxy_1.0.0_amd64.AppImage` | `28635d33c72ed59dd0b4cc61e9af5a9c2e8946118b14ea8e3b93e05c9b07a073` |

同一 Release 附带 Windows 更新签名、`latest.json`、`SHA256SUMS`
及 `install-linux.sh`。Windows 保留签名自动更新;Linux 使用构件安装。

## 已完成验证

- [原生构建](https://github.com/TgolMsk/lcd-proxy/actions/runs/37077706790):
  Windows runner 构建 MSI/NSIS,Linux Ubuntu 22.04 runner 构建 `.deb`/AppImage;
  前端 37 项测试、Linux Rust 测试和隔离桌面代理测试通过。
- [最终发布流水线](https://github.com/TgolMsk/lcd-proxy/actions/runs/37079232129):
  恢复上述构件后重新校验 MSI 产品版本、两份 Windows 更新签名与下载地址,
  在全部检查成功后公开 Release。
- Ubuntu 24.04 runner 实际安装 `.deb`,并分别运行 `.deb` 和 AppImage:
  界面版本为 1.0.0;从受控 HTTP 服务导入真实订阅并持久化节点;
  HTTP/SOCKS5 请求经客户端与真实 Shadowsocks 上游获得预期响应;
  停止还原原桌面代理,保留无关内核进程;客户端正常退出。
  测试脚本为 `scripts/test-linux-release.py`,截图与日志位于上述流水线的
  `linux-smoke-1.0.0` artifact。
- 本地 Ubuntu 24.04 x86_64 虚拟机再次完成固定 AppImage 的同样运行检查。
- 从公开 Release 下载全部 8 个有效载荷,逐一校验 SHA-256 通过。
  在本地 Linux 虚拟机下载公开的安装脚本,实际完成校验及 apt 安装,
  `dpkg-query` 返回 1.0.0。
- GitHub 的 latest Release 确认为 `v1.0.0`,非草稿、非预发布;
  更新清单与所有安装包使用相同版本。

AppImage 已修复其捆绑 GLib 环境影响宿主 `/usr/bin/gsettings` 的问题。
桌面代理命令清除捆绑库与模块路径,保留用户 D-Bus/dconf 会话。

本机最终构件与证据保存于忽略 Git 的 `artifacts/v1.0.0/`;
`verification/ci-final/` 为最终 CI 日志与截图,
`verification/online-install-final.log` 为公开构件安装记录。

## 验证范围

目标为 Linux Mint 22.3 Cinnamon x86_64。运行测试使用其 Ubuntu 24.04 基础环境
及隔离 GSettings 会话,尚未完成 Mint 实机显卡、托盘和密码授权弹窗验收。
AppImage 使用 `--appimage-extract-and-run`,未验证 FUSE 挂载方式。
Windows 已完成原生构建、版本和签名校验,尚未完成 Windows 实机 GUI/UAC/TUN 验收。
较早的 Linux TUN 与异常恢复测试见 [Linux 功能基线](linux-validation.md)。
