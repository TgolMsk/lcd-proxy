import { describe, it, expect } from "vitest";
import { decodeSubscriptionContent, profileName } from "../subscription";
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

describe("profileName", () => {
  const url = "https://sub.example.com/api/profile/abc";

  it("优先用 profile-title,其次文件名", () => {
    expect(profileName(url, "我的机场", 'attachment; filename="other.yaml"')).toBe("我的机场");
    expect(profileName(url, null, 'attachment; filename="我的机场.yaml"')).toBe("我的机场");
  });

  it("通用文件名分不清订阅,改用域名", () => {
    expect(profileName(url, null, 'inline; filename="clash.yaml"')).toBe("sub.example.com");
    expect(profileName(url, null, 'inline; filename="config.yml"')).toBe("sub.example.com");
  });
});
