import {
  DATA_AGENT_VERSION,
  analysisDraftSchema,
  DataAgentError,
  type AnalysisDraft,
  type AnalysisPredicate,
  type DataAgent,
  type DataAgentErrorCode,
  type PlanningCapability,
  type SemanticCatalog,
} from "@open-tessera/data-agent";
import { z } from "zod";
import {
  modelAnalysisFilterSchema,
  modelAnalysisToolInputSchema,
  type DiscoveryBlocked,
  type PrepareAnalysisRejected,
} from "./model-contracts";
import { containsRawSqlStatement, containsSensitiveText } from "./safety";

export type PlanningCatalogScope = Readonly<{
  capability: PlanningCapability;
  catalog: SemanticCatalog;
  /** The source determines whether candidate discovery is complete enough. */
  discovery?: "context" | "inspect" | "describe";
  /** A partial scope cannot authorize a final plan on its own. */
  truncated?: boolean;
  omitted?: Readonly<{
    entities: number;
    fields: number;
    metrics: number;
    relationships: number;
  }>;
}>;

export type InvalidAnalysisInputState = {
  rejectedInvalidAnalysisInputs: number;
};

export type DiscoveryScopeState = Readonly<{
  planningScopes: readonly PlanningCatalogScope[];
}>;

type PlanningIdentifierRequirements = Readonly<{
  entityIds: ReadonlySet<string>;
  fieldIds: ReadonlySet<string>;
  metricIds: ReadonlySet<string>;
  relationshipIds: ReadonlySet<string>;
}>;

/** Converts the compact provider wire format into the compiler's strict AST. */
export function normalizeAnalysisToolDraft(
  input: z.input<typeof modelAnalysisToolInputSchema>,
): AnalysisDraft {
  const parsed = modelAnalysisToolInputSchema.parse(input);
  const filter = parsed.filter === undefined ? undefined : normalizeModelFilter(parsed.filter);
  const common = {
    version: DATA_AGENT_VERSION,
    ...(parsed.title === undefined ? {} : { title: parsed.title }),
    ...(parsed.description === undefined ? {} : { description: parsed.description }),
    primaryEntityId: parsed.primaryEntityId,
    relationshipIds: parsed.relationshipIds,
    limit: parsed.limit,
    ...(filter === undefined ? {} : { filter }),
  };

  if (parsed.mode === "records") {
    return analysisDraftSchema.parse({
      ...common,
      mode: "records",
      fields: parsed.fields?.map((fieldId, index) => ({
        fieldId,
        outputId: generatedOutputId("field", index),
      })),
      orderBy: parsed.recordOrderBy,
    });
  }

  const dimensions = (parsed.dimensions ?? []).map((dimension, index) =>
    dimension.grain === undefined
      ? {
          kind: "field" as const,
          fieldId: dimension.fieldId,
          outputId: generatedOutputId("dimension", index),
        }
      : {
          kind: "time" as const,
          fieldId: dimension.fieldId,
          grain: dimension.grain,
          outputId: generatedOutputId("dimension", index),
        }
  );
  const measures = (parsed.measures ?? []).map((measure, index) =>
    measure.kind === "metric"
      ? {
          kind: "metric" as const,
          ...(measure.metricId === undefined ? {} : { metricId: measure.metricId }),
          outputId: generatedOutputId("measure", index),
        }
      : {
          kind: "aggregate" as const,
          ...(measure.aggregate === undefined ? {} : { aggregate: measure.aggregate }),
          ...(measure.fieldId === undefined ? {} : { fieldId: measure.fieldId }),
          outputId: generatedOutputId("measure", index),
        }
  );
  const orderBy = (parsed.aggregateOrderBy ?? []).map((order) => {
    const target = order.by === "dimension" ? dimensions[order.index] : measures[order.index];
    if (target === undefined) {
      throw new TypeError(
        "An aggregate order target must reference an included dimension or measure.",
      );
    }
    return { outputId: target.outputId, direction: order.direction };
  });
  return analysisDraftSchema.parse({
    ...common,
    mode: "aggregate",
    measures,
    dimensions,
    orderBy,
    output: parsed.output,
  });
}

/** Chooses the narrowest already-inspected scopes that authorize a draft. */
export function selectPlanningCapabilityScopes(
  scopes: readonly PlanningCatalogScope[],
  draft: AnalysisDraft,
): readonly PlanningCatalogScope[] | undefined {
  return selectPlanningCapabilityScopesForRequirements(
    scopes,
    planningIdentifierRequirements(draft),
  );
}

export async function planningCapabilityForDraft(
  dataAgent: DataAgent,
  scopes: readonly PlanningCatalogScope[],
  draft: AnalysisDraft,
  signal: AbortSignal,
): Promise<PlanningCapability | undefined> {
  return planningCapabilityForRequirements(
    dataAgent,
    scopes,
    planningIdentifierRequirements(draft),
    signal,
  );
}

export async function planningCapabilityForEntityIds(
  dataAgent: DataAgent,
  scopes: readonly PlanningCatalogScope[],
  entityIds: readonly string[],
  signal: AbortSignal,
): Promise<PlanningCapability | undefined> {
  const required = emptyPlanningIdentifierRequirements();
  for (const entityId of entityIds) required.entityIds.add(entityId);
  return planningCapabilityForRequirements(dataAgent, scopes, required, signal);
}

/**
 * Global omission is normal for a large database. Require expansion only when
 * the current inspect slice still contains an ungrounded candidate entity.
 */
export function planningScopesRequireDiscovery(
  scopes: readonly PlanningCatalogScope[],
  draft: AnalysisDraft,
): boolean {
  if (scopes.length === 0 || scopes.every((scope) => scope.discovery === "describe")) {
    return false;
  }
  const candidateEntityIds = new Set(
    scopes.flatMap((scope) => scope.catalog.entities.map((entity) => entity.id)),
  );
  if (candidateEntityIds.size <= 1) return false;

  const required = planningIdentifierRequirements(draft);
  const groundedEntityIds = new Set(required.entityIds);
  for (const scope of scopes) {
    for (const entity of scope.catalog.entities) {
      if (entity.fields.some((field) => required.fieldIds.has(field.id))
        || entity.metrics.some((metric) => required.metricIds.has(metric.id))) {
        groundedEntityIds.add(entity.id);
      }
    }
    for (const relationship of scope.catalog.relationships) {
      if (required.relationshipIds.has(relationship.id)) {
        groundedEntityIds.add(relationship.fromEntityId);
        groundedEntityIds.add(relationship.toEntityId);
      }
    }
  }
  for (const entityId of candidateEntityIds) {
    if (!groundedEntityIds.has(entityId)) return true;
  }
  return false;
}

export function analysisPlanFingerprint(draft: AnalysisDraft): string {
  // Zod parsing produces deterministic key order. This fingerprint is only
  // used inside one turn to reject exact plan replays.
  return JSON.stringify(draft);
}

export function invalidAnalysisInputRejection(
  state: InvalidAnalysisInputState,
): PrepareAnalysisRejected {
  state.rejectedInvalidAnalysisInputs += 1;
  return state.rejectedInvalidAnalysisInputs === 1
    ? {
        status: "rejected",
        reason: "invalid_plan",
        message: "The analysis input did not match the tool schema. Provide a complete semantic draft using identifiers copied from a completed search_data_context result.",
        nextAction: "revise_plan",
      }
    : {
        status: "rejected",
        reason: "duplicate_plan",
        message: "The same invalid analysis input was already rejected in this turn. Do not replay it unchanged.",
        nextAction: "respond",
      };
}

export function incompleteCatalogRejection(): PrepareAnalysisRejected {
  return {
    status: "rejected",
    reason: "catalog_incomplete",
    message: "The current catalog scope contains multiple plausible entities, so the analysis cannot be authorized without expanding the catalog or clarifying which entity the user means.",
    nextAction: "describe_or_clarify",
  };
}

/** Maps recoverable compiler/runtime failures to a bounded model correction. */
export function analysisToolRejection(error: unknown): PrepareAnalysisRejected {
  const dataAgentErrorCode = readDataAgentErrorCode(error);
  if (dataAgentErrorCode !== undefined) {
    if (dataAgentErrorCode === "catalog_stale") {
      return {
        status: "rejected",
        reason: "catalog_changed",
        message: analysisDiagnostic(
          error,
          "The database catalog changed while this analysis was being planned. Refresh the catalog and retry with the new identifiers.",
        ),
        nextAction: "search_data_context",
      };
    }
    if (dataAgentErrorCode === "invalid_analysis_spec"
      || dataAgentErrorCode === "compile_failed"
      || dataAgentErrorCode === "query_limit_exceeded") {
      return {
        status: "rejected",
        reason: "invalid_plan",
        message: analysisDiagnostic(
          error,
          "The analysis plan was rejected by server-side validation. Check the identifiers, required ordering, filters, and limits, then revise the plan.",
        ),
        nextAction: "revise_plan",
      };
    }
  }
  if (error instanceof z.ZodError || error instanceof TypeError) {
    return {
      status: "rejected",
      reason: "invalid_plan",
      message: analysisDiagnostic(
        error,
        "The analysis input failed server-side validation. Provide a complete semantic draft using identifiers from the current catalog.",
      ),
      nextAction: "revise_plan",
    };
  }
  return {
    status: "rejected",
    reason: "data_unavailable",
    message: analysisDiagnostic(
      error,
      "The database did not return a usable result for this analysis. Check the connection and the reported database diagnostic before retrying.",
    ),
    nextAction: "respond",
  };
}

export function discoveryToolRejection(error: unknown): DiscoveryBlocked {
  const message = safeToolResultMessage(error);
  const code = readDataAgentErrorCode(error);
  if (code !== undefined) {
    if (code === "catalog_stale") {
      return {
        status: "blocked",
        reason: "catalog_changed",
        message,
        nextAction: "search_data_context",
      };
    }
    if (code === "invalid_analysis_spec"
      || code === "compile_failed"
      || code === "query_limit_exceeded") {
      return {
        status: "blocked",
        reason: "invalid_request",
        message,
        nextAction: "describe_or_clarify",
      };
    }
  }
  return {
    status: "blocked",
    reason: "data_unavailable",
    message,
    nextAction: "respond",
  };
}

export function discoveryScopeRejection(state: DiscoveryScopeState): DiscoveryBlocked {
  return state.planningScopes.length === 0
    ? {
        status: "blocked",
        reason: "catalog_changed",
        message: "No current catalog scope can authorize this entity lookup. Run a new catalog search before retrying.",
        nextAction: "search_data_context",
      }
    : {
        status: "blocked",
        reason: "invalid_request",
        message: "The requested entity ids were not returned by the current catalog scope. Use ids from a completed search_data_context result or clarify the request.",
        nextAction: "describe_or_clarify",
      };
}

function selectPlanningCapabilityScopesForRequirements(
  scopes: readonly PlanningCatalogScope[],
  required: PlanningIdentifierRequirements,
): readonly PlanningCatalogScope[] | undefined {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const scope = scopes[index]!;
    if (planningScopeCovers(scope, required)) return [scope];
  }

  const selected: PlanningCatalogScope[] = [];
  const available = emptyPlanningIdentifierRequirements();
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const scope = scopes[index]!;
    if (!planningScopeContributes(scope, required)) continue;
    selected.push(scope);
    addPlanningCatalogIdentifiers(available, scope.catalog);
  }
  return planningRequirementsCoveredBy(available, required) ? selected : undefined;
}

async function planningCapabilityForRequirements(
  dataAgent: DataAgent,
  scopes: readonly PlanningCatalogScope[],
  required: PlanningIdentifierRequirements,
  signal: AbortSignal,
): Promise<PlanningCapability | undefined> {
  const selected = selectPlanningCapabilityScopesForRequirements(scopes, required);
  if (selected === undefined || selected.length === 0) return undefined;
  if (selected.length === 1) return selected[0]!.capability;
  return dataAgent.composePlanningCapabilities(
    { capabilities: selected.map((scope) => scope.capability) },
    signal,
  );
}

function planningIdentifierRequirements(draft: AnalysisDraft): PlanningIdentifierRequirements {
  const required = emptyPlanningIdentifierRequirements();
  required.entityIds.add(draft.primaryEntityId);
  for (const relationshipId of draft.relationshipIds) {
    required.relationshipIds.add(relationshipId);
  }
  if (draft.mode === "records") {
    for (const field of draft.fields) required.fieldIds.add(field.fieldId);
    for (const order of draft.orderBy) required.fieldIds.add(order.fieldId);
  } else {
    for (const dimension of draft.dimensions) required.fieldIds.add(dimension.fieldId);
    for (const measure of draft.measures) {
      if (measure.kind === "metric") required.metricIds.add(measure.metricId);
      else if (measure.fieldId !== undefined) required.fieldIds.add(measure.fieldId);
    }
  }
  if (draft.filter !== undefined) addPredicateFieldIdentifiers(required.fieldIds, draft.filter);
  return required;
}

function emptyPlanningIdentifierRequirements(): {
  entityIds: Set<string>;
  fieldIds: Set<string>;
  metricIds: Set<string>;
  relationshipIds: Set<string>;
} {
  return {
    entityIds: new Set(),
    fieldIds: new Set(),
    metricIds: new Set(),
    relationshipIds: new Set(),
  };
}

function addPredicateFieldIdentifiers(target: Set<string>, predicate: AnalysisPredicate): void {
  if (predicate.kind === "all" || predicate.kind === "any") {
    for (const item of predicate.items) addPredicateFieldIdentifiers(target, item);
    return;
  }
  if (predicate.kind === "not") {
    addPredicateFieldIdentifiers(target, predicate.item);
    return;
  }
  target.add(predicate.fieldId);
}

function planningScopeCovers(
  scope: PlanningCatalogScope,
  required: PlanningIdentifierRequirements,
): boolean {
  const available = emptyPlanningIdentifierRequirements();
  addPlanningCatalogIdentifiers(available, scope.catalog);
  return planningRequirementsCoveredBy(available, required);
}

function planningScopeContributes(
  scope: PlanningCatalogScope,
  required: PlanningIdentifierRequirements,
): boolean {
  const available = emptyPlanningIdentifierRequirements();
  addPlanningCatalogIdentifiers(available, scope.catalog);
  return setsOverlap(available.entityIds, required.entityIds)
    || setsOverlap(available.fieldIds, required.fieldIds)
    || setsOverlap(available.metricIds, required.metricIds)
    || setsOverlap(available.relationshipIds, required.relationshipIds);
}

function addPlanningCatalogIdentifiers(
  target: ReturnType<typeof emptyPlanningIdentifierRequirements>,
  catalog: SemanticCatalog,
): void {
  for (const entity of catalog.entities) {
    target.entityIds.add(entity.id);
    for (const field of entity.fields) target.fieldIds.add(field.id);
    for (const metric of entity.metrics) target.metricIds.add(metric.id);
  }
  for (const relationship of catalog.relationships) {
    target.relationshipIds.add(relationship.id);
  }
}

function planningRequirementsCoveredBy(
  available: PlanningIdentifierRequirements,
  required: PlanningIdentifierRequirements,
): boolean {
  return setContainsAll(available.entityIds, required.entityIds)
    && setContainsAll(available.fieldIds, required.fieldIds)
    && setContainsAll(available.metricIds, required.metricIds)
    && setContainsAll(available.relationshipIds, required.relationshipIds);
}

function setContainsAll(available: ReadonlySet<string>, required: ReadonlySet<string>): boolean {
  for (const id of required) {
    if (!available.has(id)) return false;
  }
  return true;
}

function setsOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function generatedOutputId(
  kind: "dimension" | "field" | "measure",
  index: number,
): string {
  return `out_${kind}_${index + 1}`;
}

function normalizeModelFilter(
  input: z.output<typeof modelAnalysisFilterSchema>,
): AnalysisPredicate {
  const items = input.conditions.map((condition) => {
    if (condition.op === "is_null") {
      return { kind: "null" as const, fieldId: condition.fieldId, isNull: true };
    }
    if (condition.op === "is_not_null") {
      return { kind: "null" as const, fieldId: condition.fieldId, isNull: false };
    }
    if (condition.value === undefined) {
      throw new TypeError("A comparison filter requires a value.");
    }
    return {
      kind: "comparison" as const,
      fieldId: condition.fieldId,
      op: condition.op,
      value: condition.value,
    };
  });
  return items.length === 1 ? items[0]! : { kind: input.join, items };
}

const GENERIC_ANALYSIS_ERROR_MESSAGES = new Set([
  "The structured data analysis could not be completed.",
  "The operation failed without an Error message.",
]);

const dataAgentErrorCodes = new Set<DataAgentErrorCode>([
  "catalog_stale",
  "invalid_analysis_spec",
  "invalid_semantic_catalog",
  "invalid_relation_context",
  "invalid_relation_preview",
  "compile_failed",
  "query_policy_rejected",
  "query_failed",
  "query_limit_exceeded",
]);

function analysisDiagnostic(error: unknown, fallback: string): string {
  const message = safeToolResultMessage(error);
  return GENERIC_ANALYSIS_ERROR_MESSAGES.has(message) ? fallback : message;
}

function readDataAgentErrorCode(error: unknown): DataAgentErrorCode | undefined {
  if (error instanceof DataAgentError) return error.code;
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { name?: unknown; code?: unknown };
  if (candidate.name !== "DataAgentError" || typeof candidate.code !== "string") {
    return undefined;
  }
  return dataAgentErrorCodes.has(candidate.code as DataAgentErrorCode)
    ? candidate.code as DataAgentErrorCode
    : undefined;
}

function safeToolResultMessage(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : typeof error === "object" && error !== null && "message" in error
        && typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : "The operation failed without an Error message.";
  const message = raw.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (!message || containsSensitiveText(message) || containsRawSqlStatement(message)) {
    return "The operation failed without an Error message.";
  }
  return Array.from(message).slice(0, 2_000).join("");
}
