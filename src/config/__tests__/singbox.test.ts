import { describe, it, expect } from "vitest";
import { buildSingBoxConfig, buildOutbound, PROXY_PORT } from "../singbox";
import { Node } from "../../parser/types";

const base = { id: "n1", raw: "test", port: 443, server: "example.com" };

describe("buildSingBoxConfig", () => {
  it("外壳:mixed 入站 + proxy/direct 出站", () => {
    const node: Node = {
      ...base,
      name: "ss",
      protocol: "shadowsocks",
      method: "aes-256-gcm",
      password: "pw",
    };
    const cfg = buildSingBoxConfig(node) as any;
    expect(cfg.inbounds[0]).toMatchObject({
      type: "mixed",
      listen: "127.0.0.1",
      listen_port: PROXY_PORT,
    });
    expect(cfg.outbounds).toHaveLength(2);
    expect(cfg.outbounds[0].tag).toBe("proxy");
    expect(cfg.outbounds[1]).toMatchObject({ type: "direct", tag: "direct" });
  });

  it("TUN 模式追加 tun 入站与路由", () => {
    const node: Node = {
      ...base,
      name: "ss",
      protocol: "shadowsocks",
      method: "aes-256-gcm",
      password: "pw",
    };
    const cfg = buildSingBoxConfig(node, { tun: true }) as any;
    expect(cfg.inbounds.some((i: any) => i.type === "tun")).toBe(true);
    expect(cfg.route).toMatchObject({ auto_detect_interface: true });
  });
});

describe("buildOutbound", () => {
  it("VLESS + TLS + WS", () => {
    const node: Node = {
      ...base,
      name: "v",
      protocol: "vless",
      uuid: "u-u-i-d",
      network: "ws",
      security: "tls",
      sni: "cdn.example.com",
      host: "cdn.example.com",
      path: "/ws",
    };
    expect(buildOutbound(node)).toMatchObject({
      type: "vless",
      tag: "proxy",
      server: "example.com",
      server_port: 443,
      uuid: "u-u-i-d",
      tls: { enabled: true, server_name: "cdn.example.com", insecure: false },
      transport: {
        type: "ws",
        path: "/ws",
        headers: { Host: "cdn.example.com" },
      },
    });
  });

  it("VLESS + Reality(utls + reality 块 + flow)", () => {
    const node: Node = {
      ...base,
      name: "r",
      protocol: "vless",
      uuid: "u",
      network: "tcp",
      security: "reality",
      sni: "www.microsoft.com",
      publicKey: "PBK",
      shortId: "SID",
      fingerprint: "chrome",
      flow: "xtls-rprx-vision",
    };
    const out = buildOutbound(node) as any;
    expect(out.flow).toBe("xtls-rprx-vision");
    expect(out.tls.reality).toMatchObject({
      enabled: true,
      public_key: "PBK",
      short_id: "SID",
    });
    expect(out.tls.utls).toMatchObject({ enabled: true, fingerprint: "chrome" });
    expect(out.transport).toBeUndefined(); // tcp 无 transport
  });

  it("Shadowsocks", () => {
    const node: Node = {
      ...base,
      name: "s",
      protocol: "shadowsocks",
      method: "aes-256-gcm",
      password: "pw",
    };
    expect(buildOutbound(node)).toEqual({
      type: "shadowsocks",
      tag: "proxy",
      server: "example.com",
      server_port: 443,
      method: "aes-256-gcm",
      password: "pw",
    });
  });

  it("ShadowsocksR(protocol/obfs 参数齐全)", () => {
    const node: Node = {
      ...base,
      name: "r",
      protocol: "shadowsocksr",
      method: "aes-256-cfb",
      password: "pw",
      ssrProtocol: "auth_aes128_md5",
      protocolParam: "32:ab",
      obfs: "http_simple",
      obfsParam: "win.example.com",
    };
    expect(buildOutbound(node)).toEqual({
      type: "shadowsocksr",
      tag: "proxy",
      server: "example.com",
      server_port: 443,
      method: "aes-256-cfb",
      password: "pw",
      protocol: "auth_aes128_md5",
      protocol_param: "32:ab",
      obfs: "http_simple",
      obfs_param: "win.example.com",
    });
  });
});
