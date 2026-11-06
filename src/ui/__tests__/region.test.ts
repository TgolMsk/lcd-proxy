import { describe, expect, it } from "vitest";
import { isBuiltin, nodeLabel } from "../region";

describe("nodeLabel", () => {
  it("内核内置出站显示中文,不算地区", () => {
    expect(nodeLabel("DIRECT")).toEqual({ code: null, region: null, name: "直连", tags: [] });
    expect(nodeLabel("reject").name).toBe("拦截");
    expect(nodeLabel("REJECT-DROP").name).toBe("拦截");
    expect(isBuiltin("Direct")).toBe(true);
  });

  it("普通节点照旧识别地区和标签", () => {
    expect(nodeLabel("🇯🇵 JP-日本Ssr | x2")).toEqual({
      code: "JP",
      region: "日本",
      name: "JP-日本Ssr",
      tags: ["x2"],
    });
    expect(isBuiltin("JP-日本Ssr")).toBe(false);
  });
});
