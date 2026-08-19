import { describe, expect, test } from "bun:test";
import { BackgroundSecurity } from "@/lib/background-security";
import { createBackgroundAccessPostHandler } from "./route";

const origin = "https://playground.example.com";
const endpoint = `${origin}/api/background/access`;

function productionSecurity() {
  return new BackgroundSecurity({
    env: {
      NODE_ENV: "production",
      ARTIFACT_BACKGROUND_ALLOWED_ORIGINS: origin,
      ARTIFACT_BACKGROUND_ACCESS_TOKEN: "access-token",
      ARTIFACT_BACKGROUND_SESSION_SECRET: "session-secret",
    },
    rateLimiter: { check: async () => ({ allowed: true, limit: 12, remaining: 11, resetAt: Date.now() + 60_000 }) },
  });
}

function accessRequest(payload: unknown, headers: HeadersInit = {}): Request {
  return new Request(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, ...headers },
    body: JSON.stringify(payload),
  });
}

describe("background access route", () => {
  test("exchanges a valid access token for a private signed session", async () => {
    const response = await createBackgroundAccessPostHandler(productionSecurity())(
      accessRequest({ accessToken: "access-token" }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("rejects invalid tokens and cross-origin token submissions", async () => {
    const handler = createBackgroundAccessPostHandler(productionSecurity());
    const invalidToken = await handler(accessRequest({ accessToken: "not-it" }));
    expect(invalidToken).toMatchObject({ status: 401 });
    expect((await invalidToken.json()) as unknown).toMatchObject({ error: { code: "background_access_denied" } });

    const crossOrigin = await handler(accessRequest(
      { accessToken: "access-token" },
      { Origin: "https://untrusted.example" },
    ));
    expect(crossOrigin).toMatchObject({ status: 403 });
    expect((await crossOrigin.json()) as unknown).toMatchObject({ error: { code: "background_origin_denied" } });
  });

  test("bounds and validates the access request before checking the token", async () => {
    const handler = createBackgroundAccessPostHandler(productionSecurity());
    const missing = await handler(accessRequest({}));
    expect(missing).toMatchObject({ status: 400 });

    const unsupported = await handler(new Request(endpoint, { method: "POST", body: "access-token" }));
    expect(unsupported).toMatchObject({ status: 415 });
  });
});
