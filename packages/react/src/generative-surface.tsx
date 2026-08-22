"use client";

import {
  contractRefKey,
  placementContextSchema,
} from "@open-generative/catalog";
import type {
  NodeProjection,
} from "@open-generative/client";
import type {
  EventPort,
  JsonValue,
  NodeId,
} from "@open-generative/protocol";
import {
  cloneElement,
  useCallback,
  useMemo,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactElement,
} from "react";
import { NodeErrorBoundary } from "./node-error-boundary";
import { defaultSystemSurfaces } from "./system-surfaces";
import type {
  ErrorSystemSurfaceInput,
  GenerativeSurfaceProps,
  NodeScopedEventEmitter,
  RendererInput,
  SystemSurfaceRenderers,
} from "./types";

export function GenerativeSurface({
  controller,
  registry,
  placement,
  systemSurfaces,
  onNodeError,
}: GenerativeSurfaceProps): ReactElement {
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  );
  const getSnapshot = useCallback(
    () => controller.getSnapshot(),
    [controller],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const surfaces = useMemo<SystemSurfaceRenderers>(() => ({
    loading: systemSurfaces?.loading ?? defaultSystemSurfaces.loading,
    empty: systemSurfaces?.empty ?? defaultSystemSurfaces.empty,
    error: systemSurfaces?.error ?? defaultSystemSurfaces.error,
    unsupported: systemSurfaces?.unsupported ?? defaultSystemSurfaces.unsupported,
  }), [systemSurfaces]);
  const placementResult = useMemo(() => {
    const parsed = placementContextSchema.safeParse(placement);
    return parsed.success
      ? Object.freeze({ ok: true as const, value: Object.freeze(parsed.data) })
      : Object.freeze({ ok: false as const, error: parsed.error });
  }, [placement]);

  if (!placementResult.ok) {
    return (
      <surfaces.error
        diagnostics={snapshot.diagnostics}
        error={placementResult.error}
        reason="placement-invalid"
        scope="surface"
      />
    );
  }
  const resolvedPlacement = placementResult.value;

  if (snapshot.status === "awaiting-snapshot") {
    return (
      <surfaces.loading
        diagnostics={snapshot.diagnostics}
        scope="surface"
      />
    );
  }
  if (snapshot.status === "resync-required") {
    return (
      <surfaces.error
        diagnostics={snapshot.diagnostics}
        reason="resync-required"
        scope="surface"
      />
    );
  }
  if (snapshot.rootNodeId === undefined) {
    return <surfaces.empty diagnostics={snapshot.diagnostics} />;
  }

  const renderError = (
    input: Omit<ErrorSystemSurfaceInput, "diagnostics"> & Readonly<{
      diagnostics?: ErrorSystemSurfaceInput["diagnostics"];
    }>,
  ): ReactElement => (
    <surfaces.error
      {...input}
      diagnostics={input.diagnostics ?? snapshot.diagnostics}
    />
  );

  const renderNode = (
    nodeId: NodeId,
    ancestors: ReadonlySet<NodeId>,
  ): ReactElement => {
    if (ancestors.has(nodeId)) {
      return renderError({
        scope: "node",
        reason: "graph-cycle",
        nodeId,
      });
    }

    let projection: NodeProjection | undefined;
    try {
      projection = controller.bindNode(nodeId);
    } catch (error) {
      return renderError({
        scope: "node",
        reason: "projection-missing",
        nodeId,
        error,
      });
    }
    if (!projection) {
      return renderError({
        scope: "node",
        reason: "projection-missing",
        nodeId,
      });
    }
    if (projection.nodeId !== nodeId) {
      return renderError({
        scope: "node",
        reason: "projection-mismatch",
        nodeId,
        diagnostics: projection.diagnostics,
      });
    }
    if (projection.status === "unresolved") {
      return (
        <surfaces.loading
          diagnostics={projection.diagnostics}
          nodeId={nodeId}
          scope="node"
        />
      );
    }
    if (projection.status === "invalid") {
      return renderError({
        scope: "node",
        reason: "projection-invalid",
        nodeId,
        diagnostics: projection.diagnostics,
      });
    }
    if (projection.status === "unsupported-contract") {
      return (
        <surfaces.unsupported
          contract={projection.node.contract}
          diagnostics={projection.diagnostics}
          nodeId={nodeId}
          placement={resolvedPlacement}
          reason="unsupported-contract"
        />
      );
    }
    if (projection.contract === undefined || projection.resolvedProps === undefined) {
      return renderError({
        scope: "node",
        reason: "projection-invalid",
        nodeId,
        diagnostics: projection.diagnostics,
      });
    }
    if (contractRefKey(projection.contract.ref) !== contractRefKey(projection.node.contract)) {
      return renderError({
        scope: "node",
        reason: "projection-mismatch",
        nodeId,
        diagnostics: projection.diagnostics,
      });
    }

    let resolution;
    try {
      resolution = registry.resolve(projection.contract, resolvedPlacement);
    } catch (error) {
      return renderError({
        scope: "node",
        reason: "registry-failure",
        nodeId,
        diagnostics: projection.diagnostics,
        error,
      });
    }
    if (resolution.status === "unsupported") {
      return (
        <surfaces.unsupported
          contract={projection.contract.ref}
          diagnostics={projection.diagnostics}
          nodeId={nodeId}
          placement={resolvedPlacement}
          reason={resolution.reason}
        />
      );
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(nodeId);
    const slots = Object.freeze(Object.fromEntries(
      Object.entries(projection.node.slots).map(([slotName, childIds]) => [
        slotName,
        renderSlot(childIds, nextAncestors, renderNode),
      ]),
    ));
    const emit = createNodeEmitter(projection);
    const common = {
      node: projection.node,
      contract: projection.contract,
      resolvedProps: projection.resolvedProps,
      slots,
      stateBindings: projection.stateBindings,
      resourceBindings: projection.resourceBindings,
      placement: resolvedPlacement,
    } as const;
    const input: RendererInput = projection.projectionMode === "committed"
      ? {
        ...common,
        projectionMode: "committed",
        ...(emit === undefined ? {} : { emit }),
      }
      : {
        ...common,
        projectionMode: "read-only-preview",
      };
    const Renderer = resolution.registration.renderer;
    const resetKey = `${projection.nodeId}:${projection.revisionId}:${contractRefKey(projection.contract.ref)}:${snapshot.version}`;

    return (
      <NodeErrorBoundary
        fallback={(error) => renderError({
          scope: "node",
          reason: "renderer-error",
          nodeId,
          diagnostics: projection.diagnostics,
          error,
        })}
        onError={(error, info) => {
          onNodeError?.({
            nodeId,
            revisionId: projection.revisionId,
            contract: projection.contract!.ref,
            error,
            ...componentStack(info),
          });
        }}
        resetKey={resetKey}
        resetToken={Renderer}
      >
        <Renderer {...input} />
      </NodeErrorBoundary>
    );
  };

  return renderNode(snapshot.rootNodeId, new Set());
}

function createNodeEmitter(
  projection: NodeProjection,
): NodeScopedEventEmitter | undefined {
  if (
    projection.projectionMode !== "committed"
    || projection.contract === undefined
    || Object.keys(projection.contract.events).length === 0
  ) return undefined;
  const commands = projection.commands;
  if (commands?.emit === undefined) return undefined;

  return async (port: EventPort, payload: JsonValue) => {
    if (!Object.hasOwn(projection.contract!.events, port)) {
      throw new TypeError(
        `Event port ${port} is not declared by ${contractRefKey(projection.contract!.ref)}.`,
      );
    }
    return commands.emit!.call(commands, port, payload);
  };
}

function renderSlot(
  childIds: readonly NodeId[],
  ancestors: ReadonlySet<NodeId>,
  renderNode: (nodeId: NodeId, ancestors: ReadonlySet<NodeId>) => ReactElement,
): readonly ReactElement[] {
  const occurrences = new Map<NodeId, number>();
  return Object.freeze(childIds.map((childId) => {
    const occurrence = occurrences.get(childId) ?? 0;
    occurrences.set(childId, occurrence + 1);
    const key = occurrence === 0 ? childId : `${childId}#${occurrence}`;
    return cloneElement(renderNode(childId, ancestors), { key });
  }));
}

function componentStack(info: ErrorInfo): Readonly<{ componentStack?: string }> {
  return info.componentStack === null
    ? {}
    : { componentStack: info.componentStack };
}
