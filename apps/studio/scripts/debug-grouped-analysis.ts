import { createDataAgent, type DataAgentError } from "@open-tessera/data-agent";
import { createPostgresConnector } from "@open-tessera/postgres";
import {
  createTesseraLocalSettingsStore,
} from "../src/settings-runtime";

const entityId = "ent_eecd0896ad83a5f5730d61a2";
const providerFieldId = "fld_a10d74777e1a8753a67cfb5e";
const userCountMetricId = "met_ec2ac0c8a2c1a42bdd59089c";

function diagnostic(error: unknown) {
  const value = error instanceof Error ? error : new Error(String(error));
  const cause = value.cause instanceof Error ? value.cause : undefined;
  return {
    name: value.name,
    message: value.message.slice(0, 800),
    ...("code" in value && typeof value.code === "string" ? { code: value.code } : {}),
    ...(cause === undefined
      ? {}
      : {
        cause: {
          name: cause.name,
          message: cause.message.slice(0, 800),
          ...("code" in cause && typeof cause.code === "string" ? { code: cause.code } : {}),
        },
      }),
  };
}

const settings = await createTesseraLocalSettingsStore({ rootDirectory: process.cwd() }).read();
if (settings?.database.dialect !== "postgres" || settings.database.url === undefined) {
  throw new Error("A configured PostgreSQL Studio connection is required for this diagnostic.");
}

const connector = createPostgresConnector({
  connectionString: settings.database.url,
  maxRows: settings.limits.maxRows,
  statementTimeoutMs: settings.limits.timeoutMs,
  applicationName: "tessera-grouped-analysis-debug",
});

try {
  const dataAgent = createDataAgent({
    connector,
    catalog: { introspection: { includeComments: true } },
    query: {
      maxRows: settings.limits.maxRows,
      timeoutMs: settings.limits.timeoutMs,
    },
  });
  const planning = await dataAgent.inspectPlanningCatalog({ mode: "describe", entityIds: [entityId] });
  console.log(JSON.stringify({
    control: "catalog_described",
    entityFound: planning.semanticCatalog.entities.some((entity) => entity.id === entityId),
    capabilityPresent: Boolean(planning.capability.token),
  }));

  const draft = {
    version: "2" as const,
    mode: "aggregate" as const,
    primaryEntityId: entityId,
    relationshipIds: [],
    title: "Diagnostic: User count by Provider",
    measures: [{ kind: "metric" as const, metricId: userCountMetricId }],
    dimensions: [{ fieldId: providerFieldId }],
    orderBy: [],
    output: "table" as const,
  };

  try {
    const result = await dataAgent.runAnalysis({ capability: planning.capability, draft });
    console.log(JSON.stringify({
      control: "grouped_analysis_completed",
      rowCount: result.execution.result.rowCount,
      columns: result.columns.map(({ outputId, label, type }) => ({ outputId, label, type })),
    }));
  } catch (error) {
    console.log(JSON.stringify({ control: "grouped_analysis_failed", error: diagnostic(error) }));
    process.exitCode = 1;
  }
} finally {
  await connector.close();
}
