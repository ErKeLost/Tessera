import { describe, expect, test } from "bun:test";
import { isFeishuEnvironment } from "./feishu-environment";

describe("source environment routing", () => {
  test("keeps ordinary browsers on the web flow, including deceptive referrers", () => {
    for (const referrer of ["", "https://google.com/", "https://feishu.cn.example.com/", "invalid"])
      expect(isFeishuEnvironment({ pathname: "/chat/id", userAgent: "Mozilla/5.0 Chrome/140.0 Safari/537.36", referrer })).toBe(false);
    expect(isFeishuEnvironment({ pathname: "/feishufake" })).toBe(false);
  });
  test("recognizes Feishu clients, the Feishu web workspace and the dedicated entry", () => {
    expect(isFeishuEnvironment({ pathname: "/", userAgent: "Mozilla/5.0 Lark/7.40.0" })).toBe(true);
    expect(isFeishuEnvironment({ pathname: "/", userAgent: "Mozilla/5.0 Feishu/7.40.0" })).toBe(true);
    expect(isFeishuEnvironment({ pathname: "/", referrer: "https://tenant.feishu.cn/" })).toBe(true);
    expect(isFeishuEnvironment({ pathname: "/feishu" })).toBe(true);
    expect(isFeishuEnvironment({ pathname: "/feishu/chat/id" })).toBe(true);
  });
});
