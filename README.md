# LCD Proxy · 现代仪表盘风订阅式代理客户端

> **打开客户端 → 在列表里选一个节点 → 点击启动 → 系统代理生效。**
> 视觉:近黑→靛紫渐变 + 毛玻璃卡片 + 薄荷绿强调(深色默认,可切浅色)。内核:sing-box。框架:Tauri 2。
> 视觉风格参考 [lan-send/ui-style-reference](https://github.com/TgolMsk/lan-send/blob/main/docs/ui-style-reference.md)。

- 支持 **VLESS(TLS/WS/gRPC/Reality)、Shadowsocks(SIP002 + 旧格式)、ShadowsocksR** 分享链接
- 订阅支持两种格式,自动识别:**① base64/明文分享链接列表**;**② sing-box 完整配置 profile**(如 Surge Config Center,只抽取节点、不套用其路由规则)
- 手动粘贴导入(分享链接或 profile JSON 均可),节点存本地 JSON
- **系统代理模式**(写 Windows 注册表)与 **TUN 全局模式**(虚拟网卡接管全局流量,自动申请管理员权限)两种模式,一键切换
- 启动/切换自动重启内核,退出自动清理
- TCP 连接测速、系统托盘(启动/停止/退出)、单实例

## 技术栈

| 层 | 选型 |
|----|------|
| 框架 | Tauri 2.x(Rust 后端 + React/TS/Vite 前端) |
| 内核 | sing-box(sidecar 方式打包,`src-tauri/binaries/`) |
| UI | 纯 CSS 实现现代仪表盘风(Inter 可变字体本地打包;渐变背景 + 毛玻璃卡片 + 薄荷绿强调;深/浅色) |
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

## 应用自更新(基于 GitHub Release)

用 Tauri 官方 updater 插件实现:

- 启动时**静默检查**更新;也可点右上角「vX.Y.Z · 检查更新」手动查
- 有新版时顶部弹横幅 →「立即更新」→ 应用内下载(带进度)→ 安装 → 自动重启
- 更新源:`plugins.updater.endpoints` 指向 `releases/latest/download/latest.json`;
  产物由 CI 用**签名私钥**签名,客户端用内置**公钥**校验,防篡改

### ⚠️ 自更新只认「已发布」的 Release

`releases/latest` **不包含草稿(draft)**。CI 默认生成的是草稿 Release,所以
**必须在 GitHub 上点 Publish 把该版本正式发布**,旧版本客户端才能检测并更新到它。
(草稿阶段你自己下载安装包测试不受影响。)

### 维护者:签名密钥

- 密钥对已生成:**公钥**写在 [tauri.conf.json](src-tauri/tauri.conf.json) 的 `plugins.updater.pubkey`;
  **私钥**在仓库外 `~/.lcd-proxy/updater.key`(已 `.gitignore`,**务必自行备份**,丢了就没法再发能被老客户端校验的更新)
- CI 签名:私钥存为仓库 Secret `TAURI_SIGNING_PRIVATE_KEY`,空密码在 workflow 里以空 env 传入
- 想换密钥:`npm run tauri signer generate -- -w <路径>`,更新公钥与 Secret 即可(但换key后老客户端无法自更新到新key签名的版本,需手动升级一次)

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

## 两种代理模式

工具栏 `TUN` 按钮切换,状态持久化。

| 模式 | 原理 | 权限 | 适用 |
|------|------|------|------|
| **系统代理**(默认) | 写注册表 `ProxyEnable/ProxyServer` 指向 `127.0.0.1:10808`,内核起 `mixed` 入站 | 普通用户 | 浏览器等遵循系统代理的程序 |
| **TUN 全局** | 内核建虚拟网卡 + `auto_route` 接管全部流量(含不认系统代理的程序) | **管理员** | 全局代理、游戏/命令行工具 |

TUN 模式的 sing-box 配置内置了 **DNS 处理**(劫持所有 DNS 查询到内置解析器:远端 DoH 走代理、节点服务器域名走直连解析)与**局域网直连**规则,并把 `strict_route` 关掉 —— 否则 TUN 吞掉全部流量后 DNS 无法解析,会表现为「整机断网」。

**TUN 的管理员权限是自动处理的**:点 `TUN` 开启时,若当前非管理员,会弹 UAC 请求授权并**以管理员身份重启应用**(状态已先落盘,重启后 TUN 保持开启);授权取消则自动回退。开启 TUN 后启动连接,不再设置系统代理,由虚拟网卡接管。

> 实现细节:提权用 `ShellExecuteW(runas)` 重启自身,原(非管理员)实例在干净断开后硬退出、交接单实例锁给提权实例。TUN 需要 Wintun 驱动,近版 sing-box 的 Windows 二进制已内嵌。**这些只能在真 Windows 上验证**(见下方"未在 Windows 上验证的部分")。

## 订阅格式(自动识别两种)

1. **分享链接列表**:整体 base64 或明文多行 `vless://` / `ss://` / `ssr://`(机场最常见)。
2. **sing-box 完整配置 profile**:订阅返回一份完整 sing-box 配置 JSON(如 Surge Config Center 的 `/api/sing-box/profile/...`)。本工具会从其 `outbounds` 里**抽取真实代理节点**(vless / shadowsocks / shadowsocksr),**忽略** profile 自带的 selector 策略分组、route 路由规则、tun 入站等 —— 仍按本工具"选一个节点 → 生成自己的配置"的模型工作。也就是说:**profile 里的分流规则不会生效**,只借用它的节点。

> 粘贴 profile JSON 到"导入"框同样可用。若你需要的正是 profile 里那套分流规则,本工具当前不支持(需要另一套"整份配置直通"的实现)。

## 未在 Windows 上验证的部分

本项目在 macOS 上开发,以下逻辑已通过**隔离交叉编译**(`x86_64-pc-windows-msvc` 目标)确认能编译,且生成的 sing-box 配置已用真实 sing-box 1.12.4 二进制 `check` 通过,但**运行期行为必须在真 Windows 上实测**:

- TUN 虚拟网卡创建、`auto_route` 生效、Wintun 驱动可用性
- UAC 提权重启与单实例锁交接的时序(极少数情况下若提权实例启动过快可能与旧实例抢锁)
- 注册表系统代理写入与 `InternetSetOption` 广播刷新

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

- 顶栏:薄荷绿品牌标 + 深/浅色切换 + 版本/检查更新
- 连接状态卡片(毛玻璃):状态灯(灰待机 / 黄闪连接中 / 薄荷在线 / 红失败)+ 大号延迟读数(在线时薄荷绿)
- 订阅栏:订阅地址、刷新、手动导入、全列表 TCP 测速、`TUN` 全局模式开关(开启填充薄荷)
- 节点列表:毛玻璃卡片,单击选中(薄荷绿边框+圆点,不立即连接),`● 生效中` 标记当前节点;高延迟/超时标红
- 控制区:薄荷绿胶囊`启动`(已连接时选别的节点变`切换节点`)/ 描边`停止`
- 关窗 = 收进托盘;托盘右键可启动/停止/退出

## 合规提示

该工具是通用网络代理框架,技术实现合法。在中国大陆使用代理访问境外网络涉及监管风险,请自行评估使用场景。
