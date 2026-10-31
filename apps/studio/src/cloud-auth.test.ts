import { describe, expect, test } from "bun:test";
import { cloudSessionAuthenticated, handleCloudLogin } from "./cloud-auth";

const origin = "https://studio.example.test";
const secret = "test-workspace-password";

function login(password: string, requestOrigin = origin) {
  return new Request(`${origin}/auth/login`, {
    method: "POST", headers: { Origin: requestOrigin },
    body: new URLSearchParams({ password }),
  });
}

describe("cloud workspace authentication", () => {
  test("preserves the Feishu entry after login and leaves the web login free of Feishu labels", async () => {
    const page = await handleCloudLogin(new Request(`${origin}/feishu`), secret);
    expect(await page.text()).toContain('/auth/login?next=feishu');
    const web = await handleCloudLogin(new Request(`${origin}/auth/login`), secret);
    expect(await web.text()).not.toContain("Feishu");
    const response = await handleCloudLogin(new Request(`${origin}/auth/login?next=feishu`, {
      method: "POST", headers: { Origin: origin }, body: new URLSearchParams({ password: secret }),
    }), secret);
    expect(response.headers.get("Location")).toBe("/feishu");
  });
  test("accepts the login cookie and rejects a different workspace key or tampering", async () => {
    const response = await handleCloudLogin(login(secret), secret);
    expect(response.status).toBe(303);
    const cookie = response.headers.get("Set-Cookie")!.split(";")[0]!;
    const request = new Request(`${origin}/api/threads`, { headers: { Cookie: cookie } });
    expect(cloudSessionAuthenticated(request, secret)).toBe(true);
    expect(cloudSessionAuthenticated(request, "another-workspace")).toBe(false);
    expect(cloudSessionAuthenticated(new Request(`${origin}/api/threads`, {
      headers: { Cookie: `${cookie}extra` },
    }), secret)).toBe(false);
  });

  test("rejects incorrect passwords, other origins and malformed cookie signatures", async () => {
    expect((await handleCloudLogin(login("wrong-password"), secret)).status).toBe(401);
    expect((await handleCloudLogin(login(secret, "https://other.example.test"), secret)).status).toBe(403);
    const request = new Request(`${origin}/api/threads`, { headers: {
      Cookie: `__Host-tessera-session=${Date.now() + 60_000}.${"é".repeat(64)}`,
    } });
    expect(cloudSessionAuthenticated(request, secret)).toBe(false);
    expect(cloudSessionAuthenticated(new Request(`${origin}/api/threads`), secret)).toBe(false);
  });
});
