import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Kept free of the __Host- prefix so localhost development can issue the same
// cookie shape. Production still requires Secure, HttpOnly, SameSite=Strict,
// and a host-only Path=/ cookie.
export const BACKGROUND_SESSION_COOKIE = "artifact-background-session";

const DEFAULT_RATE_LIMIT = 12;
const DEFAULT_RATE_WINDOW_SECONDS = 60;
const DEFAULT_CONCURRENCY_LIMIT = 2;
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;

type Environment = Readonly<Record<string, string | undefined>>;

export type BackgroundRateLimit = Readonly<{
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}>;

export interface BackgroundRateLimiter {
  check(key: string): Promise<BackgroundRateLimit>;
}

export type BackgroundRequestIdentity = Readonly<{
  subject: string;
  source: "development" | "session" | "bearer";
  clientIp: string;
}>;

export type BackgroundAdmission =
  | Readonly<{
      allowed: true;
      identity: BackgroundRequestIdentity;
      rateLimit: BackgroundRateLimit;
      release(): void;
    }>
  | Readonly<{
      allowed: false;
      status: 401 | 403 | 429 | 503;
      code: string;
      message: string;
      retryAfterSeconds?: number;
    }>;

export type BackgroundSessionGrant =
  | Readonly<{ success: true; cookie: string; expiresAt: number }>
  | Readonly<{ success: false; status: 400 | 401 | 403 | 503; code: string; message: string }>;

export type BackgroundSecurityOptions = {
  env?: Environment;
  now?: () => number;
  rateLimiter?: BackgroundRateLimiter;
  concurrency?: BackgroundConcurrencyGate;
};

/**
 * Protects the paid playground route. Local development deliberately remains
 * frictionless; a production process fails closed unless its origin, session
 * signing key, access token, and distributed limiter are configured.
 */
export class BackgroundSecurity {
  readonly #env: Environment;
  readonly #now: () => number;
  readonly #production: boolean;
  readonly #test: boolean;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #accessToken: string | undefined;
  readonly #sessionSecret: string | undefined;
  readonly #sessionTtlSeconds: number;
  readonly #rateLimiter: BackgroundRateLimiter | undefined;
  readonly #concurrency: BackgroundConcurrencyGate;

  constructor(options: BackgroundSecurityOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#now = options.now ?? Date.now;
    this.#production = this.#env.NODE_ENV === "production";
    this.#test = this.#env.NODE_ENV === "test";
    this.#allowedOrigins = parseAllowedOrigins(this.#env.ARTIFACT_BACKGROUND_ALLOWED_ORIGINS);
    this.#accessToken = nonEmpty(this.#env.ARTIFACT_BACKGROUND_ACCESS_TOKEN);
    this.#sessionSecret = nonEmpty(this.#env.ARTIFACT_BACKGROUND_SESSION_SECRET);
    this.#sessionTtlSeconds = positiveInteger(
      this.#env.ARTIFACT_BACKGROUND_SESSION_TTL_SECONDS,
      DEFAULT_SESSION_TTL_SECONDS,
      300,
      24 * 60 * 60,
    );
    this.#rateLimiter = options.rateLimiter ?? createEnvironmentRateLimiter(
      this.#env,
      this.#production,
      this.#test,
      this.#now,
    );
    this.#concurrency = options.concurrency ?? new BackgroundConcurrencyGate(
      this.#test
        ? Number.MAX_SAFE_INTEGER
        : positiveInteger(this.#env.ARTIFACT_BACKGROUND_CONCURRENCY, DEFAULT_CONCURRENCY_LIMIT, 1, 32),
    );
  }

  issueSession(request: Request, accessToken: unknown): BackgroundSessionGrant {
    const configurationFailure = this.#configurationFailure();
    if (configurationFailure) {
      return Object.freeze({
        success: false,
        status: 503,
        code: configurationFailure.code,
        message: configurationFailure.message,
      });
    }
    if (!this.#isAllowedOrigin(request)) {
      return Object.freeze({
        success: false,
        status: 403,
        code: "background_origin_denied",
        message: "This origin is not allowed to use the Playground.",
      });
    }
    if (typeof accessToken !== "string" || !sameSecret(this.#accessToken!, accessToken)) {
      return Object.freeze({
        success: false,
        status: 401,
        code: "background_access_denied",
        message: "The provided Playground access token is not valid.",
      });
    }

    const issuedAt = Math.floor(this.#now() / 1000);
    const expiresAt = issuedAt + this.#sessionTtlSeconds;
    const payload = encodeSession({
      subject: subjectFor(this.#accessToken!),
      issuedAt,
      expiresAt,
      nonce: randomUUID(),
    }, this.#sessionSecret!);
    const secure = this.#production || new URL(request.url).protocol === "https:";
    return Object.freeze({
      success: true,
      expiresAt: expiresAt * 1_000,
      cookie: [
        `${BACKGROUND_SESSION_COOKIE}=${payload}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        ...(secure ? ["Secure"] : []),
        `Max-Age=${this.#sessionTtlSeconds}`,
      ].join("; "),
    });
  }

  async admit(request: Request): Promise<BackgroundAdmission> {
    const configurationFailure = this.#configurationFailure();
    if (configurationFailure) return configurationFailure;
    if (!this.#isAllowedOrigin(request)) return originFailure();

    const identity = this.#identityFor(request);
    if (!identity) {
      return Object.freeze({
        allowed: false,
        status: 401,
        code: "background_access_required",
        message: "A valid Playground session is required.",
      });
    }

    let rateLimit: BackgroundRateLimit;
    try {
      rateLimit = await this.#rateLimiter!.check(`${identity.subject}:${identity.clientIp}`);
    } catch {
      return Object.freeze({
        allowed: false,
        status: 503,
        code: "background_rate_limiter_unavailable",
        message: "The Playground rate limiter is unavailable.",
      });
    }
    if (!rateLimit.allowed) {
      return Object.freeze({
        allowed: false,
        status: 429,
        code: "background_rate_limited",
        message: "Too many Playground requests. Please try again shortly.",
        retryAfterSeconds: Math.max(1, Math.ceil((rateLimit.resetAt - this.#now()) / 1_000)),
      });
    }

    const release = this.#concurrency.tryAcquire();
    if (!release) {
      return Object.freeze({
        allowed: false,
        status: 429,
        code: "background_busy",
        message: "The Playground is at capacity. Please retry shortly.",
        retryAfterSeconds: 1,
      });
    }
    return Object.freeze({ allowed: true, identity, rateLimit, release });
  }

  #configurationFailure(): Extract<BackgroundAdmission, { allowed: false }> | undefined {
    if (!this.#production) return undefined;
    if (!this.#accessToken || !this.#sessionSecret || this.#allowedOrigins.size === 0 || !this.#rateLimiter) {
      return Object.freeze({
        allowed: false,
        status: 503,
        code: "background_security_unconfigured",
        message: "The Playground is not configured for production access.",
      });
    }
    return undefined;
  }

  #isAllowedOrigin(request: Request): boolean {
    const origin = request.headers.get("origin");
    if (!origin) return !this.#production;
    const normalized = normalizeOrigin(origin);
    if (!normalized) return false;
    if (this.#production) return this.#allowedOrigins.has(normalized);
    return normalized === normalizeOrigin(new URL(request.url).origin);
  }

  #identityFor(request: Request): BackgroundRequestIdentity | undefined {
    const clientIp = trustedClientIp(request);
    if (!this.#production) {
      return Object.freeze({ subject: "development", source: "development", clientIp });
    }
    const bearer = bearerToken(request.headers.get("authorization"));
    if (bearer && sameSecret(this.#accessToken!, bearer)) {
      return Object.freeze({ subject: subjectFor(this.#accessToken!), source: "bearer", clientIp });
    }
    const session = decodeSession(readCookie(request.headers.get("cookie"), BACKGROUND_SESSION_COOKIE), this.#sessionSecret!, this.#now());
    if (!session || session.subject !== subjectFor(this.#accessToken!)) return undefined;
    return Object.freeze({ subject: session.subject, source: "session", clientIp });
  }
}

export class BackgroundConcurrencyGate {
  readonly #limit: number;
  #active = 0;

  constructor(limit: number) {
    this.#limit = Math.max(1, Math.floor(limit));
  }

  tryAcquire(): (() => void) | undefined {
    if (this.#active >= this.#limit) return undefined;
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active = Math.max(0, this.#active - 1);
    };
  }
}

class MemoryRateLimiter implements BackgroundRateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, { used: number; resetAt: number }>();

  constructor(limit: number, windowSeconds: number, now: () => number) {
    this.#limit = limit;
    this.#windowMs = windowSeconds * 1_000;
    this.#now = now;
  }

  async check(key: string): Promise<BackgroundRateLimit> {
    const now = this.#now();
    const current = this.#entries.get(key);
    const entry = !current || current.resetAt <= now
      ? { used: 0, resetAt: now + this.#windowMs }
      : current;
    entry.used += 1;
    this.#entries.set(key, entry);
    return Object.freeze({
      allowed: entry.used <= this.#limit,
      limit: this.#limit,
      remaining: Math.max(0, this.#limit - entry.used),
      resetAt: entry.resetAt,
    });
  }
}

export function createDefaultBackgroundSecurity(): BackgroundSecurity {
  return new BackgroundSecurity();
}

// A process-scoped guard keeps development rate/concurrency state coherent and
// gives the access-session route and streaming route one configuration source.
// It must be created after MemoryRateLimiter is initialized: native ESM class
// bindings are temporal-dead-zone values until their declaration executes.
export const backgroundSecurity = createDefaultBackgroundSecurity();

function createEnvironmentRateLimiter(
  env: Environment,
  production: boolean,
  test: boolean,
  now: () => number,
): BackgroundRateLimiter | undefined {
  if (test) return new MemoryRateLimiter(Number.MAX_SAFE_INTEGER, DEFAULT_RATE_WINDOW_SECONDS, now);
  const limit = positiveInteger(env.ARTIFACT_BACKGROUND_RATE_LIMIT, DEFAULT_RATE_LIMIT, 1, 120);
  const windowSeconds = positiveInteger(
    env.ARTIFACT_BACKGROUND_RATE_WINDOW_SECONDS,
    DEFAULT_RATE_WINDOW_SECONDS,
    1,
    60 * 60,
  );
  if (!production) return new MemoryRateLimiter(limit, windowSeconds, now);
  if (!nonEmpty(env.UPSTASH_REDIS_REST_URL) || !nonEmpty(env.UPSTASH_REDIS_REST_TOKEN)) return undefined;

  const ratelimit = new Ratelimit({
    redis: new Redis({
      url: nonEmpty(env.UPSTASH_REDIS_REST_URL)!,
      token: nonEmpty(env.UPSTASH_REDIS_REST_TOKEN)!,
      enableAutoPipelining: true,
    }),
    limiter: Ratelimit.slidingWindow(limit, `${windowSeconds} s`),
    analytics: false,
    prefix: "tessera-agent:background:v1",
    timeout: 2_000,
  });
  return {
    async check(key) {
      const result = await ratelimit.limit(key);
      void result.pending.catch(() => undefined);
      return Object.freeze({
        allowed: result.success,
        limit: result.limit,
        remaining: result.remaining,
        resetAt: result.reset,
      });
    },
  };
}

function parseAllowedOrigins(input: string | undefined): ReadonlySet<string> {
  return new Set((input ?? "").split(",")
    .map((origin) => normalizeOrigin(origin.trim()))
    .filter((origin): origin is string => origin !== undefined));
}

function normalizeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function trustedClientIp(request: Request): string {
  const netlifyIp = request.headers.get("x-nf-client-connection-ip")?.trim();
  return netlifyIp && netlifyIp.length <= 128 ? netlifyIp : "unknown";
}

function positiveInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sameSecret(expected: string, supplied: string): boolean {
  const left = createHash("sha256").update(expected).digest();
  const right = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(left, right);
}

function subjectFor(accessToken: string): string {
  return `token:${createHash("sha256").update(accessToken).digest("hex").slice(0, 24)}`;
}

function bearerToken(value: string | null): string | undefined {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

type SessionPayload = {
  subject: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

function encodeSession(payload: SessionPayload, secret: string): string {
  const serialized = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(serialized).digest("base64url");
  return `${serialized}.${signature}`;
}

function decodeSession(value: string | undefined, secret: string, now: number): SessionPayload | undefined {
  if (!value) return undefined;
  const [serialized, suppliedSignature, ...extra] = value.split(".");
  if (!serialized || !suppliedSignature || extra.length > 0) return undefined;
  const expectedSignature = createHmac("sha256", secret).update(serialized).digest("base64url");
  if (!sameSecret(expectedSignature, suppliedSignature)) return undefined;
  try {
    const candidate = JSON.parse(Buffer.from(serialized, "base64url").toString("utf8")) as unknown;
    if (!isSessionPayload(candidate) || candidate.expiresAt * 1_000 <= now) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.subject === "string"
    && Number.isSafeInteger(payload.issuedAt)
    && Number.isSafeInteger(payload.expiresAt)
    && typeof payload.nonce === "string";
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

function originFailure(): Extract<BackgroundAdmission, { allowed: false }> {
  return Object.freeze({
    allowed: false,
    status: 403,
    code: "background_origin_denied",
    message: "This origin is not allowed to use the Playground.",
  });
}
