import type {
  EffectCancellationReceipt,
  EffectExecutionResult,
  ModelVisibleGrantSet,
} from "@open-tessera/capabilities";
import type {
  DatabaseCompiledMutation,
  DatabaseMutationAction,
  DatabaseMutationResult,
} from "@open-tessera/database";
import type { TesseraUIMessage } from "../../protocol";
import type { OpenGenerativeThemePresetId } from "../../open-generative-theme-preset";
import {
  surfaceEventEnvelopeSchema,
  type HostCommandEnvelope,
  type SurfaceEventEnvelope,
} from "@open-generative/protocol";

export type StudioThreadSummary = Readonly<{
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}>;

export type DatabaseDialect = "postgres" | "mysql" | "sqlite" | "turso" | "mongodb";

export type StudioConnection = Readonly<{
  connected: boolean;
  credentialCanWrite?: boolean;
  databaseName?: string;
  dialect: DatabaseDialect;
  latencyMs?: number;
  readOnlyTransactions: boolean;
  serverVersion?: string;
  warnings: string[];
}>;

export type StudioCatalogColumn = Readonly<{
  dataType: string;
  name: string;
  nullable: boolean;
  ordinal?: number;
}>;

export type StudioCatalogForeignKey = Readonly<{
  columns: string[];
  name: string;
  referencedColumns: string[];
  referencedSchema: string;
  referencedTable: string;
}>;

export type StudioCatalogTable = Readonly<{
  columns: StudioCatalogColumn[];
  estimatedRows?: number;
  foreignKeys?: StudioCatalogForeignKey[];
  kind: string;
  name: string;
  primaryKey?: string[];
  schema: string;
}>;

export type StudioCatalog = Readonly<{
  connectionRef: string;
  databaseName: string;
  dialect: DatabaseDialect;
  fingerprint: string;
  scannedAt: string;
  schemas: Array<{ name: string; tables: StudioCatalogTable[] }>;
}>;

export type StudioMeta = Readonly<{
  protocolVersion: number;
  capabilities: Readonly<{ chat: boolean }>;
  generativeUi: Readonly<{
    themePreset: OpenGenerativeThemePresetId;
    inspectorEnabled: boolean;
    hostDeployment: "demo" | "production" | null;
  }>;
}>;

export type StudioOpenGenerativeInspectionObject = Readonly<Record<string, unknown>>;

export type StudioOpenGenerativeInspection = Readonly<{
  authority: Readonly<{
    actorBindingHash: string;
    tenantBindingHash: string;
    authorityPolicyRevision: string;
  }>;
  snapshot: Readonly<{
    version: 2;
    surfaceSessionId: string;
    ogl: StudioOpenGenerativeInspectionObject & Readonly<{
      source?: string;
      ast?: readonly unknown[];
    }>;
    catalog: StudioOpenGenerativeInspectionObject;
    resourceAuthorizations: readonly StudioOpenGenerativeInspectionObject[];
    events: readonly StudioOpenGenerativeInspectionObject[];
    receipts: readonly StudioOpenGenerativeInspectionObject[];
    rejections: readonly StudioOpenGenerativeInspectionObject[];
  }>;
}>;

export type StudioSettingsStatus = Readonly<{
  database: Readonly<{ urlConfigured: boolean }>;
  llm: Readonly<{
    provider: string;
    apiKeyConfigured: boolean;
    apiKeySource: "explicit" | "environment" | "none";
  }>;
}>;

/**
 * Browser-facing typed mutation contract. Read actions continue through the
 * existing Data Agent APIs; the database-actions transport only accepts this
 * mutation union and never accepts raw SQL.
 */
export type StudioDatabaseAction = DatabaseMutationAction;

export type StudioDatabaseActionResult = DatabaseMutationResult & Readonly<{
  actionHash: `sha256:${string}`;
  catalogFingerprint: `sha256:${string}`;
}>;

export type StudioDatabaseActionReview = Readonly<{
  action: StudioDatabaseAction;
  purpose: string;
  compiled?: DatabaseCompiledMutation;
}>;

export type StudioDatabaseActionEffect = EffectExecutionResult & Readonly<{
  result?: StudioDatabaseActionResult;
  review?: StudioDatabaseActionReview;
}>;

export type StudioDatabaseActionCapabilities = ModelVisibleGrantSet;

export type StudioDatabaseActionSubmitInput = Readonly<{
  action: StudioDatabaseAction;
  purpose: string;
  /** Can tighten policy for a retry, but can never bypass required approval. */
  requireApproval?: boolean;
  /** Stable request identity makes retries replay-safe. */
  requestId?: string;
  invocationId?: string;
  stepId?: string;
  actionId?: string;
  idempotencyKey?: string;
}>;

export type StudioDatabaseActionApprovalInput = Readonly<{
  checkpointId: string;
  decision: "approve" | "reject";
}>;

export type StudioDatabaseActionCancelInput = Readonly<{
  cancelRequestId?: string;
}>;

type ApiError = { error?: { message?: string } };

type RequestJsonOptions = Readonly<{
  acceptedStatuses?: readonly number[];
}>;

export async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit, options: RequestJsonOptions = {}): Promise<T> {
  const response = await fetch(input, init);
  const body = await response.json().catch(() => undefined) as ApiError | T | undefined;
  if (!response.ok && !options.acceptedStatuses?.includes(response.status)) {
    const message = body && typeof body === "object" && "error" in body ? body.error?.message : undefined;
    throw new Error(message || "Tessera could not complete this request.");
  }
  return body as T;
}

/** Dispatches a governed Surface command without starting another Agent turn. */
export async function dispatchStudioOpenGenerativeCommand(
  command: HostCommandEnvelope,
  signal?: AbortSignal,
): Promise<readonly SurfaceEventEnvelope[]> {
  const body = await requestJson<unknown>("/api/open-generative/commands", {
    body: JSON.stringify(command),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal,
  });
  const result = asRecord(body);
  if (result?.status === "events") {
    return surfaceEventEnvelopeSchema.array().parse(result.events);
  }
  if (result?.status === "acknowledged") return [];
  if (result?.status === "snapshot-required") {
    const reason = readPublicText(result.reason, 128) ?? "snapshot-required";
    throw new Error(`The Surface must be reloaded (${reason}).`);
  }
  throw new Error("The Surface command response is invalid.");
}

/** Reads a server-authorized Inspector snapshot without starting an Agent turn. */
export async function fetchStudioOpenGenerativeInspection(
  surfaceSessionId: string,
  signal?: AbortSignal,
): Promise<StudioOpenGenerativeInspection> {
  const normalizedSessionId = readStudioSurfaceSessionId(surfaceSessionId);
  if (normalizedSessionId !== surfaceSessionId) throw new Error("surface_session_id_invalid");
  const body = await requestJson<unknown>(
    `/api/open-generative/inspections/${encodeURIComponent(normalizedSessionId)}`,
    { headers: { Accept: "application/json" }, signal },
  );
  return readStudioOpenGenerativeInspection(body, normalizedSessionId);
}

export async function fetchStudioConnection(signal?: AbortSignal): Promise<StudioConnection> {
  return (await requestJson<{ connection: StudioConnection }>("/api/connection", { signal })).connection;
}

export async function fetchStudioCatalog(options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<StudioCatalog> {
  const search = options.refresh ? "?refresh=1" : "";
  return (await requestJson<{ catalog: StudioCatalog }>(`/api/catalog${search}`, { signal: options.signal })).catalog;
}

export function fetchStudioDatabaseActionCapabilities(signal?: AbortSignal): Promise<StudioDatabaseActionCapabilities> {
  return requestJson<StudioDatabaseActionCapabilities>("/api/database-actions/capabilities", { signal });
}

export function submitStudioDatabaseAction(
  input: StudioDatabaseActionSubmitInput,
  signal?: AbortSignal,
): Promise<StudioDatabaseActionEffect> {
  return requestJson<StudioDatabaseActionEffect>("/api/database-actions", {
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal,
  }, { acceptedStatuses: [202] });
}

export function fetchStudioDatabaseAction(
  requestId: string,
  signal?: AbortSignal,
): Promise<StudioDatabaseActionEffect> {
  return requestJson<StudioDatabaseActionEffect>(
    `/api/database-actions/${encodeURIComponent(requestId)}`,
    { signal },
  );
}

export function retryStudioDatabaseAction(
  requestId: string,
  signal?: AbortSignal,
): Promise<StudioDatabaseActionEffect> {
  return requestJson<StudioDatabaseActionEffect>(
    `/api/database-actions/${encodeURIComponent(requestId)}/retry`,
    { method: "POST", signal },
    { acceptedStatuses: [202] },
  );
}

export function respondToStudioDatabaseActionApproval(
  requestId: string,
  input: StudioDatabaseActionApprovalInput,
  signal?: AbortSignal,
): Promise<StudioDatabaseActionEffect> {
  return requestJson<StudioDatabaseActionEffect>(
    `/api/database-actions/${encodeURIComponent(requestId)}/approval`,
    {
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal,
    },
  );
}

export function approveStudioDatabaseAction(
  requestId: string,
  checkpointId: string,
  signal?: AbortSignal,
): Promise<StudioDatabaseActionEffect> {
  return respondToStudioDatabaseActionApproval(requestId, { checkpointId, decision: "approve" }, signal);
}

export function rejectStudioDatabaseAction(
  requestId: string,
  checkpointId: string,
  signal?: AbortSignal,
): Promise<StudioDatabaseActionEffect> {
  return respondToStudioDatabaseActionApproval(requestId, { checkpointId, decision: "reject" }, signal);
}

export function cancelStudioDatabaseAction(
  requestId: string,
  input: StudioDatabaseActionCancelInput = {},
  signal?: AbortSignal,
): Promise<EffectCancellationReceipt> {
  return requestJson<EffectCancellationReceipt>(
    `/api/database-actions/${encodeURIComponent(requestId)}/cancel`,
    {
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal,
    },
  );
}

export function fetchStudioMeta(signal?: AbortSignal): Promise<StudioMeta> {
  return requestJson<StudioMeta>("/api/meta", { signal });
}

export async function fetchStudioThreads(signal?: AbortSignal): Promise<readonly StudioThreadSummary[]> {
  return readThreadList(await requestJson<unknown>("/api/threads", { signal }));
}

export async function createStudioThread(signal?: AbortSignal): Promise<StudioThreadSummary> {
  const body = await requestJson<unknown>("/api/threads", {
    body: "{}",
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal,
  });
  const thread = readThreadSummary(body);
  if (!thread) throw new Error("thread_create_response_invalid");
  return thread;
}

export async function renameStudioThread(threadId: string, title: string): Promise<StudioThreadSummary> {
  const body = await requestJson<unknown>(`/api/threads/${encodeURIComponent(threadId)}`, {
    body: JSON.stringify({ title }),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  const thread = readThreadSummary(body);
  if (!thread) throw new Error("thread_rename_response_invalid");
  return thread;
}

export function deleteStudioThread(threadId: string): Promise<unknown> {
  return requestJson<unknown>(`/api/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
}

export async function clearStudioThreads(): Promise<number> {
  const body = await requestJson<unknown>("/api/threads", { method: "DELETE" });
  const deletedCount = asRecord(body)?.deletedCount;
  if (!Number.isSafeInteger(deletedCount) || (deletedCount as number) < 0) {
    throw new Error("thread_clear_response_invalid");
  }
  return deletedCount as number;
}

export async function fetchStudioThreadMessages(threadId: string, signal?: AbortSignal): Promise<readonly TesseraUIMessage[]> {
  const body = await requestJson<unknown>(`/api/threads/${encodeURIComponent(threadId)}/messages`, { signal });
  return readPublicUiMessages(body);
}

export async function fetchStudioSettingsStatus(signal?: AbortSignal): Promise<StudioSettingsStatus> {
  const body = await requestJson<unknown>("/api/settings", {
    headers: { Accept: "application/json" },
    signal,
  });
  const settings = asRecord(asRecord(body)?.settings);
  const database = asRecord(settings?.database);
  const llm = asRecord(settings?.llm);
  const databaseConfigured = database?.urlConfigured;
  const provider = llm?.provider;
  const apiKeyConfigured = llm?.apiKeyConfigured;
  const apiKeySource = readApiKeySource(llm?.apiKeySource);
  if (
    typeof databaseConfigured !== "boolean"
    || typeof provider !== "string"
    || typeof apiKeyConfigured !== "boolean"
    || apiKeySource === undefined
  ) {
    throw new Error("settings_response_invalid");
  }
  return {
    database: { urlConfigured: databaseConfigured },
    llm: { provider, apiKeyConfigured, apiKeySource },
  };
}

function readApiKeySource(value: unknown): StudioSettingsStatus["llm"]["apiKeySource"] | undefined {
  return value === "explicit" || value === "environment" || value === "none" ? value : undefined;
}

export function publicError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Tessera could not load this information.";
}

function readThreadList(value: unknown): readonly StudioThreadSummary[] {
  const threads = asRecord(value)?.threads;
  if (!Array.isArray(threads) || threads.length > 200) throw new Error("thread_list_response_invalid");

  const seen = new Set<string>();
  const result: StudioThreadSummary[] = [];
  for (const item of threads) {
    const thread = readThreadSummary(item);
    if (!thread || seen.has(thread.id)) continue;
    seen.add(thread.id);
    result.push(thread);
  }
  return result;
}

function readThreadSummary(value: unknown): StudioThreadSummary | undefined {
  const root = asRecord(value);
  const thread = asRecord(root?.thread) ?? root;
  const id = readStudioThreadId(thread?.id);
  if (!id) return undefined;
  return {
    id,
    title: readPublicText(thread?.title, 160) ?? "New analysis",
    createdAt: readPublicText(thread?.createdAt, 64) ?? "",
    updatedAt: readPublicText(thread?.updatedAt, 64) ?? "",
  };
}

function readPublicUiMessages(value: unknown): readonly TesseraUIMessage[] {
  const messages = asRecord(value)?.messages;
  if (!Array.isArray(messages) || messages.length > 256) throw new Error("thread_messages_response_invalid");

  const result: TesseraUIMessage[] = [];
  for (const message of messages) {
    const source = asRecord(message);
    const id = readPublicText(source?.id, 256);
    const role = source?.role;
    const parts = source?.parts;
    if (!id || (role !== "user" && role !== "assistant") || !Array.isArray(parts) || parts.length > 128) {
      throw new Error("thread_message_invalid");
    }
    result.push({ id, role, parts } as TesseraUIMessage);
  }
  return result;
}

function readStudioThreadId(value: unknown): string | undefined {
  const id = readPublicText(value, 128);
  return id && /^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(id) ? id : undefined;
}

function readStudioOpenGenerativeInspection(
  value: unknown,
  expectedSurfaceSessionId: string,
): StudioOpenGenerativeInspection {
  const root = asRecord(value);
  const authority = asRecord(root?.authority);
  const snapshot = asRecord(root?.snapshot);
  const ogl = asRecord(snapshot?.ogl);
  const catalog = asRecord(snapshot?.catalog);
  const actorBindingHash = readPublicText(authority?.actorBindingHash, 256);
  const tenantBindingHash = readPublicText(authority?.tenantBindingHash, 256);
  const authorityPolicyRevision = readPublicText(authority?.authorityPolicyRevision, 256);
  const surfaceSessionId = readStudioSurfaceSessionId(snapshot?.surfaceSessionId);
  const resourceAuthorizations = readInspectionObjectArray(snapshot?.resourceAuthorizations);
  const events = readInspectionObjectArray(snapshot?.events);
  const receipts = readInspectionObjectArray(snapshot?.receipts);
  const rejections = readInspectionObjectArray(snapshot?.rejections);
  const source = ogl?.source;
  const ast = ogl?.ast;
  if (
    snapshot?.version !== 2
    || surfaceSessionId !== expectedSurfaceSessionId
    || !actorBindingHash
    || !tenantBindingHash
    || !authorityPolicyRevision
    || !ogl
    || !catalog
    || resourceAuthorizations === undefined
    || events === undefined
    || receipts === undefined
    || rejections === undefined
    || (source !== undefined && (typeof source !== "string" || source.length > 96_000))
    || (ast !== undefined && (!Array.isArray(ast) || ast.length > 1_024))
  ) {
    throw new Error("open_generative_inspection_response_invalid");
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 2_000_000) throw new Error("open_generative_inspection_response_too_large");
  return Object.freeze({
    authority: Object.freeze({ actorBindingHash, tenantBindingHash, authorityPolicyRevision }),
    snapshot: Object.freeze({
      version: 2,
      surfaceSessionId,
      ogl: Object.freeze({
        ...ogl,
        ...(source === undefined ? {} : { source }),
        ...(ast === undefined ? {} : { ast: Object.freeze([...ast]) }),
      }),
      catalog: Object.freeze({ ...catalog }),
      resourceAuthorizations,
      events,
      receipts,
      rejections,
    }),
  });
}

function readInspectionObjectArray(value: unknown): readonly StudioOpenGenerativeInspectionObject[] | undefined {
  if (!Array.isArray(value) || value.length > 10_000) return undefined;
  const records = value.map(asRecord);
  return records.every((record): record is Record<string, unknown> => record !== undefined)
    ? Object.freeze(records.map((record) => Object.freeze({ ...record })))
    : undefined;
}

function readStudioSurfaceSessionId(value: unknown): string | undefined {
  const id = readPublicText(value, 256);
  return id && /^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(id) ? id : undefined;
}

function readPublicText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximum && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
