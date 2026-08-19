import {
  DATA_AGENT_DESCRIBE_MAX_FIELDS_PER_ENTITY,
  DATA_AGENT_DESCRIBE_MAX_METRICS_PER_ENTITY,
  DATA_AGENT_DESCRIBE_MAX_RELATIONSHIPS,
  semanticCatalogSchema,
  type EntityId,
  type FieldId,
  type SemanticCatalog,
  type SemanticEntity,
  type SemanticField,
  type SemanticMetric,
  type SemanticRelationship,
} from "./contracts";

/**
 * Bounded context for a planning model. These limits govern model context,
 * never the administrator-visible runtime catalog or SQL compiler.
 */
export const DATA_AGENT_DEFAULT_CATALOG_SLICE_BUDGET = Object.freeze({
  maxEntities: 12,
  maxFieldsPerEntity: 40,
  maxMetricsPerEntity: 24,
  maxRelationships: 48,
});

export type SemanticCatalogSliceOptions = Readonly<{
  query?: string;
  maxEntities?: number;
  maxFieldsPerEntity?: number;
  maxMetricsPerEntity?: number;
  maxRelationships?: number;
}>;

export type SemanticCatalogSlice = Readonly<{
  /**
   * A model-facing subset of the full semantic catalog. Its ref still points
   * to the full catalog, so it must only be used to plan opaque IDs. Binding
   * and compiling always use the full server-side catalog.
   */
  catalog: SemanticCatalog;
  truncated: boolean;
  omitted: Readonly<{
    entities: number;
    fields: number;
    metrics: number;
    relationships: number;
  }>;
}>;

type Ranked<T> = Readonly<{ value: T; index: number; score: number }>;

/**
 * Selects a small, relationship-complete semantic catalog for one planning
 * request. Unlike a naïve per-entity field slice, every retained relationship
 * retains both sides of every join pair. The function is deterministic so the
 * same catalog and question always produce the same model context.
 */
export function sliceSemanticCatalog(
  catalogInput: SemanticCatalog,
  options: SemanticCatalogSliceOptions = {},
): SemanticCatalogSlice {
  const catalog = semanticCatalogSchema.parse(catalogInput);
  const budget = normalizeBudget(options);
  const tokens = catalogSearchTokens(options.query);
  const rankedEntities = catalog.entities
    .map((entity, index) => ({ value: entity, index, score: scoreEntity(entity, tokens) }))
    .sort(compareRanked);
  // A non-empty question with no semantic match must not be represented as a
  // plausible-looking slice of unrelated leading tables. It is safer for the
  // planner to ask for clarification (or use another catalog term) than to
  // invent an answer from catalog order. Empty queries retain the deterministic
  // browsing fallback.
  const hasQueryMatch = tokens.length === 0 || rankedEntities.some(({ score }) => score > 0);
  const selectedEntityIds = hasQueryMatch
    ? selectEntityIds(rankedEntities, catalog.relationships, budget.maxEntities)
    : new Set<string>();
  const selectedEntities = rankedEntities.filter(({ value }) => selectedEntityIds.has(value.id));
  const entityById = new Map(selectedEntities.map(({ value }) => [value.id, value]));
  const fieldOwner = fieldOwners(selectedEntities.map(({ value }) => value));
  const selectedRelationships = selectRelationships({
    relationships: catalog.relationships,
    entityById,
    entityScores: new Map(rankedEntities.map(({ value, score }) => [value.id, score])),
    fieldOwner,
    maxRelationships: budget.maxRelationships,
    maxFieldsPerEntity: budget.maxFieldsPerEntity,
  });
  const requiredFields = requiredFieldIds(selectedEntities.map(({ value }) => value), selectedRelationships);
  const projectedEntities = selectedEntities.map(({ value: entity }) => projectEntity({
    entity,
    tokens,
    requiredFields: requiredFields.get(entity.id) ?? new Set<FieldId>(),
    maxFields: budget.maxFieldsPerEntity,
    maxMetrics: budget.maxMetricsPerEntity,
  }));
  const projected = semanticCatalogSchema.parse({
    ...catalog,
    entities: projectedEntities,
    relationships: selectedRelationships,
  });
  const total = catalogTotals(catalog);
  const selected = catalogTotals(projected);
  const omitted = {
    entities: Math.max(0, total.entities - selected.entities),
    fields: Math.max(0, total.fields - selected.fields),
    metrics: Math.max(0, total.metrics - selected.metrics),
    relationships: Math.max(0, total.relationships - selected.relationships),
  };
  return {
    catalog: projected,
    truncated: Object.values(omitted).some((value) => value > 0),
    omitted,
  };
}

/**
 * Expands a small, already-authorized set of candidate entities for an Agent
 * that needs to compare their business meaning before committing to a plan.
 * Unlike search, it never discovers new entities. The caller must therefore
 * pass only opaque ids returned by a prior inspected slice.
 */
export function describeSemanticCatalog(
  catalogInput: SemanticCatalog,
  entityIds: readonly EntityId[],
): SemanticCatalogSlice {
  const catalog = semanticCatalogSchema.parse(catalogInput);
  const byId = new Map(catalog.entities.map((entity) => [entity.id, entity]));
  const entities = entityIds.map((id) => byId.get(id)).filter((entity): entity is SemanticEntity => entity !== undefined);
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const required = requiredFieldIds(entities, []);
  const relationships: SemanticRelationship[] = [];

  for (const relationship of catalog.relationships) {
    if (relationships.length >= DATA_AGENT_DESCRIBE_MAX_RELATIONSHIPS) break;
    const from = entityById.get(relationship.fromEntityId);
    const to = entityById.get(relationship.toEntityId);
    if (!from || !to) continue;
    const fromRequired = required.get(from.id);
    const toRequired = required.get(to.id);
    if (!fromRequired || !toRequired) continue;
    const nextFrom = new Set(fromRequired);
    const nextTo = new Set(toRequired);
    for (const pair of relationship.pairs) {
      nextFrom.add(pair.fromFieldId);
      nextTo.add(pair.toFieldId);
    }
    if (nextFrom.size > DATA_AGENT_DESCRIBE_MAX_FIELDS_PER_ENTITY
      || nextTo.size > DATA_AGENT_DESCRIBE_MAX_FIELDS_PER_ENTITY) continue;
    fromRequired.clear();
    toRequired.clear();
    for (const fieldId of nextFrom) fromRequired.add(fieldId);
    for (const fieldId of nextTo) toRequired.add(fieldId);
    relationships.push(relationship);
  }

  const projectedEntities = entities.map((entity) => describeEntity(
    entity,
    required.get(entity.id) ?? new Set<FieldId>(),
  ));
  const projected = semanticCatalogSchema.parse({
    ...catalog,
    entities: projectedEntities,
    relationships,
  });
  const total = catalogTotals(catalog);
  const selected = catalogTotals(projected);
  const omitted = {
    entities: Math.max(0, total.entities - selected.entities),
    fields: Math.max(0, total.fields - selected.fields),
    metrics: Math.max(0, total.metrics - selected.metrics),
    relationships: Math.max(0, total.relationships - selected.relationships),
  };
  return {
    catalog: projected,
    truncated: Object.values(omitted).some((value) => value > 0),
    omitted,
  };
}

function normalizeBudget(options: SemanticCatalogSliceOptions) {
  return {
    maxEntities: boundedInteger(options.maxEntities, DATA_AGENT_DEFAULT_CATALOG_SLICE_BUDGET.maxEntities, 1, 10_000),
    maxFieldsPerEntity: boundedInteger(options.maxFieldsPerEntity, DATA_AGENT_DEFAULT_CATALOG_SLICE_BUDGET.maxFieldsPerEntity, 1, 2_000),
    maxMetricsPerEntity: boundedInteger(options.maxMetricsPerEntity, DATA_AGENT_DEFAULT_CATALOG_SLICE_BUDGET.maxMetricsPerEntity, 0, 256),
    maxRelationships: boundedInteger(options.maxRelationships, DATA_AGENT_DEFAULT_CATALOG_SLICE_BUDGET.maxRelationships, 0, 20_000),
  };
}

function selectEntityIds(
  ranked: readonly Ranked<SemanticEntity>[],
  relationships: readonly SemanticRelationship[],
  maximum: number,
): Set<string> {
  const selected = new Set<string>();
  if (ranked.length === 0 || maximum === 0) return selected;

  const matching = ranked.filter(({ score }) => score > 0);
  if (matching.length > 0) {
    // A concrete question is a retrieval request, not a catalog browser.
    // Do not expand along relationships or pad the context with unrelated
    // tables: the planner can only choose from the returned semantic IDs.
    for (const { value } of matching.slice(0, maximum)) selected.add(value.id);
    return selected;
  }

  // No search terms: retain a compact browsing fallback. Keep capacity for a
  // related business entity so an initial catalog view is still useful.
  const seedLimit = maximum === 1 ? 1 : Math.max(1, maximum - Math.max(1, Math.floor(maximum / 4)));
  for (const { value } of ranked.slice(0, seedLimit)) selected.add(value.id);
  const scores = new Map(ranked.map(({ value, score }) => [value.id, score]));
  while (selected.size < maximum) {
    const candidates = relationships
      .map((relationship, index) => {
        const fromSelected = selected.has(relationship.fromEntityId);
        const toSelected = selected.has(relationship.toEntityId);
        if (fromSelected === toSelected) return undefined;
        const entityId = fromSelected ? relationship.toEntityId : relationship.fromEntityId;
        const score = (scores.get(entityId) ?? 0) + (scores.get(fromSelected ? relationship.fromEntityId : relationship.toEntityId) ?? 0) + relationshipWeight(relationship);
        return { entityId, index, score };
      })
      .filter((candidate): candidate is Readonly<{ entityId: string; index: number; score: number }> => candidate !== undefined)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    const neighbor = candidates[0];
    if (!neighbor) break;
    selected.add(neighbor.entityId);
  }

  for (const { value } of ranked) {
    if (selected.size >= maximum) break;
    selected.add(value.id);
  }
  return selected;
}

function selectRelationships(input: Readonly<{
  relationships: readonly SemanticRelationship[];
  entityById: ReadonlyMap<string, SemanticEntity>;
  entityScores: ReadonlyMap<string, number>;
  fieldOwner: ReadonlyMap<FieldId, string>;
  maxRelationships: number;
  maxFieldsPerEntity: number;
}>): SemanticRelationship[] {
  const required = new Map<string, Set<FieldId>>();
  for (const entity of input.entityById.values()) {
    const ids = new Set<FieldId>();
    if (entity.defaultTimeFieldId && entity.fields.some((field) => field.id === entity.defaultTimeFieldId)) {
      ids.add(entity.defaultTimeFieldId);
    }
    required.set(entity.id, ids);
  }
  const candidates = input.relationships
    .map((relationship, index) => ({
      value: relationship,
      index,
      score: (input.entityScores.get(relationship.fromEntityId) ?? 0)
        + (input.entityScores.get(relationship.toEntityId) ?? 0)
        + relationshipWeight(relationship),
    }))
    .filter(({ value }) => (
      input.entityById.has(value.fromEntityId)
      && input.entityById.has(value.toEntityId)
      && value.pairs.every((pair) => (
        input.fieldOwner.get(pair.fromFieldId) === value.fromEntityId
        && input.fieldOwner.get(pair.toFieldId) === value.toEntityId
      ))
    ))
    .sort(compareRanked);

  const selected: SemanticRelationship[] = [];
  for (const { value } of candidates) {
    if (selected.length >= input.maxRelationships) break;
    const from = required.get(value.fromEntityId);
    const to = required.get(value.toEntityId);
    if (!from || !to) continue;
    const nextFrom = new Set(from);
    const nextTo = new Set(to);
    for (const pair of value.pairs) {
      nextFrom.add(pair.fromFieldId);
      nextTo.add(pair.toFieldId);
    }
    if (nextFrom.size > input.maxFieldsPerEntity || nextTo.size > input.maxFieldsPerEntity) continue;
    required.set(value.fromEntityId, nextFrom);
    required.set(value.toEntityId, nextTo);
    selected.push(value);
  }
  return selected;
}

function requiredFieldIds(
  entities: readonly SemanticEntity[],
  relationships: readonly SemanticRelationship[],
): Map<string, Set<FieldId>> {
  const required = new Map<string, Set<FieldId>>();
  for (const entity of entities) {
    const ids = new Set<FieldId>();
    if (entity.defaultTimeFieldId && entity.fields.some((field) => field.id === entity.defaultTimeFieldId)) {
      ids.add(entity.defaultTimeFieldId);
    }
    required.set(entity.id, ids);
  }
  for (const relationship of relationships) {
    const from = required.get(relationship.fromEntityId);
    const to = required.get(relationship.toEntityId);
    if (!from || !to) continue;
    for (const pair of relationship.pairs) {
      from.add(pair.fromFieldId);
      to.add(pair.toFieldId);
    }
  }
  return required;
}

function projectEntity(input: Readonly<{
  entity: SemanticEntity;
  tokens: readonly string[];
  requiredFields: ReadonlySet<FieldId>;
  maxFields: number;
  maxMetrics: number;
}>): SemanticEntity {
  const required = new Set(input.requiredFields);
  const fieldById = new Map(input.entity.fields.map((field) => [field.id, field]));
  const rankedMetrics = input.entity.metrics
    .map((metric, index) => ({ value: metric, index, score: scoreMetric(metric, input.tokens) }))
    .sort(compareRanked);
  const metrics: SemanticMetric[] = [];
  for (const { value } of rankedMetrics) {
    if (metrics.length >= input.maxMetrics) break;
    if (value.fieldId !== undefined && !fieldById.has(value.fieldId)) continue;
    const next = new Set(required);
    if (value.fieldId !== undefined) next.add(value.fieldId);
    if (next.size > input.maxFields) continue;
    required.clear();
    for (const fieldId of next) required.add(fieldId);
    metrics.push(value);
  }
  const rankedFields = input.entity.fields
    .map((field, index) => ({ value: field, index, score: scoreField(field, input.tokens, input.entity.defaultTimeFieldId) }))
    .sort(compareRanked);
  // Required fields (relationship keys, default time, and metric inputs) are
  // placed first so a highly scored display field cannot crowd out a key.
  const fields = [
    ...rankedFields.filter(({ value }) => required.has(value.id)),
    ...rankedFields
      .filter(({ value }) => !required.has(value.id))
      .slice(0, Math.max(0, input.maxFields - required.size)),
  ].map(({ value }) => value);
  const selectedFieldIds = new Set(fields.map((field) => field.id));
  const { defaultTimeFieldId: _defaultTimeFieldId, ...entity } = input.entity;
  return {
    ...entity,
    ...(input.entity.defaultTimeFieldId && selectedFieldIds.has(input.entity.defaultTimeFieldId)
      ? { defaultTimeFieldId: input.entity.defaultTimeFieldId }
      : {}),
    fields,
    metrics,
  };
}

function describeEntity(entity: SemanticEntity, requiredFields: ReadonlySet<FieldId>): SemanticEntity {
  const required = new Set(requiredFields);
  const fields = [
    ...entity.fields.filter((field) => required.has(field.id)),
    ...entity.fields.filter((field) => !required.has(field.id)),
  ].slice(0, DATA_AGENT_DESCRIBE_MAX_FIELDS_PER_ENTITY);
  const selectedFieldIds = new Set(fields.map((field) => field.id));
  const metrics = entity.metrics
    .filter((metric) => metric.fieldId === undefined || selectedFieldIds.has(metric.fieldId))
    .slice(0, DATA_AGENT_DESCRIBE_MAX_METRICS_PER_ENTITY);
  const { defaultTimeFieldId: _defaultTimeFieldId, ...rest } = entity;
  return {
    ...rest,
    ...(entity.defaultTimeFieldId !== undefined && selectedFieldIds.has(entity.defaultTimeFieldId)
      ? { defaultTimeFieldId: entity.defaultTimeFieldId }
      : {}),
    fields,
    metrics,
  };
}

function fieldOwners(entities: readonly SemanticEntity[]): Map<FieldId, string> {
  const result = new Map<FieldId, string>();
  for (const entity of entities) {
    for (const field of entity.fields) result.set(field.id, entity.id);
  }
  return result;
}

function catalogSearchTokens(query: string | undefined): string[] {
  if (!query) return [];
  const tokens = new Set<string>();
  const add = (value: string) => {
    const token = value.trim().toLocaleLowerCase("en-US");
    if (token.length > 0 && tokens.size < 64) tokens.add(token);
  };
  // Tokenisation is deliberately schema-agnostic. It never maps a business
  // concept (for example, a Chinese term) to a guessed English table or
  // column. Cross-language meaning belongs in the optional semantic manifest
  // aliases/descriptions, which are authored for the current catalog.
  const normalized = query.normalize("NFKC");
  for (const part of normalized.match(/[\p{L}\p{N}_-]+/gu) ?? []) {
    addIdentifierTokens(part, add);
  }
  return [...tokens];
}

function addIdentifierTokens(value: string, add: (token: string) => void): void {
  add(value);
  // Database identifiers often use snake_case, kebab-case, or camelCase.
  // Split these forms without maintaining a vocabulary for any domain.
  const words = value
    .replace(/([a-z\d])([A-Z])/gu, "$1 $2")
    .split(/[_\-\s]+/u)
    .filter((word) => word.length > 0);
  for (const word of words) {
    if (word.length > 1) add(word);
  }

  // Keep CJK runs and overlapping bigrams so an operator-authored Chinese
  // label/alias can be found even when the query has no whitespace. No
  // translation or business vocabulary is embedded here.
  for (const run of value.match(/\p{Script=Han}+/gu) ?? []) {
    add(run);
    const characters = Array.from(run);
    for (const character of characters) add(character);
    for (let index = 0; index + 1 < characters.length; index += 1) {
      add(`${characters[index]}${characters[index + 1]}`);
    }
  }
}

function scoreEntity(entity: SemanticEntity, tokens: readonly string[]): number {
  return semanticTextScore([entity.label, ...entity.aliases, entity.description].filter(isDefined), tokens) * 3
    + entity.fields.reduce((score, field) => score + semanticTextScore([field.label, ...field.aliases, field.description].filter(isDefined), tokens), 0)
    + entity.metrics.reduce((score, metric) => score + semanticTextScore([metric.label, metric.description].filter(isDefined), tokens), 0);
}

function scoreField(field: SemanticField, tokens: readonly string[], defaultTimeFieldId: FieldId | undefined): number {
  const roleWeight = field.role === "time"
    ? 12
    : field.role === "measure"
      ? 10
      : field.role === "identifier"
        ? 8
        : field.role === "dimension"
          ? 4
          : 2;
  return semanticTextScore([field.label, ...field.aliases, field.description].filter(isDefined), tokens) * 4
    + roleWeight
    + (field.id === defaultTimeFieldId ? 24 : 0);
}

function scoreMetric(metric: SemanticMetric, tokens: readonly string[]): number {
  const aggregateWeight = metric.aggregate === "count" ? 4 : 10;
  return semanticTextScore([metric.label, metric.description].filter(isDefined), tokens) * 4 + aggregateWeight;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function semanticTextScore(values: readonly string[], tokens: readonly string[]): number {
  if (tokens.length === 0) return 0;
  const terms = values.map((value) => value.toLocaleLowerCase("en-US"));
  return tokens.reduce((score, token) => score + terms.reduce((next, term) => {
    if (term === token) return next + 24;
    if (term.includes(token)) return next + (isHanToken(token) ? token.length * 2 : 8);
    return next;
  }, 0), 0);
}

function isHanToken(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

function relationshipWeight(relationship: SemanticRelationship): number {
  return relationship.origin === "trusted-manifest" ? 6 : 3;
}

function compareRanked<T>(left: Ranked<T>, right: Ranked<T>): number {
  return right.score - left.score || left.index - right.index;
}

function catalogTotals(catalog: SemanticCatalog) {
  return {
    entities: catalog.entities.length,
    fields: catalog.entities.reduce((count, entity) => count + entity.fields.length, 0),
    metrics: catalog.entities.reduce((count, entity) => count + entity.metrics.length, 0),
    relationships: catalog.relationships.length,
  };
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const candidate = value ?? fallback;
  return Number.isFinite(candidate) ? Math.max(minimum, Math.min(maximum, Math.floor(candidate))) : fallback;
}
