import { createHash } from "node:crypto";
import type { DataAgentRunResult, CompiledResultColumn } from "@open-tessera/data-agent";
import type {
  OpenGenerativeAuthority,
  OpenGenerativeDatasetResource,
} from "@open-generative/host";
import {
  actorAuditRefSchema,
  resourceBindingIdSchema,
  resourceDatasetPayloadSchema,
  sha256HashSchema,
  type ResourceDatasetPayload,
} from "@open-generative/protocol";
import { normalizeResultValue } from "../result-value";

const MAX_RESOURCE_ROWS = 10_000;
const MAX_RESOURCE_VALUE_BYTES = 16_384;
const MAX_TITLE_LENGTH = 200;
const AUTHORITY_POLICY_REVISION = "tessera-studio.v1";

type CompletedAnalysis = Readonly<{
  result: DataAgentRunResult;
  title: string;
}>;

export type TesseraPresentationIdentity = Readonly<{
  subject: string;
  tenantId: string;
}>;

/**
 * Projects verified analyses into the only contract Studio needs to provide:
 * a standard dataset Resource. Component choice stays inside Open Generative's
 * Catalog/Compiler and is never guessed from column names in Tessera.
 */
export function createTesseraDataResources(input: Readonly<{
  analyses: readonly CompletedAnalysis[];
}>): readonly OpenGenerativeDatasetResource[] {
  return input.analyses.flatMap((analysis, index) => {
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
}

/** Produces opaque stable audience bindings without exposing Studio identities. */
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
