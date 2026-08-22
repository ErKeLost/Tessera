import { describe, expect, test } from "bun:test";
import {
  resourceBindingIdSchema,
  stateIdSchema,
  type JsonValue,
} from "@open-generative/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { GenerativeSurface } from "./generative-surface";
import { RendererRegistry } from "./renderer-registry";
import type {
  ErrorSystemSurfaceInput,
  NodeRenderer,
  RendererInput,
  UnsupportedSystemSurfaceInput,
} from "./types";
import {
  DECLARED_PORT,
  FIRST_ID,
  OTHER_CONTRACT_REF,
  PANEL_PLACEMENT,
  ROOT_ID,
  SECOND_ID,
  TEST_CONTRACT,
  TEST_HASH,
  UNDECLARED_PORT,
  FakeSurfaceController,
  commandsWithEmit,
  controllerWith,
  createProjection,
  createRegistry,
  createSnapshot,
  localEventResult,
  panelPlacement,
} from "./test-fixtures";

describe("GenerativeSurface trusted render chain", () => {
  test("renders recursive slots in stable order with node-scoped inputs", () => {
    const stateId = stateIdSchema.parse("node-state");
    const resourceId = resourceBindingIdSchema.parse("node-resource");
    const inputs: RendererInput[] = [];
    const Renderer: NodeRenderer = (input) => {
      inputs.push(input);
      return (
        <section data-label={String(input.resolvedProps.label)}>
          {input.slots.body}
        </section>
      );
    };
    const root = createProjection({
      label: "root",
      slots: { body: [FIRST_ID, SECOND_ID] },
      stateBindings: {
        [stateId]: {
          stateId,
          value: "root-only",
          schemaHash: TEST_HASH,
          scope: "surface",
        },
      },
    });
    const first = createProjection({
      nodeId: FIRST_ID,
      label: "first",
      resourceBindings: { [resourceId]: { bindingId: resourceId } },
    });
    const second = createProjection({ nodeId: SECOND_ID, label: "second" });

    const html = renderToStaticMarkup(
      <GenerativeSurface
        controller={controllerWith([root, first, second])}
        placement={PANEL_PLACEMENT}
        registry={createRegistry(Renderer)}
      />,
    );

    expect(html.indexOf('data-label="first"')).toBeLessThan(html.indexOf('data-label="second"'));
    expect(inputs.map((input) => input.resolvedProps.label)).toEqual([
      "root",
      "first",
      "second",
    ]);
    expect(Object.keys(inputs[0]!.stateBindings)).toEqual([stateId]);
    expect(Object.keys(inputs[1]!.stateBindings)).toEqual([]);
    expect(Object.keys(inputs[0]!.resourceBindings)).toEqual([]);
    expect(Object.keys(inputs[1]!.resourceBindings)).toEqual([resourceId]);
    expect(Object.isFrozen(inputs[0]!.slots)).toBe(true);
    expect(Object.isFrozen(inputs[0]!.slots.body)).toBe(true);
    expect(inputs[0]!.slots.body!.map((element) => element.key)).toEqual([
      FIRST_ID,
      SECOND_ID,
    ]);
    expect(inputs.every((input) => input.placement === inputs[0]!.placement)).toBe(true);
    expect(Object.isFrozen(inputs[0]!.placement)).toBe(true);
    expect(Object.keys(inputs[0]!).sort()).toEqual([
      "contract",
      "node",
      "placement",
      "projectionMode",
      "resolvedProps",
      "resourceBindings",
      "slots",
      "stateBindings",
    ]);
  });

  test("allows only declared committed events and never exposes preview commands", async () => {
    let delegated: Readonly<{ port: string; payload: JsonValue }> | undefined;
    let committedInput: RendererInput | undefined;
    const commands = commandsWithEmit(async (port, payload) => {
      delegated = { port, payload };
      return localEventResult();
    });
    const CommittedRenderer: NodeRenderer = (input) => {
      committedInput = input;
      return <div>committed</div>;
    };
    renderToStaticMarkup(
      <GenerativeSurface
        controller={controllerWith([createProjection({ commands })])}
        placement={PANEL_PLACEMENT}
        registry={createRegistry(CommittedRenderer)}
      />,
    );

    expect(committedInput?.projectionMode).toBe("committed");
    expect(committedInput?.emit).toBeFunction();
    await committedInput!.emit!(DECLARED_PORT, { accepted: true });
    expect(delegated).toEqual({
      port: DECLARED_PORT,
      payload: { accepted: true },
    });
    await expect(
      committedInput!.emit!(UNDECLARED_PORT, { accepted: false }),
    ).rejects.toThrow("is not declared");
    expect(delegated?.port).toBe(DECLARED_PORT);

    let previewInput: RendererInput | undefined;
    const PreviewRenderer: NodeRenderer = (input) => {
      previewInput = input;
      return <div>preview</div>;
    };
    renderToStaticMarkup(
      <GenerativeSurface
        controller={controllerWith([createProjection({
          commands,
          projectionMode: "read-only-preview",
        })])}
        placement={PANEL_PLACEMENT}
        registry={createRegistry(PreviewRenderer)}
      />,
    );

    expect(previewInput?.projectionMode).toBe("read-only-preview");
    expect(previewInput?.emit).toBeUndefined();
    expect(Object.hasOwn(previewInput!, "emit")).toBe(false);
  });

  test("allows a legal DAG reuse while rejecting only path-local cycles", () => {
    const Renderer: NodeRenderer = (input) => (
      <div data-label={String(input.resolvedProps.label)}>{input.slots.body}</div>
    );
    const shared = createProjection({ nodeId: SECOND_ID, label: "shared" });
    const branch = createProjection({
      nodeId: FIRST_ID,
      label: "branch",
      slots: { body: [SECOND_ID] },
    });
    const root = createProjection({
      label: "root",
      slots: { body: [FIRST_ID, SECOND_ID] },
    });
    const dagHtml = renderToStaticMarkup(
      <GenerativeSurface
        controller={controllerWith([root, branch, shared])}
        placement={PANEL_PLACEMENT}
        registry={createRegistry(Renderer)}
      />,
    );
    expect(dagHtml.match(/data-label="shared"/g)).toHaveLength(2);

    const cycleHtml = renderToStaticMarkup(
      <GenerativeSurface
        controller={controllerWith([createProjection({
          label: "cycle",
          slots: { body: [ROOT_ID] },
        })])}
        placement={PANEL_PLACEMENT}
        registry={createRegistry(Renderer)}
      />,
    );
    expect(cycleHtml).toContain('data-open-generative-system="error"');
  });
});

describe("GenerativeSurface system surfaces", () => {
  const Renderer: NodeRenderer = () => <div>ready</div>;
  const registry = createRegistry(Renderer);

  test("maps surface lifecycle states to loading, empty, and error", () => {
    expect(renderSystem(new FakeSurfaceController(
      createSnapshot("awaiting-snapshot", null),
    ))).toContain('data-open-generative-system="loading"');
    expect(renderSystem(new FakeSurfaceController(
      createSnapshot("ready", null),
    ))).toContain('data-open-generative-system="empty"');
    expect(renderSystem(new FakeSurfaceController(
      createSnapshot("resync-required", null),
    ))).toContain('data-open-generative-system="error"');
  });

  test("maps node lifecycle and unsupported states deterministically", () => {
    expect(renderSystem(controllerWith([
      createProjection({ status: "unresolved" }),
    ]))).toContain('data-open-generative-system="loading"');
    expect(renderSystem(controllerWith([
      createProjection({ status: "invalid" }),
    ]))).toContain('data-open-generative-system="error"');
    expect(renderSystem(controllerWith([
      createProjection({ status: "unsupported-contract" }),
    ]))).toContain('data-open-generative-system="unsupported"');
    expect(renderSystem(controllerWith([]))).toContain(
      'data-open-generative-system="error"',
    );
    expect(renderSystem(controllerWith([
      createProjection(),
    ]), new RendererRegistry())).toContain(
      'data-open-generative-system="unsupported"',
    );
    expect(renderSystem(controllerWith([
      createProjection({ nodeContract: OTHER_CONTRACT_REF }),
    ]))).toContain('data-open-generative-system="error"');
  });

  test("reports exact unsupported and error reasons to host-owned surfaces", () => {
    const Unsupported = ({ reason }: UnsupportedSystemSurfaceInput) => (
      <div data-unsupported-reason={reason} />
    );
    const ErrorSurface = ({ reason }: ErrorSystemSurfaceInput) => (
      <div data-error-reason={reason} />
    );
    const placementHtml = renderToStaticMarkup(
      <GenerativeSurface
        controller={controllerWith([createProjection()])}
        placement={panelPlacement(299)}
        registry={registry}
        systemSurfaces={{ unsupported: Unsupported }}
      />,
    );
    expect(placementHtml).toContain('data-unsupported-reason="placement-unsupported"');

    const invalidPlacementHtml = renderToStaticMarkup(
      <GenerativeSurface
        controller={controllerWith([createProjection()])}
        placement={{ ...PANEL_PLACEMENT, width: -1 }}
        registry={registry}
        systemSurfaces={{ error: ErrorSurface }}
      />,
    );
    expect(invalidPlacementHtml).toContain('data-error-reason="placement-invalid"');
  });

  function renderSystem(
    controller: FakeSurfaceController,
    selectedRegistry = registry,
  ): string {
    return renderToStaticMarkup(
      <GenerativeSurface
        controller={controller}
        placement={PANEL_PLACEMENT}
        registry={selectedRegistry}
      />,
    );
  }
});
