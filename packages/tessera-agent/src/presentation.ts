import { createHash } from "node:crypto";
import type { DataAgentRunResult, CompiledResultColumn } from "@open-tessera/data-agent";
import type { DatabaseQueryResult } from "@open-tessera/database";
import type {
  OpenGenerativeAuthority,
  OpenGenerativeDatasetResource,
  OpenGenerativeIntentRequest,
} from "@open-generative/mastra";
import {
  actorAuditRefSchema,
  resourceBindingIdSchema,
  resourceDatasetPayloadSchema,
  sha256HashSchema,
  type ResourceDatasetPayload,
} from "@open-generative/protocol";
import { normalizeResultValue } from "./safety";

const MAX_RESOURCE_ROWS = 10_000;
const MAX_RESOURCE_VALUE_BYTES = 16_384;
const MAX_TITLE_LENGTH = 200;
// Keep the existing revision stable while the Agent is extracted from Studio.
const AUTHORITY_POLICY_REVISION = "tessera-studio.v1";

export type TesseraCompletedAnalysisPresentation = Readonly<{
  result: DataAgentRunResult;
  title: string;
}>;

export type TesseraCompletedQueryPresentation = Readonly<{
  result: DatabaseQueryResult;
  title: string;
}>;

export type TesseraPresentationIdentity = Readonly<{
  subject: string;
  tenantId: string;
}>;

/**
 * Tessera supplies only product-level intent. Open Generative owns component
 * and chart recipe selection from the bounded resource shapes.
 */
export function createTesseraPresentationIntent(
  resources: readonly OpenGenerativeDatasetResource[],
): OpenGenerativeIntentRequest | undefined {
  return resources.length > 1
    ? Object.freeze({ kind: "auto", interactions: Object.freeze(["tabs"] as const) })
    : undefined;
}

/**
 * Projects verified analyses into the only contract a host needs to provide:
 * a standard dataset Resource. Component choice stays inside Open Generative's
 * Catalog/Compiler and is never guessed from column names in Tessera.
 */
export function createTesseraDataResources(input: Readonly<{
  analyses: readonly TesseraCompletedAnalysisPresentation[];
  queries?: readonly TesseraCompletedQueryPresentation[];
}>): readonly OpenGenerativeDatasetResource[] {
  const analyses = input.analyses.flatMap((analysis, index) => {
    const dataset = createAnalysisDataset(analysis.result);
    const title = boundedTitle(analysis.title);
    if (!dataset || !title) return [];
    return [Object.freeze({
      bindingId: resourceBindingIdSchema.parse(`analysis-${index + 1}`),
      label: title,
      description: "Verified result rows from the Tessera data agent.",
      dataset,
      classification: "internal" as const,
      sensitivity: "internal" as const,
    })];
  });
  const queries = (input.queries ?? []).flatMap((query, index) => {
    const dataset = createQueryDataset(query.result);
    const title = boundedTitle(query.title);
    if (!dataset || !title) return [];
    return [Object.freeze({
      bindingId: resourceBindingIdSchema.parse(`query-${index + 1}`),
      label: title,
      description: "Verified read result rows from the Tessera data agent.",
      dataset,
      classification: "internal" as const,
      sensitivity: "internal" as const,
    })];
  });
  return [...analyses, ...queries];
}

/** Produces opaque stable audience bindings without exposing host identities. */
export function createTesseraPresentationAuthority(
  identity: TesseraPresentationIdentity,
): OpenGenerativeAuthority {
  const actor = opaqueIdentityHash("actor", identity.subject);
  const tenant = opaqueIdentityHash("tenant", identity.tenantId);
  return Object.freeze({
    actorAuditRef: actorAuditRefSchema.parse(`tessera:actor:${actor.slice("sha256:".length)}`),
    actorBindingHash: sha256HashSchema.parse(actor),
    tenantBindingHash: sha256HashSchema.parse(tenant),
    authorityPolicyRevision: AUTHORITY_POLICY_REVISION,
  });
}

function createAnalysisDataset(result: DataAgentRunResult): ResourceDatasetPayload | undefined {
  const columns = result.columns;
  const sourceRows = result.execution.result.rows;
  if (columns.length === 0 || sourceRows.length === 0) return undefined;

  const declaredColumns = columns.map((column) => ({
    columnId: column.outputId,
    label: boundedColumnLabel(column.label),
    valueType: datasetValueType(column),
  }));
  const rows = sourceRows.slice(0, MAX_RESOURCE_ROWS).flatMap((sourceRow) => {
    const row: Record<string, string | number | boolean | null> = {};
    for (const column of columns) {
      row[column.outputId] = normalizeResourceValue(
        sourceRow[column.outputId],
        column,
      );
    }
    return [row];
  });
  if (rows.length === 0) return undefined;

  return resourceDatasetPayloadSchema.parse({
    columns: declaredColumns,
    rows,
    totalRows: result.execution.result.rowCount,
    hasMore: result.execution.result.truncated || result.execution.result.rowCount > rows.length,
  });
}

function createQueryDataset(result: DatabaseQueryResult): ResourceDatasetPayload | undefined {
  if (result.columns.length === 0 || result.rows.length === 0) return undefined;
  const columns = result.columns.map((column) => {
    const values = result.rows.map((row) => normalizeResultValue(row[column.name], MAX_RESOURCE_VALUE_BYTES));
    return {
      columnId: column.name,
      label: boundedColumnLabel(column.name),
      valueType: inferQueryValueType(values),
    };
  });
  const rows = result.rows.slice(0, MAX_RESOURCE_ROWS).map((sourceRow) => {
    const row: Record<string, string | number | boolean | null> = {};
    for (const column of columns) {
      row[column.columnId] = normalizeQueryValue(sourceRow[column.columnId], column.valueType);
    }
    return row;
  });
  return resourceDatasetPayloadSchema.parse({
    columns,
    rows,
    totalRows: result.rowCount,
    hasMore: result.truncated || result.rowCount > rows.length,
  });
}

function inferQueryValueType(
  values: readonly (string | number | boolean | null)[],
): "date" | "datetime" | "number" | "string" | "boolean" {
  const present = values.filter((value): value is string | number | boolean => value !== null);
  if (present.length === 0) return "string";
  if (present.every((value) => typeof value === "boolean")) return "boolean";
  if (present.every((value) => typeof value === "number"
    || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))))) {
    return "number";
  }
  const strings = present.filter((value): value is string => typeof value === "string");
  if (strings.length === present.length && strings.every((value) => !Number.isNaN(Date.parse(value)))) {
    return strings.every((value) => /^\d{4}-\d{2}-\d{2}$/u.test(value)) ? "date" : "datetime";
  }
  return "string";
}

function normalizeQueryValue(
  value: unknown,
  valueType: "date" | "datetime" | "number" | "string" | "boolean",
): string | number | boolean | null {
  const normalized = normalizeResultValue(value, MAX_RESOURCE_VALUE_BYTES);
  if (normalized === null) return null;
  if (valueType === "number") {
    const number = typeof normalized === "number" ? normalized : Number(normalized);
    return Number.isFinite(number) ? number : null;
  }
  if (valueType === "boolean") return typeof normalized === "boolean" ? normalized : null;
  return typeof normalized === "string" ? normalized : String(normalized);
}

function normalizeResourceValue(
  value: unknown,
  column: CompiledResultColumn,
): string | number | boolean | null {
  const normalized = normalizeResultValue(value, MAX_RESOURCE_VALUE_BYTES);
  if (normalized === null) return null;
  if (column.type === "number" || column.type === "decimal") {
    if (typeof normalized === "number") return normalized;
    const parsed = typeof normalized === "string" ? Number(normalized) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (column.type === "boolean") return typeof normalized === "boolean" ? normalized : null;
  if (column.type === "date" || column.type === "timestamp") {
    if (typeof normalized !== "string" || Number.isNaN(Date.parse(normalized))) return null;
    return normalized;
  }
  return typeof normalized === "string" ? normalized : String(normalized);
}

function datasetValueType(column: CompiledResultColumn): "date" | "datetime" | "number" | "string" | "boolean" {
  switch (column.type) {
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "timestamp":
      return "datetime";
    case "number":
    case "decimal":
      return "number";
    default:
      return "string";
  }
}

function boundedTitle(value: string): string | undefined {
  const title = value.trim();
  return title.length > 0 && title.length <= MAX_TITLE_LENGTH ? title : undefined;
}

function boundedColumnLabel(value: string): string {
  const label = value.trim();
  return label.length > 0 && label.length <= 256 ? label : "Value";
}

function opaqueIdentityHash(domain: "actor" | "tenant", value: string): string {
  const hash = createHash("sha256");
  hash.update(`open-generative.tessera.${domain}\0`, "utf8");
  hash.update(value, "utf8");
  return `sha256:${hash.digest("hex")}`;
}
