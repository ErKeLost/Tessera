import { describe, expect, test } from "bun:test";
import { canonicalHash, type EvidenceReference, type ResourceReference } from "@data-elements/runtime";
import {
  DefaultResourceRedaction,
  InMemoryCommittedResourceStore,
  InMemoryResourceAuthorization,
  InMemoryResourceResolutionStore,
  InMemoryResourceSchemaRegistry,
  InMemoryResourceSource,
  InMemoryScopedResourceBindingCache,
  JsonResourceCodec,
  ResourceResolver,
  resourceBindingCacheKey,
  type RegisteredResourceSchema,
  type ResourceActorContext,
  type ResourceResolveRequest,
  type SchemaProfileBinding,
} from "./index";

const PROFILE: SchemaProfileBinding = {
  profileId: "data-elements.schema-core",
  profileVersion: 1,
  profileHash: "schema-profile-v1",
};
const NOW = "2026-08-15T00:00:00.000Z";
const ACTOR: ResourceActorContext = {
  tenantRef: "tenant-1",
  actorRef: "actor-1",
  actorContextRef: "actor-context-1",
  allowedScopeRefs: ["scope-1"],
  allowedSensitivity: ["private"],
};

describe("resource resolver", () => {
  test("keeps replayable control receipts separate from transient, actor-isolated data", async () => {
    const harness = await createHarness();
    const control = await harness.resolver.resolveControl(harness.request, ACTOR);
    expect(control.receipt.status).toBe("resolved");
    expect("binding" in control).toBe(false);

    const data = await harness.resolver.deliverData({
      request: harness.request,
      resolutionId: control.receipt.resolutionId,
      actor: ACTOR,
    });
    expect(data.type).toBe("resource-data");
    if (data.type === "resource-data") expect(data.binding.value).toEqual({ result: "ok" });

    const replay = await harness.resolver.resolveControl(harness.request, ACTOR);
    expect(replay.replayed).toBe(true);
    expect(replay.receipt.resolutionId).toBe(control.receipt.resolutionId);
    expect(harness.sourceCalls()).toBeGreaterThanOrEqual(1);

    const otherActor = { ...ACTOR, actorRef: "actor-2", actorContextRef: "actor-context-2" };
    const isolated = await harness.resolver.deliverData({
      request: harness.request,
      resolutionId: control.receipt.resolutionId,
      actor: otherActor,
    });
    expect(isolated.type).toBe("resource-unavailable");
    expect(resourceBindingCacheKey(ACTOR, harness.request, harness.reference)).not.toBe(
      resourceBindingCacheKey(otherActor, harness.request, harness.reference),
    );
  });

  test("fails closed on content-hash mismatch and never emits a data binding", async () => {
    const harness = await createHarness({ committedContentHash: "not-the-real-hash" });
    const control = await harness.resolver.resolveControl(harness.request, ACTOR);
    expect(control.receipt.status).toBe("invalid");
    const data = await harness.resolver.deliverData({
      request: harness.request,
      resolutionId: control.receipt.resolutionId,
      actor: ACTOR,
    });
    expect(data.type).toBe("resource-unavailable");
  });

  test("reauthorizes delivery and returns a sanitized unavailable envelope after revocation", async () => {
    const harness = await createHarness();
    const control = await harness.resolver.resolveControl(harness.request, ACTOR);
    harness.authorization.revoke("scope-1");
    const data = await harness.resolver.deliverData({
      request: harness.request,
      resolutionId: control.receipt.resolutionId,
      actor: ACTOR,
    });
    expect(data).toMatchObject({ type: "resource-unavailable", reason: "denied", retryable: false });
    expect(JSON.stringify(data)).not.toContain("tenant-1");
  });
});

async function createHarness(options: { committedContentHash?: string } = {}) {
  const schema: RegisteredResourceSchema["schema"] = {
    type: "object",
    properties: { result: { type: "string", maxLength: 100 } },
    required: ["result"],
    additionalProperties: false,
  };
  const value = { result: "ok" };
  const schemaHash = await canonicalHash(schema);
  const contentHash = options.committedContentHash ?? await canonicalHash(value);
  const reference: ResourceReference = {
    resourceId: "resource-1",
    schemaId: "resource-schema",
    schemaVersion: 1,
    schemaHash,
    codec: { id: "json", version: "1" },
    mediaType: "application/json",
    contentHash,
    scopeRef: "scope-1",
    sensitivity: "private",
  };
  const evidence: EvidenceReference = {
    evidenceId: "evidence-1",
    schemaId: reference.schemaId,
    schemaVersion: reference.schemaVersion,
    schemaHash: reference.schemaHash,
    sourceRefs: [{ kind: "resource", id: reference.resourceId, contentHash: reference.contentHash }],
    activityRefs: ["activity-1"],
    contentHash: reference.contentHash,
    scopeRef: reference.scopeRef,
    recordedAt: NOW,
    validationIds: ["source.valid"],
    sensitivity: reference.sensitivity,
  };
  const documents = new InMemoryCommittedResourceStore();
  documents.set({
    documentId: "document-1",
    branchId: "main",
    revisionId: "revision-1",
    context: {
      contractFingerprint: "contract-1",
      reference,
      evidence: { "evidence-1": evidence },
      claims: {},
      nodes: {},
    },
  });
  const schemas = new InMemoryResourceSchemaRegistry([{
    schemaId: reference.schemaId,
    schemaVersion: reference.schemaVersion,
    schemaHash,
    schemaProfile: PROFILE,
    schema,
  }]);
  let calls = 0;
  const source = new InMemoryResourceSource();
  source.set(reference.resourceId, () => {
    calls += 1;
    return {
      bytes: new TextEncoder().encode(JSON.stringify(value)),
      codec: reference.codec,
      mediaType: reference.mediaType,
      scopeRef: reference.scopeRef,
      sensitivity: reference.sensitivity,
      evidenceIds: [evidence.evidenceId],
    };
  });
  const authorization = new InMemoryResourceAuthorization([{
    scopeRef: "scope-1",
    tenantRef: "tenant-1",
    actorRefs: ["actor-1"],
  }]);
  const resolver = new ResourceResolver({
    schemaProfile: PROFILE,
    now: () => NOW,
    ports: {
      documents,
      authorization,
      schemas,
      source,
      codec: new JsonResourceCodec(),
      redaction: new DefaultResourceRedaction(),
      resolutions: new InMemoryResourceResolutionStore(),
      cache: new InMemoryScopedResourceBindingCache({ now: () => NOW }),
    },
  });
  const request: ResourceResolveRequest = {
    requestId: "resource-request-1",
    contractFingerprint: "contract-1",
    documentId: "document-1",
    branchId: "main",
    revisionId: "revision-1",
    resourceId: reference.resourceId,
    expectedSchemaHash: reference.schemaHash,
    expectedContentHash: reference.contentHash,
  };
  return { resolver, request, reference, authorization, sourceCalls: () => calls };
}
