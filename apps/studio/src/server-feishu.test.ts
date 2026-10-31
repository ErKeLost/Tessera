import { describe, expect, test } from "bun:test";
import { InMemoryDurableStateStore } from "@open-tessera/runtime";
import type { DatabaseConnector } from "@open-tessera/database";
import { createStudioApp } from "./server";
import { FeishuConnectionService } from "./feishu-connections";

const origin = "https://studio.example.test";

describe("Feishu OAuth routes", () => {
  test("saves credentials without returning secrets and completes cookie-bound consent", async () => {
    let tokenCalls = 0;
    const connections = new FeishuConnectionService({ state: new InMemoryDurableStateStore(), encryptionSecret: "test-key", fetch: async () => {
      tokenCalls++;
      return Response.json({ code: 0, access_token: "private-token", refresh_token: "private-refresh", expires_in: 7_200 });
    } });
    const app = createStudioApp({ connector: { id: "unused", dialect: "postgres", close: async () => {} } as unknown as DatabaseConnector, feishuConnections: connections });
    const saved = await app.fetch(new Request(`${origin}/api/feishu`, { method: "PUT", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ appId: "cli_test", appSecret: "private-secret" }) }));
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain("private-secret");
    const begin = await app.fetch(new Request(`${origin}/api/feishu/connect`, { method: "POST", headers: { Origin: origin } }));
    const cookie = begin.headers.get("Set-Cookie")!.split(";")[0]!;
    const authorization = new URL((await begin.json() as { url: string }).url);
    const callback = `${origin}/api/feishu/callback?code=one-time-code&state=${authorization.searchParams.get("state")}`;
    const withoutCookie = await app.fetch(new Request(callback));
    expect(withoutCookie.headers.get("Location")).toBe("/feishu?feishu=error");
    expect(tokenCalls).toBe(0);
    const completed = await app.fetch(new Request(callback, { headers: { Cookie: cookie } }));
    expect(completed.status).toBe(303);
    expect(completed.headers.get("Location")).toBe("/feishu?feishu=connected");
    expect(tokenCalls).toBe(1);
    const status = await app.fetch(new Request(`${origin}/api/feishu`));
    expect(await status.json()).toMatchObject({ connected: true, configured: true });
    const denied = await app.fetch(new Request(`${origin}/api/feishu`, { method: "DELETE", headers: { Origin: "https://other.test" } }));
    expect(denied.status).toBe(403);
  });
});
