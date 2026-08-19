import { createHash } from "node:crypto";
import { z } from "zod";

/** The input contract version for server-bound database actions. */
export const DATABASE_ACTION_VERSION = 1 as const;

const identifierSchema = z.string().min(1).max(256);
const catalogFingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const scalarValueSchema = z.union([
  z.string().max(8_192),
  z.number().finite(),
  z.boolean(),
]);
const writeValueSchema = z.union([scalarValueSchema, z.null()]);
const predicateValueSchema = z.union([
  scalarValueSchema,
  z.array(scalarValueSchema).min(1).max(64),
]);

export const databaseActionKindSchema = z.enum([
  "data.read",
  "data.insert",
  "data.update",
  "data.delete",
  "data.ddl",
]);
export const databaseActionRiskSchema = z.enum(["low", "medium", "high", "critical"]);
export const databaseConnectionRefSchema = identifierSchema;
export const databaseCatalogFingerprintSchema = catalogFingerprintSchema;
export const databaseIdentifierSchema = identifierSchema;
export const databaseWriteValueSchema = writeValueSchema;

export const databaseRelationRefSchema = z.object({
  schema: identifierSchema,
  table: identifierSchema,
}).strict();

export const databaseColumnRefSchema = databaseRelationRefSchema.extend({
  column: identifierSchema,
}).strict();

export type DatabaseActionKind = z.infer<typeof databaseActionKindSchema>;
export type DatabaseActionRisk = z.infer<typeof databaseActionRiskSchema>;
export type DatabaseRelationRef = z.infer<typeof databaseRelationRefSchema>;
export type DatabaseColumnRef = z.infer<typeof databaseColumnRefSchema>;
export type DatabaseWriteValue = z.infer<typeof databaseWriteValueSchema>;

export type DatabasePredicate =
  | Readonly<{ kind: "all"; items: readonly DatabasePredicate[] }>
  | Readonly<{ kind: "any"; items: readonly DatabasePredicate[] }>
  | Readonly<{ kind: "not"; item: DatabasePredicate }>
  | Readonly<{ kind: "null"; column: string; isNull: boolean }>
  | Readonly<{
      kind: "comparison";
      column: string;
      op: "eq" | "neq" | "in" | "between" | "gt" | "gte" | "lt" | "lte" | "contains";
      value: string | number | boolean | readonly (string | number | boolean)[];
    }>;

export const databasePredicateSchema: z.ZodType<DatabasePredicate> = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all"), items: z.array(databasePredicateSchema).min(1).max(64) }).strict(),
  z.object({ kind: z.literal("any"), items: z.array(databasePredicateSchema).min(1).max(64) }).strict(),
  z.object({ kind: z.literal("not"), item: databasePredicateSchema }).strict(),
  z.object({ kind: z.literal("null"), column: identifierSchema, isNull: z.boolean() }).strict(),
  z.object({
    kind: z.literal("comparison"),
    column: identifierSchema,
    op: z.enum(["eq", "neq", "in", "between", "gt", "gte", "lt", "lte", "contains"]),
    value: predicateValueSchema,
  }).strict().superRefine((value, context) => {
    const values = Array.isArray(value.value) ? value.value : undefined;
    if ((value.op === "in" || value.op === "between") && values === undefined) {
      context.addIssue({ code: "custom", message: `${value.op} requires an array value.`, path: ["value"] });
    }
    if (value.op === "between" && values?.length !== 2) {
      context.addIssue({ code: "custom", message: "between requires exactly two values.", path: ["value"] });
    }
    if (!["in", "between"].includes(value.op) && values !== undefined) {
      context.addIssue({ code: "custom", message: `${value.op} requires one scalar value.`, path: ["value"] });
    }
  }),
]));

/** A server-issued predicate that is merged into an action before approval. */
export const databaseRowPredicateBindingSchema = z.object({
  ref: identifierSchema,
  predicate: databasePredicateSchema,
}).strict();

export type DatabaseRowPredicateBinding = z.infer<typeof databaseRowPredicateBindingSchema>;

const rowSchema = z.record(identifierSchema, writeValueSchema).superRefine((value, context) => {
  if (Object.keys(value).length === 0) {
    context.addIssue({ code: "custom", message: "A row must include at least one column." });
  }
});

const patchSchema = z.record(identifierSchema, writeValueSchema).superRefine((value, context) => {
  if (Object.keys(value).length === 0) {
    context.addIssue({ code: "custom", message: "A patch must include at least one column." });
  }
});

const returningColumnsSchema = z.array(identifierSchema).min(1).max(128).optional();
const mutationLimitSchema = z.number().int().positive().max(10_000);

const actionEnvelopeSchema = z.object({
  version: z.literal(DATABASE_ACTION_VERSION),
  connectionRef: databaseConnectionRefSchema,
  databaseRef: identifierSchema.optional(),
  catalogFingerprint: catalogFingerprintSchema,
  relation: databaseRelationRefSchema,
}).strict();

export const databaseReadActionSchema = actionEnvelopeSchema.extend({
  kind: z.literal("data.read"),
  columns: z.array(identifierSchema).min(1).max(256),
  where: databasePredicateSchema.optional(),
  orderBy: z.array(z.object({
    column: identifierSchema,
    direction: z.enum(["asc", "desc"]),
  }).strict()).max(32).default([]),
  limit: z.number().int().positive().max(10_000),
}).strict();

export const databaseInsertActionSchema = actionEnvelopeSchema.extend({
  kind: z.literal("data.insert"),
  values: z.array(rowSchema).min(1).max(1_000),
  maxAffectedRows: mutationLimitSchema,
  returning: returningColumnsSchema,
}).strict().superRefine((value, context) => {
  if (value.values.length > value.maxAffectedRows) {
    context.addIssue({
      code: "custom",
      message: "maxAffectedRows cannot be lower than the number of rows being inserted.",
      path: ["maxAffectedRows"],
    });
  }
});

export const databaseUpdateActionSchema = actionEnvelopeSchema.extend({
  kind: z.literal("data.update"),
  patch: patchSchema,
  where: databasePredicateSchema,
  maxAffectedRows: mutationLimitSchema,
  returning: returningColumnsSchema,
}).strict();

export const databaseDeleteActionSchema = actionEnvelopeSchema.extend({
  kind: z.literal("data.delete"),
  where: databasePredicateSchema,
  maxAffectedRows: mutationLimitSchema,
  returning: returningColumnsSchema,
}).strict();

export const databaseDdlColumnSchema = z.object({
  name: identifierSchema,
  dataType: z.string().min(1).max(256),
  nullable: z.boolean(),
}).strict();

export const databaseDdlOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create-table"),
    columns: z.array(databaseDdlColumnSchema).min(1).max(256),
    primaryKey: z.array(identifierSchema).max(32).default([]),
  }).strict(),
  z.object({ kind: z.literal("drop-table") }).strict(),
  z.object({ kind: z.literal("truncate-table") }).strict(),
  z.object({ kind: z.literal("add-column"), column: databaseDdlColumnSchema }).strict(),
  z.object({ kind: z.literal("drop-column"), column: identifierSchema }).strict(),
  z.object({
    kind: z.literal("rename-table"),
    to: databaseRelationRefSchema,
  }).strict(),
  z.object({
    kind: z.literal("rename-column"),
    column: identifierSchema,
    to: identifierSchema,
  }).strict(),
  z.object({
    kind: z.literal("create-index"),
    indexName: identifierSchema,
    columns: z.array(identifierSchema).min(1).max(32),
    unique: z.boolean().default(false),
  }).strict(),
  z.object({ kind: z.literal("drop-index"), indexName: identifierSchema }).strict(),
]);

export const databaseDdlActionSchema = actionEnvelopeSchema.extend({
  kind: z.literal("data.ddl"),
  operation: databaseDdlOperationSchema,
}).strict();

export const databaseActionSchema = z.discriminatedUnion("kind", [
  databaseReadActionSchema,
  databaseInsertActionSchema,
  databaseUpdateActionSchema,
  databaseDeleteActionSchema,
  databaseDdlActionSchema,
]);

export type DatabaseReadAction = z.infer<typeof databaseReadActionSchema>;
export type DatabaseInsertAction = z.infer<typeof databaseInsertActionSchema>;
export type DatabaseUpdateAction = z.infer<typeof databaseUpdateActionSchema>;
export type DatabaseDeleteAction = z.infer<typeof databaseDeleteActionSchema>;
export type DatabaseDdlAction = z.infer<typeof databaseDdlActionSchema>;
export type DatabaseDdlOperation = z.infer<typeof databaseDdlOperationSchema>;
export type DatabaseAction = z.infer<typeof databaseActionSchema>;

export type DatabaseActionClassification = Readonly<{
  statementClass: "read" | "write" | "destructive";
  risk: DatabaseActionRisk;
}>;

/**
 * Structured actions have stricter semantics than arbitrary SQL. The raw SQL
 * classifier remains conservative; typed updates are still destructive until
 * a compiler proves their bounded predicate and affected-row limit.
 */
export function classifyDatabaseAction(actionInput: DatabaseAction | unknown): DatabaseActionClassification {
  const action = databaseActionSchema.parse(actionInput);
  switch (action.kind) {
    case "data.read":
      return Object.freeze({ statementClass: "read", risk: "low" });
    case "data.insert":
      return Object.freeze({ statementClass: "write", risk: "medium" });
    case "data.update":
      return Object.freeze({ statementClass: "destructive", risk: "high" });
    case "data.delete":
      return Object.freeze({ statementClass: "destructive", risk: "high" });
    case "data.ddl":
      return Object.freeze({ statementClass: "destructive", risk: "critical" });
  }
}

/** Returns every physical column referenced by a structured action. */
export function collectDatabaseActionColumns(actionInput: DatabaseAction | unknown): readonly string[] {
  const action = databaseActionSchema.parse(actionInput);
  const columns = new Set<string>();
  const includePredicate = (predicate: DatabasePredicate): void => {
    switch (predicate.kind) {
      case "all":
      case "any":
        predicate.items.forEach(includePredicate);
        return;
      case "not":
        includePredicate(predicate.item);
        return;
      case "null":
      case "comparison":
        columns.add(predicate.column);
        return;
    }
  };

  switch (action.kind) {
    case "data.read":
      action.columns.forEach((column) => columns.add(column));
      action.orderBy.forEach(({ column }) => columns.add(column));
      if (action.where) includePredicate(action.where);
      break;
    case "data.insert":
      action.values.forEach((row) => Object.keys(row).forEach((column) => columns.add(column)));
      action.returning?.forEach((column) => columns.add(column));
      break;
    case "data.update":
      Object.keys(action.patch).forEach((column) => columns.add(column));
      includePredicate(action.where);
      action.returning?.forEach((column) => columns.add(column));
      break;
    case "data.delete":
      includePredicate(action.where);
      action.returning?.forEach((column) => columns.add(column));
      break;
    case "data.ddl":
      collectDdlColumns(action.operation, columns);
      break;
  }

  return Object.freeze([...columns]);
}

/**
 * Merges server-issued row predicates into the action that is reviewed and
 * compiled. Insert and DDL actions have no WHERE clause, so they cannot claim
 * row-level isolation through this mechanism.
 */
export function bindDatabaseActionRowPredicates(
  actionInput: DatabaseAction | unknown,
  bindingsInput: readonly DatabaseRowPredicateBinding[],
): DatabaseAction {
  const action = databaseActionSchema.parse(actionInput);
  const bindings = bindingsInput
    .map((binding) => databaseRowPredicateBindingSchema.parse(binding))
    .sort((left, right) => left.ref.localeCompare(right.ref));
  const duplicate = bindings.find((binding, index) => binding.ref === bindings[index - 1]?.ref);
  if (duplicate) throw new TypeError(`Row predicate binding "${duplicate.ref}" is duplicated.`);
  if (bindings.length === 0) return action;

  const predicate = combineDatabasePredicates(
    "where" in action && action.where ? action.where : undefined,
    bindings.map((binding) => binding.predicate),
  );
  switch (action.kind) {
    case "data.read":
    case "data.update":
    case "data.delete":
      return databaseActionSchema.parse({ ...action, where: predicate });
    case "data.insert":
    case "data.ddl":
      throw new TypeError("Row predicate bindings only support read, update, and delete actions.");
  }
}

/** Verifies that a client-supplied database label matches the server catalog. */
export function assertDatabaseActionCatalogBinding(
  actionInput: DatabaseAction | unknown,
  catalog: Readonly<{ connectorId: string; fingerprint: string; databaseName: string }>,
): DatabaseAction {
  const action = databaseActionSchema.parse(actionInput);
  if (action.connectionRef !== catalog.connectorId) {
    throw new TypeError("Database action connection does not match the catalog.");
  }
  if (action.catalogFingerprint !== catalog.fingerprint) {
    throw new TypeError("Database action catalog binding is stale.");
  }
  if (action.databaseRef !== catalog.databaseName) {
    throw new TypeError("Database action database does not match the catalog.");
  }
  return action;
}

/** A stable SHA-256 binding for approvals, grants, effects, and audit records. */
export function createDatabaseActionHash(actionInput: DatabaseAction | unknown): `sha256:${string}` {
  const action = databaseActionSchema.parse(actionInput);
  return `sha256:${createHash("sha256").update(canonicalJson(action)).digest("hex")}`;
}

/** The canonical JSON form used by createDatabaseActionHash. */
export function canonicalizeDatabaseAction(actionInput: DatabaseAction | unknown): string {
  return canonicalJson(databaseActionSchema.parse(actionInput));
}

function collectDdlColumns(operation: DatabaseDdlOperation, columns: Set<string>): void {
  switch (operation.kind) {
    case "create-table":
      operation.columns.forEach(({ name }) => columns.add(name));
      operation.primaryKey.forEach((column) => columns.add(column));
      return;
    case "add-column":
      columns.add(operation.column.name);
      return;
    case "drop-column":
      columns.add(operation.column);
      return;
    case "rename-column":
      columns.add(operation.column);
      columns.add(operation.to);
      return;
    case "create-index":
      operation.columns.forEach((column) => columns.add(column));
      return;
    case "drop-table":
    case "truncate-table":
    case "rename-table":
    case "drop-index":
      return;
  }
}

function combineDatabasePredicates(
  existing: DatabasePredicate | undefined,
  bindings: readonly DatabasePredicate[],
): DatabasePredicate {
  const items = existing ? [existing, ...bindings] : [...bindings];
  if (items.length === 1) return items[0]!;
  return { kind: "all", items };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Database action JSON cannot encode non-finite numbers.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new TypeError(`Database action JSON cannot encode ${typeof value}.`);
}
