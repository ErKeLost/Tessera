import { describe, expect, test } from "bun:test";
import {
  BackgroundConcurrencyGate,
  BackgroundSecurity,
  type BackgroundRateLimiter,
} from "./background-security";

const baseUrl = "https://playground.example.com/api/background";
const allowedRateLimiter: BackgroundRateLimiter = {
  check: async () => ({ allowed: true, limit: 12, remaining: 11, resetAt: 1_800_000_060_000 }),
};

describe("BackgroundSecurity", () => {
  test("keeps local development usable while denying cross-origin browser requests", async () => {
    const security = new BackgroundSecurity({
      env: { NODE_ENV: "development" },
      rateLimiter: allowedRateLimiter,
    });
    const accepted = await security.admit(new Request("http://localhost:3001/api/background", {
      headers: { Origin: "http://localhost:3001" },
    }));
    expect(accepted.allowed).toBe(true);
    if (accepted.allowed) accepted.release();

    const rejected = await security.admit(new Request("http://localhost:3001/api/background", {
      headers: { Origin: "https://untrusted.example" },
    }));
    expect(rejected).toMatchObject({
      allowed: false,
      status: 403,
      code: "background_origin_denied",
    });
  });

  test("fails closed in production until every paid-route control is configured", async () => {
    const security = new BackgroundSecurity({
      env: { NODE_ENV: "production" },
      rateLimiter: allowedRateLimiter,
    });
    const decision = await security.admit(new Request(baseUrl, {
      headers: { Origin: "https://playground.example.com" },
    }));
    expect(decision).toMatchObject({
      allowed: false,
      status: 503,
      code: "background_security_unconfigured",
    });
  });

  test("issues a signed session, enforces its origin, and accepts a cookie-bound request", async () => {
    const now = 1_800_000_000_000;
    const security = new BackgroundSecurity({
      now: () => now,
      rateLimiter: allowedRateLimiter,
      env: {
        NODE_ENV: "production",
        ARTIFACT_BACKGROUND_ALLOWED_ORIGINS: "https://playground.example.com",
        ARTIFACT_BACKGROUND_ACCESS_TOKEN: "test-access-token",
        ARTIFACT_BACKGROUND_SESSION_SECRET: "test-session-secret",
      },
    });
    const grant = security.issueSession(new Request(baseUrl, {
      headers: { Origin: "https://playground.example.com" },
    }), "test-access-token");
    expect(grant.success).toBe(true);
    if (!grant.success) return;
    const cookie = grant.cookie.split(";", 1)[0]!;
    expect(grant.cookie).toContain("HttpOnly");
    expect(grant.cookie).toContain("SameSite=Strict");
    expect(grant.cookie).toContain("Secure");

    const decision = await security.admit(new Request(baseUrl, {
      headers: {
        Cookie: cookie,
        Origin: "https://playground.example.com",
        "x-nf-client-connection-ip": "203.0.113.7",
      },
    }));
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.identity).toMatchObject({ source: "session", clientIp: "203.0.113.7" });
      decision.release();
    }

    const foreignOrigin = await security.admit(new Request(baseUrl, {
      headers: { Cookie: cookie, Origin: "https://untrusted.example" },
    }));
    expect(foreignOrigin).toMatchObject({ allowed: false, code: "background_origin_denied" });
  });

  test("applies both a distributed rate decision and local model-concurrency ceiling", async () => {
    const limitedRateLimiter: BackgroundRateLimiter = {
      check: async () => ({ allowed: false, limit: 12, remaining: 0, resetAt: 1_800_000_001_000 }),
    };
    const security = new BackgroundSecurity({
      env: { NODE_ENV: "development" },
      rateLimiter: limitedRateLimiter,
    });
    const limited = await security.admit(new Request("http://localhost:3001/api/background"));
    expect(limited).toMatchObject({ allowed: false, status: 429, code: "background_rate_limited" });

    const concurrency = new BackgroundConcurrencyGate(1);
    const concurrent = new BackgroundSecurity({
      env: { NODE_ENV: "development" },
      rateLimiter: allowedRateLimiter,
      concurrency,
    });
    const first = await concurrent.admit(new Request("http://localhost:3001/api/background"));
    const second = await concurrent.admit(new Request("http://localhost:3001/api/background"));
    expect(first.allowed).toBe(true);
    expect(second).toMatchObject({ allowed: false, status: 429, code: "background_busy" });
    if (first.allowed) first.release();
  });
});
