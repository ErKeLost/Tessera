import type {
  NodeCommandBridge,
  NodeProjection,
  SurfaceControllerSnapshot,
} from "@open-generative/client";
import {
  componentContractSchema,
  placementContextSchema,
  type PlacementConstraint,
  type PlacementContext,
} from "@open-generative/catalog";
import {
  canonicalNodeSchema,
  contractRefSchema,
  eventPortSchema,
  nodeIdSchema,
  requestIdSchema,
  revisionIdSchema,
  sha256HashSchema,
  surfaceSessionIdSchema,
  type ContractRef,
  type NodeId,
} from "@open-generative/protocol";
import type { NodeRenderer, SurfaceControllerPort } from "./types";
import { RendererRegistry } from "./renderer-registry";

export const TEST_HASH = sha256HashSchema.parse(`sha256:${"a".repeat(64)}`);
export const OTHER_HASH = sha256HashSchema.parse(`sha256:${"b".repeat(64)}`);
export const ROOT_ID = nodeIdSchema.parse("root");
export const FIRST_ID = nodeIdSchema.parse("first");
export const SECOND_ID = nodeIdSchema.parse("second");
export const REVISION_ID = revisionIdSchema.parse("revision-1");
export const DECLARED_PORT = eventPortSchema.parse("activate");
export const UNDECLARED_PORT = eventPortSchema.parse("undeclared");
export const REQUEST_ID = requestIdSchema.parse("request-1");

export const TEST_CONTRACT = componentContractSchema.parse({
  ref: {
    publisher: "open-generative",
    catalogId: "react-test",
    componentType: "test.surface",
    revision: 1,
    contractHash: TEST_HASH,
  },
  category: "layout",
  resolvedPropsSchema: { type: "object" },
  authoringBindings: {},
  slots: {},
  events: {
    activate: {
      payloadSchema: { type: "object" },
      actionContracts: [],
    },
  },
  trust: "safe",
  commitPolicy: "progressive",
  readiness: {
    strategy: "all-required",
    requiredBindings: [],
    pendingFallback: "loading",
    failureFallback: "error",
  },
  placements: [{
    kind: "panel",
    minWidth: 300,
    maxWidth: 1_000,
    minHeight: 200,
    maxHeight: 1_000,
  }],
  accessibility: {
    semanticRole: "group",
    accessibleName: { kind: "host", key: "component-label" },
    keyboardInteractions: ["activate"],
    liveRegion: "off",
    equivalentView: "none",
  },
  prompt: {
    summary: "React binding test component.",
    useWhen: ["Testing the trusted React binding."],
    avoidWhen: [],
    examples: [],
  },
  migrations: [],
});

export const OTHER_CONTRACT_REF = contractRefSchema.parse({
  ...TEST_CONTRACT.ref,
  contractHash: OTHER_HASH,
});

export const PANEL_PLACEMENT = placementContextSchema.parse({
  kind: "panel",
  width: 600,
  height: 500,
});

export function createRegistry(
  renderer: NodeRenderer,
  placements: readonly PlacementConstraint[] = TEST_CONTRACT.placements,
): RendererRegistry {
  return new RendererRegistry([{
    contract: TEST_CONTRACT.ref,
    placements,
    renderer,
  }]);
}

export function createProjection(input: Readonly<{
  nodeId?: NodeId;
  label?: string;
  slots?: Readonly<Record<string, readonly NodeId[]>>;
  projectionMode?: NodeProjection["projectionMode"];
  status?: NodeProjection["status"];
  commands?: NodeCommandBridge;
  nodeContract?: ContractRef;
  stateBindings?: NodeProjection["stateBindings"];
  resourceBindings?: NodeProjection["resourceBindings"];
}> = {}): NodeProjection {
  const nodeId = input.nodeId ?? ROOT_ID;
  const status = input.status ?? "ready";
  const node = canonicalNodeSchema.parse({
    contract: input.nodeContract ?? TEST_CONTRACT.ref,
    props: {},
    slots: input.slots ?? {},
    events: {},
    evidence: [],
  });
  return Object.freeze({
    nodeId,
    revisionId: REVISION_ID,
    projectionMode: input.projectionMode ?? "committed",
    status,
    node,
    ...(status === "unsupported-contract" ? {} : { contract: TEST_CONTRACT }),
    ...(status === "ready" ? {
      resolvedProps: Object.freeze({ label: input.label ?? nodeId }),
    } : {}),
    stateBindings: input.stateBindings ?? Object.freeze({}),
    resourceBindings: input.resourceBindings ?? Object.freeze({}),
    diagnostics: Object.freeze([]),
    ...(input.commands === undefined ? {} : { commands: input.commands }),
  }) as NodeProjection;
}

export function createSnapshot(
  status: SurfaceControllerSnapshot["status"] = "ready",
  rootNodeId: NodeId | null = ROOT_ID,
  version = 1,
): SurfaceControllerSnapshot {
  return Object.freeze({
    version,
    status,
    surfaceSessionId: surfaceSessionIdSchema.parse("surface-react-test"),
    acceptedThroughSequence: 0,
    acknowledgedThroughSequence: 0,
    actions: Object.freeze({}),
    approvals: [],
    effectReceipts: Object.freeze({}),
    diagnostics: Object.freeze([]),
    ...(rootNodeId === null ? {} : { rootNodeId }),
  });
}

export class FakeSurfaceController implements SurfaceControllerPort {
  readonly #snapshot: SurfaceControllerSnapshot;
  readonly #projections: ReadonlyMap<NodeId, NodeProjection>;

  constructor(
    snapshot: SurfaceControllerSnapshot,
    projections: readonly NodeProjection[] = [],
  ) {
    this.#snapshot = snapshot;
    this.#projections = new Map(projections.map((projection) => [
      projection.nodeId,
      projection,
    ]));
  }

  getSnapshot(): SurfaceControllerSnapshot {
    return this.#snapshot;
  }

  subscribe(
    _listener: (snapshot: SurfaceControllerSnapshot) => void,
  ): () => void {
    return () => undefined;
  }

  bindNode(nodeId: NodeId): NodeProjection | undefined {
    return this.#projections.get(nodeId);
  }
}

export function controllerWith(
  projections: readonly NodeProjection[],
  snapshot = createSnapshot(),
): FakeSurfaceController {
  return new FakeSurfaceController(snapshot, projections);
}

export function commandsWithEmit(
  emit: NonNullable<NodeCommandBridge["emit"]>,
): NodeCommandBridge {
  return {
    requestResource: async () => {
      throw new Error("Resource commands are not exposed by the React binding.");
    },
    emit,
  };
}

export function localEventResult() {
  return Object.freeze({
    kind: "local-transition" as const,
    requestId: REQUEST_ID,
    changes: Object.freeze([]),
    focusNodeIds: Object.freeze([]),
  });
}

export function panelPlacement(
  width: number,
  height = PANEL_PLACEMENT.height,
): PlacementContext {
  return placementContextSchema.parse({ kind: "panel", width, height });
}
