import type { SemanticCatalog } from "@open-tessera/data-agent";
import {
  describeDataOutputSchema,
  inspectCatalogOutputSchema,
  inspectCurrentContextOutputSchema,
  inspectDatabaseCapabilitiesOutputSchema,
  inspectSchemaOutputSchema,
  type DescribeDataToolOutput,
  type InspectCatalogOutput,
  type InspectCurrentContextOutput,
  type InspectSchemaToolOutput,
  type ListDatabaseToolOutput,
  type SearchDataContextToolOutput,
} from "./model-contracts";

export const MAX_MODEL_CATALOG_ENTITY_ALIASES = 6;
export const MAX_MODEL_CATALOG_FIELD_ALIASES = 4;
export const MAX_MODEL_CATALOG_TEXT_CHARACTERS = 120;

/**
 * The governed runtime retains the full semantic slice, while the model only
 * receives the meaning and opaque identifiers required to plan valid calls.
 */
export function compactInspectCatalogForModel(output: InspectCatalogOutput) {
  return {
    type: "json" as const,
    value: {
      status: output.status,
      entityCount: output.entityCount,
      truncated: output.truncated,
      omitted: output.omitted,
      catalog: compactSemanticCatalogForModel(output.catalog),
    },
  };
}

/** A current table is a trusted page hint, not a model-supplied selector. */
export function compactInspectCurrentContextForModel(output: InspectCurrentContextOutput) {
  return {
    type: "json" as const,
    value: output.status === "completed"
      ? {
          status: output.status,
          entityCount: output.entityCount,
          truncated: output.truncated,
          omitted: output.omitted,
          catalog: compactSemanticCatalogForModel(output.catalog),
        }
      : output,
  };
}

export function compactInspectSchemaForModel(output: InspectSchemaToolOutput) {
  return { type: "json" as const, value: output };
}

export function compactListDatabaseForModel(output: ListDatabaseToolOutput) {
  const { operation, ...payload } = output;
  if (output.operation === "current_relation") {
    if (output.status !== "completed") return { type: "json" as const, value: output };
    const current = inspectCurrentContextOutputSchema.parse(payload);
    const compact = compactInspectCurrentContextForModel(current);
    return { ...compact, value: { operation, ...compact.value } };
  }
  if (output.operation === "list_relations") {
    return { type: "json" as const, value: output };
  }
  if (output.operation === "describe_schema" || output.operation === "describe_relation") {
    const schema = inspectSchemaOutputSchema.parse(payload);
    const compact = compactInspectSchemaForModel(schema);
    return { ...compact, value: { operation, ...compact.value } };
  }
  if (output.operation === "extensions" || output.operation === "rls_policies") {
    return { type: "json" as const, value: output };
  }
  if (output.status !== "completed") {
    return { type: "json" as const, value: output };
  }
  const capabilities = inspectDatabaseCapabilitiesOutputSchema.parse(payload);
  if (capabilities.status !== "completed") {
    return { type: "json" as const, value: output };
  }
  return {
    type: "json" as const,
    value: {
      status: capabilities.status,
      operation: output.operation,
      dialect: capabilities.dialect,
      availability: capabilities.availability,
      ...(capabilities.serverVersion === undefined
        ? {}
        : { serverVersion: capabilities.serverVersion }),
      components: capabilities.components,
      truncated: capabilities.truncated,
      warnings: capabilities.warnings,
    },
  };
}

export function compactSearchDataContextForModel(output: SearchDataContextToolOutput) {
  if (output.status !== "completed") {
    return { type: "json" as const, value: output };
  }
  const { mode, ...payload } = output;
  if (output.mode === "search") {
    const search = inspectCatalogOutputSchema.parse(payload);
    const compact = compactInspectCatalogForModel(search);
    return { ...compact, value: { mode, ...compact.value } };
  }
  const description = describeDataOutputSchema.parse(payload);
  const compact = compactDescribeDataForModel(description);
  return { ...compact, value: { mode, ...compact.value } };
}

/** Expansions retain business semantics but omit compiler and catalog refs. */
export function compactDescribeDataForModel(output: DescribeDataToolOutput) {
  return {
    type: "json" as const,
    value: output.status === "completed"
      ? {
          status: output.status,
          entityCount: output.entityCount,
          truncated: output.truncated,
          omitted: output.omitted,
          catalog: compactSemanticCatalogForModel(output.catalog),
        }
      : output,
  };
}

export function compactSemanticCatalogForModel(catalog: SemanticCatalog) {
  return {
    entities: catalog.entities.map((entity) => ({
      id: entity.id,
      label: compactModelCatalogText(entity.label),
      ...(entity.aliases.length === 0
        ? {}
        : {
            aliases: compactModelCatalogAliases(
              entity.aliases,
              MAX_MODEL_CATALOG_ENTITY_ALIASES,
            ),
          }),
      ...(entity.description === undefined
        ? {}
        : { description: compactModelCatalogText(entity.description) }),
      ...(entity.defaultTimeFieldId === undefined
        ? {}
        : { defaultTimeFieldId: entity.defaultTimeFieldId }),
      fields: entity.fields.map((field) => ({
        id: field.id,
        label: compactModelCatalogText(field.label),
        ...(field.aliases.length === 0
          ? {}
          : {
              aliases: compactModelCatalogAliases(
                field.aliases,
                MAX_MODEL_CATALOG_FIELD_ALIASES,
              ),
            }),
        ...(field.description === undefined
          ? {}
          : { description: compactModelCatalogText(field.description) }),
        type: field.type,
        role: field.role,
        exposure: field.exposure,
      })),
      metrics: entity.metrics.map((metric) => ({
        id: metric.id,
        label: compactModelCatalogText(metric.label),
        ...(metric.description === undefined
          ? {}
          : { description: compactModelCatalogText(metric.description) }),
        aggregate: metric.aggregate,
        ...(metric.fieldId === undefined ? {} : { fieldId: metric.fieldId }),
      })),
    })),
    // Physical origin pairs are compiler concerns. The Agent only needs the
    // relationship id, endpoints, and operator-authored meaning.
    relationships: catalog.relationships.map((relationship) => ({
      id: relationship.id,
      ...(relationship.label === undefined
        ? {}
        : { label: compactModelCatalogText(relationship.label) }),
      ...(relationship.description === undefined
        ? {}
        : { description: compactModelCatalogText(relationship.description) }),
      fromEntityId: relationship.fromEntityId,
      toEntityId: relationship.toEntityId,
    })),
  };
}

function compactModelCatalogAliases(values: readonly string[], maximum: number): string[] {
  const aliases = new Set<string>();
  for (const value of values) {
    const normalized = compactModelCatalogText(value);
    if (!normalized) continue;
    aliases.add(normalized);
    if (aliases.size >= maximum) break;
  }
  return [...aliases];
}

function compactModelCatalogText(value: string): string {
  const characters = Array.from(value.trim());
  if (characters.length <= MAX_MODEL_CATALOG_TEXT_CHARACTERS) return characters.join("");
  return `${characters.slice(0, MAX_MODEL_CATALOG_TEXT_CHARACTERS - 3).join("")}...`;
}
