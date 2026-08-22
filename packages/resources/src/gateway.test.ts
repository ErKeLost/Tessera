import { describe, expect, test } from "bun:test";
import {
  columnIdSchema,
  resourceBindingIdSchema,
  resourceVersionIdSchema,
  revisionIdSchema,
  sha256HashSchema,
  stateIdSchema,
  surfaceSessionIdSchema,
} from "@open-generative/protocol";
import {
  EncryptedResourceCursorCodec,
  InMemoryResourceGrantStore,
  InMemoryResourceVersionStore,
  ResourceCursorError,
  ResourceGateway,
  ResourceSchemaRegistry,
} from "./index";

const hash = (character: string) => sha256HashSchema.parse(`sha256:${character.repeat(64)}`);

function fixture() {
  const schemas = new ResourceSchemaRegistry();
  const constraint = schemas.register({
    schemaId: "schema:sales",
    schemaRevision: 1,
    schema: {
      type: "object",
      properties: {
        columns: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, label: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
        },
        rows: { type: "array", items: { type: "object", additionalProperties: true } },
      },
      required: ["columns", "rows"],
      additionalProperties: false,
    },
  });
  const versions = new InMemoryResourceVersionStore();
  const grants = new InMemoryResourceGrantStore();
  let version = 0;
  let snapshot = 0;
  let grant = 0;
  const gateway = new ResourceGateway({
    versions,
    grants,
    schemas,
    cursorCodec: new EncryptedResourceCursorCodec(new Uint8Array(32).fill(7)),
    projectionPolicy: {
      authorize: async () => ({
        allowed: true,
        allowedColumns: [columnIdSchema.parse("region"), columnIdSchema.parse("revenue")],
        filterRow: (row) => typeof row.revenue === "number" && row.revenue > 0,
      }),
    },
    now: () => new Date("2026-08-22T00:00:00.000Z"),
    versionIdFactory: () => `resource-version:${++version}`,
    snapshotIdFactory: () => `resource-snapshot:${++snapshot}`,
    grantIdFactory: () => `resource-grant:${++grant}`,
  });
  return { gateway, grants, constraint };
}

describe("ResourceGateway", () => {
  test("publishes ref-only metadata and resolves actor-scoped projected windows", async () => {
    const { gateway, constraint } = fixture();
    const publication = await gateway.publishPinned({
      resourceKey: "resource:sales",
      kind: "dataset",
      schemaConstraint: constraint,
      selector: {
        projection: [columnIdSchema.parse("region"), columnIdSchema.parse("revenue")],
        windowLimit: 1,
      },
      payload: {
        columns: [{ id: "region", label: "Region" }, { id: "revenue", label: "Revenue" }],
        rows: [{ region: "North", revenue: 12 }, { region: "South", revenue: 8 }],
      },
    });
    const serializedMetadata = JSON.stringify(publication);
    expect(serializedMetadata).not.toContain("North");
    expect(serializedMetadata).not.toContain("South");

    const bindingId = resourceBindingIdSchema.parse("binding:sales");
    const surfaceSessionId = surfaceSessionIdSchema.parse("surface:1");
    const actorBindingHash = hash("a");
    const tenantBindingHash = hash("b");
    await gateway.createGrant({
      bindingId,
      surfaceSessionId,
      authority: { actorBindingHash, tenantBindingHash },
      authorityPolicyRevision: "policy:1",
      allowedOperations: ["read", "window", "project"],
      rowPolicyHash: hash("c"),
      columnPolicyHash: hash("d"),
      expiresAt: "2026-08-22T01:00:00.000Z",
    });
    const revisionId = revisionIdSchema.parse("revision:1");
    const first = await gateway.resolve({
      request: {
        requestId: "request:1",
        bindingId,
        surfaceSessionId,
        expectedRevisionId: revisionId,
      },
      declaration: publication.declaration,
      authority: { actorBindingHash, tenantBindingHash },
      activeRevisionId: revisionId,
    });
    expect(first.status).toBe("resolved");
    if (first.status !== "resolved") throw new Error("Expected a resolved window.");
    expect(first.snapshot.payload.kind).toBe("json");
    expect(first.snapshot.nextCursor).toBeDefined();
    if (first.snapshot.payload.kind !== "json") throw new Error("Expected JSON data.");
    expect(first.snapshot.payload.value).toEqual({
      columns: [{ id: "region", label: "Region" }, { id: "revenue", label: "Revenue" }],
      rows: [{ region: "North", revenue: 12 }],
      totalRows: 2,
    });

    const second = await gateway.resolve({
      request: {
        requestId: "request:2",
        bindingId,
        surfaceSessionId,
        expectedRevisionId: revisionId,
        expectedResourceVersionId: first.snapshot.resourceVersionId,
        serverCursor: first.snapshot.nextCursor,
      },
      declaration: publication.declaration,
      authority: { actorBindingHash, tenantBindingHash },
      activeRevisionId: revisionId,
    });
    expect(second.status).toBe("resolved");
    if (second.status !== "resolved" || second.snapshot.payload.kind !== "json") throw new Error("Expected the second JSON window.");
    expect(second.snapshot.payload.value).toEqual({
      columns: [{ id: "region", label: "Region" }, { id: "revenue", label: "Revenue" }],
      rows: [{ region: "South", revenue: 8 }],
      totalRows: 2,
    });
  });

  test("fails closed for another actor and a revoked grant", async () => {
    const { gateway, grants, constraint } = fixture();
    const publication = await gateway.publishPinned({
      resourceKey: "resource:record",
      kind: "record",
      schemaConstraint: constraint,
      payload: { columns: [], rows: [] },
    });
    const bindingId = resourceBindingIdSchema.parse("binding:record");
    const surfaceSessionId = surfaceSessionIdSchema.parse("surface:2");
    const actorBindingHash = hash("a");
    const tenantBindingHash = hash("b");
    const grant = await gateway.createGrant({
      bindingId,
      surfaceSessionId,
      authority: { actorBindingHash, tenantBindingHash },
      authorityPolicyRevision: "policy:1",
      allowedOperations: ["read", "window"],
      rowPolicyHash: hash("c"),
      columnPolicyHash: hash("d"),
      expiresAt: "2026-08-22T01:00:00.000Z",
    });
    const request = {
      requestId: "request:3",
      bindingId,
      surfaceSessionId,
      expectedRevisionId: revisionIdSchema.parse("revision:2"),
    };
    const denied = await gateway.resolve({
      request,
      declaration: publication.declaration,
      authority: { actorBindingHash: hash("e"), tenantBindingHash },
      activeRevisionId: "revision:2",
    });
    expect(denied).toEqual({ status: "unavailable", unavailable: { bindingId, reason: "denied", retryable: false } });

    await grants.revoke(grant.grantId, 1);
    const revoked = await gateway.resolve({
      request,
      declaration: publication.declaration,
      authority: { actorBindingHash, tenantBindingHash },
      activeRevisionId: "revision:2",
    });
    expect(revoked).toEqual({ status: "unavailable", unavailable: { bindingId, reason: "revoked", retryable: false } });
  });

  test("rejects an authenticated cursor after tampering", () => {
    const codec = new EncryptedResourceCursorCodec(new Uint8Array(32).fill(9));
    const cursor = codec.encode({
      bindingId: resourceBindingIdSchema.parse("binding:cursor"),
      surfaceSessionId: surfaceSessionIdSchema.parse("surface:cursor"),
      resourceVersionId: resourceVersionIdSchema.parse("resource-version:cursor"),
      actorBindingHash: hash("a"),
      projectionHash: hash("b"),
      policyProjectionHash: hash("c"),
      offset: 10,
      expiresAt: "2026-08-22T01:00:00.000Z",
    });
    const changed = cursor[3] === "a" ? "b" : "a";
    const tampered = `${cursor.slice(0, 3)}${changed}${cursor.slice(4)}` as typeof cursor;
    expect(() => codec.decode(tampered)).toThrow(ResourceCursorError);
  });

  test("passes filter state into projection policy and fails closed when it is missing", async () => {
    const schemas = new ResourceSchemaRegistry();
    const constraint = schemas.register({
      schemaId: "schema:filtered",
      schemaRevision: 1,
      schema: {
        type: "object",
        properties: {
          columns: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
          rows: { type: "array", items: { type: "object", additionalProperties: true } },
        },
        required: ["columns", "rows"],
        additionalProperties: false,
      },
    });
    const grants = new InMemoryResourceGrantStore();
    let observedState: unknown;
    const gateway = new ResourceGateway({
      versions: new InMemoryResourceVersionStore(),
      grants,
      schemas,
      cursorCodec: new EncryptedResourceCursorCodec(new Uint8Array(32).fill(4)),
      projectionPolicy: {
        authorize: async ({ stateValues }) => {
          observedState = stateValues;
          return { allowed: true };
        },
      },
      now: () => new Date("2026-08-22T00:00:00.000Z"),
      versionIdFactory: () => "resource-version:filtered",
      snapshotIdFactory: () => "resource-snapshot:filtered",
      grantIdFactory: () => "resource-grant:filtered",
    });
    const filterStateId = stateIdSchema.parse("state:region");
    const publication = await gateway.publishPinned({
      resourceKey: "resource:filtered",
      kind: "dataset",
      schemaConstraint: constraint,
      selector: { filterStateRef: filterStateId },
      payload: { columns: [{ id: "region" }], rows: [{ region: "North" }] },
    });
    const bindingId = resourceBindingIdSchema.parse("binding:filtered");
    const surfaceSessionId = surfaceSessionIdSchema.parse("surface:filtered");
    const actorBindingHash = hash("a");
    const tenantBindingHash = hash("b");
    await gateway.createGrant({
      bindingId,
      surfaceSessionId,
      authority: { actorBindingHash, tenantBindingHash },
      authorityPolicyRevision: "policy:1",
      allowedOperations: ["read", "window"],
      rowPolicyHash: hash("c"),
      columnPolicyHash: hash("d"),
      expiresAt: "2026-08-22T01:00:00.000Z",
    });
    const request = {
      requestId: "request:filtered",
      bindingId,
      surfaceSessionId,
      expectedRevisionId: revisionIdSchema.parse("revision:filtered"),
    };
    const missing = await gateway.resolve({
      request,
      declaration: publication.declaration,
      authority: { actorBindingHash, tenantBindingHash },
      activeRevisionId: request.expectedRevisionId,
    });
    expect(missing).toMatchObject({ status: "unavailable", unavailable: { retryable: true } });

    const resolved = await gateway.resolve({
      request,
      declaration: publication.declaration,
      authority: { actorBindingHash, tenantBindingHash },
      activeRevisionId: request.expectedRevisionId,
      stateValues: { [filterStateId]: "North" },
    });
    expect(resolved.status).toBe("resolved");
    expect(observedState).toEqual({ [filterStateId]: "North" });
  });

  test("rejects malformed dataset rows even when a host schema is permissive", async () => {
    const { gateway, constraint } = fixture();
    await expect(gateway.publishPinned({
      resourceKey: "resource:malformed",
      kind: "dataset",
      schemaConstraint: constraint,
      payload: {
        columns: [{ id: "declared" }],
        rows: [{ undeclared: 1 }],
      },
    })).rejects.toBeDefined();
  });
});
