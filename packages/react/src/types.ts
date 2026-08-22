import type {
  NodeEventDispatchResult,
  NodeProjection,
  SurfaceController,
  SurfaceControllerSnapshot,
} from "@open-generative/client";
import type {
  ComponentContract,
  PlacementConstraint,
  PlacementContext,
} from "@open-generative/catalog";
import type {
  CanonicalNode,
  ContractRef,
  Diagnostic,
  EventPort,
  JsonObject,
  JsonValue,
  NodeId,
  RevisionId,
} from "@open-generative/protocol";
import type { ComponentType, ReactElement } from "react";

export type RenderedSlots = Readonly<Record<string, readonly ReactElement[]>>;

export type NodeScopedEventEmitter<TPort extends EventPort = EventPort> = (
  port: TPort,
  payload: JsonValue,
) => Promise<NodeEventDispatchResult>;

type RendererInputBase<TProps extends JsonObject> = Readonly<{
  node: CanonicalNode;
  contract: ComponentContract;
  resolvedProps: TProps;
  slots: RenderedSlots;
  stateBindings: NodeProjection["stateBindings"];
  resourceBindings: NodeProjection["resourceBindings"];
  placement: PlacementContext;
}>;

export type CommittedRendererInput<TProps extends JsonObject = JsonObject> =
  RendererInputBase<TProps> & Readonly<{
    projectionMode: "committed";
    emit?: NodeScopedEventEmitter;
  }>;

export type PreviewRendererInput<TProps extends JsonObject = JsonObject> =
  RendererInputBase<TProps> & Readonly<{
    projectionMode: "read-only-preview";
    emit?: never;
  }>;

export type RendererInput<TProps extends JsonObject = JsonObject> =
  | CommittedRendererInput<TProps>
  | PreviewRendererInput<TProps>;

export type NodeRenderer<TProps extends JsonObject = JsonObject> =
  ComponentType<RendererInput<TProps>>;

export type RendererRegistration = Readonly<{
  contract: ContractRef;
  placements: readonly PlacementConstraint[];
  renderer: NodeRenderer<any>;
}>;

export type RendererResolution =
  | Readonly<{
    status: "ready";
    registration: RendererRegistration;
  }>
  | Readonly<{
    status: "unsupported";
    reason: "renderer-missing" | "placement-unsupported";
  }>;

export type SurfaceControllerPort = Pick<
  SurfaceController,
  "getSnapshot" | "subscribe" | "bindNode"
>;

export type SystemSurfaceScope = "surface" | "node";

export type LoadingSystemSurfaceInput = Readonly<{
  scope: SystemSurfaceScope;
  nodeId?: NodeId;
  diagnostics: readonly Diagnostic[];
}>;

export type EmptySystemSurfaceInput = Readonly<{
  diagnostics: readonly Diagnostic[];
}>;

export type ErrorSystemSurfaceReason =
  | "resync-required"
  | "projection-missing"
  | "projection-invalid"
  | "projection-mismatch"
  | "graph-cycle"
  | "registry-failure"
  | "renderer-error";

export type ErrorSystemSurfaceInput = Readonly<{
  scope: SystemSurfaceScope;
  reason: ErrorSystemSurfaceReason;
  nodeId?: NodeId;
  diagnostics: readonly Diagnostic[];
  error?: unknown;
}>;

export type UnsupportedSystemSurfaceReason =
  | "unsupported-contract"
  | "renderer-missing"
  | "placement-unsupported";

export type UnsupportedSystemSurfaceInput = Readonly<{
  nodeId: NodeId;
  contract: ContractRef;
  placement: PlacementContext;
  reason: UnsupportedSystemSurfaceReason;
  diagnostics: readonly Diagnostic[];
}>;

export type SystemSurfaceRenderers = Readonly<{
  loading: ComponentType<LoadingSystemSurfaceInput>;
  empty: ComponentType<EmptySystemSurfaceInput>;
  error: ComponentType<ErrorSystemSurfaceInput>;
  unsupported: ComponentType<UnsupportedSystemSurfaceInput>;
}>;

export type SystemSurfaceOverrides = Partial<SystemSurfaceRenderers>;

export type NodeRenderErrorReport = Readonly<{
  nodeId: NodeId;
  revisionId: RevisionId;
  contract: ContractRef;
  error: unknown;
  componentStack?: string;
}>;

export type GenerativeSurfaceProps = Readonly<{
  controller: SurfaceControllerPort;
  registry: import("./renderer-registry").RendererRegistry;
  placement: PlacementContext;
  systemSurfaces?: SystemSurfaceOverrides;
  onNodeError?: (report: NodeRenderErrorReport) => void;
}>;

export type SurfaceSnapshot = SurfaceControllerSnapshot;
