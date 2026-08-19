import { describe, expect, test } from "bun:test";

describe("server-only package boundary", () => {
  test("browser entry fails closed", async () => {
    await expect(import("./browser")).rejects.toThrow("server-only");
  });
});
