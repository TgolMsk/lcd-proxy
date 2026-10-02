import { readFileSync, appendFileSync } from "node:fs";

const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const version = json("package.json").version;
const lock = json("package-lock.json");
const rustVersion = (file) => {
  const match = readFileSync(file, "utf8").match(/name = "lcd-proxy"\r?\nversion = "([^"]+)"/);
  if (!match) throw new Error(`Cannot find lcd-proxy version in ${file}`);
  return match[1];
};
const versions = [lock.version, lock.packages[""].version,
  json("src-tauri/tauri.conf.json").version,
  rustVersion("src-tauri/Cargo.toml"), rustVersion("src-tauri/Cargo.lock")];
if (!/^\d+\.\d+\.\d+$/.test(version) || versions.some((v) => v !== version)) {
  throw new Error(`Version mismatch: ${[version, ...versions].join(", ")}`);
}
if (!readFileSync("scripts/install-linux.sh", "utf8").includes(`package_version=${version}\n`)) {
  throw new Error("Linux installer version does not match the application");
}
const tag = process.argv[2] ?? `v${version}`;
if (tag !== `v${version}`) throw new Error(`Expected tag v${version}, got ${tag}`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\n`);
}
console.log(`Version verified: ${version} (Windows / Linux), tag ${tag}`);
