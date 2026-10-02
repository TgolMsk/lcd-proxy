#!/usr/bin/env bash
set -euo pipefail

# Install the verified x86_64 package; no source checkout or build toolchain needed.
release_tag=linux-v0.1.9
package_version=0.1.9
package_name="lcd-proxy_${package_version}_amd64.deb"
package_sha256=6a6a790a29edc3fc000f4eaa020900ff41d2d4cec00458bfab8cc7024c7edcb3
package_url="https://github.com/TgolMsk/lcd-proxy/releases/download/${release_tag}/${package_name}"
deb_path=
download_dir=
verify_only=false

usage() {
  cat <<'EOF'
LCD Proxy 0.1.9 Linux x86_64 安装器

用法: bash install-linux.sh [--deb FILE] [--verify-only]
  默认           下载并校验已发布的 .deb,通过 apt 安装
  --deb FILE     使用本地构件,仍校验固定 SHA-256
  --verify-only  只校验构件与包信息,不安装
  --help         显示帮助

适用 Linux Mint 22.3 / Ubuntu / Debian x86_64。
安装后从应用菜单打开 LCD Proxy;TUN 权限在应用中开启时申请。
EOF
}

fail() { echo "错误:$*" >&2; exit 1; }
cleanup() { if [[ -n "$download_dir" ]]; then rm -rf -- "$download_dir"; fi; }
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deb)
      [[ $# -ge 2 && -n "$2" ]] || fail "--deb 需要安装包路径"
      deb_path=$2
      shift 2
      ;;
    --verify-only) verify_only=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "未知参数:$1 (使用 --help 查看用法)" ;;
  esac
done

[[ "$(uname -s)" == Linux ]] || fail "请在 Linux Mint / Ubuntu / Debian 上运行"
for dependency in dpkg dpkg-deb sha256sum apt-get; do
  command -v "$dependency" >/dev/null || fail "缺少命令:$dependency"
done
[[ "$(dpkg --print-architecture)" == amd64 ]] || fail "此构件仅支持 x86_64 (amd64)"

if [[ -z "$deb_path" ]]; then
  command -v curl >/dev/null || fail "请先安装 curl: sudo apt install curl"
  download_dir=$(mktemp -d)
  chmod 755 "$download_dir"
  deb_path="$download_dir/$package_name"
  echo "下载 LCD Proxy ${package_version}:$package_url"
  curl --proto '=https' --tlsv1.2 --fail --location --retry 3 \
    "$package_url" -o "$deb_path"
  chmod 644 "$deb_path"
else
  [[ -f "$deb_path" ]] || fail "找不到安装包:$deb_path"
  deb_path="$(cd -P -- "$(dirname -- "$deb_path")" && pwd)/$(basename -- "$deb_path")"
fi

actual_sha256=$(sha256sum -- "$deb_path")
actual_sha256=${actual_sha256%% *}
[[ "$actual_sha256" == "$package_sha256" ]] || fail "SHA-256 校验失败,安装已中止"
[[ "$(dpkg-deb --field "$deb_path" Package)" == lcd-proxy ]] || fail "软件包名称不匹配"
[[ "$(dpkg-deb --field "$deb_path" Version)" == "$package_version" ]] || fail "软件包版本不匹配"
[[ "$(dpkg-deb --field "$deb_path" Architecture)" == amd64 ]] || fail "软件包架构不匹配"
echo "构件校验通过:LCD Proxy ${package_version} amd64"

if [[ "$verify_only" == true ]]; then exit 0; fi
if [[ "$EUID" == 0 ]]; then
  apt-get update
  apt-get install --yes --reinstall "$deb_path"
else
  command -v sudo >/dev/null || fail "请使用 root 执行安装脚本,或安装 sudo"
  sudo apt-get update
  sudo apt-get install --yes --reinstall "$deb_path"
fi
installed_version=$(dpkg-query --show --showformat='${Version}' lcd-proxy)
[[ "$installed_version" == "$package_version" ]] || fail "安装后的版本不匹配"
echo "安装完成:LCD Proxy ${installed_version}。请从应用菜单启动,或运行 lcd-proxy。"
