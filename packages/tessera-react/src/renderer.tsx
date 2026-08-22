"use client";

import { safeParseArtifact, type Artifact, type ArtifactKind } from "@open-tessera/schema";
import {
  ARTIFACT_PROTOCOL,
  STREAM_PROTOCOL,
  artifactDocumentSchema,
  canExecuteActionLocally,
  createImplicitRuntimeSnapshot,
  createClientReplayState,
  executeLocalArtifactAction,
  inspectArtifactDocument,
  isArtifactPart,
  jsonValueSchema,
  replayClientArtifactEvents,
  resolveArtifactValue,
  resolveRuntimeStateValues,
  validateArtifactDocument,
  type ArtifactDocument,
  type ArtifactNode,
  type ArtifactPart,
  type ClientArtifactCommand,
  type ClientReplayState,
  type Diagnostic,
  type JsonValue,
  type RuntimeSnapshot,
} from "@open-tessera/runtime";
import { Component, Fragment, useEffect, useMemo, useRef, useState, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { AnomalyArtifact } from "./anomaly-artifact";
import { BreakdownArtifact } from "./breakdown-artifact";
import { CalculatorArtifact } from "./calculator-artifact";
import { ComparisonArtifact } from "./comparison-artifact";
import { CohortArtifact } from "./cohort-artifact";
import { DataQualityArtifact } from "./data-quality-artifact";
import { DistributionArtifact } from "./distribution-artifact";
import { DriverArtifact } from "./driver-artifact";
import { ExperimentArtifact } from "./experiment-artifact";
import { ForecastArtifact } from "./forecast-artifact";
import { FunnelArtifact } from "./funnel-artifact";
import { InsightArtifact } from "./insight-artifact";
import { MetricArtifact } from "./metric-artifact";
import { QueryArtifact } from "./query-artifact";
import { RankingArtifact } from "./ranking-artifact";
import { ArtifactEmpty } from "./primitives";
import { TargetArtifact } from "./target-artifact";
import { TimelineArtifact } from "./timeline-artifact";
import { TrendArtifact } from "./trend-artifact";
import { ArtifactUIProvider, useArtifactUI } from "./bridge";
import { officialFormNodeEventPayloadValidators, officialFormNodeRenderers } from "./form-nodes";
import {
  defineArtifactNodeRenderer,
  type ArtifactNodeRenderer,
  type ArtifactNodeEventPayloadValidatorRegistry,
  type ArtifactNodeRendererProps,
  type ArtifactNodeRendererRegistry,
  type ArtifactNodeTrigger,
  type EvaluatedArtifactNodeProps,
} from "./node-types";
import { officialSurfaceNodeRenderers } from "./surface-nodes";

export type ArtifactComponentProps<TValue = Artifact> = {
  /** Preferred renderer input name. */
  value: TValue;
  /** v1-compatible alias for value. */
  artifact: TValue;
  locale?: string;
};

export type ArtifactComponent<TValue = Artifact> = ComponentType<ArtifactComponentProps<TValue>>;

export type OfficialRendererRegistry = {
  [TKind in ArtifactKind]: ArtifactComponent<Extract<Artifact, { kind: TKind }>>;
};

type AnyArtifactComponent = ArtifactComponent<any>;

export type RendererRegistry = Readonly<Record<string, AnyArtifactComponent>>;
export type RendererOverrides = Partial<OfficialRendererRegistry> & Readonly<Record<string, AnyArtifactComponent | undefined>>;

export const defaultRendererRegistry = Object.freeze({
  query: ({ artifact, locale }) => <QueryArtifact artifact={artifact} locale={locale} />,
  calculator: ({ artifact, locale }) => <CalculatorArtifact artifact={artifact} locale={locale} />,
  metric: ({ artifact, locale }) => <MetricArtifact artifact={artifact} locale={locale} />,
  comparison: ({ artifact }) => <ComparisonArtifact artifact={artifact} />,
  trend: ({ artifact, locale }) => <TrendArtifact artifact={artifact} locale={locale} />,
  anomaly: ({ artifact, locale }) => <AnomalyArtifact artifact={artifact} locale={locale} />,
  forecast: ({ artifact, locale }) => <ForecastArtifact artifact={artifact} locale={locale} />,
  funnel: ({ artifact, locale }) => <FunnelArtifact artifact={artifact} locale={locale} />,
  "data-quality": ({ artifact, locale }) => <DataQualityArtifact artifact={artifact} locale={locale} />,
  insight: ({ artifact }) => <InsightArtifact artifact={artifact} />,
  breakdown: ({ artifact, locale }) => <BreakdownArtifact artifact={artifact} locale={locale} />,
  distribution: ({ artifact, locale }) => <DistributionArtifact artifact={artifact} locale={locale} />,
  cohort: ({ artifact, locale }) => <CohortArtifact artifact={artifact} locale={locale} />,
  experiment: ({ artifact, locale }) => <ExperimentArtifact artifact={artifact} locale={locale} />,
  driver: ({ artifact, locale }) => <DriverArtifact artifact={artifact} locale={locale} />,
  ranking: ({ artifact, locale }) => <RankingArtifact artifact={artifact} locale={locale} />,
  target: ({ artifact, locale }) => <TargetArtifact artifact={artifact} locale={locale} />,
  timeline: ({ artifact, locale }) => <TimelineArtifact artifact={artifact} locale={locale} />,
}) satisfies OfficialRendererRegistry;

function assignRenderers(target: Record<string, AnyArtifactComponent>, source: RendererOverrides | RendererRegistry | undefined) {
  if (!source) return;
  for (const [kind, component] of Object.entries(source)) {
    if (component) target[kind] = component;
  }
}

export function createRendererRegistry<TOverrides extends RendererOverrides = {}>(overrides?: TOverrides): OfficialRendererRegistry & RendererRegistry & TOverrides {
  const registry: Record<string, AnyArtifactComponent> = {};
  assignRenderers(registry, defaultRendererRegistry);
  assignRenderers(registry, overrides);
  return registry as OfficialRendererRegistry & RendererRegistry & TOverrides;
}

export function extendRendererRegistry<TBase extends RendererRegistry, TExtensions extends RendererOverrides>(base: TBase, extensions: TExtensions): TBase & TExtensions {
  const registry: Record<string, AnyArtifactComponent> = {};
  assignRenderers(registry, base);
  assignRenderers(registry, extensions);
  return registry as TBase & TExtensions;
}

export function defineArtifactRenderer<TValue>(component: ArtifactComponent<TValue>): ArtifactComponent<TValue> {
  return component;
}

export type ArtifactNodeRendererOverrides = Readonly<Record<string, ArtifactNodeRenderer<any> | undefined>>;

const semanticArtifactKinds = [
  "query",
  "calculator",
  "metric",
  "comparison",
  "trend",
  "anomaly",
  "forecast",
  "funnel",
  "data-quality",
  "insight",
  "breakdown",
  "distribution",
  "cohort",
  "experiment",
  "driver",
  "ranking",
  "target",
  "timeline",
] as const satisfies readonly ArtifactKind[];

const SemanticArtifactNode = defineArtifactNodeRenderer<EvaluatedArtifactNodeProps>(({
  document,
  locale,
  node,
  nodeId,
  value,
}) => {
  const kind = node.type.startsWith("artifact.") ? node.type.slice("artifact.".length) : "";
  const title = typeof value.title === "string"
    ? value.title
    : document.meta.title ?? kind.replaceAll("-", " ");
  const description = typeof value.description === "string"
    ? value.description
    : document.meta.description ?? "";
  const candidate = {
    ...value,
    protocolVersion: "1.0",
    id: nodeId,
    kind,
    title,
    description,
    createdAt: document.meta.createdAt,
  };
  const parsed = safeParseArtifact(candidate);
  if (!parsed.success) {
    return (
      <ArtifactEmpty
        description="The evaluated semantic props do not satisfy the installed artifact contract."
        title="Artifact data unavailable"
      />
    );
  }
  const LegacyRenderer = defaultRendererRegistry[parsed.data.kind] as ArtifactComponent<Artifact>;
  return (
    <div className="min-w-0" data-artifact-node-id={nodeId} tabIndex={-1}>
      <ArtifactUIProvider inheritActions={false}>
        <LegacyRenderer artifact={parsed.data} locale={locale} value={parsed.data} />
      </ArtifactUIProvider>
    </div>
  );
});

const officialSemanticNodeRenderers = Object.fromEntries(
  semanticArtifactKinds.map((kind) => [`artifact.${kind}`, SemanticArtifactNode]),
) as ArtifactNodeRendererRegistry;

export const defaultArtifactNodeRendererRegistry: ArtifactNodeRendererRegistry = Object.freeze({
  ...officialSurfaceNodeRenderers,
  ...officialFormNodeRenderers,
  ...officialSemanticNodeRenderers,
});

function assignNodeRenderers(
  target: Record<string, ArtifactNodeRenderer<any>>,
  source: ArtifactNodeRendererOverrides | ArtifactNodeRendererRegistry | undefined,
): void {
  if (!source) return;
  for (const [type, renderer] of Object.entries(source)) {
    if (renderer) target[type] = renderer;
  }
}

export function createArtifactNodeRendererRegistry<TExtensions extends ArtifactNodeRendererOverrides = {}>(
  extensions?: TExtensions,
): ArtifactNodeRendererRegistry & TExtensions {
  const registry: Record<string, ArtifactNodeRenderer<any>> = {};
  assignNodeRenderers(registry, defaultArtifactNodeRendererRegistry);
  assignNodeRenderers(registry, extensions);
  return registry as ArtifactNodeRendererRegistry & TExtensions;
}

export function extendArtifactNodeRendererRegistry<
  TBase extends ArtifactNodeRendererRegistry,
  TExtensions extends ArtifactNodeRendererOverrides,
>(base: TBase, extensions: TExtensions): TBase & TExtensions {
  const registry: Record<string, ArtifactNodeRenderer<any>> = {};
  assignNodeRenderers(registry, base);
  assignNodeRenderers(registry, extensions);
  return registry as TBase & TExtensions;
}

export interface ArtifactRendererValueGuard<TValue = unknown> {
  is(value: unknown): value is TValue;
  getKind(value: TValue): string;
  unwrap?(value: TValue): unknown;
}

export function isV1ArtifactRendererValue(value: unknown): value is Artifact {
  return safeParseArtifact(value).success;
}

export const v1ArtifactRendererValueGuard: ArtifactRendererValueGuard<Artifact> = {
  is: isV1ArtifactRendererValue,
  getKind: (value) => value.kind,
  unwrap: (value) => {
    const result = safeParseArtifact(value);
    return result.success ? result.data : value;
  },
};

export type ArtifactRendererFallbackContext = {
  kind?: string;
  value: unknown;
};

export type ArtifactRendererErrorContext = ArtifactRendererFallbackContext & {
  error: Error;
  reset: () => void;
};

export type ArtifactRendererFallback = ReactNode | ((context: ArtifactRendererFallbackContext) => ReactNode);
export type ArtifactRendererErrorFallback = ReactNode | ((context: ArtifactRendererErrorContext) => ReactNode);

export type ArtifactRendererErrorBoundaryProps = {
  children: ReactNode;
  fallback?: ArtifactRendererErrorFallback;
  kind?: string;
  onError?: (error: Error, info: ErrorInfo) => void;
  resetKey: unknown;
  value: unknown;
};

export type ArtifactRendererErrorBoundaryComponent = ComponentType<ArtifactRendererErrorBoundaryProps>;

type ArtifactRendererErrorBoundaryState = { error?: Error };

function renderErrorFallback(fallback: ArtifactRendererErrorFallback | undefined, context: ArtifactRendererErrorContext) {
  if (typeof fallback === "function") return fallback(context);
  if (fallback !== undefined) return fallback;
  return <ArtifactEmpty description={context.error.message} title="Artifact could not be rendered" />;
}

export class ArtifactRendererErrorBoundary extends Component<ArtifactRendererErrorBoundaryProps, ArtifactRendererErrorBoundaryState> {
  state: ArtifactRendererErrorBoundaryState = {};

  static getDerivedStateFromError(error: unknown): ArtifactRendererErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
  }

  componentDidUpdate(previousProps: ArtifactRendererErrorBoundaryProps) {
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) this.reset();
  }

  reset = () => {
    this.setState({ error: undefined });
  };

  render() {
    if (this.state.error) {
      return renderErrorFallback(this.props.fallback, {
        error: this.state.error,
        kind: this.props.kind,
        reset: this.reset,
        value: this.props.value,
      });
    }
    return this.props.children;
  }
}

type SharedArtifactRendererProps<TValue> = {
  errorBoundary?: ArtifactRendererErrorBoundaryComponent | false;
  errorFallback?: ArtifactRendererErrorFallback;
  fallback?: ArtifactRendererFallback;
  locale?: string;
  onError?: (error: Error, info: ErrorInfo) => void;
  registry?: RendererOverrides;
  nodeRegistry?: ArtifactNodeRendererOverrides;
  eventPayloadValidators?: ArtifactNodeEventPayloadValidatorRegistry;
  valueGuards?: readonly ArtifactRendererValueGuard<TValue>[];
};

export type ArtifactRendererProps<TValue = unknown> = SharedArtifactRendererProps<TValue> & (
  | { artifact: Artifact; value?: never }
  | { artifact?: never; value: TValue }
);

type ResolvedRendererValue = { kind: string; value: unknown };

type RuntimeRendererResolution = {
  recognized: boolean;
  document?: ArtifactDocument;
  snapshot?: RuntimeSnapshot;
  streamId?: string;
  diagnostics: Diagnostic[];
  pending: boolean;
};

function resolveRendererValue<TValue>(value: unknown, valueGuards: readonly ArtifactRendererValueGuard<TValue>[]): ResolvedRendererValue | undefined {
  for (const guard of valueGuards) {
    if (!guard.is(value)) continue;
    return {
      kind: guard.getKind(value),
      value: guard.unwrap ? guard.unwrap(value) : value,
    };
  }
  return undefined;
}

function getKindHint(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("kind" in value)) return undefined;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : undefined;
}

function renderFallback(fallback: ArtifactRendererFallback | undefined, context: ArtifactRendererFallbackContext) {
  if (typeof fallback === "function") return fallback(context);
  if (fallback !== undefined) return fallback;
  return <ArtifactEmpty title="Unsupported artifact" description={context.kind ? `No trusted renderer is registered for \"${context.kind}\".` : "The value is not a trusted artifact renderer input."} />;
}

export function ArtifactRenderer<TValue = unknown>(props: ArtifactRendererProps<TValue>) {
  const input = "value" in props ? props.value : props.artifact;
  const runtime = useRuntimeRendererValue(input);

  if (runtime.recognized) {
    if (!runtime.document) {
      const diagnostic = runtime.diagnostics.at(-1);
      return renderFallback(props.fallback, {
        kind: getKindHint(input) ?? "artifact.document",
        value: diagnostic ?? input,
      });
    }

    const content = (
      <ArtifactDocumentRuntimeBoundary
        document={runtime.document}
        eventPayloadValidators={props.eventPayloadValidators}
        fallback={props.fallback}
        locale={props.locale}
        nodeRegistry={props.nodeRegistry}
        snapshot={runtime.snapshot}
        streamId={runtime.streamId}
      />
    );
    if (props.errorBoundary === false) return content;
    const ErrorBoundary = props.errorBoundary ?? ArtifactRendererErrorBoundary;
    return (
      <ErrorBoundary
        fallback={props.errorFallback}
        kind="artifact.document"
        onError={props.onError}
        resetKey={runtime.document.revision.revisionId}
        value={input}
      >
        {content}
      </ErrorBoundary>
    );
  }

  const customResolved = "artifact" in props && props.artifact
    ? { kind: props.artifact.kind, value: props.artifact }
    : resolveRendererValue(input, props.valueGuards ?? []);
  const parsedV1 = customResolved ? undefined : safeParseArtifact(input);
  const resolved = customResolved ?? (parsedV1?.success ? { kind: parsedV1.data.kind, value: parsedV1.data } : undefined);

  if (!resolved) return renderFallback(props.fallback, { kind: getKindHint(input), value: input });

  const registry = createRendererRegistry(props.registry);
  const Component = registry[resolved.kind] as ArtifactComponent<unknown> | undefined;
  if (!Component) return renderFallback(props.fallback, resolved);

  const content = <Component artifact={resolved.value} value={resolved.value} locale={props.locale} />;
  if (props.errorBoundary === false) return content;

  const ErrorBoundary = props.errorBoundary ?? ArtifactRendererErrorBoundary;
  return (
    <ErrorBoundary fallback={props.errorFallback} kind={resolved.kind} onError={props.onError} resetKey={input} value={input}>
      {content}
    </ErrorBoundary>
  );
}

export type ArtifactDocumentRendererProps = {
  document: ArtifactDocument;
  snapshot?: RuntimeSnapshot;
  streamId?: string;
  locale?: string;
  nodeRegistry?: ArtifactNodeRendererOverrides;
  eventPayloadValidators?: ArtifactNodeEventPayloadValidatorRegistry;
  fallback?: ArtifactRendererFallback;
};

function ArtifactDocumentRuntimeBoundary(props: ArtifactDocumentRendererProps) {
  const runtime = useArtifactUI();
  if (runtime.hasProvider) return <ArtifactDocumentRenderer {...props} />;
  return (
    <ArtifactUIProvider>
      <ArtifactDocumentRenderer {...props} />
    </ArtifactUIProvider>
  );
}

export function ArtifactDocumentRenderer({
  document,
  snapshot,
  streamId,
  locale,
  nodeRegistry,
  eventPayloadValidators,
  fallback,
}: ArtifactDocumentRendererProps) {
  const runtime = useArtifactUI();
  const providerSession = runtime.getRuntimeSession(document.documentId, document.revision.branchId);
  const implicitSnapshot = useMemo(() => createImplicitRuntimeSnapshot(document), [document]);
  const activeSnapshot = providerSession?.snapshot.document.revision.revisionId === document.revision.revisionId
    ? providerSession.snapshot
    : snapshot ?? implicitSnapshot;
  const activeStreamId = streamId ?? providerSession?.streamId ?? implicitStreamId(document);
  const publishedInput = useRef<{ snapshot: RuntimeSnapshot; streamId: string } | undefined>(undefined);
  const localActionTail = useRef<Promise<unknown>>(Promise.resolve());
  const enqueueLocalAction = (operation: () => ReturnType<ArtifactNodeTrigger>): ReturnType<ArtifactNodeTrigger> => {
    const result = localActionTail.current.then(operation, operation);
    localActionTail.current = result.then(() => undefined, () => undefined);
    return result;
  };
  useEffect(() => {
    const candidate = snapshot ?? (providerSession ? undefined : implicitSnapshot);
    if (!candidate) return;
    const candidateStreamId = streamId ?? implicitStreamId(document);
    if (
      publishedInput.current?.snapshot === candidate
      && publishedInput.current.streamId === candidateStreamId
    ) return;
    if (runtime.publishRuntimeSession({ streamId: candidateStreamId, snapshot: candidate })) {
      publishedInput.current = { snapshot: candidate, streamId: candidateStreamId };
    }
  }, [document, implicitSnapshot, providerSession, snapshot, streamId]);
  const registry = createArtifactNodeRendererRegistry(nodeRegistry);
  const validators = mergeNodeEventPayloadValidators(eventPayloadValidators);
  const stateValues = resolveRuntimeStateValues(document, activeSnapshot);
  const resourceValues: Record<string, JsonValue> = {};
  for (const [resourceId, reference] of Object.entries(document.resources)) {
    if (reference.preview !== undefined) resourceValues[resourceId] = reference.preview;
    const binding = runtime.getResourceBinding(document, resourceId);
    if (binding) resourceValues[resourceId] = binding.value;
  }

  const renderNode = (nodeId: string, ancestry: ReadonlySet<string>): ReactNode => {
    if (ancestry.has(nodeId)) {
      return renderFallback(fallback, { kind: "artifact.node-cycle", value: nodeId });
    }
    const node = document.nodes[nodeId];
    if (!node) return renderFallback(fallback, { kind: "artifact.node-missing", value: nodeId });
    const Component = registry[node.type];
    if (!Component) return renderFallback(fallback, { kind: node.type, value: node });

    const evaluation = evaluateNodeProps(node, {
      state: stateValues,
      resources: resourceValues,
      context: {
        locale: locale ?? document.meta.locale ?? runtime.locale ?? "en-US",
        timezone: runtime.timezone ?? "UTC",
      },
    });
    if (!evaluation.success) {
      const missingResource = evaluation.diagnostics.some((diagnostic) => diagnostic.code === "value.unresolved-resource");
      return (
        <ArtifactEmpty
          description={missingResource
            ? "The required resource is not available for this document revision."
            : "A typed value required by this node could not be resolved."}
          title={missingResource ? "Resource unavailable" : "Artifact unavailable"}
        />
      );
    }
    if (evaluation.value.visible === false) return null;

    const nextAncestry = new Set(ancestry);
    nextAncestry.add(nodeId);
    const slots = Object.fromEntries(
      Object.entries(node.slots ?? {}).map(([name, childIds]) => [
        name,
        childIds.map((childId, index) => (
          <Fragment key={`${childId}:${index}`}>{renderNode(childId, nextAncestry)}</Fragment>
        )),
      ]),
    );
    const trigger = async (port: string, payload: JsonValue = null) => {
      const actionId = node.events?.[port];
      const plan = actionId ? document.actions[actionId] : undefined;
      if (!actionId || !plan || !activeSnapshot || !activeStreamId) {
        return {
          ok: false as const,
          diagnostic: rendererDiagnostic(
            "runtime.action-unavailable",
            "This node event is not bound to an active runtime session.",
            nodeId,
          ),
        };
      }
      const parsedPayload = jsonValueSchema.safeParse(payload);
      if (!parsedPayload.success) {
        return {
          ok: false as const,
          diagnostic: rendererDiagnostic("runtime.event-payload-invalid", "The event payload is not valid JSON data.", nodeId),
        };
      }
      const validation = validateNodeEventPayload(validators, node.type, port, parsedPayload.data);
      if (!validation.success) {
        return {
          ok: false as const,
          diagnostic: rendererDiagnostic("runtime.event-payload-invalid", validation.message, nodeId),
        };
      }
      const requestId = createRuntimeRequestId();
      if (shouldExecuteActionLocally(document, plan, runtime.hasRuntimeTransport)) {
        return enqueueLocalAction(async () => {
          const session = runtime.getRuntimeSession(document.documentId, document.revision.branchId);
          const currentSnapshot = session?.snapshot.document.revision.revisionId === document.revision.revisionId
            ? session.snapshot
            : activeSnapshot;
          const currentStreamId = session?.streamId ?? activeStreamId;
          const executed = await executeLocalArtifactAction({
            snapshot: currentSnapshot,
            nodeId,
            port,
            payload: parsedPayload.data,
            resources: resourceValues,
            context: {
              locale: locale ?? document.meta.locale ?? runtime.locale ?? "en-US",
              timezone: runtime.timezone ?? "UTC",
            },
            options: { requestId },
          });
          if (!executed.ok) return executed;
          if (!runtime.publishRuntimeSession({ streamId: currentStreamId, snapshot: executed.snapshot })) {
            return {
              ok: false as const,
              diagnostic: rendererDiagnostic("runtime.session-publish-failed", "The local runtime session rejected the state update.", nodeId),
            };
          }
          scheduleNodeFocus(executed.focusNodeIds);
          return { ok: true as const };
        });
      }
      const session = runtime.getRuntimeSession(document.documentId, document.revision.branchId);
      const currentSnapshot = session?.snapshot.document.revision.revisionId === document.revision.revisionId
        ? session.snapshot
        : activeSnapshot;
      const currentStreamId = session?.streamId ?? activeStreamId;
      const command: ClientArtifactCommand = {
        streamProtocol: STREAM_PROTOCOL,
        streamId: currentStreamId,
        contractFingerprint: document.revision.contractFingerprint,
        payload: {
          type: "action-trigger",
          requestId,
          documentId: document.documentId,
          branchId: document.revision.branchId,
          revisionId: document.revision.revisionId,
          headToken: currentSnapshot.branchHead.headToken,
          nodeId,
          port,
          payload: parsedPayload.data,
          statePreconditions: Object.fromEntries(currentSnapshot.state.map((record) => [record.stateId, record.stateRevision])),
        },
      };
      return runtime.dispatchRuntimeCommand(command);
    };
    const canTrigger = (port: string): boolean => {
      const actionId = node.events?.[port];
      const plan = actionId ? document.actions[actionId] : undefined;
      if (!actionId || !plan || !activeSnapshot || !activeStreamId) return false;
      if (shouldExecuteActionLocally(document, plan, runtime.hasRuntimeTransport)) return true;
      const command: ClientArtifactCommand = {
        streamProtocol: STREAM_PROTOCOL,
        streamId: activeStreamId,
        contractFingerprint: document.revision.contractFingerprint,
        payload: {
          type: "action-trigger",
          requestId: "availability-check",
          documentId: document.documentId,
          branchId: document.revision.branchId,
          revisionId: document.revision.revisionId,
          headToken: activeSnapshot.branchHead.headToken,
          nodeId,
          port,
          payload: null,
          statePreconditions: Object.fromEntries(activeSnapshot.state.map((record) => [record.stateId, record.stateRevision])),
        },
      };
      return runtime.canDispatchRuntimeCommand(command);
    };
    const componentProps: ArtifactNodeRendererProps = {
      nodeId,
      node,
      value: evaluation.value,
      props: evaluation.value,
      document,
      ...(activeSnapshot ? { snapshot: activeSnapshot } : {}),
      slots,
      children: slots.children ?? null,
      locale: locale ?? document.meta.locale ?? runtime.locale,
      timezone: runtime.timezone,
      diagnostics: evaluation.diagnostics,
      canTrigger,
      trigger,
    };
    return <Component key={nodeId} {...componentProps} />;
  };

  return <>{renderNode(document.root, new Set())}</>;
}

function mergeNodeEventPayloadValidators(
  overrides: ArtifactNodeEventPayloadValidatorRegistry | undefined,
): ArtifactNodeEventPayloadValidatorRegistry {
  if (!overrides) return officialFormNodeEventPayloadValidators;
  const output: Record<string, Record<string, ArtifactNodeEventPayloadValidatorRegistry[string][string]>> = {};
  for (const [type, ports] of Object.entries(officialFormNodeEventPayloadValidators)) output[type] = { ...ports };
  for (const [type, ports] of Object.entries(overrides)) output[type] = { ...output[type], ...ports };
  return output;
}

function shouldExecuteActionLocally(
  document: ArtifactDocument,
  plan: ArtifactDocument["actions"][string],
  hasRuntimeTransport: boolean,
): boolean {
  if (!canExecuteActionLocally(document, plan)) return false;
  return !hasRuntimeTransport || plan.steps.every((step) => step.type === "node.focus");
}

function validateNodeEventPayload(
  validators: ArtifactNodeEventPayloadValidatorRegistry,
  type: string,
  port: string,
  payload: JsonValue,
): { success: true } | { success: false; message: string } {
  const ports = validators[type];
  if (!ports) return { success: true };
  const validator = ports[port];
  if (!validator) return { success: false, message: `Event port ${port} is not declared for ${type}.` };
  try {
    return validator(payload);
  } catch {
    return { success: false, message: `Event payload validation failed for ${type}.${port}.` };
  }
}

function implicitStreamId(document: ArtifactDocument): string {
  return `local:${document.documentId.slice(0, 240)}:${document.revision.branchId.slice(0, 240)}`;
}

function createRuntimeRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `request:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

function scheduleNodeFocus(nodeIds: readonly string[]): void {
  if (nodeIds.length === 0 || !globalThis.document) return;
  const focus = () => {
    const elements = globalThis.document.querySelectorAll<HTMLElement>("[data-artifact-node-id]");
    for (const nodeId of nodeIds) {
      for (const element of elements) {
        if (element.dataset.artifactNodeId === nodeId) {
          element.focus();
          break;
        }
      }
    }
  };
  if (typeof globalThis.requestAnimationFrame === "function") globalThis.requestAnimationFrame(focus);
  else queueMicrotask(focus);
}

type NodeValueResolutionContext = Parameters<typeof resolveArtifactValue>[1];

function evaluateNodeProps(
  node: ArtifactNode,
  context: NodeValueResolutionContext,
): { success: true; value: EvaluatedArtifactNodeProps; diagnostics: Diagnostic[] } | { success: false; diagnostics: Diagnostic[] } {
  const value: EvaluatedArtifactNodeProps = {};
  const diagnostics: Diagnostic[] = [];
  for (const [key, input] of Object.entries(node.props)) {
    const result = resolveArtifactValue(input, context);
    if (!result.ok) diagnostics.push(result.diagnostic);
    else value[key] = result.value;
  }
  return diagnostics.length > 0 ? { success: false, diagnostics } : { success: true, value, diagnostics };
}

function useRuntimeRendererValue(input: unknown): RuntimeRendererResolution {
  const synchronous = resolveRuntimeSynchronously(input);
  const [resolved, setResolved] = useState<{ input: unknown; value: RuntimeRendererResolution }>();

  useEffect(() => {
    let active = true;
    if (isArtifactPart(input)) {
      void resolveArtifactPart(input).then((value) => {
        if (active) setResolved({ input, value });
      });
    } else if (synchronous.document) {
      void validateArtifactDocument(synchronous.document).then((validation) => {
        if (!active) return;
        setResolved({
          input,
          value: validation.success
            ? synchronous
            : { recognized: true, diagnostics: validation.diagnostics, pending: false },
        });
      });
    } else {
      setResolved({ input, value: synchronous });
    }
    return () => {
      active = false;
    };
  }, [input]);

  if (resolved && resolved.input === input) return resolved.value;
  return synchronous;
}

function resolveRuntimeSynchronously(input: unknown): RuntimeRendererResolution {
  if (isArtifactPart(input)) {
    const snapshot = trustedLastGoodSnapshot(input);
    return {
      recognized: true,
      ...(snapshot ? { document: snapshot.document, snapshot } : {}),
      ...(input.kind === "artifact-stream" && input.events[0] ? { streamId: input.events[0].streamId } : {}),
      diagnostics: [],
      pending: input.kind === "artifact-stream",
    };
  }
  if (isArtifactDocumentCandidate(input)) {
    const parsed = artifactDocumentSchema.safeParse(input);
    if (!parsed.success) {
      return {
        recognized: true,
        diagnostics: parsed.error.issues.map((issue) => rendererDiagnostic("document.schema-invalid", issue.message)),
        pending: false,
      };
    }
    let diagnostics: Diagnostic[];
    try {
      diagnostics = inspectArtifactDocument(parsed.data);
    } catch {
      diagnostics = [rendererDiagnostic("document.validation-failed", "Document validation failed closed.")];
    }
    return diagnostics.length > 0
      ? { recognized: true, diagnostics, pending: false }
      : { recognized: true, document: parsed.data, diagnostics: [], pending: true };
  }
  return { recognized: false, diagnostics: [], pending: false };
}

async function resolveArtifactPart(part: ArtifactPart): Promise<RuntimeRendererResolution> {
  if (part.kind === "artifact-snapshot") {
    return {
      recognized: true,
      document: part.snapshot.document,
      snapshot: part.snapshot,
      diagnostics: [],
      pending: false,
    };
  }
  const firstEvent = part.events[0];
  const initial: ClientReplayState = createClientReplayState(part.base);
  if (firstEvent) {
    initial.acceptedThroughSeq = firstEvent.seq - 1;
    initial.streamId = firstEvent.streamId;
    initial.contractFingerprint = firstEvent.contractFingerprint;
  }
  const replayed = await replayClientArtifactEvents(part.events, initial);
  return {
    recognized: true,
    ...(replayed.lastGood ? { document: replayed.lastGood.document, snapshot: replayed.lastGood } : {}),
    ...(firstEvent ? { streamId: firstEvent.streamId } : {}),
    diagnostics: replayed.diagnostics,
    pending: false,
  };
}

function trustedLastGoodSnapshot(part: ArtifactPart): RuntimeSnapshot | undefined {
  if (part.kind === "artifact-snapshot") return part.snapshot;
  let snapshot = part.base;
  for (const event of part.events) {
    if (event.payload.type === "snapshot" || event.payload.type === "committed") snapshot = event.payload.snapshot;
  }
  return snapshot;
}

function isArtifactDocumentCandidate(input: unknown): input is Record<string, unknown> {
  return Boolean(
    input
    && typeof input === "object"
    && "protocol" in input
    && (input as { protocol?: unknown }).protocol === ARTIFACT_PROTOCOL,
  );
}

function rendererDiagnostic(code: string, message: string, nodeId?: string): Diagnostic {
  return {
    phase: "render",
    code,
    severity: "error",
    recoverable: true,
    modelCorrectable: false,
    message,
    ...(nodeId ? { location: { entity: { kind: "node", id: nodeId } } } : {}),
  };
}
