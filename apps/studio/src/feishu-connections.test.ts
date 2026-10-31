import { describe, expect, test } from "bun:test";
import { InMemoryDurableStateStore } from "@open-tessera/runtime";
import { FeishuConnectionService } from "./feishu-connections";

const owner = { tenantId: "tenant", subject: "owner" };
const stranger = { tenantId: "tenant", subject: "other" };
const origin = "https://studio.example.test";
const signal = new AbortController().signal;

function fixture() {
  const state = new InMemoryDurableStateStore();
  let now = Date.now();
  const calls: Record<string, unknown>[] = [];
  const create = () => new FeishuConnectionService({ state, encryptionSecret: "test-encryption-key", now: () => now,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); calls.push(body);
      return Response.json({ code: 0, access_token: body.grant_type === "refresh_token" ? "refreshed-token" : "original-token", refresh_token: "refresh-token", expires_in: 120 });
    },
  });
  return { state, create, calls, advance: () => { now += 100_000; } };
}

describe("Feishu authorization boundary", () => {
  test("binds consent to owner, browser, origin, PKCE and a one-time state", async () => {
    const f = fixture(); const service = f.create();
    await service.configure(owner, { appId: "cli_test", appSecret: "test-secret" });
    const pending = await service.begin(owner, origin);
    const state = new URL(pending.url).searchParams.get("state")!;
    const input = { code: "one-time-code", state, browserBinding: pending.browserBinding, origin };
    await expect(service.complete(stranger, input, signal)).rejects.toThrow();
    await expect(service.complete(owner, { ...input, browserBinding: "wrong-browser" }, signal)).rejects.toThrow();
    await expect(service.complete(owner, { ...input, origin: "https://other.example.test" }, signal)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
    await service.complete(owner, input, signal);
    expect(f.calls[0]).toMatchObject({ grant_type: "authorization_code", code: "one-time-code", redirect_uri: `${origin}/api/feishu/callback` });
    expect(typeof f.calls[0]?.code_verifier).toBe("string");
    expect(await service.status(owner)).toMatchObject({ connected: true, configured: true });
    expect(JSON.stringify(await service.status(owner))).not.toContain("original-token");
    await expect(service.complete(owner, input, signal)).rejects.toThrow();
    expect(await f.create().accessToken(owner, signal)).toBe("original-token");
    await expect(service.accessToken(stranger, signal)).rejects.toThrow();
  });

  test("serializes refresh across service instances and disconnects every reader", async () => {
    const f = fixture(); const service = f.create();
    await service.configure(owner, { appId: "cli_test", appSecret: "test-secret" });
    const pending = await service.begin(owner, origin);
    await service.complete(owner, { code: "test-code", state: new URL(pending.url).searchParams.get("state")!, browserBinding: pending.browserBinding, origin }, signal);
    f.advance();
    const tokens = await Promise.all([service.accessToken(owner, signal), f.create().accessToken(owner, signal)]);
    expect(tokens).toEqual(["refreshed-token", "refreshed-token"]);
    expect(f.calls.filter((call) => call.grant_type === "refresh_token")).toHaveLength(1);
    await service.disconnect(owner);
    await expect(f.create().accessToken(owner, signal)).rejects.toThrow();
  });

  test("invalidates consent when app credentials change and expires pending consent", async () => {
    const f = fixture(); const service = f.create();
    await service.configure(owner, { appId: "cli_test", appSecret: "test-secret" });
    const pending = await service.begin(owner, origin);
    await service.configure(owner, { appId: "cli_other", appSecret: "other-secret" });
    await expect(service.complete(owner, { code: "test-code", state: new URL(pending.url).searchParams.get("state")!, browserBinding: pending.browserBinding, origin }, signal)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
    const expired = await service.begin(owner, origin);
    f.advance(); f.advance(); f.advance(); f.advance();
    await expect(service.complete(owner, { code: "test-code", state: new URL(expired.url).searchParams.get("state")!, browserBinding: expired.browserBinding, origin }, signal)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
});
