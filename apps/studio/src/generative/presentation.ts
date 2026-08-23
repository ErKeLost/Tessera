import { createHash } from "node:crypto";
import type { DataAgentRunResult } from "@open-tessera/data-agent";
import type {
  OpenGenerativeAuthority,
  PresentDataChartInput,
} from "@open-generative/host";
import {
  actorAuditRefSchema,
  columnIdSchema,
  resourceDatasetPayloadSchema,
  sha256HashSchema,
  type ResourceDatasetPayload,
} from "@open-generative/protocol";

const MAX_CHART_ROWS = 10_000;
const MAX_CHART_LABEL_LENGTH = 512;
const AUTHORITY_POLICY_REVISION = "tessera-studio.v1";

export type TesseraPresentationIdentity = Readonly<{
  subject: string;
  tenantId: string;
}>;

export type TesseraDataChartPresentation = Pick<PresentDataChartInput, "authority" | "dataset" | "spec" | "title">;

/**
 * Projects a completed governed analysis into the first Tessera chart recipe.
 * It intentionally declines values that cannot cross the resource boundary.
 */
export function createTesseraDataChartPresentation(input: Readonly<{
  analysis: Readonly<{ result: DataAgentRunResult; title: string }>;
  identity: TesseraPresentationIdentity;
}>): TesseraDataChartPresentation | undefined {
  const result = input.analysis.result;
  const rows = result.execution.result.rows;
  if (rows.length < 1 || rows.length > MAX_CHART_ROWS) return undefined;

  const device = result.columns.find((column) => (
    column.type === "string" || column.type === "date" || column.type === "timestamp"
  ));
  const value = result.columns.find((column) => (
    (column.type === "number" || column.type === "decimal") && column.outputId !== device?.outputId
  ));
  if (!device || !value) return undefined;

  const deviceColumn = columnIdSchema.parse(device.outputId);
  const valueColumn = columnIdSchema.parse(value.outputId);
  const chartRows: Record<string, string | number | null>[] = [];
  for (const row of rows) {
    const deviceValue = safeDimensionValue(row[device.outputId]);
    const numericValue = safeNumericValue(row[value.outputId]);
    // A chart does not give meaningful semantics to an absent axis or value.
    if (deviceValue === undefined || numericValue === undefined) continue;
    chartRows.push({ [deviceColumn]: deviceValue, [valueColumn]: numericValue });
  }
  if (chartRows.length === 0) return undefined;

  const dataset: ResourceDatasetPayload = resourceDatasetPayloadSchema.parse({
    columns: [
      {
        columnId: deviceColumn,
        label: device.label,
        valueType: device.type === "timestamp" ? "datetime" : device.type === "date" ? "date" : "string",
      },
      { columnId: valueColumn, label: value.label, valueType: "number" },
    ],
    rows: chartRows,
    totalRows: chartRows.length,
    hasMore: false,
  });
  const title = boundedTitle(input.analysis.title);
  if (!title) return undefined;

  return Object.freeze({
    authority: createTesseraPresentationAuthority(input.identity),
    dataset,
    title,
    spec: {
      recipe: "devices-bars" as const,
      title,
      deviceColumn,
      valueColumn,
      equivalentView: "table" as const,
      accessibility: {
        label: `${title} chart`,
        description: "The same values are available in the equivalent data table.",
      },
    },
  });
}

/** Produces stable opaque bindings without ever placing a Studio identity in a surface event. */
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

function safeDimensionValue(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_CHART_LABEL_LENGTH) return undefined;
  return normalized;
}

function safeNumericValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return undefined;
  // Database decimal values frequently arrive as strings. Accept only a
  // complete base-10 literal; never coerce arbitrary text into a chart value.
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boundedTitle(value: string): string | undefined {
  const title = value.trim();
  return title.length > 0 && title.length <= 200 ? title : undefined;
}

function opaqueIdentityHash(domain: "actor" | "tenant", value: string): string {
  const hash = createHash("sha256");
  hash.update(`open-generative.tessera.${domain}\0`, "utf8");
  hash.update(value, "utf8");
  return `sha256:${hash.digest("hex")}`;
}
