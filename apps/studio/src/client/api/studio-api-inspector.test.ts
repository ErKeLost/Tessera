import { afterEach, describe, expect, test } from "bun:test";
import {
  dispatchStudioOpenGenerativeCommand,
  fetchStudioOpenGenerativeInspection,
} from "./studio-api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Studio Open Generative Inspector API", () => {
  test("forwards a Surface command AbortSignal to fetch", async () => {
    const abortController = new AbortController();
    installFetch(async (input, init) => {
      expect(String(input)).toBe("/api/open-generative/commands");
      expect(init?.signal).toBe(abortController.signal);
      return Response.json({ status: "acknowledged" });
    });

    await expect(dispatchStudioOpenGenerativeCommand(
      { commandId: "command:abort-signal" } as never,
      abortController.signal,
    )).resolves.toEqual([]);
  });

  test("accepts a bounded inspection belonging to the requested Surface", async () => {
    const surfaceSessionId = "surface:api-inspection";
    installFetch(async (input) => {
      expect(String(input)).toBe(`/api/open-generative/inspections/${encodeURIComponent(surfaceSessionId)}`);
      return Response.json(record(surfaceSessionId));
    });

    const result = await fetchStudioOpenGenerativeInspection(surfaceSessionId);

    expect(result.snapshot.surfaceSessionId).toBe(surfaceSessionId);
    expect(result.snapshot.ogl.source).toBe('root = Text("Ready")\n');
    expect(result.snapshot.events).toEqual([{ sequence: 1 }]);
  });

  test("rejects a response for another Surface session", async () => {
    installFetch(async () => Response.json(record("surface:foreign")));

    await expect(fetchStudioOpenGenerativeInspection("surface:requested")).rejects.toThrow(
      "open_generative_inspection_response_invalid",
    );
  });

  test("rejects an invalid Surface id before issuing a request", async () => {
    let called = false;
    installFetch(async () => {
      called = true;
      return Response.json({});
    });

    await expect(fetchStudioOpenGenerativeInspection("../private")).rejects.toThrow("surface_session_id_invalid");
    expect(called).toBe(false);
  });
});

function installFetch(handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): void {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect });
}

function record(surfaceSessionId: string) {
  return {
    authority: {
      actorBindingHash: `sha256:${"a".repeat(64)}`,
      tenantBindingHash: `sha256:${"b".repeat(64)}`,
      authorityPolicyRevision: "tessera-studio.v1",
    },
    snapshot: {
      version: 2,
      surfaceSessionId,
      ogl: { source: 'root = Text("Ready")\n', ast: [{ name: "root" }] },
      catalog: { sliceHash: `sha256:${"c".repeat(64)}` },
      resourceAuthorizations: [{ bindingId: "users", decision: "allowed" }],
      events: [{ sequence: 1 }],
      receipts: [],
      rejections: [],
    },
  };
}
