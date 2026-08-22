import { describe, expect, test } from "bun:test";
import {
  stateDefinitionSchema,
  stateValueSnapshotSchema,
  stateWriteRequestSchema,
} from "@open-generative/protocol";
import type { StateDefinition } from "@open-generative/protocol";
import { InMemoryDocumentStateWriter } from "./document-state";
import { createServerFixture, testHash } from "./test-fixtures";

describe("InMemoryDocumentStateWriter", () => {
  test("commits by state revision and replays an identical request exactly", async () => {
    const fixture = await createServerFixture();
    const definition = documentStateDefinition({
      scope: "document",
      persistence: "host",
      schema: { type: "string", enum: ["all", "enterprise"] },
      schemaHash: testHash("6"),
      initial: "all",
      sensitivity: "private",
      modelVisibility: "descriptor",
      retention: "retain",
    });
    const current = stateValueSnapshotSchema.parse({
      stateId: "state:segment",
      stateRevisionId: "state-revision:initial",
      schemaHash: definition.schemaHash,
      scope: "document",
      value: "all",
    });
    const request = stateWriteRequestSchema.parse({
      requestId: "request:state-write",
      surfaceSessionId: fixture.record.surfaceSessionId,
      documentId: fixture.record.committedRevision.envelope.documentId,
      expectedRevisionId: fixture.record.committedRevision.envelope.revisionId,
      stateId: current.stateId,
      expectedStateRevisionId: current.stateRevisionId,
      value: "enterprise",
    });
    let authorizations = 0;
    const writer = new InMemoryDocumentStateWriter({
      policy: {
        authorize: async () => {
          authorizations += 1;
          return { allowed: true };
        },
      },
      now: () => new Date("2026-08-22T00:05:00.000Z"),
    });

    const written = await writer.write({ request, definition, current, authority: fixture.record.authority });
    expect(written.status).toBe("written");
    if (written.status !== "written") throw new Error("Expected document state write.");
    expect(written.state.value).toBe("enterprise");
    expect(written.receipt.fromStateRevisionId).toBe(current.stateRevisionId);

    const replayed = await writer.write({ request, definition, current, authority: fixture.record.authority });
    expect(replayed).toEqual({ ...written, status: "replayed" });
    expect(authorizations).toBe(1);

    const reused = await writer.write({
      request: stateWriteRequestSchema.parse({ ...request, value: "all" }),
      definition,
      current,
      authority: fixture.record.authority,
    });
    expect(reused).toMatchObject({ status: "conflict", code: "state.request-id-reused" });

    const stale = await writer.write({
      request: stateWriteRequestSchema.parse({ ...request, requestId: "request:stale" }),
      definition,
      current,
      authority: fixture.record.authority,
    });
    expect(stale).toMatchObject({ status: "conflict", code: "state.revision-conflict" });
  });

  test("rejects invalid values and host policy denial before mutation", async () => {
    const fixture = await createServerFixture();
    const definition = documentStateDefinition({
      scope: "document",
      persistence: "host",
      schema: { type: "integer", minimum: 0, maximum: 10 },
      schemaHash: testHash("7"),
      initial: 0,
      sensitivity: "private",
      modelVisibility: "none",
      retention: "retain",
    });
    const current = stateValueSnapshotSchema.parse({
      stateId: "state:limit",
      stateRevisionId: "state-revision:limit",
      schemaHash: definition.schemaHash,
      scope: "document",
      value: 0,
    });
    const baseRequest = stateWriteRequestSchema.parse({
      requestId: "request:invalid",
      surfaceSessionId: fixture.record.surfaceSessionId,
      documentId: fixture.record.committedRevision.envelope.documentId,
      expectedRevisionId: fixture.record.committedRevision.envelope.revisionId,
      stateId: current.stateId,
      expectedStateRevisionId: current.stateRevisionId,
      value: 11,
    });
    const writer = new InMemoryDocumentStateWriter({
      policy: { authorize: async () => ({ allowed: false, code: "policy.state-denied", message: "Denied." }) },
    });
    expect(await writer.write({
      request: baseRequest,
      definition,
      current,
      authority: fixture.record.authority,
    })).toMatchObject({ status: "denied", code: "state.value-invalid" });
    expect(await writer.write({
      request: stateWriteRequestSchema.parse({ ...baseRequest, requestId: "request:denied", value: 5 }),
      definition,
      current,
      authority: fixture.record.authority,
    })).toMatchObject({ status: "denied", code: "policy.state-denied" });
  });

  test("rejects JSON Schema defaults instead of mutating the canonical request value", async () => {
    const fixture = await createServerFixture();
    const definition = documentStateDefinition({
      scope: "document",
      persistence: "host",
      schema: {
        type: "object",
        properties: { mode: { type: "string", default: "all" } },
        additionalProperties: false,
      },
      schemaHash: testHash("8"),
      initial: { mode: "all" },
      sensitivity: "private",
      modelVisibility: "none",
      retention: "retain",
    });
    const current = stateValueSnapshotSchema.parse({
      stateId: "state:preferences",
      stateRevisionId: "state-revision:preferences",
      schemaHash: definition.schemaHash,
      scope: "document",
      value: { mode: "all" },
    });
    const request = stateWriteRequestSchema.parse({
      requestId: "request:default-forbidden",
      surfaceSessionId: fixture.record.surfaceSessionId,
      documentId: fixture.record.committedRevision.envelope.documentId,
      expectedRevisionId: fixture.record.committedRevision.envelope.revisionId,
      stateId: current.stateId,
      expectedStateRevisionId: current.stateRevisionId,
      value: {},
    });
    let authorizations = 0;
    const writer = new InMemoryDocumentStateWriter({
      policy: {
        authorize: async () => {
          authorizations += 1;
          return { allowed: true };
        },
      },
    });
    expect(await writer.write({
      request,
      definition,
      current,
      authority: fixture.record.authority,
    })).toMatchObject({ status: "denied", code: "state.value-transformation-forbidden" });
    expect(authorizations).toBe(0);
  });
});

function documentStateDefinition(input: unknown): Extract<StateDefinition, { scope: "document" }> {
  const definition = stateDefinitionSchema.parse(input);
  if (definition.scope !== "document") throw new TypeError("Expected document state definition.");
  return definition;
}
