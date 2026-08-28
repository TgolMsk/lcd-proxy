# LCD Proxy · 黑绿荧光屏订阅式代理客户端

> **打开客户端 → 在列表里选一个节点 → 点击启动 → 系统代理生效。**
> 视觉:老式单色液晶屏 / 绿色荧光终端。内核:sing-box。框架:Tauri 2。

- 支持 **VLESS(TLS/WS/gRPC/Reality)、Shadowsocks(SIP002 + 旧格式)、ShadowsocksR** 分享链接
- 订阅链接拉取(base64/明文自动识别)+ 手动粘贴导入,节点存本地 JSON
- 启动/切换自动重启内核、写 Windows 注册表系统代理,退出自动清理
- TCP 连接测速、系统托盘(启动/停止/退出)、单实例、TUN 模式预留开关

## 技术栈

| 层 | 选型 |
|----|------|
| 框架 | Tauri 2.x(Rust 后端 + React/TS/Vite 前端) |
| 内核 | sing-box(sidecar 方式打包,`src-tauri/binaries/`) |
| UI | 纯 CSS 实现 LCD 黑绿风(JetBrains Mono + DSEG7 数码管字体,已本地打包) |
| 存储 | 应用数据目录下 `state.json` / `config.json` |
| 系统代理 | 注册表 `ProxyEnable/ProxyServer` + WinINet 广播刷新(仅 Windows) |

## 快速开始(macOS 开发机)

```sh
npm install
npm test          # 26 个解析器/配置生成器单元测试
npm run tauri dev # 起开发窗口(UI、解析、订阅逻辑均可在 Mac 上调)
```

> macOS 上 `src-tauri/binaries/` 里默认是**占位脚本**,点「启动」会提示内核启动失败——属预期。
> 要在 Mac 上端到端调内核:`brew install sing-box` 后把二进制拷成
> `src-tauri/binaries/sing-box-aarch64-apple-darwin`(详见 [binaries/README.md](src-tauri/binaries/README.md))。
> 系统代理(注册表)、托盘、WebView2 等 **Windows 集成必须在 Windows 上真机测试**。

## 构建 Windows 安装包(CI,推荐)

1. 推代码到 GitHub 仓库
2. 打 tag:`git tag v0.1.0 && git push origin v0.1.0`
3. Actions 在 Windows runner 上自动:**下载 sing-box 内核** → 测试 → 构建 → 挂到 Releases 草稿

内核版本改 [.github/workflows/release.yml](.github/workflows/release.yml) 顶部的 `SING_BOX_VERSION`。
不想让 CI 下载,也可以把 `sing-box-x86_64-pc-windows-msvc.exe` 直接提交进
`src-tauri/binaries/`(建议 Git LFS),CI 检测到会跳过下载。

本机(Windows)构建:`npm run tauri build`,产物在 `src-tauri/target/release/bundle/`。

## ⚠️ SSR 支持情况(必读)

**sing-box 官方版从 1.6.0 起已彻底移除 ShadowsocksR 出站**(早期版本也需要编译时带
`with_shadowsocksr` 标签)。本项目按规格完整实现了 SSR 链接解析与配置生成,但用默认
CI 下载的 sing-box 1.12.x 启动 SSR 节点时,内核会报 `unknown outbound type: shadowsocksr`
并被界面拦截提示。

遇到 SSR 节点时请先确认:

1. **它是不是其实是标准 SS?** 很多机场发的 `ssr://` 链接里 `protocol=origin&obfs=plain`,
   这就是纯 Shadowsocks,直接用对应的 `ss://` 链接即可;
2. 确需真 SSR:自行编译带 SSR 支持的旧版内核(≤1.5,带 `with_shadowsocksr` 标签)替换
   sidecar,或换用其他支持 SSR 的内核并适配配置生成。

## 错误处理约定

以下失败都会在界面状态行给出可读提示,不会静默崩溃:

- **订阅拉取失败** → 提示原因,继续用本地旧列表;单条节点解析失败跳过并计数
- **内核启动失败/立即退出** → 展示内核最后几行日志;8 秒未监听端口判定超时
- **端口 10808 被占用** → 启动前预检,明确提示
- **内核运行中意外崩溃** → 自动清除系统代理(防断网)、状态灯转红、提示日志
- **退出/托盘退出** → 一律先杀内核、清系统代理

## 目录结构

```
src-tauri/
  src/main.rs        # Tauri 入口:命令注册、托盘、退出清理
  src/kernel.rs      # sing-box 进程拉起/杀死/意外退出监控
  src/sysproxy.rs    # Windows 注册表系统代理 + WinINet 广播
  src/config.rs      # 配置/状态文件落盘、端口提取
  binaries/          # sing-box sidecar(见其中 README)
src/
  parser/            # vless / ss / ssr 三个 URI 解析器 + 单元测试
  config/singbox.ts  # buildSingBoxConfig:节点 → sing-box 配置
  api/               # 订阅拉取、Rust 命令封装
  store/             # 节点列表 / 连接状态(useSyncExternalStore)
  ui/                # StatusHeader / NodeList / ControlBar … + theme.css
```

## 界面速览

- 顶栏:状态灯(灰待机 / 黄闪连接中 / 绿常亮在线 / 红失败)+ DSEG7 数码管延迟读数
- 订阅栏:订阅地址、刷新、手动导入、全列表 TCP 测速、`SCAN` 扫描线开关
- 节点列表:单击选中(高亮辉光,不立即连接),`◆` 标记当前生效节点;高延迟/超时标红
- 控制区:`▶ 启动`(已连接时选了别的节点变 `▶ 切换`)/ `■ 停止`
- 关窗 = 收进托盘;托盘右键可启动/停止/退出

## 合规提示

该工具是通用网络代理框架,技术实现合法。在中国大陆使用代理访问境外网络涉及监管风险,请自行评估使用场景。
