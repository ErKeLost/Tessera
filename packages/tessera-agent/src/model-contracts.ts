import {
  DATA_AGENT_DESCRIBE_MAX_ENTITIES,
  entityIdSchema,
  fieldIdSchema,
  metricIdSchema,
  relationshipIdSchema,
  semanticCatalogSchema,
} from "@open-tessera/data-agent";
import {
  databaseDdlOperationSchema,
  databasePredicateSchema,
  type DatabaseExtensionInspectionInput,
  type DatabaseRlsPolicyInspectionInput,
} from "@open-tessera/database";
import { z } from "zod";
import { modelEvidenceSchema } from "./evidence";

export const modelPredicateValueSchema = z.union([
  z.string().min(1).max(1_024),
  z.number().finite(),
  z.boolean(),
  z.array(z.union([
    z.string().min(1).max(1_024),
    z.number().finite(),
    z.boolean(),
  ])).min(1).max(64),
]);

export const modelAnalysisConditionSchema = z.object({
  fieldId: fieldIdSchema.describe(
    "Opaque field id returned by search_data_context; never use a physical column name here.",
  ),
  op: z.enum([
    "eq",
    "neq",
    "in",
    "between",
    "gt",
    "gte",
    "lt",
    "lte",
    "contains",
    "is_null",
    "is_not_null",
  ]).describe(
    "Comparison operator. in requires an array; between requires exactly two values; null checks do not accept a value.",
  ),
  value: modelPredicateValueSchema.optional().describe(
    "Comparison value. Required for every operator except is_null and is_not_null; use a scalar except for in and between.",
  ),
}).strict().superRefine((condition, validation) => {
  const isNullCheck = condition.op === "is_null" || condition.op === "is_not_null";
  const isArray = Array.isArray(condition.value);

  if (isNullCheck) {
    if (condition.value !== undefined) {
      validation.addIssue({
        code: "custom",
        path: ["value"],
        message: `${condition.op} must not include value.`,
      });
    }
    return;
  }

  if (condition.value === undefined) {
    validation.addIssue({
      code: "custom",
      path: ["value"],
      message: `${condition.op} requires value.`,
    });
    return;
  }
  if (condition.op === "in" && !isArray) {
    validation.addIssue({
      code: "custom",
      path: ["value"],
      message: "in requires a non-empty array of values.",
    });
  }
  if (condition.op === "between") {
    if (!Array.isArray(condition.value) || condition.value.length !== 2) {
      validation.addIssue({
        code: "custom",
        path: ["value"],
        message: "between requires an array containing exactly two values.",
      });
    }
  } else if (isArray && condition.op !== "in") {
    validation.addIssue({
      code: "custom",
      path: ["value"],
      message: `${condition.op} requires one scalar value.`,
    });
  }
});

/**
 * The model-facing plan is deliberately flat because providers differ in
 * their support for recursive JSON Schema and nested oneOf constructs.
 */
export const modelAnalysisFilterSchema = z.object({
  join: z.enum(["all", "any"]).default("all"),
  conditions: z.array(modelAnalysisConditionSchema).min(1).max(64).describe(
    "All conditions are combined using join. Every condition must match the operator's value shape.",
  ),
}).strict().describe(
  "Optional semantic filter. Use opaque field ids from search_data_context, never physical column names.",
);

export const modelAnalysisMeasureSchema = z.object({
  kind: z.enum(["metric", "aggregate"]).describe(
    "metric references a catalog metric; aggregate applies a standard aggregate to a catalog field.",
  ),
  metricId: metricIdSchema.optional().describe(
    "Required only when kind=metric. Do not send it for kind=aggregate.",
  ),
  aggregate: z.enum(["count", "count_distinct", "sum", "avg", "min", "max"])
    .optional()
    .describe("Required only when kind=aggregate."),
  fieldId: fieldIdSchema.optional().describe(
    "Required for count_distinct, sum, avg, min, or max; omit it for count. Do not send it for kind=metric.",
  ),
}).strict().superRefine((measure, validation) => {
  if (measure.kind === "metric") {
    if (measure.metricId === undefined) {
      validation.addIssue({ code: "custom", path: ["metricId"], message: "metric requires metricId." });
    }
    if (measure.aggregate !== undefined) {
      validation.addIssue({ code: "custom", path: ["aggregate"], message: "metric must not include aggregate." });
    }
    if (measure.fieldId !== undefined) {
      validation.addIssue({ code: "custom", path: ["fieldId"], message: "metric must not include fieldId." });
    }
    return;
  }

  if (measure.aggregate === undefined) {
    validation.addIssue({ code: "custom", path: ["aggregate"], message: "aggregate requires aggregate." });
    return;
  }
  if (measure.metricId !== undefined) {
    validation.addIssue({ code: "custom", path: ["metricId"], message: "aggregate must not include metricId." });
  }
  if (measure.aggregate === "count") {
    if (measure.fieldId !== undefined) {
      validation.addIssue({ code: "custom", path: ["fieldId"], message: "count must not include fieldId." });
    }
  } else if (measure.fieldId === undefined) {
    validation.addIssue({
      code: "custom",
      path: ["fieldId"],
      message: `${measure.aggregate} requires fieldId.`,
    });
  }
}).describe(
  "A semantic measure. Send exactly the fields required by kind and aggregate; use ids returned by search_data_context.",
);

export const modelAnalysisDimensionSchema = z.object({
  fieldId: fieldIdSchema,
  grain: z.enum(["hour", "day", "week", "month", "quarter", "year"]).optional(),
}).strict();

export const modelAnalysisToolInputSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2_000).optional(),
  mode: z.enum(["aggregate", "records"]).describe(
    "Use records for row-level facts ordered by a catalog field. Use aggregate for metrics, grouped tables, series, and rankings.",
  ),
  primaryEntityId: entityIdSchema,
  relationshipIds: z.array(relationshipIdSchema).max(16).default([]),
  filter: modelAnalysisFilterSchema.optional(),
  limit: z.number().int().min(1).max(20_000).default(100),
  fields: z.array(fieldIdSchema).min(1).max(32).optional(),
  recordOrderBy: z.array(z.object({
    fieldId: fieldIdSchema,
    direction: z.enum(["asc", "desc"]),
  }).strict()).min(1).max(8).optional(),
  measures: z.array(modelAnalysisMeasureSchema).min(1).max(16).optional(),
  dimensions: z.array(modelAnalysisDimensionSchema).max(8).optional(),
  aggregateOrderBy: z.array(z.object({
    by: z.enum(["dimension", "measure"]).describe(
      "Selects the dimensions or measures array to order by.",
    ),
    index: z.number().int().min(0).max(15).describe(
      "Zero-based index into the selected dimensions or measures array; it must identify an output included in this plan.",
    ),
    direction: z.enum(["asc", "desc"]).describe("Sort direction for this output."),
  }).strict()).min(1).max(8).optional().describe(
    "Required for output=table, series, or ranking; omit it only for output=scalar. Never send an empty array. For table, order by its first dimension ascending (then further dimensions ascending when useful). For series, order the time dimension ascending. For ranking, order the primary measure descending, then a dimension ascending as a tie-breaker. Each entry uses by plus a zero-based index into that plan array.",
  ),
  output: z.enum(["scalar", "table", "series", "ranking"]).optional().describe(
    "Presentation shape. scalar returns one aggregate value and omits aggregateOrderBy. table, series, and ranking require a non-empty aggregateOrderBy that references this plan's included outputs.",
  ),
}).strict().describe(
  "A governed semantic analysis plan. Use only catalog-returned opaque identifiers; never include SQL, physical relation names, connection details, compiler output ids, or invented identifiers.",
);

export type ModelAnalysisToolInput = z.infer<typeof modelAnalysisToolInputSchema>;

export const inspectDatabaseCapabilitiesOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    dialect: z.string().min(1).max(32),
    availability: z.enum(["available", "unavailable", "not-applicable"]),
    serverVersion: z.string().min(1).max(256).optional(),
    components: z.array(z.object({
      id: z.string().min(1).max(256),
      kind: z.enum(["engine", "feature", "extension", "module"]),
      status: z.enum(["supported", "installed", "available", "unsupported", "unknown"]),
      version: z.string().max(256).optional(),
      defaultVersion: z.string().max(256).optional(),
      schema: z.string().max(256).optional(),
    }).strict()).max(256),
    truncated: z.boolean(),
    warnings: z.array(z.string().max(1_000)).max(16),
  }).strict(),
  z.object({
    status: z.literal("unavailable").describe(
      "Capability metadata could not be loaded. This does not mean SQL or database authorization is unavailable.",
    ),
    reason: z.literal("capabilities_unavailable"),
    message: z.string().min(1).max(1_000),
  }).strict(),
]);

export type InspectDatabaseCapabilitiesToolOutput = z.infer<
  typeof inspectDatabaseCapabilitiesOutputSchema
>;

export const schemaInspectionOmittedSchema = z.object({
  tables: z.number().int().nonnegative(),
  columns: z.number().int().nonnegative(),
  foreignKeys: z.number().int().nonnegative(),
  indexes: z.number().int().nonnegative(),
}).strict().describe(
  "Known exposed metadata omitted only by this response's output budget. Security-withheld metadata is not counted.",
);

export const databaseIdentifierSchema = z.string().trim().min(1).max(256).describe(
  "Case-preserving physical identifier. Copy it exactly from the user or a completed list_database result; never translate, singularize, pluralize, or guess it.",
);

export const listDatabaseInputSchema = z.object({
  operation: z.enum([
    "list_relations",
    "describe_schema",
    "describe_relation",
    "current_relation",
    "capabilities",
    "extensions",
    "rls_policies",
  ]).default("list_relations").describe(
    "Database metadata operation. Omit only for the initial bounded inventory, which defaults to list_relations.",
  ),
  schema: databaseIdentifierSchema.optional().describe(
    "Required only for describe_schema and describe_relation. Copy the exact case-preserving schema or namespace name verbatim.",
  ),
  relation: databaseIdentifierSchema.optional().describe(
    "Required only for describe_relation. Copy the exact case-preserving table, view, or collection name verbatim.",
  ),
  names: z.array(databaseIdentifierSchema).max(128).optional().describe(
    "Optional exact extension names for operation=extensions.",
  ),
  includeAvailable: z.boolean().optional().describe(
    "For operation=extensions, include available but not installed features. Defaults to true.",
  ),
  schemas: z.array(databaseIdentifierSchema).max(64).optional().describe(
    "Optional schema filter for operation=rls_policies.",
  ),
  relations: z.array(z.object({
    schema: databaseIdentifierSchema,
    table: databaseIdentifierSchema,
  }).strict()).max(128).optional().describe(
    "Optional exact relation filter for operation=rls_policies.",
  ),
  includeExpressions: z.boolean().optional().describe(
    "For operation=rls_policies, include bounded policy expressions. Defaults to false.",
  ),
}).strict().superRefine((value, validation) => {
  if (value.operation === "describe_schema" || value.operation === "describe_relation") {
    if (value.schema === undefined) {
      validation.addIssue({
        code: "custom",
        message: `schema is required for ${value.operation}.`,
        path: ["schema"],
      });
    }
  } else if (value.schema !== undefined) {
    validation.addIssue({
      code: "custom",
      message: `schema is not accepted for ${value.operation}.`,
      path: ["schema"],
    });
  }

  if (value.operation === "describe_relation") {
    if (value.relation === undefined) {
      validation.addIssue({
        code: "custom",
        message: "relation is required for describe_relation.",
        path: ["relation"],
      });
    }
  } else if (value.relation !== undefined) {
    validation.addIssue({
      code: "custom",
      message: `relation is not accepted for ${value.operation}.`,
      path: ["relation"],
    });
  }

  if (value.operation !== "extensions"
    && (value.names !== undefined || value.includeAvailable !== undefined)) {
    validation.addIssue({
      code: "custom",
      message: `extension filters are not accepted for ${value.operation}.`,
      path: ["names"],
    });
  }
  if (value.operation !== "rls_policies"
    && (value.schemas !== undefined
      || value.relations !== undefined
      || value.includeExpressions !== undefined)) {
    validation.addIssue({
      code: "custom",
      message: `RLS filters are not accepted for ${value.operation}.`,
      path: ["schemas"],
    });
  }
}).describe(
  "One database metadata operation. Empty input safely lists the bounded relation inventory. Exact schema and relation lookups require their named fields.",
);

export type ListDatabaseInput = z.infer<typeof listDatabaseInputSchema>;

export const listDatabaseRecoverySchema = z.object({
  tool: z.literal("list_database").describe("The exact tool to call next."),
  input: z.union([
    z.object({ operation: z.literal("list_relations") }).strict(),
    z.object({
      operation: z.literal("describe_schema"),
      schema: databaseIdentifierSchema,
    }).strict(),
  ]).describe(
    "A complete, schema-valid next input. Use it exactly; do not remove required fields.",
  ),
}).strict().describe(
  "Executable recovery for an exact-name miss. This is not a permission result.",
);

export const schemaInspectionIssueSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("not_found").describe(
      "Only the exact requested identifier was not found after catalog refresh. Never generalize this to an empty schema or database.",
    ),
    reason: z.enum(["schema_not_found", "relation_not_found"]).describe(
      "Stable exact-lookup failure reason.",
    ),
    message: z.string().min(1).max(1_000).describe("Human-readable interpretation boundary."),
    recovery: listDatabaseRecoverySchema,
  }).strict(),
  z.object({
    status: z.literal("unavailable").describe(
      "The tool cannot provide this metadata. This never proves physical nonexistence and is not automatically a SQL permission denial.",
    ),
    reason: z.enum([
      "catalog_unavailable",
      "catalog_incomplete",
      "schema_not_exposed",
      "relation_not_exposed",
    ]).describe(
      "Stable availability or exposure reason; none of these values means not_found.",
    ),
    message: z.string().min(1).max(1_000).describe("Human-readable interpretation boundary."),
    nextAction: z.literal("respond_without_existence_claim"),
  }).strict(),
]);

export const physicalSchemaTableSchema = z.object({
  name: z.string().min(1).max(256).describe("Exact physical relation name."),
  kind: z.enum([
    "table",
    "view",
    "materialized-view",
    "foreign-table",
    "partitioned-table",
    "collection",
  ]).describe("Connector-neutral physical relation kind."),
  columns: z.array(z.object({
    name: z.string().min(1).max(256).describe("Exact physical field or column name."),
    dataType: z.string().min(1).max(256).describe(
      "Database-native data type reported by the connector.",
    ),
    nullable: z.boolean().describe("Whether the field accepts null values."),
  }).strict()).max(128),
  primaryKey: z.array(z.string().min(1).max(256)).max(32),
  foreignKeys: z.array(z.object({
    name: z.string().min(1).max(256).describe(
      "Exact native constraint name reported by the connector.",
    ),
    columns: z.array(z.string().min(1).max(256)).min(1).max(32),
    referencedSchema: z.string().min(1).max(256),
    referencedTable: z.string().min(1).max(256),
    referencedColumns: z.array(z.string().min(1).max(256)).min(1).max(32),
  }).strict()).max(64),
  foreignKeyMetadata: z.enum(["complete", "partial", "unavailable"]).describe(
    "complete means the connector checked native foreign keys for this relation; partial means some were withheld or could not be represented; unavailable means the connector could not inspect them. Never treat partial or unavailable as no relationships.",
  ),
  indexes: z.array(z.object({
    name: z.string().min(1).max(256).describe("Exact native index name reported by the connector."),
    columns: z.array(z.string().min(1).max(4_000)).min(1).max(32).describe(
      "Indexed physical columns or key expressions when the connector can report them safely.",
    ),
    unique: z.boolean(),
    method: z.string().min(1).max(128).optional(),
    isConstraint: z.boolean().describe("True when the index backs a native key or uniqueness constraint."),
  }).strict()).max(128).optional().describe(
    "Returned index metadata. Omitted only when the connector could not provide a reliable index inventory.",
  ),
  indexMetadata: z.enum(["complete", "partial", "unavailable"]).describe(
    "complete means indexes is a full checked inventory for this exposed response and may be empty; partial means some indexes were withheld, bounded, or could not be represented; unavailable means the connector did not provide a reliable index inventory. Never treat partial or unavailable as no indexes.",
  ),
}).strict();

export type PhysicalSchemaTable = z.infer<typeof physicalSchemaTableSchema>;

export const inspectSchemaSuccessSchema = z.object({
  status: z.literal("completed").describe("The requested metadata was loaded successfully."),
  schema: z.object({
    name: z.string().min(1).max(256).describe("Exact schema or namespace name."),
    tables: z.array(physicalSchemaTableSchema).max(192).describe(
      "Visible relations in only the requested schema; an empty array does not describe other schemas.",
    ),
  }).strict(),
  tableCount: z.number().int().nonnegative().describe(
    "Number of returned relations, not the whole database count.",
  ),
  columnCount: z.number().int().nonnegative().describe("Number of returned fields/columns."),
  foreignKeyCount: z.number().int().nonnegative().describe(
    "Number of returned foreign-key relationships.",
  ),
  indexCount: z.number().int().nonnegative().describe(
    "Number of returned indexes; this is not a total when any relation reports partial or unavailable index metadata.",
  ),
  truncated: z.boolean().describe(
    "True means omitted items may exist and absence is not evidence of nonexistence.",
  ),
  omitted: schemaInspectionOmittedSchema,
  catalogCoverage: z.object({
    status: z.enum(["complete", "partial", "unknown"]),
    reason: z.enum(["max_tables", "connector_limit", "metadata_unavailable", "unknown"]).optional(),
    maxTables: z.number().int().positive().max(100_000).optional(),
    returnedTables: z.number().int().nonnegative().max(100_000),
    omittedTables: z.number().int().nonnegative().optional(),
  }).strict().optional().describe(
    "Connector-level coverage. partial means the connector may have omitted relations before this response was built.",
  ),
}).strict().superRefine((value, context) => {
  const tables = value.schema.tables;
  const columnCount = tables.reduce((count, table) => count + table.columns.length, 0);
  const foreignKeyCount = tables.reduce((count, table) => count + table.foreignKeys.length, 0);
  const indexCount = tables.reduce((count, table) => count + (table.indexes?.length ?? 0), 0);
  const omittedTotal = Object.values(value.omitted).reduce((count, omitted) => count + omitted, 0);
  if (value.tableCount !== tables.length) {
    context.addIssue({
      code: "custom",
      path: ["tableCount"],
      message: "tableCount must equal the number of returned tables.",
    });
  }
  if (value.columnCount !== columnCount) {
    context.addIssue({
      code: "custom",
      path: ["columnCount"],
      message: "columnCount must equal the number of returned columns.",
    });
  }
  if (value.foreignKeyCount !== foreignKeyCount) {
    context.addIssue({
      code: "custom",
      path: ["foreignKeyCount"],
      message: "foreignKeyCount must equal the number of returned foreign keys.",
    });
  }
  if (value.indexCount !== indexCount) {
    context.addIssue({
      code: "custom",
      path: ["indexCount"],
      message: "indexCount must equal the number of returned indexes.",
    });
  }
  if (omittedTotal > 0 && !value.truncated) {
    context.addIssue({
      code: "custom",
      path: ["truncated"],
      message: "truncated must be true when metadata omission counts are non-zero.",
    });
  }
  for (const [tableIndex, table] of tables.entries()) {
    if (table.indexMetadata === "unavailable" && table.indexes !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["schema", "tables", tableIndex, "indexes"],
        message: "Unavailable index metadata must omit indexes.",
      });
    }
    if (table.indexMetadata !== "complete" && !value.truncated) {
      context.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "A non-complete index inventory requires truncated=true.",
      });
    }
    if (table.foreignKeyMetadata !== "complete" && !value.truncated) {
      context.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "A non-complete foreign-key inventory requires truncated=true.",
      });
    }
  }
});

export const inspectSchemaOutputSchema = z.discriminatedUnion("status", [
  inspectSchemaSuccessSchema,
  ...schemaInspectionIssueSchema.options,
]);

export type InspectSchemaToolOutput = z.infer<typeof inspectSchemaOutputSchema>;

export const catalogOmittedSchema = z.object({
  entities: z.number().int().nonnegative(),
  fields: z.number().int().nonnegative(),
  metrics: z.number().int().nonnegative(),
  relationships: z.number().int().nonnegative(),
}).strict();

export const inspectCatalogOutputSchema = z.object({
  status: z.literal("completed"),
  entityCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  omitted: catalogOmittedSchema,
  catalog: semanticCatalogSchema,
}).strict();

export type InspectCatalogOutput = z.output<typeof inspectCatalogOutputSchema>;

export const inspectCurrentContextOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    entityCount: z.number().int().positive(),
    truncated: z.boolean(),
    omitted: catalogOmittedSchema,
    catalog: semanticCatalogSchema,
  }).strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
]);

export type InspectCurrentContextOutput = z.infer<typeof inspectCurrentContextOutputSchema>;

export const listRelationsSuccessSchema = z.object({
  status: z.literal("completed").describe("A bounded relation inventory was loaded successfully."),
  operation: z.literal("list_relations"),
  dialect: z.string().min(1).max(32).describe("Connected database dialect selected at runtime."),
  schemas: z.array(z.object({
    name: z.string().min(1).max(256).describe("Exact schema or namespace name."),
    tableCount: z.number().int().nonnegative().describe(
      "Number of returned relations for this schema; it may be incomplete when catalogCoverage is partial or truncated is true.",
    ),
    tables: z.array(z.object({
      name: z.string().min(1).max(256).describe("Exact relation name."),
      kind: z.enum([
        "table",
        "view",
        "materialized-view",
        "foreign-table",
        "partitioned-table",
        "collection",
      ]),
    }).strict()).max(512).describe(
      "Bounded relation names; absence is inconclusive when truncated is true.",
    ),
  }).strict()).max(128),
  schemaCount: z.number().int().nonnegative().describe(
    "Number of schemas/namespaces returned in this bounded inventory.",
  ),
  relationCount: z.number().int().nonnegative().describe(
    "Number of relation names returned in this bounded inventory.",
  ),
  catalogCoverage: z.object({
    status: z.enum(["complete", "partial", "unknown"]),
    reason: z.enum(["max_tables", "connector_limit", "metadata_unavailable", "unknown"]).optional(),
    maxTables: z.number().int().positive().max(100_000).optional(),
    returnedTables: z.number().int().nonnegative().max(100_000),
    omittedTables: z.number().int().nonnegative().optional(),
  }).strict().describe(
    "Connector-level coverage. partial means the connector may have omitted relations before Studio applied its own response bound.",
  ),
  truncated: z.boolean().describe("True means unreturned schemas or relations may exist."),
  omitted: z.object({
    schemas: z.number().int().nonnegative(),
    tables: z.number().int().nonnegative(),
  }).strict().describe(
    "Counts omitted by bounded output; omitted items must never be treated as nonexistent.",
  ),
}).strict().superRefine((value, context) => {
  const relationCount = value.schemas.reduce((count, schema) => count + schema.tables.length, 0);
  const omittedTotal = value.omitted.schemas + value.omitted.tables;
  if (value.schemaCount !== value.schemas.length) {
    context.addIssue({
      code: "custom",
      path: ["schemaCount"],
      message: "schemaCount must equal the number of returned schemas.",
    });
  }
  if (value.relationCount !== relationCount) {
    context.addIssue({
      code: "custom",
      path: ["relationCount"],
      message: "relationCount must equal the number of returned relations.",
    });
  }
  if (omittedTotal > 0 && !value.truncated) {
    context.addIssue({
      code: "custom",
      path: ["truncated"],
      message: "truncated must be true when schemas or relations were omitted.",
    });
  }
  for (const [schemaIndex, schema] of value.schemas.entries()) {
    if (schema.tables.length > schema.tableCount) {
      context.addIssue({
        code: "custom",
        path: ["schemas", schemaIndex, "tables"],
        message: "A bounded schema cannot return more relations than its tableCount.",
      });
    }
    if (!value.truncated && schema.tables.length !== schema.tableCount) {
      context.addIssue({
        code: "custom",
        path: ["schemas", schemaIndex, "tableCount"],
        message: "tableCount must equal returned tables when the inventory is not truncated.",
      });
    }
  }
});

export const listRelationsOutputSchema = z.discriminatedUnion("status", [
  listRelationsSuccessSchema,
  z.object({
    status: z.literal("unavailable").describe(
      "The inventory could not be loaded; this does not mean the database is empty.",
    ),
    operation: z.literal("list_relations"),
    reason: z.literal("catalog_unavailable"),
    message: z.string().min(1).max(1_000),
  }).strict(),
]);

export const currentRelationOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    operation: z.literal("current_relation"),
    entityCount: z.number().int().positive(),
    truncated: z.boolean().describe("True means selected-relation metadata is partial."),
    omitted: catalogOmittedSchema,
    catalog: semanticCatalogSchema,
  }).strict(),
  z.object({
    status: z.literal("unavailable").describe(
      "No Studio relation is selected; this says nothing about database contents.",
    ),
    operation: z.literal("current_relation"),
    reason: z.literal("current_relation_unavailable"),
    message: z.string().min(1).max(1_000),
  }).strict(),
]);

export const describedDatabaseOutputSchema = z.intersection(
  z.object({
    operation: z.enum(["describe_schema", "describe_relation"]).describe(
      "The exact metadata lookup that produced this result.",
    ),
  }).strict(),
  inspectSchemaOutputSchema,
);

export const databaseCapabilitiesOutputSchema = z.intersection(
  z.object({ operation: z.literal("capabilities") }).strict(),
  inspectDatabaseCapabilitiesOutputSchema,
);

export const listRlsPoliciesInputSchema = z.object({
  schemas: z.array(z.string().trim().min(1).max(256)).max(64).optional(),
  relations: z.array(z.object({
    schema: z.string().trim().min(1).max(256),
    table: z.string().trim().min(1).max(256),
  }).strict()).max(128).optional(),
  includeExpressions: z.boolean().default(false),
}).strict() satisfies z.ZodType<DatabaseRlsPolicyInspectionInput>;

export const rlsPolicyModelSchema = z.object({
  schema: z.string().min(1).max(256),
  table: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  permissive: z.enum(["permissive", "restrictive"]),
  roles: z.array(z.string().min(1).max(256)).max(64),
  command: z.enum(["select", "insert", "update", "delete", "all"]),
  usingExpression: z.string().max(8_000).optional(),
  checkExpression: z.string().max(8_000).optional(),
}).strict();

export const toolResultReasonSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "reason must be a stable machine-readable token.");

export const toolResultMessageSchema = z.string().min(1).max(2_000);

export const listRlsPoliciesSuccessSchema = z.object({
  operation: z.literal("rls_policies"),
  status: z.literal("completed"),
  dialect: z.string().min(1).max(32),
  relations: z.array(z.object({
    schema: z.string().min(1).max(256),
    table: z.string().min(1).max(256),
    rlsEnabled: z.boolean(),
    rlsForced: z.boolean(),
    policies: z.array(rlsPolicyModelSchema).max(256),
  }).strict()).max(512),
  policyCount: z.number().int().nonnegative(),
  relationCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  warnings: z.array(z.string().max(1_000)).max(16).optional(),
}).strict().superRefine((value, context) => {
  const relationCount = value.relations.length;
  const policyCount = value.relations.reduce(
    (count, relation) => count + relation.policies.length,
    0,
  );
  if (value.relationCount !== relationCount) {
    context.addIssue({
      code: "custom",
      path: ["relationCount"],
      message: "relationCount must equal the number of returned relations.",
    });
  }
  if (value.policyCount !== policyCount) {
    context.addIssue({
      code: "custom",
      path: ["policyCount"],
      message: "policyCount must equal the number of returned policies.",
    });
  }
});

export const listRlsPoliciesOutputSchema = z.union([
  listRlsPoliciesSuccessSchema,
  z.object({
    operation: z.literal("rls_policies"),
    status: z.literal("unavailable").describe(
      "This connector does not expose a reliable RLS policy inventory. This is not a database authorization result.",
    ),
    reason: z.literal("rls_inspection_unavailable"),
    message: toolResultMessageSchema,
  }).strict(),
  z.object({
    operation: z.literal("rls_policies"),
    status: z.literal("failed"),
    reason: z.literal("rls_inspection_failed"),
    message: toolResultMessageSchema,
    nextAction: z.literal("respond"),
  }).strict(),
]);

export const listExtensionsInputSchema = z.object({
  names: z.array(z.string().trim().min(1).max(256)).max(128).optional(),
  includeAvailable: z.boolean().default(true),
}).strict() satisfies z.ZodType<DatabaseExtensionInspectionInput>;

export const extensionModelSchema = z.object({
  name: z.string().min(1).max(256),
  kind: z.enum(["extension", "plugin", "module"]).default("extension"),
  schema: z.string().min(1).max(256).optional(),
  installed: z.boolean(),
  installedVersion: z.string().min(1).max(256).optional(),
  defaultVersion: z.string().min(1).max(256).optional(),
  status: z.string().min(1).max(128).optional(),
  type: z.string().min(1).max(128).optional(),
}).strict();

export const listExtensionsSuccessSchema = z.object({
  operation: z.literal("extensions"),
  status: z.literal("completed"),
  dialect: z.string().min(1).max(32),
  extensions: z.array(extensionModelSchema).max(512),
  extensionCount: z.number().int().nonnegative(),
  installedCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  warnings: z.array(z.string().max(1_000)).max(16).optional(),
}).strict().superRefine((value, context) => {
  const installedCount = value.extensions.filter((extension) => extension.installed).length;
  if (value.extensionCount !== value.extensions.length) {
    context.addIssue({
      code: "custom",
      path: ["extensionCount"],
      message: "extensionCount must equal the number of returned extensions.",
    });
  }
  if (value.installedCount !== installedCount) {
    context.addIssue({
      code: "custom",
      path: ["installedCount"],
      message: "installedCount must equal the number of installed extensions in the result.",
    });
  }
});

export const listExtensionsOutputSchema = z.union([
  listExtensionsSuccessSchema,
  z.object({
    operation: z.literal("extensions"),
    status: z.literal("unavailable").describe(
      "This connector does not expose a reliable extension, plugin, or module inventory. This is not a database authorization result.",
    ),
    reason: z.literal("extension_inspection_unavailable"),
    message: toolResultMessageSchema,
  }).strict(),
  z.object({
    operation: z.literal("extensions"),
    status: z.literal("failed"),
    reason: z.literal("extension_inspection_failed"),
    message: toolResultMessageSchema,
    nextAction: z.literal("respond"),
  }).strict(),
]);

export const listDatabaseOutputSchema = z.union([
  listRelationsOutputSchema,
  describedDatabaseOutputSchema,
  currentRelationOutputSchema,
  databaseCapabilitiesOutputSchema,
  listExtensionsOutputSchema,
  listRlsPoliciesOutputSchema,
]).describe(
  "Database metadata result. completed is evidence only for the requested operation; not_found is limited to one exact identifier; unavailable never proves nonexistence or a permission denial. Follow structured recovery when present.",
);

export type ListDatabaseToolOutput = z.infer<typeof listDatabaseOutputSchema>;

export const describeDataSuccessSchema = z.object({
  status: z.literal("completed"),
  entityCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  omitted: catalogOmittedSchema,
  catalog: semanticCatalogSchema,
}).strict();

export const discoveryBlockedSchema = z.object({
  status: z.literal("blocked"),
  reason: z.enum(["catalog_changed", "invalid_request", "probe_limit", "data_unavailable"]),
  nextAction: z.enum([
    "search_data_context",
    "describe_or_clarify",
    "proceed_or_clarify",
    "respond",
  ]),
  message: toolResultMessageSchema.describe(
    "A sanitized diagnostic when discovery failed. It is not query evidence.",
  ),
}).strict();

export const describeDataOutputSchema = z.discriminatedUnion("status", [
  describeDataSuccessSchema,
  discoveryBlockedSchema,
]);

export type DescribeDataToolOutput = z.infer<typeof describeDataOutputSchema>;
export type DiscoveryBlocked = z.infer<typeof discoveryBlockedSchema>;

export const searchDataContextInputSchema = z.object({
  mode: z.enum(["search", "describe"]),
  query: z.string().trim().min(1).max(240).optional().describe(
    "For mode=search: concise semantic terms from the request. Never pass SQL, a URL, or instructions.",
  ),
  entityIds: z.array(entityIdSchema).min(1).max(DATA_AGENT_DESCRIBE_MAX_ENTITIES)
    .optional()
    .describe(
      "For mode=describe: entity ids returned by an earlier search_data_context result in this turn.",
    ),
}).strict().superRefine((value, context) => {
  if (value.mode === "search" && value.query === undefined) {
    context.addIssue({
      code: "custom",
      message: "query is required when mode is search.",
      path: ["query"],
    });
  }
  if (value.mode === "search" && value.entityIds !== undefined) {
    context.addIssue({
      code: "custom",
      message: "entityIds is only valid when mode is describe.",
      path: ["entityIds"],
    });
  }
  if (value.mode === "describe" && value.entityIds === undefined) {
    context.addIssue({
      code: "custom",
      message: "entityIds is required when mode is describe.",
      path: ["entityIds"],
    });
  }
  if (value.mode === "describe" && value.query !== undefined) {
    context.addIssue({
      code: "custom",
      message: "query is only valid when mode is search.",
      path: ["query"],
    });
  }
});

export type SearchDataContextInput = z.infer<typeof searchDataContextInputSchema>;

const searchedDataContextSchema = z.object({
  status: z.literal("completed"),
  mode: z.literal("search"),
  entityCount: z.number().int().nonnegative().describe(
    "Number of semantic entities returned by this bounded search.",
  ),
  truncated: z.boolean(),
  omitted: catalogOmittedSchema,
  catalog: semanticCatalogSchema,
}).strict().superRefine(validateCatalogResultCounts);

const describedDataContextSchema = z.object({
  status: z.literal("completed"),
  mode: z.literal("describe"),
  entityCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  omitted: catalogOmittedSchema,
  catalog: semanticCatalogSchema,
}).strict().superRefine(validateCatalogResultCounts);

export const searchDataContextOutputSchema = z.union([
  searchedDataContextSchema,
  describedDataContextSchema,
  z.object({
    status: z.literal("blocked"),
    mode: z.enum(["search", "describe"]),
    reason: z.enum(["catalog_changed", "invalid_request", "probe_limit", "data_unavailable"]),
    nextAction: z.enum([
      "search_data_context",
      "describe_or_clarify",
      "proceed_or_clarify",
      "respond",
    ]),
    message: toolResultMessageSchema.describe(
      "A sanitized diagnostic when discovery failed. It is not query evidence.",
    ),
  }).strict(),
]);

export type SearchDataContextToolOutput = z.infer<typeof searchDataContextOutputSchema>;

export const modelMutationRelationSchema = z.object({
  schema: z.string().trim().min(1).max(256),
  table: z.string().trim().min(1).max(256),
}).strict().describe(
  "Exact physical relation coordinates returned by list_database; do not translate, pluralize, or guess either name.",
);

export const modelMutationValueSchema = z.union([
  z.string().max(8_192),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const modelMutationRowSchema = z.record(
  z.string().min(1).max(256),
  modelMutationValueSchema,
).superRefine((value, context) => {
  if (Object.keys(value).length === 0) {
    context.addIssue({
      code: "custom",
      message: "An inserted row must include at least one physical column.",
    });
  }
});

export const modelMutationPatchSchema = z.record(
  z.string().min(1).max(256),
  modelMutationValueSchema,
).superRefine((value, context) => {
  if (Object.keys(value).length === 0) {
    context.addIssue({
      code: "custom",
      message: "An update patch must include at least one physical column.",
    });
  }
});

export const modelMutationMaxAffectedRowsSchema = z.number().int().positive().max(10_000)
  .describe(
    "Required hard upper bound for this change. Use the smallest safe number; the server rejects changes that affect more rows.",
  );

export const modelMutationReturningSchema = z.array(
  z.string().trim().min(1).max(256),
).min(1).max(128).optional().describe(
  "Optional physical columns to return after the approved change.",
);

export const modelMutationActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("data.insert"),
    relation: modelMutationRelationSchema,
    values: z.array(modelMutationRowSchema).min(1).max(1_000).describe(
      "One or more non-empty rows keyed by exact physical column name.",
    ),
    maxAffectedRows: modelMutationMaxAffectedRowsSchema,
    returning: modelMutationReturningSchema,
  }).strict().superRefine((value, context) => {
    if (value.values.length > value.maxAffectedRows) {
      context.addIssue({
        code: "custom",
        message: "maxAffectedRows cannot be lower than the number of rows being inserted.",
        path: ["maxAffectedRows"],
      });
    }
  }),
  z.object({
    kind: z.literal("data.update"),
    relation: modelMutationRelationSchema,
    patch: modelMutationPatchSchema,
    where: databasePredicateSchema.describe(
      "Required typed predicate using exact physical column names. Never use an unbounded update.",
    ),
    maxAffectedRows: modelMutationMaxAffectedRowsSchema,
    returning: modelMutationReturningSchema,
  }).strict(),
  z.object({
    kind: z.literal("data.delete"),
    relation: modelMutationRelationSchema,
    where: databasePredicateSchema.describe(
      "Required typed predicate using exact physical column names. Never use an unbounded delete.",
    ),
    maxAffectedRows: modelMutationMaxAffectedRowsSchema,
    returning: modelMutationReturningSchema,
  }).strict(),
  z.object({
    kind: z.literal("data.ddl"),
    relation: modelMutationRelationSchema,
    operation: databaseDdlOperationSchema.describe(
      "A typed DDL operation such as create-table, add-column, create-index, or rename-table.",
    ),
  }).strict(),
]).describe(
  "A catalog-bound database mutation. It is structured data, not raw SQL. Its exact shape depends on kind; do not mix fields from another kind. The server validates the relation, columns, catalog fingerprint, and affected-row bound again before approval.",
);

export type ModelMutationAction = z.infer<typeof modelMutationActionSchema>;

export const executeSqlInputSchema = z.object({
  sql: z.string().trim().min(1).max(100_000).optional().describe(
    "One read-only SQL statement. Use for SELECT, read-only WITH, SHOW, DESCRIBE, VALUES, or EXPLAIN. Never use it for mutations or DDL.",
  ),
  parameters: z.array(z.union([
    z.string().max(8_192),
    z.number().finite(),
    z.boolean(),
    z.null(),
  ])).max(256).optional().describe(
    "Positional values for placeholders in sql, in exact order. Null is a valid database value. Omit when sql has no placeholders.",
  ),
  analysisRef: z.string().regex(/^analysis_[0-9a-f]{32}$/u).optional().describe(
    "Opaque, single-use reference returned by prepare_analysis in this turn. It executes the already validated semantic plan; never invent or edit it.",
  ),
  mutation: modelMutationActionSchema.optional().describe(
    "Typed catalog-bound mutation. Use this instead of raw SQL for writes or DDL.",
  ),
  purpose: z.string().trim().min(1).max(1_000).optional().describe(
    "A concise user-facing reason. Required for explicit SQL and mutations; the prepared analysis already carries its title.",
  ),
}).strict().superRefine((value, context) => {
  const operationCount = Number(value.sql !== undefined)
    + Number(value.analysisRef !== undefined)
    + Number(value.mutation !== undefined);
  if (operationCount !== 1) {
    context.addIssue({ code: "custom", message: "Provide exactly one of sql, analysisRef, or mutation." });
  }
  if (value.sql === undefined && value.parameters !== undefined) {
    context.addIssue({
      code: "custom",
      message: "parameters are only valid with sql.",
      path: ["parameters"],
    });
  }
  if ((value.sql !== undefined || value.mutation !== undefined) && value.purpose === undefined) {
    context.addIssue({
      code: "custom",
      message: "purpose is required for explicit SQL and mutations.",
      path: ["purpose"],
    });
  }
}).describe(
  "The only business-data execution boundary. Provide exactly one explicit read-only sql statement, one prepared analysisRef, or one typed mutation.",
);

export type ExecuteSqlInput = z.infer<typeof executeSqlInputSchema>;

export const executeSqlOutputSchema = z.union([
  z.object({
    status: z.literal("completed"),
    mode: z.literal("read"),
    rowCount: z.number().int().nonnegative().describe(
      "Total verified rows returned by a completed read.",
    ),
    truncated: z.boolean().describe(
      "True when the verified result was bounded; omitted rows must not be inferred.",
    ),
    evidence: modelEvidenceSchema.describe(
      "Verified bounded read evidence. Use its columns and rows as the source for later presentation.",
    ),
  }).strict(),
  z.object({
    status: z.literal("completed"),
    mode: z.literal("analysis"),
    title: z.string().min(1).max(200),
    rowCount: z.number().int().nonnegative(),
    resultStatus: z.enum(["data", "no_rows"]),
    truncated: z.boolean(),
    evidence: modelEvidenceSchema.describe("Verified bounded semantic-analysis evidence."),
  }).strict(),
  z.object({
    status: z.literal("completed"),
    mode: z.literal("mutation"),
    affectedRows: z.number().int().nonnegative().optional().describe(
      "Rows changed when the connector reports an affected-row count.",
    ),
  }).strict(),
  z.object({
    status: z.literal("approval_required"),
    mode: z.literal("mutation"),
    requestId: z.string().min(1).max(512),
    checkpointId: z.string().min(1).max(512),
  }).strict(),
  z.object({
    status: z.literal("blocked"),
    mode: z.enum(["read", "analysis", "mutation"]),
    reason: toolResultReasonSchema,
    message: toolResultMessageSchema,
    nextAction: z.string().min(1).max(128).regex(/^[a-z][a-z0-9_]*$/),
  }).strict(),
  z.object({
    status: z.literal("failed"),
    mode: z.enum(["read", "analysis", "mutation"]),
    reason: toolResultReasonSchema,
    message: toolResultMessageSchema,
    nextAction: z.string().min(1).max(128).regex(/^[a-z][a-z0-9_]*$/),
  }).strict(),
]).describe(
  "Structured database result. A completed read is trusted evidence and is automatically offered to the final response processor as a governed resource; do not invent rows or columns that are not present here.",
);

export type ExecuteSqlToolOutput = z.infer<typeof executeSqlOutputSchema>;

export const prepareAnalysisSuccessSchema = z.object({
  status: z.literal("prepared").describe(
    "The semantic plan is validated and compiled but has not accessed business data.",
  ),
  analysisRef: z.string().regex(/^analysis_[0-9a-f]{32}$/u).describe(
    "Opaque, single-use reference to pass unchanged to execute_sql.",
  ),
  title: z.string().min(1).max(200).describe("Human-readable analysis title."),
  columns: z.array(z.object({
    outputId: z.string().min(1).max(128),
    label: z.string().min(1).max(256),
    type: z.enum([
      "string",
      "number",
      "decimal",
      "date",
      "timestamp",
      "boolean",
      "json",
      "unknown",
    ]),
  }).strict()).min(1).max(32).describe(
    "Expected verified output columns. This is plan metadata, not query evidence.",
  ),
}).strict().describe(
  "Prepared server-side analysis. Call execute_sql with analysisRef to access data.",
);

export const prepareAnalysisRejectedSchema = z.object({
  status: z.literal("rejected").describe("The governed analysis did not execute."),
  reason: z.enum([
    "catalog_changed",
    "catalog_incomplete",
    "invalid_plan",
    "duplicate_plan",
    "data_unavailable",
  ]).describe("Stable rejection reason."),
  message: toolResultMessageSchema.describe(
    "Concrete sanitized diagnostic explaining why execution did not occur. This is not query evidence and may include a driver error, but never credentials, SQL, or provider payloads.",
  ),
  nextAction: z.enum([
    "search_data_context",
    "describe_or_clarify",
    "revise_plan",
    "respond",
  ]).describe("Exact next step; do not repeat the rejected plan unchanged."),
}).strict().describe(
  "Rejected analysis result. Do not treat it as query evidence or create a chart from it.",
);

export const prepareAnalysisOutputSchema = z.discriminatedUnion("status", [
  prepareAnalysisSuccessSchema,
  prepareAnalysisRejectedSchema,
]).describe(
  "A prepared plan or a structured rejection. Preparation never accesses business rows.",
);

export type PrepareAnalysisToolOutput = z.infer<typeof prepareAnalysisOutputSchema>;
export type PrepareAnalysisRejected = z.infer<typeof prepareAnalysisRejectedSchema>;

function validateCatalogResultCounts(
  value: Readonly<{
    entityCount: number;
    truncated: boolean;
    omitted: Readonly<Record<"entities" | "fields" | "metrics" | "relationships", number>>;
    catalog: Readonly<{ entities: readonly unknown[] }>;
  }>,
  context: z.core.$RefinementCtx<unknown>,
): void {
  if (value.entityCount !== value.catalog.entities.length) {
    context.addIssue({
      code: "custom",
      path: ["entityCount"],
      message: "entityCount must equal the number of returned entities.",
    });
  }
  if (Object.values(value.omitted).some((count) => count > 0) && !value.truncated) {
    context.addIssue({
      code: "custom",
      path: ["truncated"],
      message: "truncated must be true when catalog omission counts are non-zero.",
    });
  }
}
