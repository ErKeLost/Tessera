import { describe, expect, test } from "bun:test";
import { GET, HEAD } from "./route";

describe("health route", () => {
  test("returns a non-cacheable, non-secret readiness payload", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(response.headers.get("content-type")).toContain("application/json");
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toMatchObject({
      status: "ok",
      service: "tessera",
      readiness: "ready",
      checks: { application: "pass" },
    });
    expect(payload.revision).toMatch(/^(unknown|[a-f0-9]{7,64})$/i);
  });

  test("supports inexpensive HEAD probes", async () => {
    const response = HEAD();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(await response.text()).toBe("");
  });
});
