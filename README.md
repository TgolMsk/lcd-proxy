# LCD Proxy · 订阅式代理客户端

> **添加订阅 → 选节点 → 连接。** 订阅里的策略组和分流规则直接生效。
> 内核:sing-box。框架:Tauri 2。

- **节点协议**:VLESS(TLS/WS/gRPC/Reality)、VMess、Trojan、Shadowsocks、Hysteria、Hysteria2、TUIC、AnyTLS、SOCKS、HTTP
- **订阅格式**自动识别:分享链接列表(base64 或明文)、Clash / mihomo 配置(含策略组、规则、`rule-providers`、`proxy-providers`)、sing-box 配置(只取节点)
- **多份订阅**:分别更新,按订阅声明的间隔自动刷新,显示流量和到期时间,选一份作为规则来源
- **分流**:订阅规则、内置的绕过大陆规则、优先级最高的自定义规则;订阅没有国内规则时补上国内直连(可关闭)
- **系统代理**(Windows 注册表 / Linux GNOME、Cinnamon 设置)与 **TUN** 一键切换
- 运行中切换节点、策略组和规则/全局模式,不重启内核
- 连上后测速走内核,测到的是经节点的实际延迟;未连接时只测 TCP 连接
- 流量图、内核日志页、系统托盘、单实例
- 主程序崩溃时内核一起退出,下次启动恢复原来的系统代理

## 技术栈

| 层 | 选型 |
|----|------|
| 框架 | Tauri 2.x(Rust 后端 + React/TS/Vite 前端) |
| 内核 | sing-box(sidecar 方式打包,`src-tauri/binaries/`) |
| UI | 纯 CSS,浅色和深色两套主题 |
| 规则数据 | sing-box 二进制规则集,随安装包发布(`src-tauri/resources/rules/`) |
| 存储 | 应用数据目录下的 `settings.json`、`profiles.json`、`profiles/`,见[数据存储](#数据存储) |
| 系统代理 | Windows 注册表 + WinINet;Linux GNOME/Cinnamon GSettings,断开时恢复原设置 |

## Linux Mint 22.3 Cinnamon 64 位

提供 **x86_64 `.deb` 安装包与 `.AppImage` 便携包**,内置 sing-box 1.12.4。

[下载 Linux 安装构件](https://github.com/TgolMsk/lcd-proxy/releases/tag/v1.1.0)。
也可在 Linux 终端运行构件安装器,直接下载、校验 SHA-256 并安装:

```sh
curl -fL https://github.com/TgolMsk/lcd-proxy/releases/latest/download/install-linux.sh -o install-linux.sh
bash install-linux.sh
```

```sh
# 推荐安装方式:在安装包所在目录运行
sudo apt install ./lcd-proxy_1.1.0_amd64.deb
# 在应用菜单打开 LCD Proxy,导入订阅/节点后点击「启动」
```

系统代理直接写入 Cinnamon 使用的 `org.gnome.system.proxy`,无须 root。
停止、退出、内核崩溃时恢复连接前的设置;进程被强杀时,下次启动会恢复备份。
`.deb` 的 TUN 模式通过系统授权对 `/usr/bin/lcd-proxy-core` 授予网络管理权限,
图形界面保持普通用户身份;AppImage 使用系统代理,TUN 请安装 `.deb`。

Linux 下关窗会最小化到任务栏,托盘提供启动、停止和退出菜单。
CLI 程序若不读取桌面代理,可使用 `HTTPS_PROXY=http://127.0.0.1:10808`,或开启 TUN。

构建和权限说明见 [Linux 使用与构建](docs/linux.md),实测结果见 [Linux 验证记录](docs/linux-validation.md)。

## 快速开始(macOS 开发机)

```sh
npm install
npm test          # 解析器、规则、配置生成、存储的单元测试
npm run tauri dev # 起开发窗口(UI、解析、订阅逻辑均可在 Mac 上调)
```

> macOS 上 `src-tauri/binaries/` 里默认是**占位脚本**,点「启动」会提示内核启动失败——属预期。
> 要在 Mac 上端到端调内核:`brew install sing-box` 后把二进制拷成
> `src-tauri/binaries/sing-box-aarch64-apple-darwin`(详见 [binaries/README.md](src-tauri/binaries/README.md))。
> 系统代理(注册表)、托盘、WebView2 等 **Windows 集成必须在 Windows 上真机测试**。

## 统一版本与 Windows / Linux 发布

从 **1.0.0** 开始,Windows 与 Linux 使用同一版本号、同一个 `vX.Y.Z` 标签与 Release。

1. 同步 `package.json`、`package-lock.json`、Tauri 配置、Cargo 清单/锁文件和 Linux 安装器版本。
2. 运行 `node scripts/check-version.mjs v1.1.0`,提交并推送代码。
3. 推送标签:`git tag v1.1.0 && git push origin v1.1.0`。
4. `Release (Windows + Linux)` 分别构建 Windows x64 `.exe`/`.msi` 与 Linux x86_64 `.deb`/`.AppImage`。
5. 两个平台成功后验证 Windows 更新签名,生成完整 `SHA256SUMS`,将安装器、更新清单和各平台安装包统一公开发布。

构建期间 Release 为草稿。任一平台或签名验证失败均不公开该版本。
内核版本见 `scripts/sing-box-version`,各平台官方内核 SHA-256 见 `scripts/sing-box-checksums.sha256`。

本机(Windows)构建:`npm run tauri build`,产物在 `src-tauri/target/release/bundle/`。

## 应用自更新(基于 GitHub Release)

用 Tauri 官方 updater 插件实现:

- 启动时**静默检查**更新;也可点右上角「vX.Y.Z · 检查更新」手动查
- 有新版时顶部弹横幅 →「立即更新」→ 应用内下载(带进度)→ 安装 → 自动重启
- 更新源:`plugins.updater.endpoints` 指向 `releases/latest/download/latest.json`;
  产物由 CI 用**签名私钥**签名,客户端用内置**公钥**校验,防篡改

### 自更新与安装入口

Windows 自更新使用统一 Release 中的签名包与 `latest.json`。
`releases/latest` 不包含构建中的草稿;统一流程在两个平台验证完成后自动发布。
Linux 通过统一 Release 中的安装器或安装包更新,不使用 Windows 更新清单安装。

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

在「连接」页的「接管」里切换,选择会保存。

| 模式 | 原理 | 权限 | 适用 |
|------|------|------|------|
| **系统代理**(默认) | Windows 写注册表,Linux 写 GNOME/Cinnamon GSettings,内核起 `mixed` 入站 | 普通用户 | 浏览器等遵循系统代理的程序 |
| **TUN** | 内核建虚拟网卡 + `auto_route` 接管流量(含不认系统代理的程序) | Windows 管理员 / Linux Polkit 授权内核 | 全局代理、游戏、命令行工具 |

TUN 配置的几个要点,改动前请先看清原因:

- **`strict_route` 必须开。** Windows 的 DNS 客户端会同时问所有网卡,不拦住物理网卡的 53 端口,拿到的就是被污染的地址。它同时会拦掉全部 IPv6,所以默认只接管 IPv4、只解析 A 记录,有 AAAA 记录的网站不会因为优先连 IPv6 而打不开。
- **直连 DNS 必须写明地址**(默认 `223.5.5.5`,设置页可改),不能用 `type: local`。TUN 下系统 DNS 会绕回内核;Windows 的虚拟网卡还带着失效的 `fec0::` 地址,每个新域名要多等 5 秒。
- **局域网网段不进 TUN**,打印机发现和组播都走物理网卡。
- 已知限制:`*.lan` 这类靠路由器解析的内网域名在 TUN 下解析不了,直接用 IP 访问。

**Windows TUN 权限**:开启 TUN 后点连接时,如果当前不是管理员,应用会请求授权并以管理员身份重启,设置已先写盘,重启后接着连接。取消授权时这次连接失败并给出提示。Wintun 驱动已内嵌在 sing-box 的 Windows 二进制里。

**Linux TUN 权限**:安装 `.deb` 后,通过 Polkit 仅为内核授予网络 capabilities,图形界面保持普通用户身份。AppImage 使用桌面代理。具体说明见 [Linux 使用与构建](docs/linux.md)。

## 订阅格式

1. **分享链接列表**:整体 base64 或明文多行的分享链接。
2. **Clash / mihomo 配置**:导入节点、策略组(`select`、`url-test`、`fallback`、`load-balance`)和规则,`rule-providers`、`proxy-providers` 会下载展开。`GEOIP,CN`、`GEOSITE,cn` 等用安装包内置的规则集。`relay` 组和 `mrs` 规则集不支持,规则页会列出跳过了什么。
3. **sing-box 完整配置**:只抽取节点,忽略其中的分组和路由。

粘贴到「订阅 → 导入」同样可用:Clash 配置保留分组和规则,其余进本地节点。

### 规则的优先级

自定义规则 > 订阅规则 > 国内直连兜底 > `MATCH`。

- **主策略组**:从 `MATCH` 的目标沿每组的默认成员往下走,路上最后一个含节点的 `select` 组。节点页的选择落在这个组,其他组各选各的。
- **国内直连兜底**:只在订阅没有 `GEOIP,CN` 规则、兜底也不是直连时生效。有些配置中心导出的规则只列海外服务,没有这一层时国内网站全部绕节点。可以在规则页关闭。
- **直连用途的组**(组名含「直连」「国内」或以「中国」结尾)如果把节点排在 `DIRECT` 前面,默认值改回直连。
- 同名节点出现在多份配置里时,策略组用规则来源那份订阅自己的节点。

## 数据存储

应用数据目录(Windows 是 `%APPDATA%\com.lcdproxy.app`):

| 文件 | 内容 |
|------|------|
| `settings.json` | 设置、当前节点、策略组选择、自定义规则 |
| `profiles.json` | 配置列表:链接、更新时间、流量、到期时间 |
| `profiles/<id>.nodes.json` | 这份配置的节点 |
| `profiles/<id>.rules.json` | 这份配置的策略组和规则,用到时才读 |
| `state.v1.json` | 旧版数据的留档,升级后不再使用 |
| `config.json`、`kernel.log` | 交给内核的配置和内核日志 |

写入先落临时文件再原子替换,并保留一份 `.bak`。主文件损坏时自动用备份恢复并提示;主文件和备份都读不出来时停止写入,不用空数据覆盖。订阅更新失败时保留旧节点和规则。

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
  src/kernel.rs      # sing-box 进程管理、Clash API、流量统计
  src/fetch.rs       # 下载订阅和规则,失败后经代理重试
  src/sysproxy.rs    # Windows 注册表系统代理 + WinINet 广播
  src/sysproxy_linux.rs # Linux GNOME/Cinnamon 代理备份与恢复
  src/elevate.rs     # Windows 提权重启
  src/elevate_linux.rs # Linux 内核网络权限授权
  src/config.rs      # 原子写入、备份恢复、端口提取
  resources/rules/   # 内置规则集,来源见其中 README
  binaries/          # sing-box sidecar(见其中 README)
src/
  parser/            # 分享链接、Clash、sing-box 配置解析
  rules/             # Clash 规则 → sing-box 规则
  config/singbox.ts  # 节点 + 规则 → sing-box 配置
  api/               # 订阅拉取、Rust 命令封装、自更新
  store/             # 配置、设置、连接状态、流量、日志
  ui/                # 连接 / 节点 / 规则 / 订阅 / 日志 / 设置六个页面 + theme.css
scripts/build-linux.sh # Linux 内核下载、校验、构建与产物归档
scripts/install-linux.sh # 下载或使用本地构件,校验后通过 apt 安装
scripts/test-linux-release.py # 发布门禁:真实安装包的界面和代理冒烟测试
```

## 界面速览

- **连接**:连接按钮、当前节点、时长和延迟、分流方式、接管方式、流量图、订阅用量
- **节点**:搜索、按地区筛选、按延迟排序、测速;同名节点标出来源
- **规则**:规则来源、国内直连开关、策略组选择、自定义规则
- **订阅**:添加、更新、改名、删除,粘贴导入
- **日志**:内核日志,可搜索,可调级别
- **设置**:外观、自启连接、端口、IPv6、TUN 协议栈、直连 DNS、日志级别、数据目录
- 关窗 = 收进托盘;托盘菜单可启动、停止、退出

## 合规提示

该工具是通用网络代理框架,技术实现合法。在中国大陆使用代理访问境外网络涉及监管风险,请自行评估使用场景。
