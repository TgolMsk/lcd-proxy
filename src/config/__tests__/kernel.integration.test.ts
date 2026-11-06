import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseClash } from "../../parser/clash";
import { buildSingBoxConfig, BuildInput } from "../singbox";

/**
 * 用真实内核校验生成的配置。需要内核二进制,平时跳过:
 * SING_BOX_BIN=/path/to/sing-box npx vitest run kernel.integration
 */
const BIN = process.env.SING_BOX_BIN;
const RULES_DIR = resolve(__dirname, "../../../src-tauri/resources/rules");

const FIXTURE = readFileSync(
  resolve(__dirname, "../../parser/__tests__/fixtures/clash-full.yaml"),
  "utf8",
);

function check(config: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "lcd-kernel-"));
  const text = JSON.stringify(config).replaceAll("@rules/", `${RULES_DIR}/`);
  const path = join(dir, "config.json");
  writeFileSync(path, text);
  try {
    execFileSync(BIN!, ["check", "-c", path], { stdio: "pipe" });
    return "";
  } catch (e) {
    return String((e as { stderr: Buffer }).stderr).replace(/\u001b\[\d+m/g, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!BIN)("真实内核校验", () => {
  const files: Record<string, string> = {
    "https://example.com/telegram.list": "DOMAIN-SUFFIX,t.me\nIP-CIDR,149.154.160.0/20,no-resolve\n",
    "https://example.com/private.yaml": "payload:\n  - '+.lan'\n",
    "https://example.com/cncidr.yaml": "payload:\n  - 1.0.1.0/24\n",
  };

  async function input(extra: Partial<BuildInput> = {}): Promise<BuildInput> {
    const parsed = await parseClash(FIXTURE, async (url) => files[url] ?? "", () => []);
    return {
      // 加密方式不被内核接受的节点由后端启动时去掉,这里只校验其余部分
      nodes: parsed.nodes.filter((n) => n.name !== "坏加密"),
      selectedId: null,
      mode: "rule",
      tun: false,
      rules: parsed.rules,
      ...extra,
    };
  }

  it("系统代理模式", async () => {
    expect(check(buildSingBoxConfig(await input()).config)).toBe("");
  });

  it("TUN 模式", async () => {
    expect(check(buildSingBoxConfig(await input({ tun: true })).config)).toBe("");
  });

  it("TUN + IPv6 + 全局", async () => {
    const config = buildSingBoxConfig(await input({ tun: true, ipv6: true, mode: "global" })).config;
    expect(check(config)).toBe("");
  });

  it("内置规则", async () => {
    expect(check(buildSingBoxConfig(await input({ rules: null })).config)).toBe("");
  });

  it("内核不接受的节点报错里带出站序号", async () => {
    const parsed = await parseClash(FIXTURE, async (url) => files[url] ?? "", () => []);
    const result = buildSingBoxConfig({
      nodes: parsed.nodes,
      selectedId: null,
      mode: "rule",
      tun: false,
    });
    expect(check(result.config)).toMatch(/outbounds?\[\d+\]/);
  });
});
