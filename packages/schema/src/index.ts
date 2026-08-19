import { z } from "zod";

export const DATA_ELEMENTS_PROTOCOL_VERSION = "1.0" as const;

export const V1_PROTOCOL_LIMITS = Object.freeze({
  maxArtifactBytes: 1_048_576,
  maxDepth: 32,
  maxStringBytes: 65_536,
  maxCollectionItems: 10_000,
  maxObjectKeys: 256,
  maxTotalValues: 100_000,
  maxQueryRows: 10_000,
  maxQueryColumns: 128,
}) as Readonly<{
  maxArtifactBytes: number;
  maxDepth: number;
  maxStringBytes: number;
  maxCollectionItems: number;
  maxObjectKeys: number;
  maxTotalValues: number;
  maxQueryRows: number;
  maxQueryColumns: number;
}>;

export type StructuredValueLimits = Pick<
  typeof V1_PROTOCOL_LIMITS,
  | "maxArtifactBytes"
  | "maxDepth"
  | "maxStringBytes"
  | "maxCollectionItems"
  | "maxObjectKeys"
  | "maxTotalValues"
>;

export type StructuredValueLimitIssue = {
  code:
    | "artifact_too_large"
    | "collection_too_large"
    | "object_too_wide"
    | "string_too_large"
    | "too_deep"
    | "too_many_values"
    | "cyclic_value";
  message: string;
  path: (string | number)[];
};

const textEncoder = new TextEncoder();

export function validateStructuredValueLimits(
  input: unknown,
  limits: StructuredValueLimits = V1_PROTOCOL_LIMITS,
): StructuredValueLimitIssue[] {
  const issues: StructuredValueLimitIssue[] = [];
  const seen = new WeakSet<object>();
  let totalValues = 0;

  const visit = (
    value: unknown,
    path: (string | number)[],
    depth: number,
  ): void => {
    totalValues += 1;
    if (totalValues > limits.maxTotalValues) {
      if (!issues.some((issue) => issue.code === "too_many_values")) {
        issues.push({
          code: "too_many_values",
          message: `Value count exceeds ${limits.maxTotalValues}.`,
          path,
        });
      }
      return;
    }
    if (depth > limits.maxDepth) {
      issues.push({
        code: "too_deep",
        message: `Value depth exceeds ${limits.maxDepth}.`,
        path,
      });
      return;
    }
    if (typeof value === "string") {
      if (textEncoder.encode(value).byteLength > limits.maxStringBytes) {
        issues.push({
          code: "string_too_large",
          message: `String exceeds ${limits.maxStringBytes} UTF-8 bytes.`,
          path,
        });
      }
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) {
      issues.push({
        code: "cyclic_value",
        message: "Cyclic values are not valid artifact data.",
        path,
      });
      return;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > limits.maxCollectionItems) {
        issues.push({
          code: "collection_too_large",
          message: `Collection exceeds ${limits.maxCollectionItems} items.`,
          path,
        });
      }
      for (
        let index = 0;
        index < Math.min(value.length, limits.maxCollectionItems + 1);
        index += 1
      ) {
        visit(value[index], [...path, index], depth + 1);
      }
      return;
    }
    const entries = Object.entries(value);
    if (entries.length > limits.maxObjectKeys) {
      issues.push({
        code: "object_too_wide",
        message: `Object exceeds ${limits.maxObjectKeys} keys.`,
        path,
      });
    }
    for (const [key, nested] of entries.slice(0, limits.maxObjectKeys + 1)) {
      visit(nested, [...path, key], depth + 1);
    }
  };

  visit(input, [], 0);
  if (!issues.some((issue) => issue.code === "cyclic_value")) {
    try {
      const serialized = JSON.stringify(input);
      if (
        serialized !== undefined &&
        textEncoder.encode(serialized).byteLength > limits.maxArtifactBytes
      ) {
        issues.push({
          code: "artifact_too_large",
          message: `Artifact exceeds ${limits.maxArtifactBytes} UTF-8 bytes.`,
          path: [],
        });
      }
    } catch {
      issues.push({
        code: "cyclic_value",
        message: "Artifact must be JSON serializable.",
        path: [],
      });
    }
  }
  return issues;
}

export const dataValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export type DataValue = z.infer<typeof dataValueSchema>;

const baseArtifactFields = {
  protocolVersion: z.literal(DATA_ELEMENTS_PROTOCOL_VERSION),
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  createdAt: z.iso.datetime().optional(),
};

export const numericFormatSchema = z.enum([
  "number",
  "compact",
  "currency",
  "percent",
]);

export const timeSeriesPointSchema = z
  .object({
    timestamp: z.iso.datetime(),
    value: z.number(),
  })
  .strict();

export const dataColumnSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["string", "number", "date", "boolean", "unknown"]),
  format: z.enum(["plain", "compact", "currency", "percent"]).default("plain"),
  currency: z.string().length(3).optional(),
});

export const chartSpecSchema = z.object({
  kind: z.enum(["line", "bar", "area"]),
  xKey: z.string().min(1),
  yKeys: z.array(z.string().min(1)).min(1).max(8),
});

export const queryArtifactSchema = z.object({
  ...baseArtifactFields,
  kind: z.literal("query"),
  metricDefinition: z.string().default(""),
  timeZone: z.string().default("UTC"),
  filters: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  sql: z.string().default(""),
  columns: z.array(dataColumnSchema).max(V1_PROTOCOL_LIMITS.maxQueryColumns),
  rows: z
    .array(z.record(z.string(), dataValueSchema))
    .max(V1_PROTOCOL_LIMITS.maxQueryRows),
  rowCount: z.number().int().nonnegative(),
  truncated: z.boolean().default(false),
  durationMs: z.number().nonnegative().optional(),
  queriedAt: z.iso.datetime().optional(),
  sourceTables: z.array(z.string()).default([]),
  chart: chartSpecSchema.optional(),
});

export const calculatorArtifactSchema = z.object({
  ...baseArtifactFields,
  kind: z.literal("calculator"),
  calculatorId: z.string().min(1),
  initialValues: z.record(z.string(), z.number()).default({}),
  currency: z.string().length(3).default("USD"),
  locale: z.string().default("en-US"),
});

export const metricValueSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.number(),
  format: numericFormatSchema.default("number"),
  currency: z.string().length(3).optional(),
  change: z.number().optional(),
  changeLabel: z.string().optional(),
  sentiment: z.enum(["positive", "negative", "neutral"]).optional(),
});

export const metricArtifactSchema = z.object({
  ...baseArtifactFields,
  kind: z.literal("metric"),
  metrics: z.array(metricValueSchema).min(1).max(12),
  footnote: z.string().optional(),
});

export const comparisonArtifactSchema = z.object({
  ...baseArtifactFields,
  kind: z.literal("comparison"),
  subjectLabel: z.string().default("Option"),
  subjects: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        description: z.string().optional(),
      }),
    )
    .min(2)
    .max(8),
  criteria: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        values: z.record(z.string(), dataValueSchema),
        winnerId: z.string().optional(),
      }),
    )
    .min(1)
    .max(24),
  recommendation: z.string().optional(),
});

export const trendArtifactSchema = z
  .object({
    ...baseArtifactFields,
    kind: z.literal("trend"),
    metricLabel: z.string().min(1),
    format: numericFormatSchema.default("number"),
    currency: z.string().length(3).optional(),
    change: z.number().min(-100).max(100).optional(),
    changeLabel: z.string().optional(),
    target: z.number().optional(),
    points: z.array(timeSeriesPointSchema).min(2).max(2_000),
    insight: z.string().optional(),
  })
  .strict();

export const anomalyItemSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    timestamp: z.iso.datetime(),
    severity: z.enum(["low", "medium", "high"]),
    actual: z.number(),
    expected: z.number(),
    deviation: z.number().min(-100).max(100),
    explanation: z.string().optional(),
  })
  .strict();

export const anomalyArtifactSchema = z
  .object({
    ...baseArtifactFields,
    kind: z.literal("anomaly"),
    format: numericFormatSchema.default("number"),
    currency: z.string().length(3).optional(),
    summary: z.string().optional(),
    anomalies: z.array(anomalyItemSchema).min(1).max(100),
    nextStep: z.string().optional(),
  })
  .strict();

export const forecastPointSchema = z
  .object({
    timestamp: z.iso.datetime(),
    actual: z.number().optional(),
    forecast: z.number().optional(),
    lower: z.number().optional(),
    upper: z.number().optional(),
  })
  .strict()
  .refine(
    (point) => point.actual !== undefined || point.forecast !== undefined,
    {
      message: "A forecast point must contain an actual or forecast value.",
    },
  );

export const forecastArtifactSchema = z
  .object({
    ...baseArtifactFields,
    kind: z.literal("forecast"),
    metricLabel: z.string().min(1),
    format: numericFormatSchema.default("number"),
    currency: z.string().length(3).optional(),
    confidenceLevel: z.number().min(0).max(100),
    horizon: z.string().min(1),
    method: z.string().min(1),
    target: z.number().optional(),
    points: z.array(forecastPointSchema).min(2).max(2_000),
  })
  .strict();

export const funnelStepSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    value: z.number().nonnegative(),
    conversionFromPrevious: z.number().min(0).max(100).optional(),
    note: z.string().optional(),
  })
  .strict();

export const funnelArtifactSchema = z
  .object({
    ...baseArtifactFields,
    kind: z.literal("funnel"),
    steps: z.array(funnelStepSchema).min(2).max(16),
    footnote: z.string().optional(),
  })
  .strict();

export const dataQualityCheckSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    status: z.enum(["passed", "warning", "failed"]),
    detail: z.string().min(1),
    observed: z.union([z.string(), z.number()]).optional(),
    threshold: z.union([z.string(), z.number()]).optional(),
  })
  .strict();

export const dataQualityArtifactSchema = z
  .object({
    ...baseArtifactFields,
    kind: z.literal("data-quality"),
    score: z.number().min(0).max(100),
    source: z.string().min(1),
    updatedAt: z.iso.datetime().optional(),
    checks: z.array(dataQualityCheckSchema).min(1).max(48),
  })
  .strict();

export const insightItemSchema = z
  .object({
    id: z.string().min(1),
    headline: z.string().min(1),
    detail: z.string().min(1),
    evidence: z.string().optional(),
  })
  .strict();

export const insightArtifactSchema = z
  .object({
    ...baseArtifactFields,
    kind: z.literal("insight"),
    insights: z.array(insightItemSchema).min(1).max(12),
    recommendedAction: z.string().optional(),
  })
  .strict();

export const breakdownItemSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    value: z.number(),
    share: z.number().min(0).max(100).optional(),
    change: z.number().optional(),
    note: z.string().optional(),
  })
  .strict();

export const breakdownArtifactSchema = z
  .object({
    ...baseArtifactFields,
    kind: z.literal("breakdown"),
    dimensionLabel: z.string().min(1),
    metricLabel: z.string().min(1),
    format: numericFormatSchema.default("number"),
    currency: z.string().length(3).optional(),
    total: z.number().optional(),
    items: z.array(breakdownItemSchema).min(1).max(24),
    insight: z.string().optional(),
  })
  .strict();

export const distributionBinSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    min: z.number(),
    max: z.number(),
    count: z.number().int().nonnegative(),
  })
  .strict()
  .refine((bin) => bin.max > bin.min, {
    message: "A distribution bin maximum must be greater than its minimum.",
  });

export const distributionSummarySchema = z
  .object({
    count: z.number().int().nonnegative(),
    min: z.number(),
    p25: z.number(),
    median: z.number(),
    mean: z.number(),
    p75: z.number(),
    max: z.number(),
  })
  .strict()
  .refine(
    (summary) =>
      summary.min <= summary.p25 &&
      summary.p25 <= summary.median &&
      summary.median <= summary.p75 &&
      summary.p75 <= summary.max,
    {
      message:
        "Distribution quantiles must be ordered from minimum to maximum.",
    },
  );

export const distributionArtifactSchema = z
  .object({
    ...baseArtifactFields,
    kind: z.literal("distribution"),
    metricLabel: z.string().min(1),
    format: numericFormatSchema.default("number"),
    currency: z.string().length(3).optional(),
    bins: z.array(distributionBinSchema).min(2).max(80),
    summary: distributionSummarySchema,
    outlierCount: z.number().int().nonnegative().default(0),
    insight: z.string().optional(),
  })
  .strict();

export const cohortRowSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    size: z.number().int().positive(),
    values: z.array(z.number().min(0).max(100).nullable()).min(1).max(24),
  })
  .strict();

export const cohortArtifactSchema = z
  .object({
    ...baseArtifactFields,
    kind: z.literal("cohort"),
    metricLabel: z.string().min(1),
    periods: z.array(z.string().min(1)).min(1).max(24),
    cohorts: z.array(cohortRowSchema).min(1).max(36),
    insight: z.string().optional(),
  })
  .strict()
  .refine(
    (artifact) =>
      artifact.cohorts.every(
        (cohort) => cohort.values.length === artifact.periods.length,
      ),
    { message: "Every cohort row must contain one value for each period." },
  );

export const experimentVariantSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    sampleSize: z.number().int().positive(),
    value: z.number(),
  })
  .strict();

export const experimentEffectSchema = z
  .object({
    absolute: z.number(),
    relative: z.number(),
    ciLower: z.number(),
    ciUpper: z.number(),
    confidenceLevel: z.number().min(0).max(100),
    pValue: z.number().min(0).max(1).optional(),
    significant: z.boolean(),
  })
  .strict()
  .refine((effect) => effect.ciLower <= effect.ciUpper, {
    message:
      "The confidence interval lower bound must not exceed its upper bound.",
  });

export const experimentGuardrailSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    status: z.enum(["passed", "warning", "failed"]),
    detail: z.string().optional(),
  })
  .strict();

export const experimentArtifactSchema = z
  .object({
    ...baseArtifactFields,
    kind: z.literal("experiment"),
    metricLabel: z.string().min(1),
    format: numericFormatSchema.default("percent"),
    currency: z.string().length(3).optional(),
    control: experimentVariantSchema,
    treatment: experimentVariantSchema,
    effect: experimentEffectSchema,
    method: z.string().min(1),
    guardrails: z.array(experimentGuardrailSchema).max(12).default([]),
    conclusion: z.string().optional(),
  })
  .strict();

export const driverItemSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    value: z.number(),
    note: z.string().optional(),
  })
  .strict();

export const driverArtifactSchema = z
  .object({
    ...baseArtifactFields,
    kind: z.literal("driver"),
    metricLabel: z.string().min(1),
    format: numericFormatSchema.default("number"),
    currency: z.string().length(3).optional(),
    startLabel: z.string().min(1),
    startValue: z.number(),
    endLabel: z.string().min(1),
    endValue: z.number(),
    drivers: z.array(driverItemSchema).min(1).max(24),
    footnote: z.string().optional(),
  })
  .strict();

export const rankingItemSchema = z
  .object({
    id: z.string().min(1).max(128),
    rank: z.number().int().positive(),
    label: z.string().min(1).max(160),
    value: z.number(),
    change: z.number().optional(),
    note: z.string().max(1_000).optional(),
  })
  .strict();

export const rankingArtifactSchema = z
  .object({
    ...baseArtifactFields,
    kind: z.literal("ranking"),
    metricLabel: z.string().min(1).max(160),
    format: numericFormatSchema.default("number"),
    currency: z.string().length(3).optional(),
    items: z.array(rankingItemSchema).min(1).max(50),
    highlightId: z.string().min(1).max(128).optional(),
    insight: z.string().max(2_000).optional(),
  })
  .strict()
  .superRefine((artifact, context) => {
    const ids = new Set<string>();
    artifact.items.forEach((item, index) => {
      if (ids.has(item.id)) {
        context.addIssue({
          code: "custom",
          message: "Ranking item IDs must be unique.",
          path: ["items", index, "id"],
        });
      }
      ids.add(item.id);
      if (index > 0 && item.rank < artifact.items[index - 1]!.rank) {
        context.addIssue({
          code: "custom",
          message: "Ranking items must be ordered by nondecreasing rank.",
          path: ["items", index, "rank"],
        });
      }
    });
    if (artifact.highlightId !== undefined && !ids.has(artifact.highlightId)) {
      context.addIssue({
        code: "custom",
        message: "A ranking highlight must reference an existing item.",
        path: ["highlightId"],
      });
    }
  });

export const targetStatusSchema = z.enum([
  "achieved",
  "on-track",
  "at-risk",
  "off-track",
]);

export const targetArtifactSchema = z
  .object({
    ...baseArtifactFields,
    kind: z.literal("target"),
    metricLabel: z.string().min(1).max(160),
    actual: z.number(),
    target: z.number(),
    baseline: z.number().optional(),
    direction: z.enum(["higher-is-better", "lower-is-better"]),
    status: targetStatusSchema,
    format: numericFormatSchema.default("number"),
    currency: z.string().length(3).optional(),
    deadline: z.iso.datetime().optional(),
    insight: z.string().max(2_000).optional(),
  })
  .strict();

export const timelineEventSchema = z
  .object({
    id: z.string().min(1).max(128),
    timestamp: z.iso.datetime(),
    label: z.string().min(1).max(160),
    description: z.string().min(1).max(1_000),
    status: z.enum(["planned", "in-progress", "completed", "blocked", "info"]),
    actor: z.string().min(1).max(160).optional(),
  })
  .strict();

const timeZoneSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    },
    { message: "Timeline timeZone must be a valid IANA time zone." },
  );

export const timelineArtifactSchema = z
  .object({
    ...baseArtifactFields,
    kind: z.literal("timeline"),
    events: z.array(timelineEventSchema).min(1).max(100),
    order: z.enum(["ascending", "descending"]).default("ascending"),
    timeZone: timeZoneSchema.default("UTC"),
  })
  .strict()
  .superRefine((artifact, context) => {
    const ids = new Set<string>();
    artifact.events.forEach((event, index) => {
      if (ids.has(event.id)) {
        context.addIssue({
          code: "custom",
          message: "Timeline event IDs must be unique.",
          path: ["events", index, "id"],
        });
      }
      ids.add(event.id);
    });
  });

export const artifactSchemas = {
  query: queryArtifactSchema,
  calculator: calculatorArtifactSchema,
  metric: metricArtifactSchema,
  comparison: comparisonArtifactSchema,
  trend: trendArtifactSchema,
  anomaly: anomalyArtifactSchema,
  forecast: forecastArtifactSchema,
  funnel: funnelArtifactSchema,
  "data-quality": dataQualityArtifactSchema,
  insight: insightArtifactSchema,
  breakdown: breakdownArtifactSchema,
  distribution: distributionArtifactSchema,
  cohort: cohortArtifactSchema,
  experiment: experimentArtifactSchema,
  driver: driverArtifactSchema,
  ranking: rankingArtifactSchema,
  target: targetArtifactSchema,
  timeline: timelineArtifactSchema,
} as const;

export type ArtifactKind = keyof typeof artifactSchemas;

export const artifactKinds = Object.freeze(
  Object.keys(artifactSchemas) as ArtifactKind[],
) as readonly ArtifactKind[];

export const artifactKindSchema = z.enum(
  artifactKinds as [ArtifactKind, ...ArtifactKind[]],
);

const artifactSchemaOptions = Object.values(artifactSchemas) as [
  (typeof artifactSchemas)[ArtifactKind],
  ...(typeof artifactSchemas)[ArtifactKind][],
];

export const artifactSchemaBase = z.discriminatedUnion(
  "kind",
  artifactSchemaOptions,
);

export const artifactSchema = artifactSchemaBase.superRefine(
  (artifact, context) => {
    for (const issue of validateStructuredValueLimits(artifact)) {
      context.addIssue({
        code: "custom",
        message: issue.message,
        path: issue.path,
      });
    }
  },
);

export const artifactActionContracts = {
  "export-query": {
    artifactKind: "query",
    payloadSchema: z.object({ format: z.literal("csv") }).strict(),
  },
  "calculator-change": {
    artifactKind: "calculator",
    payloadSchema: z
      .object({ values: z.record(z.string(), z.number()) })
      .strict(),
  },
  "copy-formula": {
    artifactKind: "calculator",
    payloadSchema: z
      .object({ values: z.record(z.string(), z.number()) })
      .strict(),
  },
  "metric-select": {
    artifactKind: "metric",
    payloadSchema: z.object({ metricId: z.string().min(1) }).strict(),
  },
  "recommendation-select": {
    artifactKind: "comparison",
    payloadSchema: z.object({ recommendation: z.string().min(1) }).strict(),
  },
  "trend-point-select": {
    artifactKind: "trend",
    payloadSchema: timeSeriesPointSchema,
  },
  "anomaly-select": {
    artifactKind: "anomaly",
    payloadSchema: z.object({ anomalyId: z.string().min(1) }).strict(),
  },
  "anomaly-next-step": {
    artifactKind: "anomaly",
    payloadSchema: z.object({ nextStep: z.string().min(1) }).strict(),
  },
  "funnel-step-select": {
    artifactKind: "funnel",
    payloadSchema: z
      .object({
        stepId: z.string().min(1),
        index: z.number().int().nonnegative(),
      })
      .strict(),
  },
  "quality-check-select": {
    artifactKind: "data-quality",
    payloadSchema: z.object({ checkId: z.string().min(1) }).strict(),
  },
  "insight-select": {
    artifactKind: "insight",
    payloadSchema: z.object({ insightId: z.string().min(1) }).strict(),
  },
  "insight-action": {
    artifactKind: "insight",
    payloadSchema: z.object({ action: z.string().min(1) }).strict(),
  },
  "breakdown-item-select": {
    artifactKind: "breakdown",
    payloadSchema: z
      .object({ itemId: z.string().min(1), rank: z.number().int().positive() })
      .strict(),
  },
  "distribution-bin-select": {
    artifactKind: "distribution",
    payloadSchema: z
      .object({ binId: z.string().min(1), min: z.number(), max: z.number() })
      .strict(),
  },
  "cohort-cell-select": {
    artifactKind: "cohort",
    payloadSchema: z
      .object({
        cohortId: z.string().min(1),
        periodIndex: z.number().int().nonnegative(),
        value: z.number().min(0).max(100),
      })
      .strict(),
  },
  "driver-select": {
    artifactKind: "driver",
    payloadSchema: z
      .object({
        driverId: z.string().min(1),
        index: z.number().int().nonnegative(),
      })
      .strict(),
  },
  "ranking-item-select": {
    artifactKind: "ranking",
    payloadSchema: z
      .object({
        itemId: z.string().min(1).max(128),
        rank: z.number().int().positive(),
      })
      .strict(),
  },
  "timeline-item-select": {
    artifactKind: "timeline",
    payloadSchema: z.object({ eventId: z.string().min(1).max(128) }).strict(),
  },
} as const satisfies Record<
  string,
  {
    artifactKind: ArtifactKind;
    payloadSchema: z.ZodType<Record<string, unknown>>;
  }
>;

export type ArtifactActionName = keyof typeof artifactActionContracts;
export type ArtifactActionPayload<TAction extends ArtifactActionName> = z.infer<
  (typeof artifactActionContracts)[TAction]["payloadSchema"]
>;
export type BuiltInArtifactActionEvent = {
  [TAction in ArtifactActionName]: {
    protocolVersion: typeof DATA_ELEMENTS_PROTOCOL_VERSION;
    eventId: string;
    artifactId: string;
    artifactKind: (typeof artifactActionContracts)[TAction]["artifactKind"];
    action: TAction;
    payload: ArtifactActionPayload<TAction>;
    timestamp: string;
  };
}[ArtifactActionName];

export const artifactActionNames = Object.freeze(
  Object.keys(artifactActionContracts) as ArtifactActionName[],
) as readonly ArtifactActionName[];

export const artifactActionNameSchema = z.enum(
  artifactActionNames as [ArtifactActionName, ...ArtifactActionName[]],
);

export const artifactActionEventSchema = z
  .object({
    protocolVersion: z.literal(DATA_ELEMENTS_PROTOCOL_VERSION),
    eventId: z.string().min(1),
    artifactId: z.string().min(1),
    artifactKind: artifactKindSchema,
    action: z.string().min(1),
    payload: z.record(z.string(), z.unknown()).default({}),
    timestamp: z.iso.datetime(),
  })
  .strict()
  .superRefine((event, context) => {
    for (const issue of validateStructuredValueLimits(event)) {
      context.addIssue({
        code: "custom",
        message: issue.message,
        path: issue.path,
      });
    }
  });

export type DataColumn = z.infer<typeof dataColumnSchema>;
export type QueryArtifact = z.infer<typeof queryArtifactSchema>;
export type CalculatorArtifact = z.infer<typeof calculatorArtifactSchema>;
export type MetricArtifact = z.infer<typeof metricArtifactSchema>;
export type ComparisonArtifact = z.infer<typeof comparisonArtifactSchema>;
export type TrendArtifact = z.infer<typeof trendArtifactSchema>;
export type AnomalyArtifact = z.infer<typeof anomalyArtifactSchema>;
export type ForecastArtifact = z.infer<typeof forecastArtifactSchema>;
export type FunnelArtifact = z.infer<typeof funnelArtifactSchema>;
export type DataQualityArtifact = z.infer<typeof dataQualityArtifactSchema>;
export type InsightArtifact = z.infer<typeof insightArtifactSchema>;
export type BreakdownArtifact = z.infer<typeof breakdownArtifactSchema>;
export type DistributionArtifact = z.infer<typeof distributionArtifactSchema>;
export type CohortArtifact = z.infer<typeof cohortArtifactSchema>;
export type ExperimentArtifact = z.infer<typeof experimentArtifactSchema>;
export type DriverArtifact = z.infer<typeof driverArtifactSchema>;
export type RankingArtifact = z.infer<typeof rankingArtifactSchema>;
export type TargetArtifact = z.infer<typeof targetArtifactSchema>;
export type TimelineArtifact = z.infer<typeof timelineArtifactSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type ArtifactActionEvent = z.infer<typeof artifactActionEventSchema>;

export function safeParseBuiltInArtifactActionEvent(
  input: unknown,
):
  | { success: true; data: BuiltInArtifactActionEvent }
  | { success: false; error: z.ZodError } {
  const parsed = artifactActionEventSchema.safeParse(input);
  if (!parsed.success) return parsed;
  const contract =
    artifactActionContracts[parsed.data.action as ArtifactActionName];
  if (!contract) {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: "custom",
          message: `Unknown built-in artifact action "${parsed.data.action}".`,
          path: ["action"],
        },
      ]),
    };
  }
  if (parsed.data.artifactKind !== contract.artifactKind) {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: "custom",
          message: `Action "${parsed.data.action}" is not valid for artifact kind "${parsed.data.artifactKind}".`,
          path: ["artifactKind"],
        },
      ]),
    };
  }
  const payload = contract.payloadSchema.safeParse(parsed.data.payload);
  if (!payload.success) return payload;
  return {
    success: true,
    data: {
      ...parsed.data,
      payload: payload.data,
    } as BuiltInArtifactActionEvent,
  };
}

export function parseBuiltInArtifactActionEvent(
  input: unknown,
): BuiltInArtifactActionEvent {
  const parsed = safeParseBuiltInArtifactActionEvent(input);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

export function parseArtifact(input: unknown): Artifact {
  return artifactSchema.parse(input);
}

export function safeParseArtifact(input: unknown) {
  return artifactSchema.safeParse(input);
}
