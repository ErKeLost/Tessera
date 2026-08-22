"use client";

import {
  artifactActionContracts,
  artifactActionEventSchema,
  safeParseBuiltInArtifactActionEvent,
  type ArtifactActionEvent,
  type ArtifactActionName,
  type ArtifactActionPayload,
  type ArtifactKind,
} from "@open-tessera/schema";
import {
  canonicalize,
  clientArtifactCommandSchema,
  clientResourceDataEnvelopeSchema,
  runtimeSnapshotSchema,
  type ArtifactDocument,
  type ClientArtifactCommand,
  type ClientResourceBinding,
  type ClientResourceDataEnvelope,
  type Diagnostic,
  type RuntimeSnapshot,
} from "@open-tessera/runtime";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type ArtifactActionHandler = (event: ArtifactActionEvent) => void | Promise<void>;

export type ArtifactActionSource = {
  id: string;
  kind: ArtifactKind;
};

export type ArtifactActionAvailability = {
  action: string;
  artifactId: string;
  artifactKind: ArtifactKind;
  brokered: boolean;
};

export type ArtifactCommandTransport = {
  dispatch: ArtifactActionHandler;
  canDispatch?: (action: ArtifactActionAvailability) => boolean;
};

export type ArtifactTransport = ArtifactActionHandler | ArtifactCommandTransport;

export type ArtifactRuntimeCommandAvailability = {
  type: ClientArtifactCommand["payload"]["type"];
  streamId: string;
  documentId?: string;
  branchId?: string;
  revisionId?: string;
};

export type ArtifactRuntimeCommandTransport = {
  dispatch: (command: ClientArtifactCommand) => void | Promise<void>;
  canDispatch?: (command: ArtifactRuntimeCommandAvailability) => boolean;
};

export type ArtifactRuntimeSession = {
  streamId: string;
  snapshot: RuntimeSnapshot;
};

export type ArtifactRuntimeDispatchResult =
  | { ok: true }
  | { ok: false; diagnostic: Diagnostic };

export type ArtifactThemeVariables = Record<`--${string}`, string | number>;

export type ArtifactTheme = {
  name?: string;
  variables?: ArtifactThemeVariables;
  cssVariables?: ArtifactThemeVariables;
};

export type ArtifactSlotName =
  | "artifact"
  | "artifact-header"
  | "artifact-title"
  | "artifact-description"
  | "artifact-actions"
  | "artifact-action"
  | "artifact-content"
  | "artifact-status"
  | "artifact-empty"
  | "artifact-empty-icon"
  | "artifact-empty-title"
  | "artifact-empty-description";

export type ArtifactSlotClasses = Partial<Record<ArtifactSlotName, string>> & Record<string, string | undefined>;

export type ArtifactUIProviderProps = {
  children: ReactNode;
  onAction?: ArtifactActionHandler;
  transport?: ArtifactTransport;
  theme?: string | ArtifactTheme;
  cssVariables?: ArtifactThemeVariables;
  slotClasses?: ArtifactSlotClasses;
  /** Disable inherited v1 action handlers inside a v2 semantic renderer. */
  inheritActions?: boolean;
  runtimeSessions?: readonly ArtifactRuntimeSession[];
  resourceEnvelopes?: readonly ClientResourceDataEnvelope[];
  runtimeTransport?: ArtifactRuntimeCommandTransport;
  locale?: string;
  timezone?: string;
};

export type ArtifactActionDispatchOptions = {
  brokered?: boolean;
};

export type ArtifactActionDispatcher = <TAction extends string>(
  action: TAction,
  ...args: TAction extends ArtifactActionName
    ? [payload: ArtifactActionPayload<TAction>, options?: ArtifactActionDispatchOptions]
    : [payload?: Record<string, unknown>, options?: ArtifactActionDispatchOptions]
) => void | Promise<void>;

export type ArtifactUIContextValue = {
  canDispatch: (artifact: ArtifactActionSource, action: string, options?: ArtifactActionDispatchOptions) => boolean;
  dispatch: (artifact: ArtifactActionSource, action: string, payload?: Record<string, unknown>, options?: ArtifactActionDispatchOptions) => void | Promise<void>;
  hasProvider: boolean;
  hasTransport: boolean;
  isLegacyActionBridge: boolean;
  slotClasses: ArtifactSlotClasses;
  themeName?: string;
  themeVariables: ArtifactThemeVariables;
  locale?: string;
  timezone?: string;
  hasRuntimeTransport: boolean;
  getRuntimeSession: (documentId: string, branchId: string) => ArtifactRuntimeSession | undefined;
  publishRuntimeSession: (session: ArtifactRuntimeSession) => boolean;
  getResourceBinding: (document: ArtifactDocument, resourceId: string) => ClientResourceBinding | undefined;
  publishResourceEnvelope: (envelope: ClientResourceDataEnvelope) => boolean;
  canDispatchRuntimeCommand: (command: ClientArtifactCommand) => boolean;
  dispatchRuntimeCommand: (command: ClientArtifactCommand) => Promise<ArtifactRuntimeDispatchResult>;
};

type ArtifactUIInternalContextValue = ArtifactUIContextValue & {
  inheritedOnAction?: ArtifactActionHandler;
  inheritedTransport?: ArtifactTransport;
  inheritedRuntimeTransport?: ArtifactRuntimeCommandTransport;
};

const defaultContext: ArtifactUIInternalContextValue = {
  canDispatch: () => false,
  dispatch: () => undefined,
  hasProvider: false,
  hasTransport: false,
  isLegacyActionBridge: false,
  slotClasses: {},
  themeVariables: {},
  hasRuntimeTransport: false,
  getRuntimeSession: () => undefined,
  publishRuntimeSession: () => false,
  getResourceBinding: () => undefined,
  publishResourceEnvelope: () => false,
  canDispatchRuntimeCommand: () => false,
  dispatchRuntimeCommand: async () => ({
    ok: false,
    diagnostic: runtimeDiagnostic("runtime.transport-unavailable", "No Artifact runtime command transport is configured."),
  }),
};

const ArtifactUIContext = createContext<ArtifactUIInternalContextValue>(defaultContext);
const EMPTY_RUNTIME_SESSIONS: readonly ArtifactRuntimeSession[] = Object.freeze([]);
const EMPTY_RESOURCE_ENVELOPES: readonly ClientResourceDataEnvelope[] = Object.freeze([]);

function isCommandTransport(transport: ArtifactTransport | undefined): transport is ArtifactCommandTransport {
  return typeof transport === "object" && transport !== null && typeof transport.dispatch === "function";
}

function createActionEvent(artifact: ArtifactActionSource, action: string, payload: Record<string, unknown>): ArtifactActionEvent {
  return {
    protocolVersion: "1.0",
    eventId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    action,
    payload,
    timestamp: new Date().toISOString(),
  };
}

export function ArtifactUIProvider({
  children,
  onAction,
  transport,
  theme,
  cssVariables,
  slotClasses,
  inheritActions = true,
  runtimeSessions = EMPTY_RUNTIME_SESSIONS,
  resourceEnvelopes = EMPTY_RESOURCE_ENVELOPES,
  runtimeTransport,
  locale,
  timezone,
}: ArtifactUIProviderProps) {
  const parent = useContext(ArtifactUIContext);
  const inheritedTransport = transport ?? (inheritActions ? parent.inheritedTransport : undefined);
  const inheritedOnAction = onAction ?? (inheritActions ? parent.inheritedOnAction : undefined);
  const themeConfig = typeof theme === "string" ? { name: theme } : theme;
  const [runtimeSessionStore] = useState(() => {
    const sessions = new Map<string, ArtifactRuntimeSession>();
    for (const session of runtimeSessions) {
      const parsed = parseRuntimeSession(session);
      if (parsed) sessions.set(runtimeSessionKey(parsed.snapshot.document.documentId, parsed.snapshot.branchHead.branchId), parsed);
    }
    return sessions;
  });
  const [runtimeStoreVersion, setRuntimeStoreVersion] = useState(0);
  const runtimePropKeys = useRef<Set<string>>(new Set());
  const [resourceStore] = useState(() => {
    const resources = new Map<string, ClientResourceDataEnvelope>();
    for (const envelope of resourceEnvelopes) {
      const parsed = clientResourceDataEnvelopeSchema.safeParse(envelope);
      if (parsed.success) resources.set(resourceEnvelopeKey(parsed.data), parsed.data);
    }
    return resources;
  });
  const [resourceStoreVersion, setResourceStoreVersion] = useState(0);
  const resourcePropKeys = useRef<Set<string>>(new Set());

  useEffect(() => {
    const next = new Map<string, ArtifactRuntimeSession>();
    for (const session of runtimeSessions) {
      const parsed = parseRuntimeSession(session);
      if (parsed) next.set(runtimeSessionKey(parsed.snapshot.document.documentId, parsed.snapshot.branchHead.branchId), parsed);
    }
    let changed = false;
    for (const key of runtimePropKeys.current) {
      if (!next.has(key)) changed = runtimeSessionStore.delete(key) || changed;
    }
    for (const [key, session] of next) {
      if (!sameJson(runtimeSessionStore.get(key), session)) {
        runtimeSessionStore.set(key, session);
        changed = true;
      }
    }
    runtimePropKeys.current = new Set(next.keys());
    if (changed) setRuntimeStoreVersion((version) => version + 1);
  }, [runtimeSessionStore, runtimeSessions]);

  useEffect(() => {
    const next = new Map<string, ClientResourceDataEnvelope>();
    for (const envelope of resourceEnvelopes) {
      const parsed = clientResourceDataEnvelopeSchema.safeParse(envelope);
      if (parsed.success) next.set(resourceEnvelopeKey(parsed.data), parsed.data);
    }
    let changed = false;
    for (const key of resourcePropKeys.current) {
      if (!next.has(key)) changed = resourceStore.delete(key) || changed;
    }
    for (const [key, envelope] of next) {
      if (!sameJson(resourceStore.get(key), envelope)) {
        resourceStore.set(key, envelope);
        changed = true;
      }
    }
    resourcePropKeys.current = new Set(next.keys());
    if (changed) setResourceStoreVersion((version) => version + 1);
  }, [resourceEnvelopes, resourceStore]);

  const value = useMemo<ArtifactUIInternalContextValue>(() => {
    const resolvedTransport = inheritedTransport;
    const resolvedOnAction = inheritedOnAction;
    const commandTransport = isCommandTransport(resolvedTransport) ? resolvedTransport : undefined;
    const transportHandler = typeof resolvedTransport === "function"
      ? resolvedTransport
      : commandTransport
        ? (event: ArtifactActionEvent) => commandTransport.dispatch(event)
        : undefined;
    const themeVariables = {
      ...parent.themeVariables,
      ...themeConfig?.variables,
      ...themeConfig?.cssVariables,
      ...cssVariables,
    };
    const resolvedSlotClasses = { ...parent.slotClasses, ...slotClasses };
    const resolvedRuntimeTransport = runtimeTransport ?? parent.inheritedRuntimeTransport;

    const canDispatch: ArtifactUIContextValue["canDispatch"] = (artifact, action, options = {}) => {
      const hasCommandChannel = Boolean(transportHandler || resolvedOnAction);
      if (!hasCommandChannel) return false;
      if (options.brokered && !transportHandler && !resolvedOnAction) return false;
      return commandTransport?.canDispatch?.({
        action,
        artifactId: artifact.id,
        artifactKind: artifact.kind,
        brokered: options.brokered ?? false,
      }) ?? true;
    };

    const dispatch: ArtifactUIContextValue["dispatch"] = async (artifact, action, payload = {}, options = {}) => {
      if (!canDispatch(artifact, action, options)) return;
      let event = createActionEvent(artifact, action, payload);
      if (Object.prototype.hasOwnProperty.call(artifactActionContracts, action)) {
        const parsed = safeParseBuiltInArtifactActionEvent(event);
        if (!parsed.success) throw parsed.error;
        event = parsed.data;
      } else {
        const parsed = artifactActionEventSchema.safeParse(event);
        if (!parsed.success) throw parsed.error;
        event = parsed.data;
      }
      if (transportHandler) await transportHandler(event);
      if (resolvedOnAction && resolvedOnAction !== transportHandler) await resolvedOnAction(event);
    };

    const getRuntimeSession: ArtifactUIContextValue["getRuntimeSession"] = (documentId, branchId) => (
      runtimeSessionStore.get(runtimeSessionKey(documentId, branchId))
      ?? parent.getRuntimeSession(documentId, branchId)
    );

    const publishRuntimeSession: ArtifactUIContextValue["publishRuntimeSession"] = (session) => {
      const parsed = parseRuntimeSession(session);
      if (!parsed) return false;
      const key = runtimeSessionKey(parsed.snapshot.document.documentId, parsed.snapshot.branchHead.branchId);
      if (sameJson(runtimeSessionStore.get(key), parsed)) return true;
      runtimeSessionStore.set(key, parsed);
      setRuntimeStoreVersion((version) => version + 1);
      return true;
    };

    const getResourceBinding: ArtifactUIContextValue["getResourceBinding"] = (document, resourceId) => {
      const reference = document.resources[resourceId];
      if (!reference) return undefined;
      const key = resourceBindingKey(
        document.documentId,
        document.revision.branchId,
        document.revision.revisionId,
        resourceId,
      );
      const envelope = resourceStore.get(key);
      if (!envelope) return parent.getResourceBinding(document, resourceId);
      if (envelope.type !== "resource-data") return undefined;
      const { binding } = envelope;
      if (
        envelope.contractFingerprint !== document.revision.contractFingerprint
        || binding.resourceId !== resourceId
        || binding.requestId !== envelope.requestId
        || binding.schemaVersion !== reference.schemaVersion
        || binding.schemaHash !== reference.schemaHash
        || binding.contentHash !== reference.contentHash
        || binding.codec.id !== reference.codec.id
        || binding.codec.version !== reference.codec.version
        || binding.mediaType !== reference.mediaType
        || (binding.expiresAt !== undefined && Date.parse(binding.expiresAt) <= Date.now())
      ) return undefined;
      return binding;
    };

    const publishResourceEnvelope: ArtifactUIContextValue["publishResourceEnvelope"] = (input) => {
      const parsed = clientResourceDataEnvelopeSchema.safeParse(input);
      if (!parsed.success) return false;
      const envelope = parsed.data;
      if (
        envelope.type === "resource-data"
        && (
          envelope.binding.requestId !== envelope.requestId
          || envelope.binding.resourceId !== envelope.resourceId
        )
      ) return false;
      const key = resourceEnvelopeKey(envelope);
      if (sameJson(resourceStore.get(key), envelope)) return true;
      resourceStore.set(key, envelope);
      setResourceStoreVersion((version) => version + 1);
      return true;
    };

    const canDispatchRuntimeCommand: ArtifactUIContextValue["canDispatchRuntimeCommand"] = (command) => {
      const parsed = clientArtifactCommandSchema.safeParse(command);
      if (!parsed.success || !resolvedRuntimeTransport) return false;
      return resolvedRuntimeTransport.canDispatch?.(runtimeAvailability(parsed.data)) ?? true;
    };

    const dispatchRuntimeCommand: ArtifactUIContextValue["dispatchRuntimeCommand"] = async (command) => {
      const parsed = clientArtifactCommandSchema.safeParse(command);
      if (!parsed.success) {
        return {
          ok: false,
          diagnostic: runtimeDiagnostic("runtime.command-invalid", parsed.error.issues[0]?.message ?? "Runtime command is invalid."),
        };
      }
      if (!resolvedRuntimeTransport || !canDispatchRuntimeCommand(parsed.data)) {
        return {
          ok: false,
          diagnostic: runtimeDiagnostic(
            "runtime.transport-unavailable",
            "External Artifact actions fail closed without an authorized runtime transport.",
          ),
        };
      }
      try {
        await resolvedRuntimeTransport.dispatch(parsed.data);
        return { ok: true };
      } catch {
        return {
          ok: false,
          diagnostic: runtimeDiagnostic(
            "runtime.transport-failed",
            "The Artifact runtime command transport failed.",
          ),
        };
      }
    };

    return {
      canDispatch,
      dispatch,
      hasProvider: true,
      hasTransport: Boolean(transportHandler),
      inheritedOnAction: resolvedOnAction,
      inheritedTransport: resolvedTransport,
      inheritedRuntimeTransport: resolvedRuntimeTransport,
      isLegacyActionBridge: Boolean(resolvedOnAction && !transportHandler),
      slotClasses: resolvedSlotClasses,
      themeName: themeConfig?.name ?? parent.themeName,
      themeVariables,
      locale: locale ?? parent.locale,
      timezone: timezone ?? parent.timezone,
      hasRuntimeTransport: Boolean(resolvedRuntimeTransport),
      getRuntimeSession,
      publishRuntimeSession,
      getResourceBinding,
      publishResourceEnvelope,
      canDispatchRuntimeCommand,
      dispatchRuntimeCommand,
    };
  }, [
    cssVariables,
    inheritedOnAction,
    inheritedTransport,
    locale,
    parent,
    resourceStore,
    resourceStoreVersion,
    runtimeSessionStore,
    runtimeStoreVersion,
    runtimeTransport,
    slotClasses,
    themeConfig,
    timezone,
  ]);

  return (
    <ArtifactUIContext.Provider value={value}>
      <div className="de-theme" data-theme={value.themeName} style={value.themeVariables}>
        {children}
      </div>
    </ArtifactUIContext.Provider>
  );
}

export function DataElementsProvider(props: ArtifactUIProviderProps) {
  return <ArtifactUIProvider {...props} />;
}

export function useArtifactUI(): ArtifactUIContextValue {
  return useContext(ArtifactUIContext);
}

export function useArtifactRuntimeSession(documentId: string, branchId: string): ArtifactRuntimeSession | undefined {
  return useContext(ArtifactUIContext).getRuntimeSession(documentId, branchId);
}

export function useArtifactResourceBinding(
  document: ArtifactDocument,
  resourceId: string,
): ClientResourceBinding | undefined {
  return useContext(ArtifactUIContext).getResourceBinding(document, resourceId);
}

export function useArtifactSlotClass(slot: ArtifactSlotName | (string & {})): string | undefined {
  return useContext(ArtifactUIContext).slotClasses[slot];
}

export function useArtifactActionAvailability(artifact: ArtifactActionSource, action: string, options: ArtifactActionDispatchOptions = {}): boolean {
  const context = useContext(ArtifactUIContext);
  return context.canDispatch(artifact, action, options);
}

export function useArtifactAction(artifact: ArtifactActionSource) {
  const context = useContext(ArtifactUIContext);

  const dispatch = useCallback((action: string, payload: Record<string, unknown> = {}, options: ArtifactActionDispatchOptions = {}) => (
    context.dispatch(artifact, action, payload, options)
  ), [artifact.id, artifact.kind, context]);
  return dispatch as ArtifactActionDispatcher;
}

function parseRuntimeSession(session: ArtifactRuntimeSession): ArtifactRuntimeSession | undefined {
  const snapshot = runtimeSnapshotSchema.safeParse(session.snapshot);
  if (!snapshot.success || !session.streamId) return undefined;
  if (
    snapshot.data.branchHead.branchId !== snapshot.data.document.revision.branchId
    || snapshot.data.branchHead.revisionId !== snapshot.data.document.revision.revisionId
  ) return undefined;
  return { streamId: session.streamId, snapshot: snapshot.data };
}

function runtimeSessionKey(documentId: string, branchId: string): string {
  return `${documentId}\u0000${branchId}`;
}

function resourceBindingKey(documentId: string, branchId: string, revisionId: string, resourceId: string): string {
  return `${documentId}\u0000${branchId}\u0000${revisionId}\u0000${resourceId}`;
}

function resourceEnvelopeKey(envelope: ClientResourceDataEnvelope): string {
  return resourceBindingKey(envelope.documentId, envelope.branchId, envelope.revisionId, envelope.resourceId);
}

function runtimeAvailability(command: ClientArtifactCommand): ArtifactRuntimeCommandAvailability {
  const payload = command.payload;
  return {
    type: payload.type,
    streamId: command.streamId,
    ...("documentId" in payload ? { documentId: payload.documentId } : {}),
    ...("branchId" in payload ? { branchId: payload.branchId } : {}),
    ...("revisionId" in payload ? { revisionId: payload.revisionId } : {}),
  };
}

function runtimeDiagnostic(code: string, message: string): Diagnostic {
  return {
    phase: "effect",
    code,
    severity: "error",
    recoverable: true,
    modelCorrectable: false,
    message,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
}
