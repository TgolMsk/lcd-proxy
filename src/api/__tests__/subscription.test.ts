import { describe, it, expect } from "vitest";
import { decodeSubscriptionContent } from "../subscription";
import { b64EncodeUtf8 } from "../../parser/base64";

describe("decodeSubscriptionContent", () => {
  const lines =
    "ss://YWVzLTI1Ni1nY206cHc@a.com:443#A\nvless://u@b.com:443?type=tcp#B";

  it("整体 base64 的订阅 → 解码为多行链接", () => {
    expect(decodeSubscriptionContent(b64EncodeUtf8(lines))).toBe(lines);
  });

  it("明文多行订阅原样返回", () => {
    expect(decodeSubscriptionContent(lines)).toBe(lines);
  });

  it("无法识别的内容报错", () => {
    expect(() => decodeSubscriptionContent("!!!???")).toThrow();
  });
});
