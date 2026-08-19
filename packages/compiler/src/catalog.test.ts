import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  CompilerCatalog,
  createCompilerCatalog,
  defaultCompilerCatalog,
  defineNodeContract,
  sliceCatalog,
} from "./catalog";
import { CompilerDiagnosticError } from "./diagnostics";
import { normalizeSurface, safeNormalizeSurface } from "./normalize";
import { createProviderSchema } from "./prompt";
import { defineSurface, surface } from "./surface";

describe("compiler catalog", () => {
  test("contains the minimal surface language and all semantic artifacts", () => {
    expect(defaultCompilerCatalog.contracts()).toHaveLength(30);
    expect(defaultCompilerCatalog.has("layout.stack")).toBe(true);
    expect(defaultCompilerCatalog.has("content.text")).toBe(true);
    expect(defaultCompilerCatalog.has("form.root")).toBe(true);
    expect(defaultCompilerCatalog.has("form.input")).toBe(true);
    expect(defaultCompilerCatalog.has("form.select")).toBe(true);
    expect(defaultCompilerCatalog.has("form.toggle")).toBe(true);
    expect(defaultCompilerCatalog.has("form.button")).toBe(true);
    expect(defaultCompilerCatalog.has("artifact.driver")).toBe(true);
    expect(defaultCompilerCatalog.has("artifact.ranking")).toBe(true);
    expect(defaultCompilerCatalog.has("artifact.target")).toBe(true);
    expect(defaultCompilerCatalog.has("artifact.timeline")).toBe(true);
  });

  test("exposes strict semantic schemas and typed selection events for the new artifacts", () => {
    const ranking = defaultCompilerCatalog.get("artifact.ranking")!;
    const target = defaultCompilerCatalog.get("artifact.target")!;
    const timeline = defaultCompilerCatalog.get("artifact.timeline")!;

    expect(Object.keys(ranking.events ?? {})).toEqual(["ranking-item-select"]);
    expect(Object.keys(target.events ?? {})).toEqual([]);
    expect(Object.keys(timeline.events ?? {})).toEqual(["timeline-item-select"]);

    const rankingSlice = sliceCatalog({
      requestedNodeTypes: ["artifact.ranking", "artifact.target", "artifact.timeline"],
    });
    const providerSchema = JSON.stringify(createProviderSchema(rankingSlice));
    expect(providerSchema).toContain("ranking-item-select");
    expect(providerSchema).toContain("timeline-item-select");
    expect(providerSchema).toContain('"status"');
    expect(providerSchema).not.toContain('"protocolVersion"');
  });

  test("fingerprints and slices are independent of registration order", () => {
    const contracts = defaultCompilerCatalog.contracts();
    const reverse = new CompilerCatalog(
      defaultCompilerCatalog.identity,
      [...contracts].reverse(),
    );
    expect(reverse.contractFingerprint).toBe(defaultCompilerCatalog.contractFingerprint);

    const left = sliceCatalog({ catalog: defaultCompilerCatalog, requestedNodeTypes: ["artifact.trend"] });
    const right = sliceCatalog({ catalog: reverse, requestedNodeTypes: ["artifact.trend"] });
    expect(left.contracts.map(({ type }) => type)).toEqual(right.contracts.map(({ type }) => type));
    expect(left.sliceHash).toBe(right.sliceHash);
    expect(left.contracts.map(({ type }) => type)).toEqual([
      "artifact.trend",
      "content.callout",
      "content.empty",
      "content.text",
      "layout.stack",
    ]);
  });

  test("supports a namespaced extension contract without changing the DSL", () => {
    const badge = defineNodeContract({
      type: "acme.status-badge",
      version: 1,
      category: "extension:acme",
      propsSchema: z.object({ label: z.string(), status: z.enum(["ok", "blocked"]) }).strict(),
      slots: {},
      trust: "safe",
      commitPolicy: "progressive",
      prompt: {
        summary: "Show an Acme workflow status.",
        useWhen: ["The host supplied an Acme workflow status."],
        avoidWhen: ["The status was inferred by the model."],
      },
      profiles: ["operations"],
    });
    const catalog = defaultCompilerCatalog.extend(
      [badge],
      { id: "acme.artifacts", version: "1.0.0" },
    );
    const slice = sliceCatalog({ catalog, requestedNodeTypes: [badge.type] });
    const normalized = normalizeSurface({
      root: {
        id: "root",
        type: "layout.stack",
        slots: {
          children: [{ id: "status", type: badge.type, props: { label: "Deploy", status: "ok" } }],
        },
      },
    }, { catalog: slice });
    expect(normalized.nodes.status?.type).toBe("acme.status-badge");
  });

  test("extends nested bindings and typed events from one custom contract", () => {
    const scoreList = defineNodeContract({
      type: "acme.score-list",
      version: 1,
      category: "extension:acme",
      propsSchema: z.object({
        items: z.array(z.object({
          label: z.string().min(1),
          value: z.number(),
        }).strict()).min(1),
      }).strict(),
      slots: {},
      trust: "safe",
      commitPolicy: "atomic",
      prompt: {
        summary: "Show Acme scores with a selectable row.",
        useWhen: ["The host supplies typed Acme scores."],
        avoidWhen: ["Scores are inferred or untrusted."],
      },
      profiles: ["operations"],
      bindings: { referencePaths: ["/items/*/value"] },
      events: {
        select: {
          payloadSchema: z.object({ item: z.object({ id: z.string() }).strict() }).strict(),
          actionContracts: { "acme.select": "^2" },
        },
      },
    });
    const catalog = defaultCompilerCatalog.extend([scoreList]);
    const slice = sliceCatalog({ catalog, requestedNodeTypes: [scoreList.type] });
    const normalized = normalizeSurface({
      root: {
        id: "scores",
        type: scoreList.type,
        props: { items: [{ label: "Quality", value: { $ref: "state", id: "score" } }] },
        events: { select: "select-score" },
      },
      state: { score: { schema: { type: "string" }, initial: "row-1" } },
      actions: {
        "select-score": {
          contractId: "acme.select",
          contractVersion: 2,
          steps: [{
            stepId: "remember",
            type: "state.set",
            stateId: "score",
            value: { $ref: "event", port: "select", path: ["item", "id"] },
          }],
        },
      },
    }, { catalog: slice });

    expect(normalized.nodes.scores?.props.items).toMatchObject({
      kind: "array",
      items: [{ kind: "object", entries: { value: { kind: "state-ref", stateId: "score" } } }],
    });
    const provider = JSON.stringify(createProviderSchema(slice));
    expect(provider).toContain("acme.select");
    expect(provider).toContain('"enum":[2]');
  });

  test("rejects duplicate contracts and missing requested node types", () => {
    const text = defaultCompilerCatalog.get("content.text")!;
    expect(() => createCompilerCatalog([text, text])).toThrow("already registered");
    expect(() => sliceCatalog({ requestedNodeTypes: ["missing.widget"] })).toThrow(CompilerDiagnosticError);
    expect(() => defineNodeContract({
      ...text,
      type: "acme.invalid-event",
      events: {
        press: { payloadSchema: z.object({}).strict(), actionContracts: { "acme.press": ">=1" } },
      },
    })).toThrow("unsupported action contract range");
  });

  test("generates a closed provider schema from only the active slice", () => {
    const slice = sliceCatalog({ requestedNodeTypes: ["artifact.trend"] });
    const schema = createProviderSchema(slice);
    const serialized = JSON.stringify(schema);
    expect(serialized).toContain("artifact.trend");
    expect(serialized).not.toContain("artifact.query");
    expect(schema.additionalProperties).toBe(false);
  });
});

describe("surface authoring and normalization", () => {
  test("flattens nested nodes and lowers ordinary values into tagged IR", () => {
    const proposal = defineSurface(surface.stack({
      id: "root",
      gap: "lg",
      children: [
        surface.text({ id: "heading", text: "Revenue", role: "heading" }),
        surface.callout({ id: "note", body: "Validated data", tone: "success" }),
      ],
    }));
    const slice = sliceCatalog({ requestedNodeTypes: ["layout.stack", "content.text", "content.callout"] });
    const normalized = normalizeSurface(proposal, { catalog: slice });

    expect(normalized.root).toBe("root");
    expect(Object.keys(normalized.nodes).sort()).toEqual(["heading", "note", "root"]);
    expect(normalized.nodes.root?.slots?.children).toEqual(["heading", "note"]);
    expect(normalized.nodes.heading?.props.text).toEqual({ kind: "literal", value: "Revenue" });
    expect(normalized.nodes.root?.props.align).toEqual({ kind: "literal", value: "stretch" });
  });

  test("normalizes a v1 semantic artifact as an atomic v2 node", () => {
    const proposal = defineSurface(surface.artifact({
      protocolVersion: "1.0",
      kind: "metric",
      id: "revenue",
      title: "Revenue",
      description: "Validated revenue",
      metrics: [{ id: "mrr", label: "MRR", value: 461_400, format: "number" }],
    }));
    const slice = sliceCatalog({ requestedNodeTypes: ["artifact.metric"] });
    expect(proposal.root.props).not.toHaveProperty("protocolVersion");
    expect(proposal.root.props).not.toHaveProperty("kind");
    expect(proposal.root.props).not.toHaveProperty("id");
    const normalized = normalizeSurface(proposal, { catalog: slice });
    expect(normalized.nodes.revenue?.type).toBe("artifact.metric");
    expect(normalized.nodes.revenue?.props.title).toEqual({ kind: "literal", value: "Revenue" });
    expect(normalized.nodes.revenue?.props.kind).toBeUndefined();
    expect(normalized.nodes.revenue?.props.protocolVersion).toBeUndefined();
    expect(normalized.nodes.revenue?.props.id).toBeUndefined();

    const providerSchema = JSON.stringify(createProviderSchema(slice));
    expect(providerSchema).not.toContain("protocolVersion");
    expect(providerSchema).not.toContain('"kind":{"const":"metric"}');

    const envelopeInProps = safeNormalizeSurface({
      root: {
        ...proposal.root,
        props: {
          ...proposal.root.props,
          protocolVersion: "1.0",
          kind: "metric",
          id: "revenue",
        },
      },
    }, { catalog: slice });
    expect(envelopeInProps.success).toBe(false);
  });

  test("rejects duplicate ids, illegal slot children, and reserved keys", () => {
    const slice = sliceCatalog({ requestedNodeTypes: ["layout.stack", "content.text", "artifact.metric"] });
    const duplicate = safeNormalizeSurface({
      root: {
        id: "root", type: "layout.stack", slots: { children: [
          { id: "same", type: "content.text", props: { text: "A" } },
          { id: "same", type: "content.text", props: { text: "B" } },
        ] },
      },
    }, { catalog: slice });
    expect(duplicate.success).toBe(false);
    if (!duplicate.success) expect(duplicate.diagnostics[0]?.code).toBe("node.duplicate_id");

    const illegalSlot = safeNormalizeSurface({
      root: { id: "text", type: "content.text", props: { text: "A" }, slots: { children: [] } },
    }, { catalog: slice });
    expect(illegalSlot.success).toBe(false);
    if (!illegalSlot.success) expect(illegalSlot.diagnostics[0]?.code).toBe("slot.unknown");

    const reserved = safeNormalizeSurface({
      root: { id: "text", type: "content.text", props: { text: "A", $script: "run" } },
    }, { catalog: slice });
    expect(reserved.success).toBe(false);
  });

  test("enforces document, node, and depth budgets", () => {
    const slice = sliceCatalog({ requestedNodeTypes: ["layout.stack", "content.text"] });
    const proposal = defineSurface(surface.stack({
      id: "root",
      children: [surface.text({ id: "one", text: "one" }), surface.text({ id: "two", text: "two" })],
    }));
    expect(() => normalizeSurface(proposal, { catalog: slice, limits: { maxNodes: 2 } })).toThrow();
    expect(() => normalizeSurface(proposal, { catalog: slice, limits: { maxDepth: 1 } })).toThrow();
    expect(() => normalizeSurface(proposal, { catalog: slice, limits: { maxDocumentBytes: 20 } })).toThrow();
  });

  test("normalizes typed form bindings and validates the event payload contract", () => {
    const slice = sliceCatalog({ profile: "form", requestedNodeTypes: ["form.root"] });
    const normalized = normalizeSurface(contactFormProposal(), {
      catalog: slice,
      allowedResourceIds: ["country-options"],
    });

    expect(normalized.nodes.name?.props.value).toEqual({ kind: "state-ref", stateId: "name" });
    expect(normalized.nodes.name?.props.inputType).toEqual({ kind: "literal", value: "text" });
    expect(normalized.nodes.name?.props.required).toEqual({ kind: "literal", value: false });
    expect(normalized.nodes.country?.props.options).toEqual({
      kind: "resource-ref",
      resourceId: "country-options",
      path: ["items"],
    });
    expect(normalized.nodes.timezone?.props.value).toEqual({ kind: "context-ref", key: "timezone" });
    expect(normalized.nodes.name?.props.disabled).toEqual({
      kind: "condition",
      op: "eq",
      args: [
        { kind: "state-ref", stateId: "name" },
        { kind: "literal", value: "locked" },
      ],
    });
    expect(normalized.actions["set-name"]?.steps[0]).toMatchObject({
      type: "state.set",
      stateId: "name",
      value: { kind: "event-ref", port: "change", path: ["value"] },
    });
  });

  test("exposes refs and conditions only on contract-declared provider paths", () => {
    const slice = sliceCatalog({ profile: "form", requestedNodeTypes: ["form.root"] });
    const schema = createProviderSchema(slice) as Record<string, any>;
    const definitions = Object.values(schema.$defs as Record<string, any>);
    const node = (type: string) => definitions.find((definition: any) => (
      definition?.properties?.type?.const === type
    ));
    const inputProps = node("form.input").properties.props.properties;
    const textProps = node("content.text").properties.props.properties;

    expect(JSON.stringify(inputProps.value)).toContain("#/$defs/propsReference");
    expect(JSON.stringify(inputProps.disabled)).toContain("#/$defs/presentationCondition");
    expect(JSON.stringify(inputProps.label)).not.toContain("propsReference");
    expect(JSON.stringify(textProps.text)).not.toContain("propsReference");
    expect(JSON.stringify(schema.$defs.actionPlan)).toContain('"const":"form.change"');
    expect(JSON.stringify(schema.$defs.actionPlan)).not.toContain('"contractId":{"type":"string"');
  });

  test("fails closed for undeclared bindings and incompatible event actions", () => {
    const slice = sliceCatalog({ profile: "form", requestedNodeTypes: ["form.root"] });
    const invalidCases: Array<[string, unknown, string, { allowedResourceIds?: string[] }?]> = [
      ["unknown state", mutateContactForm((form) => {
        form.root.slots.fields[0].props.value = { $ref: "state", id: "missing" };
      }), "reference.unknown_state"],
      ["ungranted resource", contactFormProposal(), "reference.resource_not_granted", { allowedResourceIds: [] }],
      ["wrong action contract", mutateContactForm((form) => {
        form.actions["set-name"].contractId = "form.submit";
      }), "event.action_contract_not_allowed", { allowedResourceIds: ["country-options"] }],
      ["wrong action version", mutateContactForm((form) => {
        form.actions["set-name"].contractVersion = 2;
      }), "event.action_contract_version_mismatch", { allowedResourceIds: ["country-options"] }],
      ["wrong event port", mutateContactForm((form) => {
        form.actions["set-name"].steps[0].value.port = "submit";
      }), "event.reference_port_mismatch", { allowedResourceIds: ["country-options"] }],
      ["wrong event path", mutateContactForm((form) => {
        form.actions["set-name"].steps[0].value.path = ["missing"];
      }), "event.reference_path_not_found", { allowedResourceIds: ["country-options"] }],
      ["invalid literal beside binding", mutateContactForm((form) => {
        form.root.slots.fields[0].props.required = "yes";
      }), "node.invalid_props", { allowedResourceIds: ["country-options"] }],
      ["unknown prop beside binding", mutateContactForm((form) => {
        form.root.slots.fields[0].props.script = "run";
      }), "node.invalid_props", { allowedResourceIds: ["country-options"] }],
    ];

    for (const [label, proposal, code, options] of invalidCases) {
      const result = safeNormalizeSurface(proposal, { catalog: slice, ...options });
      expect(result.success, label).toBe(false);
      if (!result.success) expect(result.diagnostics[0]?.code, label).toBe(code);
    }

    const ordinaryRef = safeNormalizeSurface({
      root: { id: "text", type: "content.text", props: { text: { $ref: "context", key: "locale" } } },
    }, { catalog: sliceCatalog({ requestedNodeTypes: ["content.text"] }) });
    expect(ordinaryRef.success).toBe(false);
    if (!ordinaryRef.success) expect(ordinaryRef.diagnostics[0]?.code).toBe("binding.reference_not_allowed");

    const ordinaryCondition = safeNormalizeSurface({
      root: {
        id: "name",
        type: "form.input",
        props: { label: { $condition: { op: "eq", args: [1, 1] } } },
      },
    }, { catalog: slice });
    expect(ordinaryCondition.success).toBe(false);
    if (!ordinaryCondition.success) expect(ordinaryCondition.diagnostics[0]?.code).toBe("binding.condition_not_allowed");
  });
});

type ContactFormProposal = ReturnType<typeof contactFormProposal>;

function contactFormProposal() {
  return {
    root: {
      id: "contact-form",
      type: "form.root",
      props: { title: "Contact" },
      slots: {
        fields: [
          {
            id: "name",
            type: "form.input",
            props: {
              label: "Name",
              value: { $ref: "state", id: "name" },
              disabled: {
                $condition: {
                  op: "eq",
                  args: [{ $ref: "state", id: "name" }, "locked"],
                },
              },
            },
            events: { change: "set-name" },
          },
          {
            id: "country",
            type: "form.select",
            props: {
              label: "Country",
              options: { $ref: "resource", id: "country-options", path: ["items"] },
            },
          },
          {
            id: "timezone",
            type: "form.input",
            props: {
              label: "Timezone",
              value: { $ref: "context", key: "timezone" },
            },
          },
          { id: "submit", type: "form.button", props: { label: "Save", type: "submit" } },
        ],
      },
    },
    state: {
      name: { schema: { type: "string", maxLength: 160 }, initial: "" },
    },
    resourceIds: ["country-options"],
    actions: {
      "set-name": {
        contractId: "form.change",
        contractVersion: 1,
        steps: [{
          stepId: "apply-name",
          type: "state.set",
          stateId: "name",
          value: { $ref: "event", port: "change", path: ["value"] },
        }],
      },
    },
  };
}

function mutateContactForm(mutate: (proposal: any) => void): ContactFormProposal {
  const proposal = structuredClone(contactFormProposal());
  mutate(proposal);
  return proposal;
}
