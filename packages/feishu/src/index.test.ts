import { describe, expect, test } from "bun:test";
import { createFeishuApiReader, createFeishuOAuthUrl, exchangeFeishuOAuthCode } from "./index";

const identity = { subject: "user-1", tenantId: "tenant-1" } as const;

describe("Feishu API reader", () => {
  test("builds an OAuth URL with an explicit state", () => {
    const url = new URL(createFeishuOAuthUrl({
      appId: "cli_test",
      redirectUri: "https://app.example.test/auth/feishu/callback",
      state: "state-123",
      scope: "contact:user.base:readonly",
    }));
    expect(url.pathname).toBe("/open-apis/authen/v1/authorize");
    expect(url.searchParams.get("client_id")).toBe("cli_test");
    expect(url.searchParams.get("state")).toBe("state-123");
  });

  test("exchanges an OAuth code without exposing the response envelope", async () => {
    let requestBody = "";
    const token = await exchangeFeishuOAuthCode({
      appId: "cli_test",
      appSecret: "secret",
      code: "one-time-code",
      fetch: async (_input, init) => {
        requestBody = String(init?.body ?? "");
        return new Response(JSON.stringify({ code: 0, access_token: "user-token", expires_in: 3_600 }), { status: 200 });
      },
    });
    expect(JSON.parse(requestBody)).toMatchObject({ client_id: "cli_test", code: "one-time-code" });
    expect(token).toEqual({ accessToken: "user-token", expiresIn: 3_600 });
  });

  test("normalizes bounded search results and passes the user token", async () => {
    let seenAuthorization = "";
    const reader = createFeishuApiReader({
      tokenProvider: { async getAccessToken() { return "user-token"; } },
      fetch: async (_input, init) => {
        seenAuthorization = new Headers(init?.headers).get("Authorization") ?? "";
        return new Response(JSON.stringify({
          code: 0,
          data: { docs_entities: [{ docs_token: "doc-1", title: "Roadmap", docs_type: "docx", url: "https://feishu.cn/docx/doc-1" }] },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    const result = await reader.search({ query: "roadmap", limit: 8 }, { identity, signal: new AbortController().signal });
    expect(seenAuthorization).toBe("Bearer user-token");
    expect(result).toMatchObject({ status: "completed", documents: [{ documentId: "https://feishu.cn/docx/doc-1", title: "Roadmap", kind: "docx" }] });
  });

  test("returns denial and truncates document content", async () => {
    let calls = 0;
    const reader = createFeishuApiReader({
      tokenProvider: { async getAccessToken() { return "user-token"; } },
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response(JSON.stringify({ code: 99991663, msg: "permission denied" }), { status: 200 })
          : new Response(JSON.stringify({ code: 0, data: { content: "abcdefghij" } }), { status: 200 });
      },
    });
    const denied = await reader.search({ query: "secret", limit: 8 }, { identity, signal: new AbortController().signal });
    const document = await reader.read({ documentId: "doc-1", maxCharacters: 4 }, { identity, signal: new AbortController().signal });
    expect(denied.status).toBe("denied");
    expect(document).toMatchObject({ status: "completed", content: "abcd", truncated: true });
  });

  test("reads Wiki content in pages and never fetches an arbitrary link origin", async () => {
    const paths: string[] = [];
    const reader = createFeishuApiReader({ tokenProvider: { async getAccessToken() { return "user-token"; } },
      fetch: async (input) => {
        const url = new URL(String(input)); paths.push(url.pathname);
        expect(url.origin).toBe("https://open.feishu.cn");
        if (url.pathname.endsWith("get_node")) return Response.json({ code: 0, data: { node: { obj_token: "doc1", obj_type: "docx", title: "Wiki title" } } });
        if (url.pathname.endsWith("raw_content")) return Response.json({ code: 0, data: { content: "abcdefgh" } });
        return Response.json({ code: 0, data: { document: { title: "Project title" } } });
      },
    });
    const context = { identity, signal: new AbortController().signal };
    const first = await reader.read({ documentId: "https://team.feishu.cn/wiki/wiki1", maxCharacters: 4 }, context);
    expect(first).toMatchObject({ status: "completed", content: "abcd", truncated: true, document: { title: "Project title" } });
    const second = await reader.read({ documentId: "https://team.feishu.cn/wiki/wiki1", maxCharacters: 4, cursor: first.nextCursor }, context);
    expect(second).toMatchObject({ status: "completed", content: "efgh", truncated: false });
    const count = paths.length;
    expect((await reader.read({ documentId: "https://attacker.test/docx/private", maxCharacters: 4 }, context)).status).toBe("unavailable");
    expect(paths).toHaveLength(count);
    expect((await reader.read({ documentId: "https://team.feishu.cn/wiki/wiki1", maxCharacters: 4, cursor: "broken" }, context)).status).toBe("unavailable");
  });
});
