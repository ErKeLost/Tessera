import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_PROTOCOL,
  ARTIFACT_PROTOCOL_VERSION,
  RESOURCE_PROTOCOL,
  STREAM_PROTOCOL,
  decodeArtifactPart,
  lowerJsonValue,
  projectArtifactSemanticContent,
  canonicalHash,
  type ArtifactDocument,
  type ClientArtifactCommand,
  type JsonValue,
  type RuntimeSnapshot,
} from "@data-elements/runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactUIProvider, useArtifactUI, type ArtifactRuntimeCommandTransport } from "./bridge";
import { defineArtifactNodeRenderer, type ArtifactNodeTrigger } from "./node-types";
import { ArtifactRenderer } from "./renderer";

const NOW = "2026-08-15T00:00:00.000Z";
const FINGERPRINT = "contract-fingerprint-v2";

async function createDocument(
  nodes: ArtifactDocument["nodes"],
  root: string,
  overrides: Partial<ArtifactDocument> = {},
): Promise<ArtifactDocument> {
  const document: ArtifactDocument = {
    protocol: ARTIFACT_PROTOCOL,
    protocolVersion: ARTIFACT_PROTOCOL_VERSION,
    documentId: "document-v2",
    revision: {
      revisionId: "revision-v2",
      parentRevisionIds: [],
      branchId: "main",
      sequence: 1,
      contentHash: "pending",
      contractFingerprint: FINGERPRINT,
      migrationReceiptIds: [],
      stateTransitionReceiptIds: [],
    },
    policy: {
      policyId: "policy-v2",
      policyVersion: 1,
      policyHash: "policy-hash-v2",
      scopeRef: "scope:test",
      sensitivity: "private",
      persistence: "session",
      allowedSinks: ["renderer"],
    },
    catalog: { id: "catalog-v2", version: "1", contractFingerprint: FINGERPRINT },
    renderMode: "progressive",
    root,
    nodes,
    state: {},
    actions: {},
    resources: {},
    evidence: {},
    claims: {},
    meta: { title: "Workspace", createdAt: NOW, updatedAt: NOW },
    ...overrides,
  };
  document.revision.contentHash = await canonicalHash(projectArtifactSemanticContent(document));
  return document;
}

function snapshot(document: ArtifactDocument): RuntimeSnapshot {
  return {
    document,
    branchHead: {
      branchId: document.revision.branchId,
      revisionId: document.revision.revisionId,
      headToken: `head:${document.revision.revisionId}`,
    },
    state: [],
    pendingActions: [],
    pendingEffects: [],
    activeApprovals: [],
    stateMigrationReceipts: [],
    stateTransitionReceipts: [],
  };
}

describe("ArtifactRenderer v2 dual read", () => {
  test("keeps v1 rendering and renders a v2 surface tree", async () => {
    const v1 = renderToStaticMarkup(<ArtifactRenderer artifact={{
      protocolVersion: "1.0",
      id: "metric-v1",
      kind: "metric",
      title: "Legacy revenue",
      description: "v1",
      metrics: [{ id: "mrr", label: "MRR", value: 12_500, format: "number" }],
    }} />);
    expect(v1).toContain("Legacy revenue");

    const document = await createDocument({
      root: {
        type: "layout.stack",
        typeVersion: 1,
        props: { gap: { kind: "literal", value: "sm" } },
        slots: { children: ["heading", "progress"] },
      },
      heading: {
        type: "content.text",
        typeVersion: 1,
        props: {
          text: { kind: "literal", value: "Pipeline health" },
          role: { kind: "literal", value: "heading" },
        },
      },
      progress: {
        type: "content.progress",
        typeVersion: 1,
        props: {
          label: { kind: "literal", value: "Indexed" },
          value: { kind: "literal", value: 72 },
        },
      },
    }, "root");
    const markup = renderToStaticMarkup(<ArtifactRenderer value={document} />);
    expect(markup).toContain('data-node-type="layout.stack"');
    expect(markup).toContain("Pipeline health");
    expect(markup).toContain('aria-valuenow="72"');
  });

  test("renders the compiler surface contract fields without drift", async () => {
    const document = await createDocument({
      root: {
        type: "layout.stack",
        typeVersion: 1,
        props: { gap: { kind: "literal", value: "xl" } },
        slots: { children: ["callout", "progress"] },
      },
      callout: {
        type: "content.callout",
        typeVersion: 1,
        props: {
          title: { kind: "literal", value: "Threshold exceeded" },
          body: { kind: "literal", value: "Investigate the failed quality checks." },
          tone: { kind: "literal", value: "critical" },
        },
      },
      progress: {
        type: "content.progress",
        typeVersion: 1,
        props: {
          label: { kind: "literal", value: "Indexed" },
          value: { kind: "literal", value: 72 },
          detail: { kind: "literal", value: "18 of 25 sources" },
        },
      },
    }, "root");
    const markup = renderToStaticMarkup(<ArtifactRenderer value={document} />);
    expect(markup).toContain("gap-12");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Investigate the failed quality checks.");
    expect(markup).toContain("18 of 25 sources");
  });

  test("bridges evaluated artifact.* props into the official v1 semantic renderer", async () => {
    const document = await createDocument({
      metric: {
        type: "artifact.metric",
        typeVersion: 1,
        props: {
          title: { kind: "literal", value: "Trusted MRR" },
          description: { kind: "literal", value: "Evaluated tagged props" },
          metrics: lowerJsonValue([{ id: "mrr", label: "MRR", value: 46_140 }]),
        },
      },
    }, "metric");
    const markup = renderToStaticMarkup(<ArtifactRenderer value={document} />);
    expect(markup).toContain("Trusted MRR");
    expect(markup).toContain("46,140");
  });

  test("uses a custom node renderer and falls back for unknown node types", async () => {
    const Badge = defineArtifactNodeRenderer<{ label: string }>(({ value }) => (
      <mark data-custom-node="badge">{value.label}</mark>
    ));
    const custom = await createDocument({
      badge: { type: "acme.badge", typeVersion: 1, props: { label: { kind: "literal", value: "Verified" } } },
    }, "badge");
    const markup = renderToStaticMarkup(<ArtifactRenderer nodeRegistry={{ "acme.badge": Badge }} value={custom} />);
    expect(markup).toContain('data-custom-node="badge"');
    expect(markup).toContain("Verified");

    const unsupported = await createDocument({
      unknown: { type: "acme.unknown", typeVersion: 1, props: {} },
    }, "unknown");
    const fallback = renderToStaticMarkup(
      <ArtifactRenderer fallback={({ kind }) => <p>Missing renderer: {kind}</p>} value={unsupported} />,
    );
    expect(fallback).toContain("Missing renderer: acme.unknown");
  });

  test("keeps the base last-good snapshot after a streamed abort", async () => {
    const document = await createDocument({
      text: { type: "content.text", typeVersion: 1, props: { text: { kind: "literal", value: "Last good" } } },
    }, "text");
    const base = snapshot(document);
    const decoded = await decodeArtifactPart({
      kind: "artifact-stream",
      base,
      events: [{
        streamProtocol: STREAM_PROTOCOL,
        streamId: "stream-v2",
        seq: 8,
        eventId: "event-abort",
        cursor: "cursor-abort",
        contractFingerprint: FINGERPRINT,
        payload: {
          type: "transaction-aborted",
          transactionId: "tx-bad",
          lastGoodRevisionId: document.revision.revisionId,
          diagnostics: [{
            phase: "commit",
            code: "commit.invalid",
            severity: "error",
            recoverable: true,
            modelCorrectable: true,
            message: "Invalid draft",
          }],
        },
      }],
    }, { contractFingerprint: FINGERPRINT });
    expect(decoded.success).toBe(true);
    if (!decoded.success) return;
    const markup = renderToStaticMarkup(<ArtifactRenderer value={decoded.part} />);
    expect(markup).toContain("Last good");
    expect(markup).not.toContain("Invalid draft");
  });

  test("refuses unbranded wire envelopes until runtime decoding succeeds", async () => {
    const document = await createDocument({
      text: { type: "content.text", typeVersion: 1, props: { text: { kind: "literal", value: "Trusted wire" } } },
    }, "text");
    const wire = { kind: "artifact-snapshot" as const, snapshot: snapshot(document) };
    const rejected = renderToStaticMarkup(<ArtifactRenderer value={wire} />);
    expect(rejected).toContain("Unsupported artifact");
    expect(rejected).not.toContain("Trusted wire");

    const decoded = await decodeArtifactPart(wire, { contractFingerprint: FINGERPRINT });
    expect(decoded.success).toBe(true);
    if (!decoded.success) return;
    const accepted = renderToStaticMarkup(<ArtifactRenderer value={decoded.part} />);
    expect(accepted).toContain("Trusted wire");
  });
});

describe("ArtifactUIProvider v2 runtime state", () => {
  test("renders state values and validated resource bindings, with unavailable fallback when absent", async () => {
    const document = await createDocument({
      root: {
        type: "layout.stack",
        typeVersion: 1,
        props: {},
        slots: { children: ["state", "resource"] },
      },
      state: {
        type: "content.text",
        typeVersion: 1,
        props: { text: { kind: "state-ref", stateId: "filter" } },
      },
      resource: {
        type: "content.text",
        typeVersion: 1,
        props: { text: { kind: "resource-ref", resourceId: "report" } },
      },
    }, "root", {
      state: {
        filter: {
          schemaId: "schema:filter",
          schema: { type: "string" },
          schemaVersion: 1,
          schemaHash: "schema-filter-hash",
          initial: "Initial filter",
          policy: {
            policyId: "state-policy",
            policyVersion: 1,
            policyHash: "state-policy-hash",
            scope: "document",
            persistence: "session",
            sensitivity: "private",
            modelAccess: "none",
            lifecycle: "retain",
          },
        },
      },
      resources: {
        report: {
          resourceId: "report",
          schemaId: "schema:report",
          schemaVersion: 1,
          schemaHash: "schema-report-hash",
          codec: { id: "json", version: "1" },
          mediaType: "application/json",
          contentHash: "content-report-hash",
          scopeRef: "scope:test",
          sensitivity: "private",
        },
      },
    });
    const current = snapshot(document);
    current.state = [{
      documentId: document.documentId,
      branchId: document.revision.branchId,
      stateId: "filter",
      stateRevision: "state-2",
      schemaId: "schema:filter",
      schemaVersion: 1,
      schemaHash: "schema-filter-hash",
      policyHash: "state-policy-hash",
      value: "Enterprise",
    }];
    const withoutResource = renderToStaticMarkup(
      <ArtifactUIProvider runtimeSessions={[{ streamId: "stream-v2", snapshot: current }]}>
        <ArtifactRenderer value={document} />
      </ArtifactUIProvider>,
    );
    expect(withoutResource).toContain("Enterprise");
    expect(withoutResource).toContain("Resource unavailable");

    const envelope = {
      resourceProtocol: RESOURCE_PROTOCOL,
      type: "resource-data" as const,
      requestId: "request-resource",
      contractFingerprint: FINGERPRINT,
      documentId: document.documentId,
      branchId: document.revision.branchId,
      revisionId: document.revision.revisionId,
      resourceId: "report",
      binding: {
        resolutionId: "resolution-resource",
        requestId: "request-resource",
        resourceId: "report",
        schemaVersion: 1,
        schemaHash: "schema-report-hash",
        codec: { id: "json", version: "1" },
        mediaType: "application/json",
        contentHash: "content-report-hash",
        value: "Resolved report",
        byteLength: 15,
        sensitivity: "private" as const,
      },
    };
    const withResource = renderToStaticMarkup(
      <ArtifactUIProvider resourceEnvelopes={[envelope]} runtimeSessions={[{ streamId: "stream-v2", snapshot: current }]}>
        <ArtifactRenderer value={document} />
      </ArtifactUIProvider>,
    );
    expect(withResource).toContain("Enterprise");
    expect(withResource).toContain("Resolved report");
  });

  test("fails external node actions closed without transport and dispatches typed commands with transport", async () => {
    const document = await createDocument({
      action: {
        type: "acme.action",
        typeVersion: 1,
        props: {},
        events: { activate: "activate-plan" },
      },
    }, "action", {
      actions: {
        "activate-plan": {
          contractId: "acme.activation",
          contractVersion: 1,
          steps: [{ stepId: "request", type: "capability.request", capabilityId: "acme.activation", input: {} }],
          onError: "halt",
        },
      },
    });
    const current = snapshot(document);
    let trigger: ArtifactNodeTrigger | undefined;
    const ActionNode = defineArtifactNodeRenderer(({ trigger: nodeTrigger, canTrigger }) => {
      trigger = nodeTrigger;
      return <span>{canTrigger("activate") ? "enabled" : "disabled"}</span>;
    });
    const disconnected = renderToStaticMarkup(
      <ArtifactUIProvider runtimeSessions={[{ streamId: "stream-action", snapshot: current }]}>
        <ArtifactRenderer nodeRegistry={{ "acme.action": ActionNode }} value={document} />
      </ArtifactUIProvider>,
    );
    expect(disconnected).toContain("disabled");
    expect((await trigger?.("activate", { source: "test" }))?.ok).toBe(false);

    const commands: ClientArtifactCommand[] = [];
    const transport: ArtifactRuntimeCommandTransport = {
      dispatch(command) {
        commands.push(command);
      },
    };
    const connected = renderToStaticMarkup(
      <ArtifactUIProvider runtimeSessions={[{ streamId: "stream-action", snapshot: current }]} runtimeTransport={transport}>
        <ArtifactRenderer nodeRegistry={{ "acme.action": ActionNode }} value={document} />
      </ArtifactUIProvider>,
    );
    expect(connected).toContain("enabled");
    expect((await trigger?.("activate", { source: "test" }))?.ok).toBe(true);
    expect(commands[0]).toMatchObject({
      streamProtocol: STREAM_PROTOCOL,
      streamId: "stream-action",
      payload: { type: "action-trigger", nodeId: "action", port: "activate", payload: { source: "test" } },
    });
  });

  test("runs validated form state actions in an implicit local session", async () => {
    const stateSchema = { type: "string", maxLength: 12 };
    const document = await createDocument({
      input: {
        type: "form.input",
        typeVersion: 1,
        props: {
          label: { kind: "literal", value: "Name" },
          inputType: { kind: "literal", value: "text" },
          value: { kind: "state-ref", stateId: "name" },
          required: { kind: "literal", value: false },
          disabled: { kind: "literal", value: false },
        },
        events: { change: "set-name" },
      },
    }, "input", {
      state: {
        name: {
          schemaId: "schema:name",
          schema: stateSchema,
          schemaVersion: 1,
          schemaHash: await canonicalHash(stateSchema),
          initial: "Initial",
          policy: {
            policyId: "state-policy",
            policyVersion: 1,
            policyHash: "state-policy-hash",
            scope: "document",
            persistence: "session",
            sensitivity: "private",
            modelAccess: "none",
            lifecycle: "retain",
          },
        },
      },
      actions: {
        "set-name": {
          contractId: "form.change",
          contractVersion: 1,
          steps: [{
            stepId: "write-name",
            type: "state.set",
            stateId: "name",
            value: { kind: "event-ref", port: "change", path: ["value"] },
          }],
          onError: "halt",
        },
      },
    });

    const formMarkup = renderToStaticMarkup(<ArtifactRenderer value={document} />);
    expect(formMarkup).toContain('data-node-type="form.input"');
    expect(formMarkup).toContain('data-artifact-node-id="input"');
    expect(formMarkup).toContain('value="Initial"');
    expect(formMarkup).not.toContain(' disabled=""');

    let trigger: ArtifactNodeTrigger | undefined;
    let context: ReturnType<typeof useArtifactUI> | undefined;
    const InputProbe = defineArtifactNodeRenderer<{ value: JsonValue }>(({ value, trigger: nodeTrigger, canTrigger }) => {
      trigger = nodeTrigger;
      context = useArtifactUI();
      return <span>{canTrigger("change") ? `enabled:${String(value.value)}` : "disabled"}</span>;
    });
    const markup = renderToStaticMarkup(
      <ArtifactRenderer nodeRegistry={{ "form.input": InputProbe }} value={document} />,
    );
    expect(markup).toContain("enabled:Initial");

    const invalidPayload = await trigger?.("change", { unexpected: "Ada" });
    expect(invalidPayload).toMatchObject({ ok: false, diagnostic: { code: "runtime.event-payload-invalid" } });
    const invalidState = await trigger?.("change", { value: "This name is too long" });
    expect(invalidState).toMatchObject({ ok: false, diagnostic: { code: "runtime.state-write-invalid" } });
    const firstWrite = trigger?.("change", { value: "Ada" });
    const secondWrite = trigger?.("change", { value: "Grace" });
    expect(await firstWrite).toEqual({ ok: true });
    expect(await secondWrite).toEqual({ ok: true });

    const stored = context?.getRuntimeSession(document.documentId, document.revision.branchId);
    expect(stored?.snapshot.state).toHaveLength(1);
    expect(stored?.snapshot.state[0]?.value).toBe("Grace");

    const commands: ClientArtifactCommand[] = [];
    let remoteTrigger: ArtifactNodeTrigger | undefined;
    let remoteContext: ReturnType<typeof useArtifactUI> | undefined;
    const RemoteInputProbe = defineArtifactNodeRenderer<{ value: JsonValue }>(({ trigger: nodeTrigger }) => {
      remoteTrigger = nodeTrigger;
      remoteContext = useArtifactUI();
      return <span>remote</span>;
    });
    renderToStaticMarkup(
      <ArtifactUIProvider
        runtimeSessions={[{ streamId: "stream-form", snapshot: snapshot(document) }]}
        runtimeTransport={{ dispatch: (command) => { commands.push(command); } }}
      >
        <ArtifactRenderer nodeRegistry={{ "form.input": RemoteInputProbe }} value={document} />
      </ArtifactUIProvider>,
    );
    expect(await remoteTrigger?.("change", { value: "Remote" })).toEqual({ ok: true });
    expect(commands[0]).toMatchObject({
      payload: { type: "action-trigger", nodeId: "input", port: "change", payload: { value: "Remote" } },
    });
    expect(remoteContext?.getRuntimeSession(document.documentId, document.revision.branchId)?.snapshot.state).toHaveLength(0);
  });
});
