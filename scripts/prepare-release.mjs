import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const tag = `v${version}`;
const dir = resolve(process.argv[2] ?? "release-assets");
const files = () => readdirSync(dir);
for (const extension of ["deb", "AppImage"]) {
  const candidates = files().filter((name) => name.endsWith(`_${version}_amd64.${extension}`));
  if (candidates.length !== 1) throw new Error(`Expected one ${version} Linux ${extension}`);
  const target = join(dir, `lcd-proxy_${version}_amd64.${extension}`);
  if (join(dir, candidates[0]) !== target) renameSync(join(dir, candidates[0]), target);
}
copyFileSync("scripts/install-linux.sh", join(dir, "install-linux.sh"));
const deb = join(dir, `lcd-proxy_${version}_amd64.deb`);
for (const [field, expected] of Object.entries({ Package: "lcd-proxy", Version: version, Architecture: "amd64" })) {
  const result = spawnSync("dpkg-deb", ["--field", deb, field], { encoding: "utf8" });
  if (result.status !== 0 || result.stdout.trim() !== expected) {
    throw new Error(`Linux package ${field} mismatch`);
  }
}
const manifest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
if (manifest.version !== version || !manifest.platforms?.["windows-x86_64"]) {
  throw new Error("Windows updater manifest version/platform mismatch");
}
const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const publicKey = Buffer.from(config.plugins.updater.pubkey, "base64")
  .toString("utf8").trim().split(/\r?\n/).at(-1);
const temporary = mkdtempSync(join(tmpdir(), "lcd-proxy-signature-"));
try {
  for (const extension of ["msi", "exe"]) {
    const candidates = files().filter((name) => name.endsWith(`.${extension}`) && name.includes(version));
    if (candidates.length !== 1) throw new Error(`Missing Windows ${version} ${extension}`);
    const name = candidates[0];
    const encoded = readFileSync(join(dir, `${name}.sig`), "utf8").trim();
    const signature = join(temporary, `${extension}.sig`);
    writeFileSync(signature, Buffer.from(encoded, "base64"));
    const result = spawnSync("minisign", ["-Vm", join(dir, name), "-x", signature, "-P", publicKey], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Invalid signature for ${name}: ${result.stderr || result.error}`);
    console.log(`Signature verified: ${name}`);
  }
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    if (!platform.startsWith("windows-")) continue;
    const url = new URL(entry.url);
    const prefix = `/TgolMsk/lcd-proxy/releases/download/${tag}/`;
    if (url.origin !== "https://github.com" || !url.pathname.startsWith(prefix)) {
      throw new Error(`Unexpected updater URL for ${platform}`);
    }
    const name = decodeURIComponent(basename(url.pathname));
    if (!existsSync(join(dir, name)) || readFileSync(join(dir, `${name}.sig`), "utf8").trim() !== entry.signature.trim()) {
      throw new Error(`Updater signature/asset mismatch for ${platform}`);
    }
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
const notes = `LCD Proxy ${version} — Windows / Linux 统一版本\n\n` +
  `Windows x64: 下载 .exe 安装器或 .msi;保留签名自动更新。\n` +
  `Linux Mint 22.3 Cinnamon / Ubuntu x86_64: 下载 .deb 或 AppImage。\n\n` +
  `Linux 安装命令:\n\n\`\`\`sh\n` +
  `curl -fL https://github.com/TgolMsk/lcd-proxy/releases/download/${tag}/install-linux.sh -o install-linux.sh\n` +
  `bash install-linux.sh\n\`\`\`\n\n` +
  `安装器下载同版本 .deb,核对 SHA256SUMS、包版本和架构后通过 apt 安装。\n` +
  `Linux .deb 支持桌面代理与 TUN 授权;AppImage 使用桌面代理。\n` +
  `Windows 的系统代理、UAC、TUN 与 Linux 的 GSettings、Polkit 集成保持各自平台行为。\n\n` +
  `构建版本和两份 Windows 更新签名已验证;Linux 功能验收记录见 docs/linux-validation.md。\n` +
  `Windows 实机及 Linux Mint 实机运行仍需对应设备验证。\n\n` +
  `[使用说明](https://github.com/TgolMsk/lcd-proxy/blob/${tag}/docs/linux.md)\n`;
manifest.notes = notes;
writeFileSync(join(dir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
mkdirSync("artifacts", { recursive: true });
writeFileSync("artifacts/release-notes.md", notes);
const sums = files().filter((name) => name !== "SHA256SUMS").sort().map((name) => {
  if (/[\r\n]/.test(name)) throw new Error("Invalid asset filename");
  return `${createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")}  ${name}`;
});
writeFileSync(join(dir, "SHA256SUMS"), sums.join("\n") + "\n");
console.log(`Release ${tag} verified: Windows MSI/EXE, Linux DEB/AppImage, installer, updater, checksums`);
