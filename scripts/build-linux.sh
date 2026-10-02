#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != Linux ]]; then
  echo "请在 Linux 构建机/虚拟机内运行;macOS 不能直接链接 Linux GTK/WebKit。" >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64) target=x86_64-unknown-linux-gnu; core_arch=amd64 ;;
  aarch64) target=aarch64-unknown-linux-gnu; core_arch=arm64 ;;
  *) echo "不支持的架构:$(uname -m)" >&2; exit 1 ;;
esac
version="$(tr -d '\r\n' < scripts/sing-box-version)"
archive="sing-box-${version}-linux-${core_arch}.tar.gz"
download_dir="$(mktemp -d)"
trap 'rm -rf "$download_dir"' EXIT
release="https://github.com/SagerNet/sing-box/releases/download/v${version}"
curl --fail --location --retry 3 "$release/$archive" -o "$download_dir/$archive"
# Digests are pinned from the official GitHub Release asset API.
checksum="$(awk -v name="$archive" '$2 == name { print $1 }' scripts/sing-box-checksums.sha256)"
if [[ ! "$checksum" =~ ^[[:xdigit:]]{64}$ ]]; then
  echo "官方校验清单没有匹配的内核校验和:$archive" >&2
  exit 1
fi
printf '%s  %s\n' "$checksum" "$download_dir/$archive" | sha256sum --check --status
tar -xzf "$download_dir/$archive" -C "$download_dir"
install -m 755 "$download_dir/sing-box-${version}-linux-${core_arch}/sing-box" \
  "src-tauri/binaries/lcd-proxy-core-${target}"
install -m 644 "$download_dir/sing-box-${version}-linux-${core_arch}/LICENSE" \
  src-tauri/resources/sing-box/LICENSE
"src-tauri/binaries/lcd-proxy-core-${target}" version

npm ci
npm test
# tauri.linux.conf.json is merged automatically on Linux.
npm run tauri -- build --target "$target" "$@"

output_dir="artifacts/linux"
mkdir -p "$output_dir"
find "src-tauri/target/${target}/release/bundle" -type f \
  \( -name '*.deb' -o -name '*.AppImage' \) -exec cp '{}' "$output_dir/" \;
(cd "$output_dir" && sha256sum ./*.deb ./*.AppImage > SHA256SUMS)
echo "Linux 安装包已生成:$output_dir"
