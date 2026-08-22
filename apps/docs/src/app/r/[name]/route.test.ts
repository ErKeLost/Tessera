import { describe, expect, test } from "bun:test";
import { GET } from "./route";

describe("retired registry route", () => {
  test("rejects invalid registry item names", async () => {
    const response = await GET(
      new Request("http://localhost:3000/r/unsafe"),
      { params: Promise.resolve({ name: "../unsafe" }) },
    );

    expect(response.status).toBe(400);
  });

  test("returns gone for the unpublished registry", async () => {
    const response = await GET(
      new Request("http://localhost:3000/r/all.json"),
      { params: Promise.resolve({ name: "all.json" }) },
    );

    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "The Tessera Agent component registry is not published. Use the repository source and proof workflow.",
    });
  });
});
