# sing-box 内核二进制放置说明

Tauri 以 sidecar 方式打包内核,文件必须按「目标平台三元组」命名放在本目录:

| 平台 | 文件名 |
|------|--------|
| Windows x64(**发布目标**) | `sing-box-x86_64-pc-windows-msvc.exe` |
| macOS Apple Silicon(本机开发) | `sing-box-aarch64-apple-darwin` |
| macOS Intel | `sing-box-x86_64-apple-darwin` |
| Linux x86_64 (Mint/Ubuntu) | `lcd-proxy-core-x86_64-unknown-linux-gnu` |
| Linux ARM64 | `lcd-proxy-core-aarch64-unknown-linux-gnu` |

Linux 使用独立的 `lcd-proxy-core` 名称,避免覆盖或清理其他软件的 sing-box。
`npm run build:linux` 从官方 Release 下载 1.12.4 并校验固定 SHA-256,
不需要手动放置内核。升级内核时同步更新 `scripts/sing-box-version` 与
`scripts/sing-box-checksums.sha256`(校验值来自官方 GitHub Release asset 的 `digest`)。

## Windows 正式包

两种方式二选一:

1. **CI 自动下载(默认,推荐)**:`.github/workflows/release.yml` 会在构建时从
   sing-box 官方 GitHub Releases 下载对应版本并放到本目录,无需提交二进制。
   版本号在 workflow 顶部的 `SING_BOX_VERSION` 环境变量里改。
2. **手动提交**:从 <https://github.com/SagerNet/sing-box/releases> 下载
   `sing-box-<版本>-windows-amd64.zip`,解压出 `sing-box.exe`,改名为
   `sing-box-x86_64-pc-windows-msvc.exe` 放到本目录并提交
   (文件较大,建议 Git LFS)。CI 检测到文件已存在就跳过下载。

## macOS 本地开发

当前的两个 darwin 文件是**占位脚本**,只为让 `tauri dev` / 编译通过。
要在 Mac 上真跑内核做端到端调试:

```sh
brew install sing-box
cp "$(which sing-box)" src-tauri/binaries/sing-box-aarch64-apple-darwin
```

> ⚠️ SSR 注意:sing-box 官方版从 1.6.0 起已移除 ShadowsocksR 支持,详见项目根 README。
