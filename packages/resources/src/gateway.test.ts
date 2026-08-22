import { describe, expect, test } from "bun:test";
import {
  columnIdSchema,
  jsonSchemaSchema,
  resourceDatasetPayloadSchema,
  resourceBindingIdSchema,
  resourceVersionIdSchema,
  revisionIdSchema,
  sha256HashSchema,
  stateIdSchema,
  surfaceSessionIdSchema,
} from "@open-generative/protocol";
import { z } from "zod";
import {
  EncryptedResourceCursorCodec,
  InMemoryResourceGrantStore,
  InMemoryResourceVersionStore,
  ResourceCursorError,
  ResourceGateway,
  ResourceSchemaRegistry,
} from "./index";

const hash = (character: string) => sha256HashSchema.parse(`sha256:${character.repeat(64)}`);
const datasetJsonSchema = jsonSchemaSchema.parse(z.toJSONSchema(resourceDatasetPayloadSchema));

function fixture() {
  const schemas = new ResourceSchemaRegistry();
  const constraint = schemas.register({
    schemaId: "schema:sales",
    schemaRevision: 1,
    schema: datasetJsonSchema,
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
  test("preserves JSON Schema date-time offsets without a lossy schema conversion", () => {
    const schemas = new ResourceSchemaRegistry();
    const constraint = schemas.register({
      schemaId: "schema:query-details",
      schemaRevision: 1,
      schema: {
        type: "object",
        properties: {
          observedAt: { type: "string", format: "date-time" },
        },
        required: ["observedAt"],
        additionalProperties: false,
      },
    });

    expect(schemas.validate(constraint, {
      observedAt: "2026-08-22T09:30:00+08:00",
    })).toEqual({
      observedAt: "2026-08-22T09:30:00+08:00",
    });
    expect(() => schemas.validate(constraint, {
      observedAt: "22 August 2026",
    })).toThrow("Resource payload does not match its registered schema");
  });

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
        columns: [
          { columnId: "region", label: "Region", valueType: "string" },
          { columnId: "revenue", label: "Revenue", valueType: "number" },
        ],
        rows: [{ region: "North", revenue: 12 }, { region: "South", revenue: 8 }],
        hasMore: false,
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
      columns: [
        { columnId: "region", label: "Region", valueType: "string" },
        { columnId: "revenue", label: "Revenue", valueType: "number" },
      ],
      rows: [{ region: "North", revenue: 12 }],
      totalRows: 2,
      hasMore: true,
    });
    expect(resourceDatasetPayloadSchema.safeParse(first.snapshot.payload.value).success).toBe(true);

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
      columns: [
        { columnId: "region", label: "Region", valueType: "string" },
        { columnId: "revenue", label: "Revenue", valueType: "number" },
      ],
      rows: [{ region: "South", revenue: 8 }],
      totalRows: 2,
      hasMore: false,
    });
    expect(resourceDatasetPayloadSchema.safeParse(second.snapshot.payload.value).success).toBe(true);
  });

  test("fails closed for another actor and a revoked grant", async () => {
    const { gateway, grants, constraint } = fixture();
    const publication = await gateway.publishPinned({
      resourceKey: "resource:record",
      kind: "record",
      schemaConstraint: constraint,
      payload: {
        columns: [{ columnId: "region", label: "Region", valueType: "string" }],
        rows: [],
        hasMore: false,
      },
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
      schema: datasetJsonSchema,
    });
    const grants = new InMemoryResourceGrantStore();
    let observedState: unknown;
    let grantSequence = 0;
    const filterStateId = stateIdSchema.parse("state:region");
    const gateway = new ResourceGateway({
      versions: new InMemoryResourceVersionStore(),
      grants,
      schemas,
      cursorCodec: new EncryptedResourceCursorCodec(new Uint8Array(32).fill(4)),
      projectionPolicy: {
        authorize: async ({ stateValues }) => {
          observedState = stateValues;
          const selectedRegion = stateValues[filterStateId];
          return {
            allowed: true,
            filterRow: (row) => row.region === selectedRegion,
          };
        },
      },
      now: () => new Date("2026-08-22T00:00:00.000Z"),
      versionIdFactory: () => "resource-version:filtered",
      snapshotIdFactory: () => "resource-snapshot:filtered",
      grantIdFactory: () => `resource-grant:filtered-${++grantSequence}`,
    });
    const publication = await gateway.publishPinned({
      resourceKey: "resource:filtered",
      kind: "dataset",
      schemaConstraint: constraint,
      selector: { filterStateRef: filterStateId },
      payload: {
        columns: [{ columnId: "region", label: "Region", valueType: "string" }],
        rows: [{ region: "North" }, { region: "South" }],
        hasMore: false,
      },
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

    const denied = await gateway.resolve({
      request,
      declaration: publication.declaration,
      authority: { actorBindingHash, tenantBindingHash },
      activeRevisionId: request.expectedRevisionId,
      stateValues: { [filterStateId]: "North" },
    });
    expect(denied).toMatchObject({
      status: "unavailable",
      unavailable: { reason: "denied", retryable: false },
    });

    await gateway.createGrant({
      bindingId,
      surfaceSessionId,
      authority: { actorBindingHash, tenantBindingHash },
      authorityPolicyRevision: "policy:2",
      allowedOperations: ["read", "window", "filter"],
      rowPolicyHash: hash("c"),
      columnPolicyHash: hash("d"),
      expiresAt: "2026-08-22T01:00:00.000Z",
    });

    const resolved = await gateway.resolve({
      request,
      declaration: publication.declaration,
      authority: { actorBindingHash, tenantBindingHash },
      activeRevisionId: request.expectedRevisionId,
      stateValues: { [filterStateId]: "North" },
    });
    expect(resolved.status).toBe("resolved");
    expect(observedState).toEqual({ [filterStateId]: "North" });
    if (resolved.status !== "resolved" || resolved.snapshot.payload.kind !== "json") {
      throw new Error("Expected the North dataset window.");
    }
    expect(resolved.snapshot.payload.value).toMatchObject({
      rows: [{ region: "North" }],
      totalRows: 1,
    });

    const south = await gateway.resolve({
      request: { ...request, requestId: "request:filtered-south" },
      declaration: publication.declaration,
      authority: { actorBindingHash, tenantBindingHash },
      activeRevisionId: request.expectedRevisionId,
      stateValues: { [filterStateId]: "South" },
    });
    expect(south.status).toBe("resolved");
    if (south.status !== "resolved" || south.snapshot.payload.kind !== "json") {
      throw new Error("Expected the South dataset window.");
    }
    expect(south.snapshot.payload.value).toMatchObject({
      rows: [{ region: "South" }],
      totalRows: 1,
    });
  });

  test("rejects malformed dataset rows even when a host schema is permissive", async () => {
    const { gateway, constraint } = fixture();
    await expect(gateway.publishPinned({
      resourceKey: "resource:malformed",
      kind: "dataset",
      schemaConstraint: constraint,
      payload: {
        columns: [{ columnId: "declared", label: "Declared", valueType: "number" }],
        rows: [{ undeclared: 1 }],
        hasMore: false,
      },
    })).rejects.toBeDefined();
  });
});
