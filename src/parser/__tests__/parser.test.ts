import { describe, it, expect } from "vitest";
import { parseVless, splitHostPort } from "../vless";
import { parseShadowsocks } from "../shadowsocks";
import { parseShadowsocksR } from "../shadowsocksr";
import { parseUri, parseUriList } from "../index";
import { b64EncodeUtf8, b64DecodeUtf8 } from "../base64";

// ---------------- VLESS ----------------

describe("parseVless", () => {
  it("解析 VLESS + TLS + WebSocket(最常见组合)", () => {
    const uri =
      "vless://2f9d3b7c-9a1e-4b8f-b2d0-1234567890ab@example.com:443" +
      "?encryption=none&security=tls&sni=cdn.example.com&type=ws" +
      "&host=cdn.example.com&path=%2Fwspath#%E7%BE%8E%E5%9B%BD-01";
    const n = parseVless(uri);
    expect(n.protocol).toBe("vless");
    expect(n.uuid).toBe("2f9d3b7c-9a1e-4b8f-b2d0-1234567890ab");
    expect(n.server).toBe("example.com");
    expect(n.port).toBe(443);
    expect(n.network).toBe("ws");
    expect(n.security).toBe("tls");
    expect(n.sni).toBe("cdn.example.com");
    expect(n.host).toBe("cdn.example.com");
    expect(n.path).toBe("/wspath");
    expect(n.name).toBe("美国-01");
  });

  it("解析 VLESS + Reality(pbk/sid/fp/flow 完整提取)", () => {
    const uri =
      "vless://11111111-2222-3333-4444-555555555555@1.2.3.4:443" +
      "?security=reality&sni=www.microsoft.com&fp=chrome&flow=xtls-rprx-vision" +
      "&pbk=SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc&sid=6ba85179&type=tcp#Reality%20HK";
    const n = parseVless(uri);
    expect(n.security).toBe("reality");
    expect(n.publicKey).toBe("SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc");
    expect(n.shortId).toBe("6ba85179");
    expect(n.fingerprint).toBe("chrome");
    expect(n.flow).toBe("xtls-rprx-vision");
    expect(n.network).toBe("tcp");
    expect(n.name).toBe("Reality HK");
  });

  it("解析 grpc 传输与 IPv6 主机", () => {
    const uri =
      "vless://abcd1234-0000-0000-0000-000000000000@[2001:db8::1]:8443" +
      "?type=grpc&serviceName=grpcSvc&security=tls#v6";
    const n = parseVless(uri);
    expect(n.server).toBe("2001:db8::1");
    expect(n.port).toBe(8443);
    expect(n.network).toBe("grpc");
    expect(n.serviceName).toBe("grpcSvc");
  });

  it("缺 uuid@host 结构时报错", () => {
    expect(() => parseVless("vless://no-at-sign:443")).toThrow();
  });
});

describe("splitHostPort", () => {
  it("普通 host:port", () => {
    expect(splitHostPort("example.com:8080")).toEqual({
      host: "example.com",
      port: 8080,
    });
  });
  it("[IPv6]:port", () => {
    expect(splitHostPort("[::1]:1080")).toEqual({ host: "::1", port: 1080 });
  });
  it("端口越界报错", () => {
    expect(() => splitHostPort("example.com:99999")).toThrow();
  });
});

// ---------------- Shadowsocks ----------------

describe("parseShadowsocks", () => {
  it("解析 SIP002 格式(userinfo base64)", () => {
    const userinfo = b64EncodeUtf8("aes-256-gcm:passw0rd!", true);
    const uri = `ss://${userinfo}@jp.example.net:8388#%E6%97%A5%E6%9C%AC-02`;
    const n = parseShadowsocks(uri);
    expect(n.protocol).toBe("shadowsocks");
    expect(n.method).toBe("aes-256-gcm");
    expect(n.password).toBe("passw0rd!");
    expect(n.server).toBe("jp.example.net");
    expect(n.port).toBe(8388);
    expect(n.name).toBe("日本-02");
  });

  it("解析旧格式(整体 base64)", () => {
    const whole = b64EncodeUtf8("rc4-md5:oldpass@1.2.3.4:8888");
    const n = parseShadowsocks(`ss://${whole}#legacy`);
    expect(n.method).toBe("rc4-md5");
    expect(n.password).toBe("oldpass");
    expect(n.server).toBe("1.2.3.4");
    expect(n.port).toBe(8888);
  });

  it("兼容 AEAD-2022 明文 userinfo(未 base64,密码含冒号)", () => {
    const uri =
      "ss://2022-blake3-aes-256-gcm:YWJjZDplZmdo%3D@host.example.com:8443#2022";
    const n = parseShadowsocks(uri);
    expect(n.method).toBe("2022-blake3-aes-256-gcm");
    expect(n.password).toBe("YWJjZDplZmdo=");
  });

  it("SIP002 带 /?plugin= 尾巴不影响 host:port", () => {
    const userinfo = b64EncodeUtf8("chacha20-ietf-poly1305:pw", true);
    const uri = `ss://${userinfo}@1.1.1.1:443/?plugin=obfs-local%3Bobfs%3Dhttp#p`;
    const n = parseShadowsocks(uri);
    expect(n.server).toBe("1.1.1.1");
    expect(n.port).toBe(443);
  });
});

// ---------------- SSR ----------------

describe("parseShadowsocksR", () => {
  /** 按 SSR 规范手工构造一条链接:内外两层 base64 */
  function makeSsrUri() {
    const password = b64EncodeUtf8("s3cret", true);
    const obfsparam = b64EncodeUtf8("download.windowsupdate.com", true);
    const protoparam = b64EncodeUtf8("32:abcd", true);
    const remarks = b64EncodeUtf8("香港-03", true);
    const group = b64EncodeUtf8("测试组", true);
    const payload =
      `hk.example.org:443:auth_aes128_md5:aes-256-cfb:http_simple:${password}` +
      `/?obfsparam=${obfsparam}&protoparam=${protoparam}&remarks=${remarks}&group=${group}`;
    return "ssr://" + b64EncodeUtf8(payload, true);
  }

  it("分层解码:主体 + 密码 + 各参数", () => {
    const n = parseShadowsocksR(makeSsrUri());
    expect(n.protocol).toBe("shadowsocksr");
    expect(n.server).toBe("hk.example.org");
    expect(n.port).toBe(443);
    expect(n.ssrProtocol).toBe("auth_aes128_md5");
    expect(n.method).toBe("aes-256-cfb");
    expect(n.obfs).toBe("http_simple");
    expect(n.password).toBe("s3cret");
    expect(n.obfsParam).toBe("download.windowsupdate.com");
    expect(n.protocolParam).toBe("32:abcd");
    expect(n.name).toBe("香港-03");
  });

  it("无参数区也能解析", () => {
    const password = b64EncodeUtf8("pw", true);
    const payload = `1.2.3.4:8388:origin:aes-128-cfb:plain:${password}`;
    const n = parseShadowsocksR("ssr://" + b64EncodeUtf8(payload, true));
    expect(n.server).toBe("1.2.3.4");
    expect(n.ssrProtocol).toBe("origin");
    expect(n.obfs).toBe("plain");
    expect(n.name).toBe("1.2.3.4:8388"); // 无 remarks 时回退 host:port
  });

  it("字段不足 6 段时报错", () => {
    const bad = "ssr://" + b64EncodeUtf8("1.2.3.4:8388:origin", true);
    expect(() => parseShadowsocksR(bad)).toThrow();
  });
});

// ---------------- 统一入口 ----------------

describe("parseUriList", () => {
  it("多行混合解析,坏行跳过不中断,重复去重", () => {
    const ssUser = b64EncodeUtf8("aes-256-gcm:pw", true);
    const good1 = `ss://${ssUser}@a.example.com:443#A`;
    const good2 =
      "vless://11111111-2222-3333-4444-555555555555@b.example.com:443?type=tcp#B";
    const text = [good1, "", "garbage-line", good2, good1, "trojan://xxx@y:1"].join(
      "\n",
    );
    const { nodes, errors } = parseUriList(text);
    expect(nodes).toHaveLength(2);
    expect(errors).toHaveLength(2);
  });

  it("未知协议报不支持", () => {
    expect(() => parseUri("http://example.com")).toThrow(/不支持/);
  });
});

// ---------------- base64 ----------------

describe("base64 工具", () => {
  it("URL-safe 与缺 padding 都能解", () => {
    expect(b64DecodeUtf8("5rWL6K-V")).toBe("测试"); // urlsafe 无 padding
    expect(b64DecodeUtf8("5rWL6K+V")).toBe("测试"); // 标准
  });
});
