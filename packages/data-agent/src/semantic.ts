import { createHash } from "node:crypto";
import type { DatabaseCatalog, DatabaseColumn, DatabaseTable } from "@data-elements/database";
import { z } from "zod";
import {
  DATA_AGENT_VERSION,
  semanticCatalogDefinitionSchema,
  semanticCatalogSchema,
  type DataTypeFamily,
  type EntityId,
  type FieldExposure,
  type FieldId,
  type MetricId,
  type RelationshipId,
  type SemanticCatalog,
  type SemanticCatalogDefinition,
  type SemanticEntity,
  type SemanticField,
  type SemanticMetric,
  type SemanticRelationship,
} from "./contracts";

export type PhysicalEntity = Readonly<{
  id: EntityId;
  schema: string;
  table: string;
  source: DatabaseTable;
}>;

export type PhysicalField = Readonly<{
  id: FieldId;
  entityId: EntityId;
  column: string;
  source: DatabaseColumn;
  type: DataTypeFamily;
  exposure: FieldExposure;
}>;

export type PhysicalMetric = Readonly<{
  id: MetricId;
  entityId: EntityId;
  aggregate: "count" | "count_distinct" | "sum" | "avg" | "min" | "max";
  fieldId?: FieldId;
}>;

export type PhysicalRelationship = Readonly<{
  id: RelationshipId;
  label?: string;
  description?: string;
  fromEntityId: EntityId;
  toEntityId: EntityId;
  pairs: readonly Readonly<{ fromFieldId: FieldId; toFieldId: FieldId }>[];
  cardinality: "one-to-one" | "one-to-many" | "many-to-one";
  origin: "foreign-key" | "trusted-manifest";
}>;

export type SemanticBindings = Readonly<{
  entities: ReadonlyMap<EntityId, PhysicalEntity>;
  fields: ReadonlyMap<FieldId, PhysicalField>;
  metrics: ReadonlyMap<MetricId, PhysicalMetric>;
  relationships: ReadonlyMap<RelationshipId, PhysicalRelationship>;
}>;

export type BuiltSemanticCatalog = Readonly<{
  catalog: SemanticCatalog;
  bindings: SemanticBindings;
}>;

type ParsedSemanticCatalogDefinition = z.output<typeof semanticCatalogDefinitionSchema>;

export class SemanticCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticCatalogError";
  }
}

/** Stable opaque handles never reveal a physical relation or column name. */
export function entityIdFor(
  catalog: Pick<DatabaseCatalog, "fingerprint">,
  schema: string,
  table: string,
): EntityId {
  return opaqueId("ent", [catalog.fingerprint, schema, table]) as EntityId;
}

export function fieldIdFor(
  catalog: Pick<DatabaseCatalog, "fingerprint">,
  schema: string,
  table: string,
  column: string,
): FieldId {
  return opaqueId("fld", [catalog.fingerprint, schema, table, column]) as FieldId;
}

export function buildSemanticCatalog(
  physicalCatalog: DatabaseCatalog,
  definitionInput: SemanticCatalogDefinition | undefined,
): BuiltSemanticCatalog {
  const definition = semanticCatalogDefinitionSchema.parse(definitionInput ?? {});
  const configured = new Map(definition.entities.map((entity) => [relationKey(entity.relation.schema, entity.relation.table), entity]));
  const physicalEntities = new Map<EntityId, PhysicalEntity>();
  const physicalFields = new Map<FieldId, PhysicalField>();
  const physicalMetrics = new Map<MetricId, PhysicalMetric>();
  const entities: SemanticEntity[] = [];

  for (const schema of physicalCatalog.schemas) {
    for (const table of schema.tables) {
      const key = relationKey(schema.name, table.name);
      const configuredEntity = configured.get(key);
      const entityId = entityIdFor(physicalCatalog, schema.name, table.name);
      const physicalEntity: PhysicalEntity = { id: entityId, schema: schema.name, table: table.name, source: table };
      const configuredFields = new Map((configuredEntity?.fields ?? []).map((field) => [field.column, field]));
      assertConfiguredColumns(table, configuredFields.keys());
      const fields: SemanticField[] = [];
      const physicalFieldsByColumn = new Map<string, PhysicalField>();
      const defaultTimeColumn = configuredEntity?.defaultTimeColumn;
      if (defaultTimeColumn !== undefined && !table.columns.some((column) => column.name === defaultTimeColumn)) {
        throw new SemanticCatalogError("A semantic entity default time field is not readable through this connector.");
      }

      for (const column of table.columns) {
        const configuredField = configuredFields.get(column.name);
        const type = dataTypeFamily(column.dataType);
        const exposure = effectiveExposure(configuredField?.exposure);
        if (exposure === "never-to-model") continue;
        const fieldId = fieldIdFor(physicalCatalog, schema.name, table.name, column.name);
        const role = configuredField?.role ?? defaultRole(table, column, type, defaultTimeColumn);
        const field: SemanticField = {
          id: fieldId,
          label: configuredField?.label ?? humanize(column.name),
          aliases: configuredField?.aliases ?? [],
          ...optionalDescription(configuredField?.description ?? column.comment),
          type,
          role,
          exposure,
        };
        fields.push(field);
        const physicalField: PhysicalField = {
          id: fieldId,
          entityId,
          column: column.name,
          source: column,
          type,
          exposure,
        };
        physicalFields.set(fieldId, physicalField);
        physicalFieldsByColumn.set(column.name, physicalField);
      }

      if (fields.length === 0) continue;
      physicalEntities.set(entityId, physicalEntity);
      const defaultTimeFieldId = selectDefaultTimeFieldId({
        catalog: physicalCatalog,
        schema: schema.name,
        table,
        fields,
        configuredColumn: defaultTimeColumn,
      });
      const metrics = buildMetrics({
        catalogFingerprint: physicalCatalog.fingerprint,
        entityId,
        table,
        physicalFieldsByColumn,
        configured: configuredEntity?.metrics ?? [],
      });
      for (const metric of metrics) {
        physicalMetrics.set(metric.id, {
          id: metric.id,
          entityId,
          aggregate: metric.aggregate,
          ...(metric.fieldId === undefined ? {} : { fieldId: metric.fieldId }),
        });
      }
      entities.push({
        id: entityId,
        label: configuredEntity?.label ?? humanize(table.name),
        aliases: configuredEntity?.aliases ?? [],
        ...optionalDescription(configuredEntity?.description ?? table.comment),
        ...(defaultTimeFieldId === undefined ? {} : { defaultTimeFieldId }),
        fields,
        metrics,
      });
    }
  }

  validateConfiguredRelations(definition, physicalCatalog);
  const relationships = buildRelationships({
    physicalCatalog,
    definition,
    entities,
    physicalEntities,
    physicalFields,
  });
  const physicalRelationships = new Map<RelationshipId, PhysicalRelationship>(relationships.map((relationship) => [relationship.id, relationship]));
  const semanticRelationships: SemanticRelationship[] = relationships.map((relationship) => ({
    id: relationship.id,
    ...(relationship.label === undefined ? {} : { label: relationship.label }),
    ...(relationship.description === undefined ? {} : { description: relationship.description }),
    fromEntityId: relationship.fromEntityId,
    toEntityId: relationship.toEntityId,
    pairs: relationship.pairs.map((pair) => ({ ...pair })),
    cardinality: relationship.cardinality,
    origin: relationship.origin,
  }));
  const unparsed = {
    version: DATA_AGENT_VERSION,
    ref: {
      manifestId: definition.manifestId,
      revision: definition.revision,
      fingerprint: semanticFingerprint({ entities, relationships: semanticRelationships }),
      catalogFingerprint: physicalCatalog.fingerprint,
    },
    entities,
    relationships: semanticRelationships,
  } as const;
  const catalog = semanticCatalogSchema.parse(unparsed);
  return {
    catalog,
    bindings: {
      entities: physicalEntities,
      fields: physicalFields,
      metrics: physicalMetrics,
      relationships: physicalRelationships,
    },
  };
}

/**
 * Reconstructs server-private physical bindings from a model-safe semantic
 * catalog. This is useful for stateless compiler calls; the runtime keeps the
 * original bindings so it does not need to repeat this work on every query.
 */
export function bindSemanticCatalog(
  physicalCatalog: DatabaseCatalog,
  semanticCatalogInput: SemanticCatalog,
): SemanticBindings {
  const semanticCatalog = semanticCatalogSchema.parse(semanticCatalogInput);
  if (semanticCatalog.ref.catalogFingerprint !== physicalCatalog.fingerprint) {
    throw new SemanticCatalogError("The semantic catalog was built from a stale physical catalog.");
  }
  const expectedFingerprint = semanticFingerprint({
    entities: semanticCatalog.entities,
    relationships: semanticCatalog.relationships,
  });
  if (semanticCatalog.ref.fingerprint !== expectedFingerprint) {
    throw new SemanticCatalogError("The semantic catalog fingerprint is invalid.");
  }
  assertUnique(semanticCatalog.entities.map((entity) => entity.id), "semantic entity");
  assertUnique(semanticCatalog.entities.flatMap((entity) => entity.fields.map((field) => field.id)), "semantic field");
  assertUnique(semanticCatalog.entities.flatMap((entity) => entity.metrics.map((metric) => metric.id)), "semantic metric");
  assertUnique(semanticCatalog.relationships.map((relationship) => relationship.id), "semantic relationship");

  const physicalEntities = new Map<EntityId, PhysicalEntity>();
  const physicalFields = new Map<FieldId, PhysicalField>();
  const physicalMetrics = new Map<MetricId, PhysicalMetric>();
  const tablesByEntity = new Map<EntityId, DatabaseTable>();
  const columnsByFieldId = new Map<FieldId, DatabaseColumn>();
  for (const schema of physicalCatalog.schemas) {
    for (const table of schema.tables) {
      tablesByEntity.set(entityIdFor(physicalCatalog, schema.name, table.name), table);
      for (const column of table.columns) {
        columnsByFieldId.set(fieldIdFor(physicalCatalog, table.schema, table.name, column.name), column);
      }
    }
  }

  for (const entity of semanticCatalog.entities) {
    const table = tablesByEntity.get(entity.id);
    if (!table) throw new SemanticCatalogError("A semantic entity no longer maps to a readable relation.");
    const physicalEntity: PhysicalEntity = { id: entity.id, schema: table.schema, table: table.name, source: table };
    physicalEntities.set(entity.id, physicalEntity);
    const semanticFieldIds = new Set(entity.fields.map((field) => field.id));
    if (entity.defaultTimeFieldId !== undefined && !semanticFieldIds.has(entity.defaultTimeFieldId)) {
      throw new SemanticCatalogError("A semantic entity default time field is unavailable.");
    }
    for (const field of entity.fields) {
      const column = columnsByFieldId.get(field.id);
      if (!column || dataTypeFamily(column.dataType) !== field.type) {
        throw new SemanticCatalogError("A semantic field no longer maps to a model-visible column.");
      }
      physicalFields.set(field.id, {
        id: field.id,
        entityId: entity.id,
        column: column.name,
        source: column,
        type: field.type,
        exposure: field.exposure,
      });
    }
    for (const metric of entity.metrics) {
      if (metric.fieldId !== undefined && !semanticFieldIds.has(metric.fieldId)) {
        throw new SemanticCatalogError("A semantic metric refers to a field from another entity.");
      }
      physicalMetrics.set(metric.id, {
        id: metric.id,
        entityId: entity.id,
        aggregate: metric.aggregate,
        ...(metric.fieldId === undefined ? {} : { fieldId: metric.fieldId }),
      });
    }
  }

  const physicalRelationships = new Map<RelationshipId, PhysicalRelationship>();
  for (const relationship of semanticCatalog.relationships) {
    if (!physicalEntities.has(relationship.fromEntityId) || !physicalEntities.has(relationship.toEntityId)) {
      throw new SemanticCatalogError("A semantic relationship refers to an unavailable entity.");
    }
    const pairs = relationship.pairs.map((pair) => {
      const from = physicalFields.get(pair.fromFieldId);
      const to = physicalFields.get(pair.toFieldId);
      if (!from || !to || from.entityId !== relationship.fromEntityId || to.entityId !== relationship.toEntityId) {
        throw new SemanticCatalogError("A semantic relationship refers to an unavailable field.");
      }
      return { fromFieldId: from.id, toFieldId: to.id };
    });
    physicalRelationships.set(relationship.id, {
      id: relationship.id,
      ...(relationship.label === undefined ? {} : { label: relationship.label }),
      ...(relationship.description === undefined ? {} : { description: relationship.description }),
      fromEntityId: relationship.fromEntityId,
      toEntityId: relationship.toEntityId,
      pairs,
      cardinality: relationship.cardinality,
      origin: relationship.origin,
    });
  }
  return {
    entities: physicalEntities,
    fields: physicalFields,
    metrics: physicalMetrics,
    relationships: physicalRelationships,
  };
}

function buildMetrics(input: Readonly<{
  catalogFingerprint: string;
  entityId: EntityId;
  table: DatabaseTable;
  physicalFieldsByColumn: ReadonlyMap<string, PhysicalField>;
  configured: readonly {
    key: string;
    label?: string;
    description?: string;
    aggregate: "count" | "count_distinct" | "sum" | "avg" | "min" | "max";
    column?: string;
  }[];
}>): SemanticMetric[] {
  const metrics: SemanticMetric[] = [{
    id: metricIdFor(input.catalogFingerprint, input.entityId, "count"),
    label: `Count of ${humanize(input.table.name)}`,
    aggregate: "count",
  }];
  for (const metric of input.configured) {
    const field = metric.column === undefined ? undefined : input.physicalFieldsByColumn.get(metric.column);
    if (metric.aggregate !== "count" && field === undefined) {
      throw new SemanticCatalogError("A semantic metric refers to a field that is not model-visible.");
    }
    if (metric.aggregate === "count" && metric.column !== undefined) {
      throw new SemanticCatalogError("A count metric cannot refer to a field.");
    }
    if (["sum", "avg"].includes(metric.aggregate) && field && !isNumeric(field.type)) {
      throw new SemanticCatalogError("A sum or average metric must refer to a numeric field.");
    }
    metrics.push({
      id: metricIdFor(input.catalogFingerprint, input.entityId, metric.key),
      label: metric.label ?? humanize(metric.key),
      ...(metric.description === undefined ? {} : { description: metric.description }),
      aggregate: metric.aggregate,
      ...(field === undefined ? {} : { fieldId: field.id }),
    });
  }
  return metrics;
}

function buildRelationships(input: Readonly<{
  physicalCatalog: DatabaseCatalog;
  definition: ParsedSemanticCatalogDefinition;
  entities: readonly SemanticEntity[];
  physicalEntities: ReadonlyMap<EntityId, PhysicalEntity>;
  physicalFields: ReadonlyMap<FieldId, PhysicalField>;
}>): PhysicalRelationship[] {
  const relationToEntity = new Map(Array.from(input.physicalEntities.values()).map((entity) => [relationKey(entity.schema, entity.table), entity]));
  const fieldIdsByEntity = new Map<EntityId, Map<string, FieldId>>();
  for (const field of input.physicalFields.values()) {
    const byColumn = fieldIdsByEntity.get(field.entityId) ?? new Map<string, FieldId>();
    byColumn.set(field.column, field.id);
    fieldIdsByEntity.set(field.entityId, byColumn);
  }
  const fieldIdFor = (entity: PhysicalEntity, column: string) => fieldIdsByEntity.get(entity.id)?.get(column);
  const output: PhysicalRelationship[] = [];
  for (const source of input.physicalEntities.values()) {
    for (const foreignKey of source.source.foreignKeys) {
      const target = relationToEntity.get(relationKey(foreignKey.referencedSchema, foreignKey.referencedTable));
      if (!target) continue;
      const pairs = foreignKey.columns.map((column, index) => {
        const fromFieldId = fieldIdFor(source, column);
        const toFieldId = fieldIdFor(target, foreignKey.referencedColumns[index] ?? "");
        return fromFieldId && toFieldId ? { fromFieldId, toFieldId } : undefined;
      });
      if (pairs.some((pair) => pair === undefined)) continue;
      output.push({
        id: opaqueId("rel", [input.physicalCatalog.fingerprint, "foreign-key", source.id, target.id, foreignKey.name]),
        fromEntityId: source.id,
        toEntityId: target.id,
        pairs: pairs as Array<{ fromFieldId: FieldId; toFieldId: FieldId }>,
        cardinality: "many-to-one",
        origin: "foreign-key",
      });
    }
  }
  for (const relationship of input.definition.relationships) {
    const from = relationToEntity.get(relationKey(relationship.from.schema, relationship.from.table));
    const to = relationToEntity.get(relationKey(relationship.to.schema, relationship.to.table));
    if (!from || !to) {
      throw new SemanticCatalogError("A trusted semantic relationship refers to a relation without model-visible fields.");
    }
    const pairs = relationship.pairs.map((pair) => {
      const fromFieldId = fieldIdFor(from, pair.fromColumn);
      const toFieldId = fieldIdFor(to, pair.toColumn);
      return fromFieldId && toFieldId ? { fromFieldId, toFieldId } : undefined;
    });
    if (pairs.some((pair) => pair === undefined)) {
      throw new SemanticCatalogError("A trusted semantic relationship refers to a field that is not model-visible.");
    }
    output.push({
      id: opaqueId("rel", [input.physicalCatalog.fingerprint, "trusted", from.id, to.id, stableJson(relationship.pairs)]),
      ...(relationship.label === undefined ? {} : { label: relationship.label }),
      ...(relationship.description === undefined ? {} : { description: relationship.description }),
      fromEntityId: from.id,
      toEntityId: to.id,
      pairs: pairs as Array<{ fromFieldId: FieldId; toFieldId: FieldId }>,
      cardinality: relationship.cardinality,
      origin: "trusted-manifest",
    });
  }
  return output;
}

function validateConfiguredRelations(definition: ParsedSemanticCatalogDefinition, catalog: DatabaseCatalog): void {
  const relations = new Set(catalog.schemas.flatMap((schema) => schema.tables.map((table) => relationKey(schema.name, table.name))));
  for (const entity of definition.entities) {
    if (!relations.has(relationKey(entity.relation.schema, entity.relation.table))) {
      throw new SemanticCatalogError("A semantic entity refers to a relation that is not readable through this connector.");
    }
  }
  for (const relationship of definition.relationships) {
    if (!relations.has(relationKey(relationship.from.schema, relationship.from.table)) || !relations.has(relationKey(relationship.to.schema, relationship.to.table))) {
      throw new SemanticCatalogError("A trusted semantic relationship refers to a relation that is not readable through this connector.");
    }
  }
}

function assertConfiguredColumns(table: DatabaseTable, columns: Iterable<string>): void {
  const existing = new Set(table.columns.map((column) => column.name));
  for (const column of columns) {
    if (!existing.has(column)) {
      throw new SemanticCatalogError("A semantic field refers to a column that is not readable through this connector.");
    }
  }
}

function assertUnique(values: readonly string[], kind: string): void {
  if (new Set(values).size !== values.length) {
    throw new SemanticCatalogError(`The ${kind} catalog contains duplicate opaque identifiers.`);
  }
}

/**
 * Tessera's default is an administrator workspace: every readable field is
 * available to governed analysis. Hosts that need a narrower policy express
 * it explicitly in the semantic manifest rather than relying on name-based
 * guesses that silently make data unavailable.
 */
function effectiveExposure(configured: FieldExposure | undefined): FieldExposure {
  return configured ?? "bounded-values";
}

function selectDefaultTimeFieldId(input: Readonly<{
  catalog: Pick<DatabaseCatalog, "fingerprint">;
  schema: string;
  table: DatabaseTable;
  fields: readonly SemanticField[];
  configuredColumn: string | undefined;
}>): FieldId | undefined {
  if (input.configuredColumn !== undefined) {
    const configuredId = fieldIdFor(input.catalog, input.schema, input.table.name, input.configuredColumn);
    if (input.fields.some((field) => field.id === configuredId)) return configuredId;
  }

  // Never infer a business lifecycle from a column name. If the schema has a
  // single time field it is unambiguous; multiple time fields must be resolved
  // by an explicit manifest or by the Agent's bounded discovery step.
  const timeFields = input.fields.filter((field) => field.role === "time");
  return timeFields.length === 1 ? timeFields[0]?.id : undefined;
}

function defaultRole(table: DatabaseTable, column: DatabaseColumn, type: DataTypeFamily, defaultTimeColumn: string | undefined): SemanticField["role"] {
  if (column.name === defaultTimeColumn || type === "date" || type === "timestamp") return "time";
  if (table.primaryKey.includes(column.name)) return "identifier";
  if (isNumeric(type)) return "measure";
  return "dimension";
}

function dataTypeFamily(value: string): DataTypeFamily {
  const normalized = value.toLocaleLowerCase("en-US");
  if (/(?:timestamp|datetime|time zone)/u.test(normalized)) return "timestamp";
  if (/\bdate\b/u.test(normalized)) return "date";
  if (/(?:numeric|decimal|money)/u.test(normalized)) return "decimal";
  if (/(?:smallint|integer|bigint|real|double|float|serial|int|number)/u.test(normalized)) return "number";
  if (/(?:bool|bit)/u.test(normalized)) return "boolean";
  if (/(?:json|xml|array|object)/u.test(normalized)) return "json";
  return /(char|text|string|uuid|objectid|enum|varchar|citext)/u.test(normalized) ? "string" : "unknown";
}

function isNumeric(type: DataTypeFamily): boolean {
  return type === "number" || type === "decimal";
}

function humanize(value: string): string {
  const text = value.replace(/[_-]+/gu, " ").trim();
  return text ? text.replace(/\b\w/gu, (character) => character.toLocaleUpperCase("en-US")) : "Data";
}

/**
 * Database comments are optional, connector-provided context. Keep them out
 * when they are empty or whitespace-only so semantic schema validation remains
 * deterministic; an explicit manifest description still takes precedence.
 */
function optionalDescription(value: string | undefined): { description?: string } {
  const description = value?.trim();
  return description ? { description } : {};
}

function relationKey(schema: string, table: string): string {
  return `${schema}\u0000${table}`;
}

function metricIdFor(catalogFingerprint: string, entityId: EntityId, key: string): MetricId {
  return opaqueId("met", [catalogFingerprint, entityId, key]) as MetricId;
}

function opaqueId(kind: "ent" | "fld" | "met" | "rel", parts: readonly string[]): string {
  return `${kind}_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24)}`;
}

function semanticFingerprint(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  throw new TypeError("Semantic catalog fingerprint cannot encode this value.");
}
