import { describe, it, expect } from "vitest";
import { compileRules, ruleCounts } from "../compile";

const compile = (...lines: string[]) => compileRules(lines);

describe("规则转换", () => {
  it("域名类", () => {
    const { runs } = compile(
      "DOMAIN,a.com,DIRECT",
      "DOMAIN-SUFFIX,b.com,DIRECT",
      "DOMAIN-KEYWORD,c,DIRECT",
      "DOMAIN-REGEX,^d\\.,DIRECT",
    );
    expect(runs).toEqual([
      {
        target: "DIRECT",
        count: 4,
        match: {
          domain: ["a.com"],
          domain_suffix: ["b.com"],
          domain_keyword: ["c"],
          domain_regex: ["^d\\."],
        },
      },
    ]);
  });

  it("只合并相邻且目标相同的规则,规则顺序不变", () => {
    const { runs } = compile(
      "DOMAIN,a.com,甲",
      "DOMAIN,b.com,乙",
      "DOMAIN,c.com,甲",
      "DOMAIN,d.com,甲",
    );
    expect(runs.map((r) => [r.target, r.count])).toEqual([
      ["甲", 1],
      ["乙", 1],
      ["甲", 2],
    ]);
  });

  it("不同类别不合并:同一条规则里 port 和域名是「与」的关系", () => {
    const { runs } = compile("DOMAIN,a.com,甲", "DST-PORT,80,甲", "IP-CIDR,1.1.1.1/32,甲,no-resolve");
    expect(runs).toHaveLength(3);
  });

  it("no-resolve 的 IP 规则和需要解析的不合并,后者标记 resolve", () => {
    const { runs } = compile(
      "IP-CIDR,1.0.0.0/8,甲,no-resolve",
      "IP-CIDR,2.0.0.0/8,甲",
      "IP-CIDR6,2001::/16,甲",
    );
    expect(runs).toEqual([
      { target: "甲", count: 1, match: { ip_cidr: ["1.0.0.0/8"] } },
      { target: "甲", count: 2, resolve: true, match: { ip_cidr: ["2.0.0.0/8", "2001::/16"] } },
    ]);
  });

  it("端口:单个、范围、多个", () => {
    const { runs } = compile("DST-PORT,80/443/1000-2000,甲", "SRC-PORT,22,甲");
    expect(runs[0].match).toEqual({ port: [80, 443], port_range: ["1000:2000"] });
    expect(runs[1].match).toEqual({ source_port: [22] });
  });

  it("GEOIP / GEOSITE 映射内置规则集", () => {
    const { runs, skipped } = compile(
      "GEOIP,CN,甲",
      "GEOIP,CN,甲,no-resolve",
      "GEOIP,LAN,甲",
      "GEOSITE,CN,甲",
      "GEOSITE,geolocation-!cn,甲",
      "GEOIP,US,甲",
      "GEOSITE,google,甲",
    );
    expect(runs[0]).toEqual({
      target: "甲",
      count: 1,
      resolve: true,
      match: { rule_set: ["geoip-cn"] },
    });
    expect(runs[1].resolve).toBeUndefined();
    expect(runs[2].match).toEqual({ ip_is_private: true });
    expect(runs[3].match).toEqual({ rule_set: ["geosite-cn", "geosite-not-cn"] });
    expect(skipped).toEqual({
      "GEOIP US 没有内置数据": 1,
      "GEOSITE google 没有内置数据": 1,
    });
  });

  it("进程规则", () => {
    const { runs } = compile("PROCESS-NAME,a.exe,甲", "PROCESS-NAME,b.exe,甲", "PROCESS-PATH,C:\\c.exe,甲");
    expect(runs[0].match).toEqual({ process_name: ["a.exe", "b.exe"] });
    expect(runs[1].match).toEqual({ process_path: ["C:\\c.exe"] });
  });

  it("MATCH 成为最终目标", () => {
    const result = compile("DOMAIN,a.com,甲", "MATCH,兜底");
    expect(result.final).toBe("兜底");
    expect(result.total).toBe(2);
  });

  it("目标名里的 emoji、空格、& 不影响解析", () => {
    const { runs } = compile("DOMAIN,a.com,🌏 爱奇艺&哔哩哔哩");
    expect(runs[0].target).toBe("🌏 爱奇艺&哔哩哔哩");
  });

  it("逻辑规则,含嵌套", () => {
    const { runs } = compile(
      "AND,((DOMAIN-SUFFIX,a.com),(NETWORK,UDP)),甲",
      "OR,((DST-PORT,25),(AND,((DOMAIN,b.com),(DST-PORT,80)))),乙",
      "NOT,((DOMAIN,c.com)),丙",
    );
    expect(runs[0]).toMatchObject({
      target: "甲",
      match: {
        type: "logical",
        mode: "and",
        rules: [{ domain_suffix: ["a.com"] }, { network: ["udp"] }],
      },
    });
    expect((runs[1].match.rules as any[])[1]).toEqual({
      type: "logical",
      mode: "and",
      rules: [{ domain: ["b.com"] }, { port: [80] }],
    });
    expect(runs[2].match).toEqual({ domain: ["c.com"], invert: true });
  });

  it("相邻的逻辑规则不合并", () => {
    const { runs } = compile(
      "AND,((DOMAIN,a.com),(NETWORK,UDP)),甲",
      "AND,((DOMAIN,b.com),(NETWORK,TCP)),甲",
    );
    expect(runs).toHaveLength(2);
  });

  it("不支持和格式错误的规则跳过并计数,不影响其他规则", () => {
    const { runs, skipped } = compile(
      "IP-ASN,13335,甲",
      "IP-CIDR,not-an-ip,甲",
      "DOMAIN-REGEX,([,甲",
      "DOMAIN,only-value",
      "DOMAIN,ok.com,甲",
    );
    expect(runs).toHaveLength(1);
    expect(skipped).toEqual({
      "不支持 IP-ASN": 1,
      "IP 段格式无效": 1,
      "正则无效": 1,
      "规则格式无效": 1,
    });
  });

  it("手写规则:空行、注释、YAML 列表写法", () => {
    const { runs } = compile("", "# 注释", "- DOMAIN,a.com,甲", "  - 'DOMAIN,b.com,甲'");
    expect(runs[0].match).toEqual({ domain: ["a.com", "b.com"] });
  });

  it("统计各目标规则数", () => {
    const { runs } = compile("DOMAIN,a.com,甲", "DOMAIN,b.com,甲", "DST-PORT,80,甲", "DOMAIN,c.com,乙");
    expect(ruleCounts(runs)).toEqual({ 甲: 3, 乙: 1 });
  });
});
