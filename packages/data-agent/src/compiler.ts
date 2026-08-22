import { createHash } from "node:crypto";
import type { DatabaseCatalog, DatabaseDialect } from "@open-tessera/database";
import type {
  Aggregate,
  AnalysisDraft,
  AnalysisPredicate,
  AnalysisSpec,
  CatalogSnapshotRef,
  CompileAnalysisSpecInput,
  CompileTypedProbeInput,
  CompiledQuery,
  CompiledResultColumn,
  Dimension,
  DataTypeFamily,
  EntityId,
  FieldId,
  Measure,
  OutputId,
  SemanticCatalog,
  SemanticCatalogDefinition,
  SemanticEntity,
  SemanticField,
  SemanticMetric,
  SemanticRelationship,
  TypedProbePlan,
  TypedProbeRequest,
} from "./contracts";
import {
  bindSemanticCatalog,
  buildSemanticCatalog,
  entityIdFor,
  fieldIdFor,
  SemanticCatalogError,
  type PhysicalEntity,
  type PhysicalField,
  type PhysicalMetric,
  type PhysicalRelationship,
  type SemanticBindings,
} from "./semantic";
import {
  DATA_AGENT_MAX_PROBES_PER_ANALYSIS,
  analysisDraftSchema,
  analysisSpecSchema,
  semanticCatalogSchema,
  typedProbePlanSchema,
  typedProbeRequestSchema,
} from "./contracts";

export { entityIdFor, fieldIdFor } from "./semantic";

export class AnalysisCompilerError extends Error {
  readonly code: "catalog_stale" | "invalid_analysis_spec" | "invalid_semantic_catalog" | "invalid_probe" | "compile_failed" | "query_limit_exceeded";

  constructor(code: AnalysisCompilerError["code"], message: string) {
    super(message);
    this.name = "AnalysisCompilerError";
    this.code = code;
  }
}

type ResolvedJoin = Readonly<{
  include: PhysicalEntity;
  alias: string;
  pairs: readonly Readonly<{ left: PhysicalField; right: PhysicalField }>[];
}>;

type ResolvedContext = Readonly<{
  catalog: DatabaseCatalog;
  semantic: SemanticCatalog;
  bindings: SemanticBindings;
  spec: AnalysisSpec;
  primary: PhysicalEntity;
  entities: ReadonlyMap<string, PhysicalEntity>;
  aliases: ReadonlyMap<string, string>;
  joins: readonly ResolvedJoin[];
}>;

type ParameterBuilder = Readonly<{
  take(value: string | number | boolean): string;
  values: readonly (string | number | boolean)[];
}>;

/** Returns the model-safe projection of a live, server-owned catalog. */
export function createSemanticCatalog(
  catalog: DatabaseCatalog,
  definition?: SemanticCatalogDefinition,
): SemanticCatalog {
  try {
    return buildSemanticCatalog(catalog, definition).catalog;
  } catch (error) {
    throw compilerErrorFrom(error, "invalid_semantic_catalog");
  }
}

/**
 * Binds a model-produced draft to the exact catalog revision that will execute
 * it. The draft language has no SQL, physical identifiers, or executable code.
 */
export function bindAnalysisDraft(input: Readonly<{
  draft: unknown;
  catalog: DatabaseCatalog;
  semanticCatalog: SemanticCatalog;
  now?: Date;
}>): AnalysisSpec {
  const draft = parseDraft(input.draft);
  const semanticCatalog = parseSemanticCatalog(input.catalog, input.semanticCatalog);
  const bindings = bindingsFor(input.catalog, semanticCatalog);
  validateDraft(draft, semanticCatalog, bindings);
  const createdAt = (input.now ?? new Date()).toISOString();
  const catalog: CatalogSnapshotRef = {
    connectorId: input.catalog.connectorId,
    catalogFingerprint: input.catalog.fingerprint,
    capturedAt: createdAt,
  };
  const specId = `spec_${hash(stableJson({ catalog, semanticCatalog: semanticCatalog.ref, draft })).slice(0, 24)}`;
  try {
    return analysisSpecSchema.parse({
      ...draft,
      catalog,
      semanticCatalog: semanticCatalog.ref,
      specId,
      createdAt,
    });
  } catch (error) {
    throw compilerErrorFrom(error, "invalid_analysis_spec");
  }
}

/** Deterministically selects a bounded set of safe diagnostic probes. */
export function planTypedProbes(specInput: AnalysisSpec, semanticCatalogInput: SemanticCatalog): TypedProbePlan {
  const spec = parseSpec(specInput);
  const semanticCatalog = parseSemanticCatalogRef(spec, semanticCatalogInput);
  const fields = semanticFields(semanticCatalog);
  const candidatesByField = predicateCandidates(spec.filter);
  const probes: TypedProbeRequest[] = [];
  const add = (probe: TypedProbeRequest) => {
    if (probes.length >= DATA_AGENT_MAX_PROBES_PER_ANALYSIS) return;
    if (!probes.some((existing) => existing.kind === probe.kind && probeFieldKey(existing) === probeFieldKey(probe))) {
      probes.push(probe);
    }
  };
  const dimensions = spec.mode === "aggregate" ? spec.dimensions : [];
  for (const dimension of dimensions) {
    if (dimension.kind === "time") {
      add({ kind: "time-bounds", id: probeId(spec.specId, "time-bounds", dimension.fieldId), fieldId: dimension.fieldId });
    }
  }
  for (const fieldId of predicateFieldIds(spec.filter)) {
    const field = fields.get(fieldId);
    if (field?.field.type === "string" && field.field.exposure === "bounded-values") {
      const candidates = candidatesByField.get(fieldId) ?? [];
      add({
        kind: "value-domain",
        id: probeId(spec.specId, "value-domain", fieldId),
        fieldId,
        ...(candidates.length === 0 ? {} : { candidates }),
        maxValues: 20,
      });
    }
  }
  try {
    return typedProbePlanSchema.parse({ version: "2", specId: spec.specId, probes });
  } catch (error) {
    throw compilerErrorFrom(error, "invalid_probe");
  }
}

/** Compiles a bound spec using reconstructed server-private physical bindings. */
export function compileAnalysisSpec(input: CompileAnalysisSpecInput): CompiledQuery {
  const spec = parseSpec(input.spec);
  const semanticCatalog = parseSemanticCatalog(input.catalog, input.semanticCatalog);
  const bindings = bindingsFor(input.catalog, semanticCatalog);
  validateBoundSpec(spec, input.catalog, semanticCatalog, bindings);
  return compileBoundAnalysis({
    catalog: input.catalog,
    semanticCatalog,
    bindings,
    spec,
    maxRows: clamp(input.limits?.maxRows, 1_000, 1, 20_000),
    maxJoins: clamp(input.limits?.maxJoins, 8, 0, 16),
  });
}

/** Compiles one schema-validated probe; arbitrary SQL is not an input. */
export function compileTypedProbe(input: CompileTypedProbeInput): CompiledQuery {
  const spec = parseSpec(input.spec);
  const probe = parseProbe(input.probe);
  const semanticCatalog = parseSemanticCatalog(input.catalog, input.semanticCatalog);
  const bindings = bindingsFor(input.catalog, semanticCatalog);
  validateBoundSpec(spec, input.catalog, semanticCatalog, bindings);
  validateProbe(spec, probe, semanticCatalog, bindings);
  return compileBoundProbe({
    catalog: input.catalog,
    semanticCatalog,
    bindings,
    spec,
    probe,
  });
}

export function compileBoundAnalysis(input: Readonly<{
  catalog: DatabaseCatalog;
  semanticCatalog: SemanticCatalog;
  bindings: SemanticBindings;
  spec: AnalysisSpec;
  maxRows: number;
  maxJoins: number;
}>): CompiledQuery {
  validateBoundSpec(input.spec, input.catalog, input.semanticCatalog, input.bindings);
  if (input.catalog.dialect === "mongodb") return compileBoundMongoAnalysis(input);
  if (input.spec.mode === "records") return compileBoundRecords(input);
  return compileBoundAggregateAnalysis(input);
}

function compileBoundAggregateAnalysis(input: Readonly<{
  catalog: DatabaseCatalog;
  semanticCatalog: SemanticCatalog;
  bindings: SemanticBindings;
  spec: AnalysisSpec;
  maxRows: number;
  maxJoins: number;
}>): CompiledQuery {
  if (input.spec.mode !== "aggregate") {
    throw new AnalysisCompilerError("invalid_analysis_spec", "An aggregate analysis must use aggregate mode.");
  }
  const spec = input.spec;
  const context = resolveContext(input);
  const params = parameterBuilder(context.catalog.dialect);
  const dimensions = spec.dimensions.map((dimension) => resolveDimension(context, dimension));
  const measures = spec.measures.map((measure) => resolveMeasure(context, measure));
  const outputIds = [...dimensions.map(({ outputId }) => outputId), ...measures.map(({ outputId }) => outputId)];
  if (new Set(outputIds).size !== outputIds.length) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "Analysis output identifiers must be unique.");
  }
  for (const order of spec.orderBy) {
    if (!outputIds.includes(order.outputId)) {
      throw new AnalysisCompilerError("invalid_analysis_spec", "An ordering target is not part of the analysis output.");
    }
  }
  const quote = (value: string) => quoteIdentifier(context.catalog.dialect, value);
  const expressionFor = (field: PhysicalField) => `${quote(aliasFor(context, field.entityId))}.${quote(field.column)}`;
  const projections = [
    ...dimensions.map((dimension) => `${dimension.expression} AS ${quote(dimension.outputId)}`),
    ...measures.map((measure) => `${measure.expression} AS ${quote(measure.outputId)}`),
  ];
  const from = `${quote(context.primary.schema)}.${quote(context.primary.table)} AS ${quote(aliasFor(context, context.primary.id))}`;
  const joins = context.joins.map((join) => {
    const on = join.pairs.map(({ left, right }) => `${expressionFor(left)} = ${expressionFor(right)}`).join(" AND ");
    return `LEFT JOIN ${quote(join.include.schema)}.${quote(join.include.table)} AS ${quote(join.alias)} ON ${on}`;
  });
  const predicate = spec.filter === undefined
    ? undefined
    : compilePredicate(context, spec.filter, expressionFor, params, quote);
  const groupBy = dimensions.map(({ expression }) => expression);
  const orderBy = spec.orderBy.length === 0
    ? undefined
    : spec.orderBy.map(({ outputId, direction }) => `${quote(outputId)} ${direction.toUpperCase()}`).join(", ");
  const limit = spec.output === "scalar" ? 1 : Math.min(spec.limit, input.maxRows);
  if (limit < 1) throw new AnalysisCompilerError("query_limit_exceeded", "The analysis result limit is outside the configured budget.");
  const sql = [
    `SELECT ${projections.join(", ")}`,
    `FROM ${from}`,
    ...joins,
    ...(predicate ? [`WHERE ${predicate}`] : []),
    ...(groupBy.length > 0 ? [`GROUP BY ${groupBy.join(", ")}`] : []),
    ...(orderBy ? [`ORDER BY ${orderBy}`] : []),
    `LIMIT ${limit}`,
  ].join("\n");
  return {
    sql,
    parameters: [...params.values],
    sourceRelationIds: [context.primary.id, ...context.joins.map(({ include }) => include.id)],
    resultColumns: [
      ...dimensions.map(({ outputId, label, type }) => ({ outputId, label, type })),
      ...measures.map(({ outputId, label, type }) => ({ outputId, label, type })),
    ],
  };
}

function compileBoundRecords(input: Readonly<{
  catalog: DatabaseCatalog;
  semanticCatalog: SemanticCatalog;
  bindings: SemanticBindings;
  spec: AnalysisSpec;
  maxRows: number;
  maxJoins: number;
}>): CompiledQuery {
  if (input.spec.mode !== "records") {
    throw new AnalysisCompilerError("invalid_analysis_spec", "A record query must use records mode.");
  }
  const spec = input.spec;
  const context = resolveContext(input);
  const params = parameterBuilder(context.catalog.dialect);
  const quote = (value: string) => quoteIdentifier(context.catalog.dialect, value);
  const expressionFor = (field: PhysicalField) => `${quote(aliasFor(context, field.entityId))}.${quote(field.column)}`;
  const fields = spec.fields.map(({ fieldId, outputId }) => {
    const field = resolveField(context, fieldId);
    if (field.exposure !== "bounded-values") {
      throw new AnalysisCompilerError("invalid_analysis_spec", "A record projection can only return a model-visible field.");
    }
    return {
      outputId,
      expression: expressionFor(field),
      label: semanticFieldLabel(context.semantic, fieldId),
      type: field.type,
    };
  });
  const outputIds = fields.map(({ outputId }) => outputId);
  if (new Set(outputIds).size !== outputIds.length) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "Analysis output identifiers must be unique.");
  }
  const from = `${quote(context.primary.schema)}.${quote(context.primary.table)} AS ${quote(aliasFor(context, context.primary.id))}`;
  const joins = context.joins.map((join) => {
    const on = join.pairs.map(({ left, right }) => `${expressionFor(left)} = ${expressionFor(right)}`).join(" AND ");
    return `LEFT JOIN ${quote(join.include.schema)}.${quote(join.include.table)} AS ${quote(join.alias)} ON ${on}`;
  });
  const predicate = spec.filter === undefined
    ? undefined
    : compilePredicate(context, spec.filter, expressionFor, params, quote);
  const orderBy = spec.orderBy.map(({ fieldId, direction }) => {
    const field = resolveField(context, fieldId);
    if (field.exposure !== "bounded-values") {
      throw new AnalysisCompilerError("invalid_analysis_spec", "A record ordering field must be model-visible.");
    }
    return `${expressionFor(field)} ${direction.toUpperCase()}`;
  }).join(", ");
  const limit = Math.min(spec.limit, input.maxRows);
  if (limit < 1) throw new AnalysisCompilerError("query_limit_exceeded", "The analysis result limit is outside the configured budget.");
  const sql = [
    `SELECT ${fields.map((field) => `${field.expression} AS ${quote(field.outputId)}`).join(", ")}`,
    `FROM ${from}`,
    ...joins,
    ...(predicate ? [`WHERE ${predicate}`] : []),
    `ORDER BY ${orderBy}`,
    `LIMIT ${limit}`,
  ].join("\n");
  return {
    sql,
    parameters: [...params.values],
    sourceRelationIds: [context.primary.id, ...context.joins.map(({ include }) => include.id)],
    resultColumns: fields.map(({ outputId, label, type }) => ({ outputId, label, type })),
  };
}

type MongoStage = Record<string, unknown>;

function compileBoundMongoAnalysis(input: Readonly<{
  catalog: DatabaseCatalog;
  semanticCatalog: SemanticCatalog;
  bindings: SemanticBindings;
  spec: AnalysisSpec;
  maxRows: number;
  maxJoins: number;
}>): CompiledQuery {
  const context = resolveContext(input);
  if (input.spec.mode === "records") return compileBoundMongoRecords(context, input.maxRows);

  const spec = input.spec;
  const stages = mongoJoinStages(context);
  if (spec.filter) stages.push({ $match: { $expr: mongoPredicate(context, spec.filter) } });

  const dimensions = spec.dimensions.map((dimension) => {
    const field = resolveField(context, dimension.fieldId);
    if (field.exposure !== "bounded-values") {
      throw new AnalysisCompilerError("invalid_analysis_spec", "An aggregate-only field cannot be returned as a dimension.");
    }
    const expression = dimension.kind === "field"
      ? mongoFieldExpression(context, field)
      : mongoTimeBucket(mongoFieldExpression(context, field), dimension.grain, field);
    return {
      outputId: dimension.outputId,
      expression,
      label: dimension.kind === "field"
        ? semanticFieldLabel(context.semantic, dimension.fieldId)
        : `${semanticFieldLabel(context.semantic, dimension.fieldId)} by ${dimension.grain}`,
      type: dimension.kind === "time"
        ? (dimension.grain === "hour" ? "timestamp" as const : "date" as const)
        : field.type,
    };
  });
  const measures = spec.measures.map((measure, index) => mongoMeasure(context, measure, index));
  const groupId = dimensions.length === 0
    ? null
    : Object.fromEntries(dimensions.map(({ outputId, expression }) => [outputId, expression]));
  stages.push({
    $group: {
      _id: groupId,
      ...Object.fromEntries(measures.map(({ internalName, accumulator }) => [internalName, accumulator])),
    },
  });
  stages.push({
    $project: {
      _id: 0,
      ...Object.fromEntries(dimensions.map(({ outputId }) => [outputId, `$_id.${outputId}`])),
      ...Object.fromEntries(measures.map(({ outputId, projection }) => [outputId, projection])),
    },
  });
  if (spec.orderBy.length > 0) {
    stages.push({
      $sort: Object.fromEntries(spec.orderBy.map(({ outputId, direction }) => [outputId, direction === "desc" ? -1 : 1])),
    });
  }
  const limit = spec.output === "scalar" ? 1 : Math.min(spec.limit, input.maxRows);
  if (limit < 1) throw new AnalysisCompilerError("query_limit_exceeded", "The analysis result limit is outside the configured budget.");
  stages.push({ $limit: limit });
  return mongoQuery(context, stages, [
    ...dimensions.map(({ outputId, label, type }) => ({ outputId, label, type })),
    ...measures.map(({ outputId, label, type }) => ({ outputId, label, type })),
  ]);
}

function compileBoundMongoRecords(context: ResolvedContext, maxRows: number): CompiledQuery {
  if (context.spec.mode !== "records") {
    throw new AnalysisCompilerError("invalid_analysis_spec", "A record query must use records mode.");
  }
  const fields = context.spec.fields.map(({ fieldId, outputId }) => {
    const field = resolveField(context, fieldId);
    if (field.exposure !== "bounded-values") {
      throw new AnalysisCompilerError("invalid_analysis_spec", "A record projection can only return a model-visible field.");
    }
    return {
      outputId,
      expression: mongoFieldExpression(context, field),
      label: semanticFieldLabel(context.semantic, fieldId),
      type: field.type,
    };
  });
  const stages = mongoJoinStages(context);
  if (context.spec.filter) stages.push({ $match: { $expr: mongoPredicate(context, context.spec.filter) } });
  if (context.spec.orderBy.length > 0) {
    stages.push({
      $sort: Object.fromEntries(context.spec.orderBy.map(({ fieldId, direction }) => {
        const field = resolveField(context, fieldId);
        if (field.exposure !== "bounded-values") {
          throw new AnalysisCompilerError("invalid_analysis_spec", "A record ordering field must be model-visible.");
        }
        return [mongoFieldPath(context, field), direction === "desc" ? -1 : 1];
      })),
    });
  }
  stages.push({
    $project: {
      _id: 0,
      ...Object.fromEntries(fields.map(({ outputId, expression }) => [outputId, expression])),
    },
  });
  const limit = Math.min(context.spec.limit, maxRows);
  if (limit < 1) throw new AnalysisCompilerError("query_limit_exceeded", "The analysis result limit is outside the configured budget.");
  stages.push({ $limit: limit });
  return mongoQuery(context, stages, fields.map(({ outputId, label, type }) => ({ outputId, label, type })));
}

function compileBoundMongoProbe(input: Readonly<{
  catalog: DatabaseCatalog;
  semanticCatalog: SemanticCatalog;
  bindings: SemanticBindings;
  spec: AnalysisSpec;
  probe: TypedProbeRequest;
}>): CompiledQuery {
  const context = resolveContext({ ...input, maxJoins: Math.max(1, input.spec.relationshipIds.length) });
  const stages = mongoJoinStages(context);
  const requireField = (id: FieldId) => resolveField(context, id);
  switch (input.probe.kind) {
    case "time-bounds": {
      const field = requireField(input.probe.fieldId);
      const expression = mongoFieldExpression(context, field);
      stages.push({ $group: {
        _id: null,
        out_minimum: { $min: expression },
        out_maximum: { $max: expression },
        out_null_count: { $sum: { $cond: [{ $eq: [expression, null] }, 1, 0] } },
      } });
      stages.push({ $project: { _id: 0, out_minimum: 1, out_maximum: 1, out_null_count: 1 } });
      return mongoQuery(context, stages, [
        { outputId: "out_minimum", label: "Minimum", type: field.type },
        { outputId: "out_maximum", label: "Maximum", type: field.type },
        { outputId: "out_null_count", label: "Null count", type: "number" },
      ]);
    }
    case "value-domain": {
      const field = requireField(input.probe.fieldId);
      const expression = mongoFieldExpression(context, field);
      const predicates: unknown[] = [{ $ne: [expression, null] }];
      if (input.probe.candidates?.length) predicates.unshift({ $in: [expression, input.probe.candidates] });
      stages.push({ $match: { $expr: predicates.length === 1 ? predicates[0] : { $and: predicates } } });
      stages.push({ $group: { _id: expression, out_count: { $sum: 1 } } });
      stages.push({ $project: { _id: 0, out_value: "$_id", out_count: 1 } });
      stages.push({ $sort: { out_count: -1, out_value: 1 } });
      stages.push({ $limit: input.probe.maxValues });
      return mongoQuery(context, stages, [
        { outputId: "out_value", label: "Value", type: field.type },
        { outputId: "out_count", label: "Count", type: "number" },
      ]);
    }
    case "field-profile": {
      const fields = input.probe.fieldIds.map(requireField);
      const group: Record<string, unknown> = { _id: null };
      const project: Record<string, unknown> = { _id: 0 };
      const resultColumns: CompiledResultColumn[] = [];
      fields.forEach((field, index) => {
        const expression = mongoFieldExpression(context, field);
        const base = `out_${index}`;
        group[`${base}_non_null`] = { $sum: { $cond: [{ $ne: [expression, null] }, 1, 0] } };
        group[`${base}_null`] = { $sum: { $cond: [{ $eq: [expression, null] }, 1, 0] } };
        group[`${base}_distinct_values`] = { $addToSet: expression };
        project[`${base}_non_null`] = 1;
        project[`${base}_null`] = 1;
        project[`${base}_distinct`] = { $size: { $setDifference: [`$${base}_distinct_values`, [null]] } };
        const label = semanticFieldLabel(context.semantic, field.id);
        resultColumns.push(
          { outputId: `${base}_non_null`, label: `${label} non-null`, type: "number" },
          { outputId: `${base}_null`, label: `${label} null`, type: "number" },
          { outputId: `${base}_distinct`, label: `${label} distinct`, type: "number" },
        );
        if (isNumeric(field.type) || isTime(field.type)) {
          group[`${base}_minimum`] = { $min: expression };
          group[`${base}_maximum`] = { $max: expression };
          project[`${base}_minimum`] = 1;
          project[`${base}_maximum`] = 1;
          resultColumns.push(
            { outputId: `${base}_minimum`, label: `${label} minimum`, type: field.type },
            { outputId: `${base}_maximum`, label: `${label} maximum`, type: field.type },
          );
        }
      });
      stages.push({ $group: group }, { $project: project });
      return mongoQuery(context, stages, resultColumns);
    }
    case "join-coverage": {
      const relationship = input.bindings.relationships.get(input.probe.relationshipId);
      const join = relationship && context.joins.find(({ include }) => (
        include.id === relationship.fromEntityId || include.id === relationship.toEntityId
      ));
      if (!relationship || !join) throw new AnalysisCompilerError("invalid_probe", "The requested relationship is not part of the compiled join graph.");
      const matched = { $and: join.pairs.flatMap(({ left, right }) => [
        { $ne: [mongoFieldExpression(context, left), null] },
        { $ne: [mongoFieldExpression(context, right), null] },
      ]) };
      stages.push({ $group: {
        _id: null,
        out_matched: { $sum: { $cond: [matched, 1, 0] } },
        out_unmatched: { $sum: { $cond: [matched, 0, 1] } },
      } });
      stages.push({ $project: { _id: 0, out_matched: 1, out_unmatched: 1 } });
      return mongoQuery(context, stages, [
        { outputId: "out_matched", label: "Matched", type: "number" },
        { outputId: "out_unmatched", label: "Unmatched", type: "number" },
      ]);
    }
  }
}

function mongoJoinStages(context: ResolvedContext): MongoStage[] {
  const stages: MongoStage[] = [];
  for (const join of context.joins) {
    if (join.include.schema !== context.primary.schema) {
      throw new AnalysisCompilerError("compile_failed", "MongoDB joins must stay within one database.");
    }
    const variables = Object.fromEntries(join.pairs.map(({ left }, index) => [
      `local_${index}`,
      mongoFieldExpression(context, left),
    ]));
    const comparisons = join.pairs.map(({ right }, index) => ({
      $eq: [`$${right.column}`, `$$local_${index}`],
    }));
    stages.push({
      $lookup: {
        from: join.include.table,
        let: variables,
        pipeline: [{ $match: { $expr: comparisons.length === 1 ? comparisons[0] : { $and: comparisons } } }],
        as: join.alias,
      },
    });
    stages.push({ $unwind: { path: `$${join.alias}`, preserveNullAndEmptyArrays: true } });
  }
  return stages;
}

function mongoMeasure(context: ResolvedContext, measure: Measure, index: number): Readonly<{
  outputId: OutputId;
  internalName: string;
  accumulator: unknown;
  projection: unknown;
  label: string;
  type: DataTypeFamily;
}> {
  const metric = measure.kind === "metric" ? resolveMetric(context, measure.metricId) : undefined;
  const aggregate = metric?.aggregate ?? (measure.kind === "aggregate" ? measure.aggregate : undefined);
  if (!aggregate) throw new AnalysisCompilerError("compile_failed", "The MongoDB compiler could not resolve a measure.");
  const fieldId = metric?.fieldId ?? (measure.kind === "aggregate" ? measure.fieldId : undefined);
  const field = fieldId === undefined ? undefined : resolveField(context, fieldId);
  if (aggregate !== "count" && !field) throw new AnalysisCompilerError("invalid_analysis_spec", "This aggregate requires a field.");
  if (["sum", "avg"].includes(aggregate) && field && !isNumeric(field.type)) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "sum and avg require a numeric field.");
  }
  const countField = metric?.aggregate === "count" && metric.entityId !== context.primary.id
    ? context.bindings.fields.get(fieldIdForColumn(context.bindings, metric.entityId, countMetricPrimaryKeyColumn(context.bindings, metric.entityId)))
    : field;
  const expression = countField ? mongoFieldExpression(context, countField) : undefined;
  const internalName = `__measure_${index}`;
  let accumulator: unknown;
  let projection: unknown = `$${internalName}`;
  if (aggregate === "count") accumulator = expression === undefined ? { $sum: 1 } : { $sum: { $cond: [{ $ne: [expression, null] }, 1, 0] } };
  else if (aggregate === "count_distinct") {
    accumulator = { $addToSet: expression };
    projection = { $size: { $setDifference: [`$${internalName}`, [null]] } };
  } else accumulator = { [`$${aggregate}`]: expression };
  return {
    outputId: measure.outputId,
    internalName,
    accumulator,
    projection,
    label: measure.kind === "metric" ? metric!.label : aggregateLabel(aggregate, field && semanticFieldLabel(context.semantic, field.id)),
    type: aggregateResultType(aggregate, field?.type),
  };
}

function fieldIdForColumn(bindings: SemanticBindings, entityId: EntityId, column: string): FieldId {
  const field = [...bindings.fields.values()].find((candidate) => candidate.entityId === entityId && candidate.column === column);
  if (!field) throw new AnalysisCompilerError("compile_failed", "The MongoDB compiler could not resolve a count field.");
  return field.id;
}

function mongoPredicate(context: ResolvedContext, predicate: AnalysisPredicate): unknown {
  switch (predicate.kind) {
    case "all": return { $and: predicate.items.map((item) => mongoPredicate(context, item)) };
    case "any": return { $or: predicate.items.map((item) => mongoPredicate(context, item)) };
    case "not": return { $not: [mongoPredicate(context, predicate.item)] };
    case "null": {
      const expression = mongoFieldExpression(context, resolveField(context, predicate.fieldId));
      return { [predicate.isNull ? "$eq" : "$ne"]: [expression, null] };
    }
    case "comparison": {
      const field = resolveField(context, predicate.fieldId);
      validatePredicateValue(predicate, field);
      const expression = mongoFieldExpression(context, field);
      const values = asValues(predicate.value).map((value) => mongoPredicateValue(field, value));
      if (predicate.op === "contains") {
        return { $regexMatch: {
          input: { $convert: { input: expression, to: "string", onError: "", onNull: "" } },
          regex: escapeRegex(String(predicate.value)),
          options: "i",
        } };
      }
      if (predicate.op === "in") return { $in: [expression, values] };
      if (predicate.op === "between") return { $and: [{ $gte: [expression, values[0]] }, { $lte: [expression, values[1]] }] };
      const operator = { eq: "$eq", neq: "$ne", gt: "$gt", gte: "$gte", lt: "$lt", lte: "$lte" }[predicate.op];
      if (!operator) throw new AnalysisCompilerError("invalid_analysis_spec", "The comparison operator is not supported.");
      return { [operator]: [expression, values[0]] };
    }
  }
}

function mongoPredicateValue(field: PhysicalField, value: string | number | boolean): unknown {
  if ((field.type === "date" || field.type === "timestamp") && typeof value === "string") {
    return { $convert: { input: value, to: "date", onError: null, onNull: null } };
  }
  return value;
}

function mongoTimeBucket(
  expression: string,
  grain: Extract<Dimension, { kind: "time" }>["grain"],
  field: PhysicalField,
): unknown {
  if (!isTime(field.type)) throw new AnalysisCompilerError("invalid_analysis_spec", "A time dimension requires a date or timestamp field.");
  return {
    $dateTrunc: {
      date: expression,
      unit: grain,
      ...(grain === "week" ? { startOfWeek: "monday" } : {}),
    },
  };
}

function mongoFieldExpression(context: ResolvedContext, field: PhysicalField): string {
  return `$${mongoFieldPath(context, field)}`;
}

function mongoFieldPath(context: ResolvedContext, field: PhysicalField): string {
  return field.entityId === context.primary.id ? field.column : `${aliasFor(context, field.entityId)}.${field.column}`;
}

function mongoQuery(
  context: ResolvedContext,
  pipeline: readonly MongoStage[],
  resultColumns: readonly CompiledResultColumn[],
): CompiledQuery {
  return {
    kind: "mongodb",
    database: context.primary.schema,
    collection: context.primary.table,
    pipeline: pipeline.map((stage) => structuredClone(stage)),
    sourceRelationIds: [context.primary.id, ...context.joins.map(({ include }) => include.id)],
    resultColumns: [...resultColumns],
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function compileBoundProbe(input: Readonly<{
  catalog: DatabaseCatalog;
  semanticCatalog: SemanticCatalog;
  bindings: SemanticBindings;
  spec: AnalysisSpec;
  probe: TypedProbeRequest;
}>): CompiledQuery {
  validateBoundSpec(input.spec, input.catalog, input.semanticCatalog, input.bindings);
  validateProbe(input.spec, input.probe, input.semanticCatalog, input.bindings);
  if (input.catalog.dialect === "mongodb") return compileBoundMongoProbe(input);
  const context = resolveContext({ ...input, maxJoins: Math.max(1, input.spec.relationshipIds.length) });
  const quote = (value: string) => quoteIdentifier(context.catalog.dialect, value);
  const params = parameterBuilder(context.catalog.dialect);
  const requireField = (id: FieldId) => resolveField(context, id);
  switch (input.probe.kind) {
    case "time-bounds": {
      const field = requireField(input.probe.fieldId);
      if (!isTime(field.type) || field.exposure !== "bounded-values") {
        throw new AnalysisCompilerError("invalid_probe", "A time-bounds probe requires a model-visible date or timestamp field.");
      }
      const expression = fieldExpression(context, field, quote);
      return query({
        sql: `SELECT MIN(${expression}) AS ${quote("out_minimum")}, MAX(${expression}) AS ${quote("out_maximum")}, COUNT(*) - COUNT(${expression}) AS ${quote("out_null_count")}\nFROM ${fromClause(context, quote)}`,
        sourceRelationIds: [field.entityId],
        resultColumns: [
          { outputId: "out_minimum", label: "Minimum", type: field.type },
          { outputId: "out_maximum", label: "Maximum", type: field.type },
          { outputId: "out_null_count", label: "Null count", type: "number" },
        ],
      });
    }
    case "value-domain": {
      const field = requireField(input.probe.fieldId);
      if (field.exposure !== "bounded-values") {
        throw new AnalysisCompilerError("invalid_probe", "This field is aggregate-only and cannot be enumerated.");
      }
      const expression = fieldExpression(context, field, quote);
      const candidatePredicate = input.probe.candidates?.length
        ? `${expression} IN (${input.probe.candidates.map((candidate) => params.take(candidate)).join(", ")}) AND `
        : "";
      return query({
        sql: `SELECT ${expression} AS ${quote("out_value")}, COUNT(*) AS ${quote("out_count")}\nFROM ${fromClause(context, quote)}\nWHERE ${candidatePredicate}${expression} IS NOT NULL\nGROUP BY 1 ORDER BY 2 DESC, 1 ASC\nLIMIT ${input.probe.maxValues}`,
        parameters: params.values,
        sourceRelationIds: [field.entityId],
        resultColumns: [
          { outputId: "out_value", label: "Value", type: field.type },
          { outputId: "out_count", label: "Count", type: "number" },
        ],
      });
    }
    case "field-profile": {
      const fields = input.probe.fieldIds.map(requireField);
      if (fields.some((field) => field.exposure !== "bounded-values")) {
        throw new AnalysisCompilerError("invalid_probe", "A field profile can only inspect model-visible fields.");
      }
      const projections = fields.flatMap((field, index) => {
        const expression = fieldExpression(context, field, quote);
        const base = `out_${index}`;
        const extrema = isNumeric(field.type) || isTime(field.type)
          ? [`MIN(${expression}) AS ${quote(`${base}_minimum`)}`, `MAX(${expression}) AS ${quote(`${base}_maximum`)}`]
          : [];
        return [
          `COUNT(${expression}) AS ${quote(`${base}_non_null`)}`,
          `COUNT(*) - COUNT(${expression}) AS ${quote(`${base}_null`)}`,
          `COUNT(DISTINCT ${expression}) AS ${quote(`${base}_distinct`)}`,
          ...extrema,
        ];
      });
      const resultColumns = fields.flatMap((field, index) => {
        const base = `out_${index}`;
        const label = semanticFieldLabel(context.semantic, field.id);
        return [
          { outputId: `${base}_non_null`, label: `${label} non-null`, type: "number" as const },
          { outputId: `${base}_null`, label: `${label} null`, type: "number" as const },
          { outputId: `${base}_distinct`, label: `${label} distinct`, type: "number" as const },
          ...(isNumeric(field.type) || isTime(field.type)
            ? [
              { outputId: `${base}_minimum`, label: `${label} minimum`, type: field.type },
              { outputId: `${base}_maximum`, label: `${label} maximum`, type: field.type },
            ]
            : []),
        ];
      });
      return query({
        sql: `SELECT ${projections.join(", ")}\nFROM ${fromClause(context, quote)}`,
        sourceRelationIds: [...new Set(fields.map((field) => field.entityId))],
        resultColumns,
      });
    }
    case "join-coverage": {
      const relationship = input.bindings.relationships.get(input.probe.relationshipId);
      if (!relationship || !context.spec.relationshipIds.includes(relationship.id)) {
        throw new AnalysisCompilerError("invalid_probe", "The join coverage probe must refer to a relationship selected by this analysis.");
      }
      const join = context.joins.find(({ include }) => include.id === relationship.fromEntityId || include.id === relationship.toEntityId);
      if (!join) throw new AnalysisCompilerError("invalid_probe", "The requested relationship is not part of the compiled join graph.");
      const match = join.pairs.map(({ left, right }) => `${fieldExpression(context, left, quote)} IS NOT NULL AND ${fieldExpression(context, right, quote)} IS NOT NULL`).join(" AND ");
      return query({
        sql: context.catalog.dialect === "postgres"
          ? `SELECT COUNT(*) FILTER (WHERE ${match}) AS ${quote("out_matched")}, COUNT(*) FILTER (WHERE NOT (${match})) AS ${quote("out_unmatched")}\nFROM ${fromClause(context, quote)}`
          : `SELECT SUM(CASE WHEN ${match} THEN 1 ELSE 0 END) AS ${quote("out_matched")}, SUM(CASE WHEN NOT (${match}) THEN 1 ELSE 0 END) AS ${quote("out_unmatched")}\nFROM ${fromClause(context, quote)}`,
        sourceRelationIds: [relationship.fromEntityId, relationship.toEntityId],
        resultColumns: [
          { outputId: "out_matched", label: "Matched", type: "number" },
          { outputId: "out_unmatched", label: "Unmatched", type: "number" },
        ],
      });
    }
  }
}

export function queryFingerprint(compiled: CompiledQuery): string {
  return `query_${createHash("sha256")
    .update(stableJson("sql" in compiled
      ? { sql: compiled.sql, parameters: compiled.parameters, sources: compiled.sourceRelationIds }
      : { database: compiled.database, collection: compiled.collection, pipeline: compiled.pipeline, sources: compiled.sourceRelationIds }))
    .digest("hex")
    .slice(0, 24)}`;
}

type SemanticFieldRecord = Readonly<{ entity: SemanticEntity; field: SemanticField }>;
type SemanticMetricRecord = Readonly<{ entity: SemanticEntity; metric: SemanticMetric }>;

function parseDraft(value: unknown): AnalysisDraft {
  try {
    return analysisDraftSchema.parse(value);
  } catch (error) {
    throw compilerErrorFrom(error, "invalid_analysis_spec");
  }
}

function parseSpec(value: unknown): AnalysisSpec {
  try {
    return analysisSpecSchema.parse(value);
  } catch (error) {
    throw compilerErrorFrom(error, "invalid_analysis_spec");
  }
}

function parseProbe(value: unknown): TypedProbeRequest {
  try {
    return typedProbeRequestSchema.parse(value);
  } catch (error) {
    throw compilerErrorFrom(error, "invalid_probe");
  }
}

function parseSemanticCatalog(catalog: DatabaseCatalog, value: SemanticCatalog): SemanticCatalog {
  let semanticCatalog: SemanticCatalog;
  try {
    semanticCatalog = semanticCatalogSchema.parse(value);
  } catch (error) {
    throw compilerErrorFrom(error, "invalid_semantic_catalog");
  }
  if (semanticCatalog.ref.catalogFingerprint !== catalog.fingerprint) {
    throw new AnalysisCompilerError("catalog_stale", "The semantic catalog was generated from a different physical catalog.");
  }
  return semanticCatalog;
}

function parseSemanticCatalogRef(spec: AnalysisSpec, value: SemanticCatalog): SemanticCatalog {
  let semanticCatalog: SemanticCatalog;
  try {
    semanticCatalog = semanticCatalogSchema.parse(value);
  } catch (error) {
    throw compilerErrorFrom(error, "invalid_semantic_catalog");
  }
  if (spec.semanticCatalog.fingerprint !== semanticCatalog.ref.fingerprint
    || spec.semanticCatalog.catalogFingerprint !== semanticCatalog.ref.catalogFingerprint) {
    throw new AnalysisCompilerError("catalog_stale", "The analysis is bound to a different semantic catalog.");
  }
  return semanticCatalog;
}

function bindingsFor(catalog: DatabaseCatalog, semanticCatalog: SemanticCatalog): SemanticBindings {
  try {
    return bindSemanticCatalog(catalog, semanticCatalog);
  } catch (error) {
    throw compilerErrorFrom(error, "invalid_semantic_catalog");
  }
}

function validateBoundSpec(
  spec: AnalysisSpec,
  catalog: DatabaseCatalog,
  semanticCatalog: SemanticCatalog,
  bindings: SemanticBindings,
): void {
  if (spec.catalog.connectorId !== catalog.connectorId
    || spec.catalog.catalogFingerprint !== catalog.fingerprint
    || spec.semanticCatalog.catalogFingerprint !== catalog.fingerprint
    || spec.semanticCatalog.fingerprint !== semanticCatalog.ref.fingerprint) {
    throw new AnalysisCompilerError("catalog_stale", "The analysis was created for a different catalog revision.");
  }
  validateDraft(spec, semanticCatalog, bindings);
}

function validateDraft(
  draft: AnalysisDraft,
  semanticCatalog: SemanticCatalog,
  bindings: SemanticBindings,
): void {
  const entities = new Map(semanticCatalog.entities.map((entity) => [entity.id, entity]));
  const primary = entities.get(draft.primaryEntityId);
  if (!primary || !bindings.entities.has(primary.id)) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "The primary business entity is not available.");
  }
  const relationships = new Map(semanticCatalog.relationships.map((relationship) => [relationship.id, relationship]));
  const selected = resolveSelectedEntities(primary.id, draft.relationshipIds, relationships);
  const fields = semanticFields(semanticCatalog);
  const metrics = semanticMetrics(semanticCatalog);
  const outputIds = new Set<string>();
  const addOutput = (outputId: string) => {
    if (outputIds.has(outputId)) {
      throw new AnalysisCompilerError("invalid_analysis_spec", "Analysis output identifiers must be unique.");
    }
    outputIds.add(outputId);
  };

  if (draft.mode === "records") {
    for (const projection of draft.fields) {
      addOutput(projection.outputId);
      const field = requireSelectedField(fields, selected, projection.fieldId);
      if (field.field.exposure !== "bounded-values") {
        throw new AnalysisCompilerError("invalid_analysis_spec", "A record projection can only return a model-visible field.");
      }
    }
    for (const order of draft.orderBy) {
      const field = requireSelectedField(fields, selected, order.fieldId);
      if (field.field.exposure !== "bounded-values") {
        throw new AnalysisCompilerError("invalid_analysis_spec", "A record ordering field must be model-visible.");
      }
    }
    if (draft.filter !== undefined) validatePredicate(draft.filter, fields, selected);
    return;
  }

  for (const dimension of draft.dimensions) {
    addOutput(dimension.outputId);
    const field = requireSelectedField(fields, selected, dimension.fieldId);
    if (field.field.exposure !== "bounded-values") {
      throw new AnalysisCompilerError("invalid_analysis_spec", "An aggregate-only field cannot be returned as a dimension.");
    }
    if (dimension.kind === "time" && !isTime(field.field.type)) {
      throw new AnalysisCompilerError("invalid_analysis_spec", "A time dimension requires a date or timestamp field.");
    }
  }
  for (const measure of draft.measures) {
    addOutput(measure.outputId);
    if (measure.kind === "metric") {
      const metric = metrics.get(measure.metricId);
      if (!metric || !selected.has(metric.entity.id)) {
        throw new AnalysisCompilerError("invalid_analysis_spec", "The metric is not part of the approved analysis graph.");
      }
      validateAggregate(metric.metric.aggregate, metric.metric.fieldId, fields, selected);
    } else {
      validateAggregate(measure.aggregate, measure.fieldId, fields, selected);
    }
  }
  assertFanoutSafeMeasures(draft, fields, metrics, relationships);
  assertJoinedCountMetricsHavePrimaryKeys(draft, metrics, bindings);
  if (draft.output === "scalar" && draft.dimensions.length > 0) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "A scalar analysis cannot include dimensions.");
  }
  if (draft.output === "series" && !draft.dimensions.some((dimension) => dimension.kind === "time")) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "A series analysis requires a time dimension.");
  }
  if (draft.output === "ranking" && draft.dimensions.length === 0) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "A ranking analysis requires a dimension.");
  }
  if (draft.output !== "scalar" && draft.orderBy.length === 0) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "A non-scalar analysis requires an explicit ordering.");
  }
  for (const order of draft.orderBy) {
    if (!outputIds.has(order.outputId)) {
      throw new AnalysisCompilerError("invalid_analysis_spec", "An ordering target is not part of the analysis output.");
    }
  }
  if (draft.filter !== undefined) validatePredicate(draft.filter, fields, selected);
}

/**
 * A selected relationship graph is a tree. For an aggregate over entity E,
 * every path from E must preserve at most one joined row per E row. Traversing
 * a one-to-many edge away from E can duplicate E rows and would inflate
 * COUNT(*), SUM, or AVG. Count distinct and extrema are stable under that
 * duplication, so they remain available.
 */
function assertFanoutSafeMeasures(
  draft: Extract<AnalysisDraft, { mode: "aggregate" }>,
  fields: ReadonlyMap<FieldId, SemanticFieldRecord>,
  metrics: ReadonlyMap<string, SemanticMetricRecord>,
  relationships: ReadonlyMap<string, SemanticRelationship>,
): void {
  const selectedRelationships = draft.relationshipIds.map((relationshipId) => {
    const relationship = relationships.get(relationshipId);
    if (!relationship) throw new AnalysisCompilerError("invalid_analysis_spec", "The requested relationship is not available.");
    return relationship;
  });

  for (const measure of draft.measures) {
    const entityId = aggregateEntityForFanoutCheck(measure, draft.primaryEntityId, fields, metrics);
    if (entityId !== undefined && joinGraphCanMultiplyEntity(entityId, selectedRelationships)) {
      throw new AnalysisCompilerError(
        "invalid_analysis_spec",
        "The selected join graph can multiply rows for a count, sum, or average at the aggregation entity.",
      );
    }
  }
}

function aggregateEntityForFanoutCheck(
  measure: Measure,
  primaryEntityId: EntityId,
  fields: ReadonlyMap<FieldId, SemanticFieldRecord>,
  metrics: ReadonlyMap<string, SemanticMetricRecord>,
): EntityId | undefined {
  if (measure.kind === "metric") {
    const metric = metrics.get(measure.metricId);
    return metric && isFanoutSensitiveAggregate(metric.metric.aggregate) ? metric.entity.id : undefined;
  }
  if (!isFanoutSensitiveAggregate(measure.aggregate)) return undefined;
  if (measure.aggregate === "count") return primaryEntityId;
  return measure.fieldId === undefined ? undefined : fields.get(measure.fieldId)?.entity.id;
}

function isFanoutSensitiveAggregate(aggregate: Aggregate): boolean {
  return aggregate === "count" || aggregate === "sum" || aggregate === "avg";
}

function assertJoinedCountMetricsHavePrimaryKeys(
  draft: Extract<AnalysisDraft, { mode: "aggregate" }>,
  metrics: ReadonlyMap<string, SemanticMetricRecord>,
  bindings: SemanticBindings,
): void {
  for (const measure of draft.measures) {
    if (measure.kind !== "metric") continue;
    const metric = metrics.get(measure.metricId);
    if (metric?.metric.aggregate === "count" && metric.entity.id !== draft.primaryEntityId) {
      countMetricPrimaryKeyColumn(bindings, metric.entity.id);
    }
  }
}

function joinGraphCanMultiplyEntity(
  entityId: EntityId,
  relationships: readonly SemanticRelationship[],
): boolean {
  const edges = new Map<EntityId, Array<Readonly<{ entityId: EntityId; expands: boolean }>>>();
  const addEdge = (from: EntityId, to: EntityId, expands: boolean) => {
    const adjacent = edges.get(from) ?? [];
    adjacent.push({ entityId: to, expands });
    edges.set(from, adjacent);
  };

  for (const relationship of relationships) {
    addEdge(
      relationship.fromEntityId,
      relationship.toEntityId,
      relationship.cardinality === "one-to-many",
    );
    addEdge(
      relationship.toEntityId,
      relationship.fromEntityId,
      relationship.cardinality === "many-to-one",
    );
  }

  const visited = new Set<EntityId>([entityId]);
  const pending = [entityId];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined) break;
    for (const edge of edges.get(current) ?? []) {
      if (visited.has(edge.entityId)) continue;
      if (edge.expands) return true;
      visited.add(edge.entityId);
      pending.push(edge.entityId);
    }
  }
  return false;
}

function resolveSelectedEntities(
  primaryEntityId: EntityId,
  relationshipIds: readonly string[],
  relationships: ReadonlyMap<string, SemanticRelationship>,
): Set<EntityId> {
  if (new Set(relationshipIds).size !== relationshipIds.length) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "A relationship may only be selected once.");
  }
  const selected = new Set<EntityId>([primaryEntityId]);
  for (const relationshipId of relationshipIds) {
    const relationship = relationships.get(relationshipId);
    if (!relationship) throw new AnalysisCompilerError("invalid_analysis_spec", "The requested relationship is not available.");
    const hasFrom = selected.has(relationship.fromEntityId);
    const hasTo = selected.has(relationship.toEntityId);
    if (hasFrom === hasTo) {
      throw new AnalysisCompilerError("invalid_analysis_spec", "Selected relationships must form a connected, acyclic join graph.");
    }
    selected.add(hasFrom ? relationship.toEntityId : relationship.fromEntityId);
  }
  return selected;
}

function semanticFields(catalog: SemanticCatalog): Map<FieldId, SemanticFieldRecord> {
  const result = new Map<FieldId, SemanticFieldRecord>();
  for (const entity of catalog.entities) {
    for (const field of entity.fields) {
      if (result.has(field.id)) throw new AnalysisCompilerError("invalid_semantic_catalog", "The semantic catalog contains duplicate field identifiers.");
      result.set(field.id, { entity, field });
    }
  }
  return result;
}

function semanticMetrics(catalog: SemanticCatalog): Map<string, SemanticMetricRecord> {
  const result = new Map<string, SemanticMetricRecord>();
  for (const entity of catalog.entities) {
    for (const metric of entity.metrics) {
      if (result.has(metric.id)) throw new AnalysisCompilerError("invalid_semantic_catalog", "The semantic catalog contains duplicate metric identifiers.");
      result.set(metric.id, { entity, metric });
    }
  }
  return result;
}

function requireSelectedField(
  fields: ReadonlyMap<FieldId, SemanticFieldRecord>,
  selected: ReadonlySet<EntityId>,
  fieldId: FieldId,
): SemanticFieldRecord {
  const field = fields.get(fieldId);
  if (!field || !selected.has(field.entity.id)) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "A field is not part of the approved analysis graph.");
  }
  return field;
}

function validateAggregate(
  aggregate: Aggregate,
  fieldId: FieldId | undefined,
  fields: ReadonlyMap<FieldId, SemanticFieldRecord>,
  selected: ReadonlySet<EntityId>,
): void {
  if (aggregate === "count") {
    if (fieldId !== undefined) throw new AnalysisCompilerError("invalid_analysis_spec", "count cannot target a field.");
    return;
  }
  if (fieldId === undefined) throw new AnalysisCompilerError("invalid_analysis_spec", `${aggregate} requires a field.`);
  const field = requireSelectedField(fields, selected, fieldId).field;
  if (["sum", "avg"].includes(aggregate) && !isNumeric(field.type)) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "sum and avg require a numeric field.");
  }
  if (["min", "max"].includes(aggregate) && field.exposure !== "bounded-values") {
    throw new AnalysisCompilerError("invalid_analysis_spec", "min and max cannot expose aggregate-only values.");
  }
}

function validatePredicate(
  predicate: AnalysisPredicate,
  fields: ReadonlyMap<FieldId, SemanticFieldRecord>,
  selected: ReadonlySet<EntityId>,
): void {
  switch (predicate.kind) {
    case "all":
    case "any":
      predicate.items.forEach((item) => validatePredicate(item, fields, selected));
      return;
    case "not":
      validatePredicate(predicate.item, fields, selected);
      return;
    case "null":
      requireSelectedField(fields, selected, predicate.fieldId);
      return;
    case "comparison": {
      const field = requireSelectedField(fields, selected, predicate.fieldId).field;
      validatePredicateValueForType(predicate, field.type);
      return;
    }
  }
}

function validatePredicateValueForType(
  predicate: Extract<AnalysisPredicate, { kind: "comparison" }>,
  type: DataTypeFamily,
): void {
  const isArray = Array.isArray(predicate.value);
  if ((predicate.op === "in" || predicate.op === "between") !== isArray) {
    throw new AnalysisCompilerError("invalid_analysis_spec", `${predicate.op} requires ${predicate.op === "between" ? "two" : "one or more"} values.`);
  }
  const values = asValues(predicate.value);
  if (predicate.op === "between" && values.length !== 2) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "between requires exactly two values.");
  }
  if (predicate.op === "contains" && (type !== "string" || typeof predicate.value !== "string")) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "contains requires a text field and a text value.");
  }
  if (["gt", "gte", "lt", "lte", "between"].includes(predicate.op) && !isComparable(type)) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "Range predicates require number, date, or timestamp fields.");
  }
  if (isNumeric(type) && values.some((value) => typeof value !== "number")) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "Numeric field predicates require numeric values.");
  }
  if (isTime(type) && values.some((value) => typeof value !== "string")) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "Date and timestamp predicates require ISO text values.");
  }
  if (type === "boolean" && values.some((value) => typeof value !== "boolean")) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "Boolean field predicates require true or false values.");
  }
  if (["string", "json", "unknown"].includes(type) && values.some((value) => typeof value !== "string")) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "Text field predicates require text values.");
  }
}

function validateProbe(
  spec: AnalysisSpec,
  probe: TypedProbeRequest,
  semanticCatalog: SemanticCatalog,
  bindings: SemanticBindings,
): void {
  const fields = semanticFields(semanticCatalog);
  const selected = resolveSelectedEntities(spec.primaryEntityId, spec.relationshipIds, new Map(semanticCatalog.relationships.map((relationship) => [relationship.id, relationship])));
  if (probe.kind === "time-bounds") {
    const field = requireSelectedField(fields, selected, probe.fieldId).field;
    if (!isTime(field.type) || field.exposure !== "bounded-values") throw new AnalysisCompilerError("invalid_probe", "A time-bounds probe requires a model-visible time field.");
    return;
  }
  if (probe.kind === "value-domain") {
    const field = requireSelectedField(fields, selected, probe.fieldId).field;
    if (field.type !== "string" || field.exposure !== "bounded-values") throw new AnalysisCompilerError("invalid_probe", "A value-domain probe requires a model-visible text field.");
    return;
  }
  if (probe.kind === "field-profile") {
    for (const fieldId of probe.fieldIds) {
      if (requireSelectedField(fields, selected, fieldId).field.exposure !== "bounded-values") {
        throw new AnalysisCompilerError("invalid_probe", "A field profile can only inspect model-visible fields.");
      }
    }
    return;
  }
  const relationship = bindings.relationships.get(probe.relationshipId);
  if (!relationship || !spec.relationshipIds.includes(relationship.id)) {
    throw new AnalysisCompilerError("invalid_probe", "The join coverage probe must target a selected relationship.");
  }
}

function predicateFieldIds(predicate: AnalysisPredicate | undefined): FieldId[] {
  if (predicate === undefined) return [];
  switch (predicate.kind) {
    case "all":
    case "any": return predicate.items.flatMap(predicateFieldIds);
    case "not": return predicateFieldIds(predicate.item);
    case "null": return [];
    case "comparison": return [predicate.fieldId];
  }
}

function predicateCandidates(predicate: AnalysisPredicate | undefined, output = new Map<FieldId, string[]>()): Map<FieldId, string[]> {
  if (predicate === undefined) return output;
  if (predicate.kind === "all" || predicate.kind === "any") {
    predicate.items.forEach((item) => predicateCandidates(item, output));
    return output;
  }
  if (predicate.kind === "not") return predicateCandidates(predicate.item, output);
  if (predicate.kind !== "comparison" || !["eq", "in"].includes(predicate.op)) return output;
  const candidates = asValues(predicate.value).filter((value): value is string => typeof value === "string");
  if (candidates.length === 0) return output;
  const values = output.get(predicate.fieldId) ?? [];
  for (const candidate of candidates) {
    if (!values.includes(candidate) && values.length < 32) values.push(candidate);
  }
  output.set(predicate.fieldId, values);
  return output;
}

function probeFieldKey(probe: TypedProbeRequest): string {
  if (probe.kind === "field-profile") return probe.fieldIds.join(",");
  if (probe.kind === "join-coverage") return probe.relationshipId;
  return probe.fieldId;
}

function probeId(specId: string, kind: string, target: string): string {
  return `probe_${hash(`${specId}\u0000${kind}\u0000${target}`).slice(0, 24)}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clamp(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(candidate)));
}

function compilerErrorFrom(error: unknown, fallback: AnalysisCompilerError["code"]): AnalysisCompilerError {
  if (error instanceof AnalysisCompilerError) return error;
  if (error instanceof SemanticCatalogError) return new AnalysisCompilerError("invalid_semantic_catalog", error.message);
  return new AnalysisCompilerError(fallback, "The structured analysis input could not be validated.");
}

function resolveContext(input: Readonly<{
  catalog: DatabaseCatalog;
  semanticCatalog: SemanticCatalog;
  bindings: SemanticBindings;
  spec: AnalysisSpec;
  maxJoins: number;
}>): ResolvedContext {
  const { catalog, semanticCatalog, bindings, spec } = input;
  if (spec.catalog.connectorId !== catalog.connectorId || spec.catalog.catalogFingerprint !== catalog.fingerprint || spec.semanticCatalog.fingerprint !== semanticCatalog.ref.fingerprint || spec.semanticCatalog.catalogFingerprint !== catalog.fingerprint) {
    throw new AnalysisCompilerError("catalog_stale", "The analysis was planned against a stale catalog snapshot.");
  }
  const primary = bindings.entities.get(spec.primaryEntityId);
  if (!primary) throw new AnalysisCompilerError("invalid_analysis_spec", "The primary business entity is unavailable.");
  if (spec.relationshipIds.length > input.maxJoins) {
    throw new AnalysisCompilerError("query_limit_exceeded", "The analysis exceeds the maximum approved join budget.");
  }
  const entities = new Map<string, PhysicalEntity>([[primary.id, primary]]);
  const aliases = new Map<string, string>([[primary.id, "t0"]]);
  const joins: ResolvedJoin[] = [];
  for (const relationshipId of spec.relationshipIds) {
    const relationship = bindings.relationships.get(relationshipId);
    if (!relationship) throw new AnalysisCompilerError("invalid_analysis_spec", "The requested relationship is unavailable.");
    const from = bindings.entities.get(relationship.fromEntityId);
    const to = bindings.entities.get(relationship.toEntityId);
    if (!from || !to) throw new AnalysisCompilerError("compile_failed", "The semantic relationship has no physical binding.");
    const fromPresent = entities.has(from.id);
    const toPresent = entities.has(to.id);
    if (fromPresent === toPresent) {
      throw new AnalysisCompilerError("invalid_analysis_spec", "Selected relationships must create one connected, acyclic join graph.");
    }
    const existing = fromPresent ? from : to;
    const include = fromPresent ? to : from;
    const pairs = relationship.pairs.map(({ fromFieldId, toFieldId }) => {
      const fromField = bindings.fields.get(fromFieldId);
      const toField = bindings.fields.get(toFieldId);
      if (!fromField || !toField) throw new AnalysisCompilerError("compile_failed", "The semantic relationship has no physical field binding.");
      return fromPresent ? { left: fromField, right: toField } : { left: toField, right: fromField };
    });
    if (!entities.has(existing.id)) throw new AnalysisCompilerError("invalid_analysis_spec", "The relationship does not attach to the analysis graph.");
    entities.set(include.id, include);
    aliases.set(include.id, `t${entities.size - 1}`);
    joins.push({ include, alias: aliases.get(include.id) ?? "t1", pairs });
  }
  return { catalog, semantic: semanticCatalog, bindings, spec, primary, entities, aliases, joins };
}

function resolveDimension(context: ResolvedContext, dimension: Dimension): Readonly<{ outputId: OutputId; expression: string; label: string; type: DataTypeFamily }> {
  const field = resolveField(context, dimension.fieldId);
  if (field.exposure !== "bounded-values") {
    throw new AnalysisCompilerError("invalid_analysis_spec", "An aggregate-only field cannot be returned as a dimension.");
  }
  const quote = (value: string) => quoteIdentifier(context.catalog.dialect, value);
  const source = fieldExpression(context, field, quote);
  if (dimension.kind === "field") return { outputId: dimension.outputId, expression: source, label: semanticFieldLabel(context.semantic, dimension.fieldId), type: field.type };
  if (!isTime(field.type)) throw new AnalysisCompilerError("invalid_analysis_spec", "A time dimension requires a date or timestamp field.");
  return {
    outputId: dimension.outputId,
    expression: timeBucket(context.catalog.dialect, source, dimension.grain),
    label: `${semanticFieldLabel(context.semantic, dimension.fieldId)} by ${dimension.grain}`,
    type: dimension.grain === "hour" ? "timestamp" : "date",
  };
}

function resolveMeasure(context: ResolvedContext, measure: Measure): Readonly<{ outputId: OutputId; expression: string; label: string; type: DataTypeFamily }> {
  let metric: ReturnType<typeof resolveMetric> | undefined;
  let resolved: Readonly<{ aggregate: Aggregate; fieldId?: FieldId; label: string }>;
  if (measure.kind === "metric") {
    metric = resolveMetric(context, measure.metricId);
    resolved = metric;
  } else {
    resolved = { aggregate: measure.aggregate, fieldId: measure.fieldId, label: measure.aggregate };
  }
  const field = resolved.fieldId === undefined ? undefined : resolveField(context, resolved.fieldId);
  if (resolved.aggregate !== "count" && !field) throw new AnalysisCompilerError("invalid_analysis_spec", "This aggregate requires a field.");
  if (["sum", "avg"].includes(resolved.aggregate) && field && !isNumeric(field.type)) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "sum and avg require a numeric field.");
  }
  if (["min", "max"].includes(resolved.aggregate) && field && field.exposure !== "bounded-values") {
    throw new AnalysisCompilerError("invalid_analysis_spec", "min and max cannot expose aggregate-only field values.");
  }
  const quote = (value: string) => quoteIdentifier(context.catalog.dialect, value);
  // COUNT(*) is only correct for the primary relation. A metric from an
  // optional LEFT JOIN must count a non-null key from the metric's relation;
  // otherwise an unmatched primary row incorrectly contributes one.
  const aggregateField = metric?.aggregate === "count" && metric.entityId !== context.primary.id
    ? countMetricPrimaryKeyExpression(context, metric.entityId, quote)
    : field === undefined
      ? undefined
      : fieldExpression(context, field, quote);
  const expression = aggregateExpression(resolved.aggregate, aggregateField);
  return {
    outputId: measure.outputId,
    expression,
    label: measure.kind === "metric" ? resolved.label : aggregateLabel(resolved.aggregate, field && semanticFieldLabel(context.semantic, field.id)),
    type: aggregateResultType(resolved.aggregate, field?.type),
  };
}

function resolveMetric(context: ResolvedContext, metricId: string): Readonly<{ aggregate: Aggregate; fieldId?: FieldId; entityId: EntityId; label: string }> {
  const metric = context.bindings.metrics.get(metricId);
  const semantic = context.semantic.entities.flatMap((entity) => entity.metrics).find((candidate) => candidate.id === metricId);
  if (!metric || !semantic || !context.entities.has(metric.entityId)) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "The selected metric is not part of the approved analysis graph.");
  }
  return {
    aggregate: metric.aggregate,
    ...(metric.fieldId === undefined ? {} : { fieldId: metric.fieldId }),
    entityId: metric.entityId,
    label: semantic.label,
  };
}

function countMetricPrimaryKeyExpression(
  context: ResolvedContext,
  entityId: EntityId,
  quote: (value: string) => string,
): string {
  const primaryKey = countMetricPrimaryKeyColumn(context.bindings, entityId);
  return `${quote(aliasFor(context, entityId))}.${quote(primaryKey)}`;
}

function countMetricPrimaryKeyColumn(bindings: SemanticBindings, entityId: EntityId): string {
  const entity = bindings.entities.get(entityId);
  const primaryKey = entity?.source.primaryKey
    .map((columnName) => entity.source.columns.find((column) => column.name === columnName && !column.nullable))
    .find((column) => column !== undefined);
  if (!primaryKey) {
    throw new AnalysisCompilerError(
      "invalid_analysis_spec",
      "A count metric outside the primary relation requires a non-null primary key.",
    );
  }
  return primaryKey.name;
}

function resolveField(context: ResolvedContext, fieldId: FieldId): PhysicalField {
  const field = context.bindings.fields.get(fieldId);
  if (!field || !context.entities.has(field.entityId)) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "A selected field is not part of the approved analysis graph.");
  }
  return field;
}

function compilePredicate(
  context: ResolvedContext,
  predicate: AnalysisPredicate,
  fieldExpressionFor: (field: PhysicalField) => string,
  params: ParameterBuilder,
  quote: (value: string) => string,
): string {
  switch (predicate.kind) {
    case "all": return `(${predicate.items.map((item) => compilePredicate(context, item, fieldExpressionFor, params, quote)).join(" AND ")})`;
    case "any": return `(${predicate.items.map((item) => compilePredicate(context, item, fieldExpressionFor, params, quote)).join(" OR ")})`;
    case "not": return `(NOT ${compilePredicate(context, predicate.item, fieldExpressionFor, params, quote)})`;
    case "null": {
      const field = resolveField(context, predicate.fieldId);
      return `${fieldExpressionFor(field)} IS ${predicate.isNull ? "NULL" : "NOT NULL"}`;
    }
    case "comparison": {
      const field = resolveField(context, predicate.fieldId);
      validatePredicateValue(predicate, field);
      const expression = fieldExpressionFor(field);
      if (predicate.op === "contains") {
        const value = params.take(`%${escapeLike(String(predicate.value))}%`);
        return context.catalog.dialect === "postgres" ? `${expression} ILIKE ${value}` : `LOWER(${expression}) LIKE LOWER(${value})`;
      }
      if (predicate.op === "in") {
        const values = asValues(predicate.value);
        return `${expression} IN (${values.map((value) => params.take(value)).join(", ")})`;
      }
      if (predicate.op === "between") {
        const values = asValues(predicate.value);
        if (values.length !== 2) throw new AnalysisCompilerError("invalid_analysis_spec", "between requires exactly two values.");
        return `${expression} BETWEEN ${params.take(values[0]!)} AND ${params.take(values[1]!)}`;
      }
      const operator = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[predicate.op];
      if (!operator) throw new AnalysisCompilerError("invalid_analysis_spec", "The comparison operator is not supported.");
      return `${expression} ${operator} ${params.take(asValues(predicate.value)[0]!)}`;
    }
  }
}

function validatePredicateValue(predicate: Extract<AnalysisPredicate, { kind: "comparison" }>, field: PhysicalField): void {
  const values = asValues(predicate.value);
  if (predicate.op === "contains" && field.type !== "string") {
    throw new AnalysisCompilerError("invalid_analysis_spec", "contains requires a text field.");
  }
  if (["gt", "gte", "lt", "lte", "between"].includes(predicate.op) && !isComparable(field.type)) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "Range predicates require number, date, or timestamp fields.");
  }
  if (isNumeric(field.type) && values.some((value) => typeof value !== "number")) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "Numeric field predicates require numeric values.");
  }
  if (field.type === "boolean" && values.some((value) => typeof value !== "boolean")) {
    throw new AnalysisCompilerError("invalid_analysis_spec", "Boolean field predicates require true or false values.");
  }
}

function query(input: Readonly<{ sql: string; parameters?: readonly (string | number | boolean)[]; sourceRelationIds: readonly string[]; resultColumns: readonly CompiledResultColumn[] }>): CompiledQuery {
  return {
    sql: input.sql,
    parameters: [...(input.parameters ?? [])],
    sourceRelationIds: [...new Set(input.sourceRelationIds)],
    resultColumns: [...input.resultColumns],
  };
}

function parameterBuilder(dialect: DatabaseDialect): ParameterBuilder {
  const values: Array<string | number | boolean> = [];
  return {
    take(value) {
      values.push(value);
      return dialect === "postgres" ? `$${values.length}` : "?";
    },
    get values() { return values; },
  };
}

function fromClause(context: ResolvedContext, quote: (value: string) => string): string {
  const primary = `${quote(context.primary.schema)}.${quote(context.primary.table)} AS ${quote(aliasFor(context, context.primary.id))}`;
  const joins = context.joins.map((join) => {
    const on = join.pairs.map(({ left, right }) => `${fieldExpression(context, left, quote)} = ${fieldExpression(context, right, quote)}`).join(" AND ");
    return `LEFT JOIN ${quote(join.include.schema)}.${quote(join.include.table)} AS ${quote(join.alias)} ON ${on}`;
  });
  return [primary, ...joins].join("\n");
}

function fieldExpression(context: ResolvedContext, field: PhysicalField, quote: (value: string) => string): string {
  return `${quote(aliasFor(context, field.entityId))}.${quote(field.column)}`;
}

function aliasFor(context: ResolvedContext, entityId: string): string {
  const alias = context.aliases.get(entityId);
  if (!alias) throw new AnalysisCompilerError("compile_failed", "The query compiler could not resolve a table alias.");
  return alias;
}

function aggregateExpression(aggregate: Aggregate, field: string | undefined): string {
  if (aggregate === "count") return field === undefined ? "COUNT(*)" : `COUNT(${field})`;
  if (!field) throw new AnalysisCompilerError("invalid_analysis_spec", `${aggregate} requires a field.`);
  switch (aggregate) {
    case "count_distinct": return `COUNT(DISTINCT ${field})`;
    case "sum": return `SUM(${field})`;
    case "avg": return `AVG(${field})`;
    case "min": return `MIN(${field})`;
    case "max": return `MAX(${field})`;
  }
}

function timeBucket(dialect: DatabaseDialect, expression: string, grain: Extract<Dimension, { kind: "time" }> ["grain"]): string {
  if (dialect === "postgres") return `DATE_TRUNC('${grain}', ${expression})`;
  if (dialect === "sqlite" || dialect === "turso") {
    switch (grain) {
      case "hour": return `strftime('%Y-%m-%d %H:00:00', ${expression})`;
      case "day": return `date(${expression})`;
      case "week": return `date(${expression}, '-' || ((cast(strftime('%w', ${expression}) as integer) + 6) % 7) || ' days')`;
      case "month": return `strftime('%Y-%m-01', ${expression})`;
      case "quarter": return `strftime('%Y', ${expression}) || '-Q' || ((cast(strftime('%m', ${expression}) as integer) - 1) / 3 + 1)`;
      case "year": return `strftime('%Y', ${expression})`;
    }
  }
  switch (grain) {
    case "hour": return `DATE_FORMAT(${expression}, '%Y-%m-%d %H:00:00')`;
    case "day": return `DATE(${expression})`;
    case "week": return `DATE_SUB(DATE(${expression}), INTERVAL WEEKDAY(${expression}) DAY)`;
    case "month": return `DATE_FORMAT(${expression}, '%Y-%m-01')`;
    case "quarter": return `CONCAT(YEAR(${expression}), '-Q', QUARTER(${expression}))`;
    case "year": return `YEAR(${expression})`;
  }
}

function quoteIdentifier(dialect: DatabaseDialect, value: string): string {
  return dialect === "postgres" || dialect === "sqlite" || dialect === "turso"
    ? `"${value.replaceAll('"', '""')}"`
    : `\`${value.replaceAll("`", "``")}\``;
}

function semanticFieldLabel(catalog: SemanticCatalog, id: FieldId): string {
  return catalog.entities.flatMap((entity) => entity.fields).find((field) => field.id === id)?.label ?? "Value";
}

function aggregateLabel(aggregate: Aggregate, field: string | undefined): string {
  return field ? `${aggregate.replaceAll("_", " ")} ${field}` : "Count";
}

function aggregateResultType(aggregate: Aggregate, field: DataTypeFamily | undefined): DataTypeFamily {
  if (aggregate === "count" || aggregate === "count_distinct") return "number";
  if (aggregate === "avg") return "decimal";
  return field ?? "unknown";
}

function asValues(value: string | number | boolean | readonly (string | number | boolean)[]): readonly (string | number | boolean)[] {
  if (Array.isArray(value)) return value as readonly (string | number | boolean)[];
  return [value as string | number | boolean];
}

function isNumeric(type: DataTypeFamily): boolean {
  return type === "number" || type === "decimal";
}

function isTime(type: DataTypeFamily): boolean {
  return type === "date" || type === "timestamp";
}

function isComparable(type: DataTypeFamily): boolean {
  return isNumeric(type) || isTime(type);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  throw new TypeError("The compiled query cannot be fingerprinted.");
}
