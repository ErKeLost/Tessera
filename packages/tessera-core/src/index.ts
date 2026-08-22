import type { Artifact, ArtifactKind } from "@open-tessera/schema";
import {
  artifactActionContracts,
  artifactKinds,
  artifactSchemas,
  validateStructuredValueLimits,
} from "@open-tessera/schema";
import { z, type ZodType } from "zod";

export type ArtifactLike = { kind: string };
export type ArtifactInteractionModel = "read-only" | "local" | "agent-action";
export type ArtifactCommitPolicy = "atomic" | "progressive";

export type ArtifactManifest<TKind extends string = ArtifactKind> = {
  kind: TKind;
  name: string;
  description: string;
  whenToUse: readonly string[];
  whenNotToUse: readonly string[];
  interactionModel: ArtifactInteractionModel;
};

export type ArtifactContract<TArtifact extends ArtifactLike = ArtifactLike> = {
  kind: TArtifact["kind"];
  version: number;
  schema: ZodType<TArtifact>;
  manifest: ArtifactManifest<TArtifact["kind"]>;
  prompt: {
    summary: string;
    useWhen: readonly string[];
    avoidWhen: readonly string[];
  };
  category: string;
  interactionModel: ArtifactInteractionModel;
  commitPolicy: ArtifactCommitPolicy;
  eventPorts: Readonly<Record<string, ZodType<Record<string, unknown>>>>;
  renderer: {
    bindingId: string;
    exportName: string;
  };
  distribution: {
    registryName: string;
    entryFile: string;
    targetFile: string;
    clientBoundary: boolean;
    styleFiles: readonly string[];
  };
};

export function defineArtifactContract<TArtifact extends ArtifactLike>(
  contract: ArtifactContract<TArtifact>,
): ArtifactContract<TArtifact> {
  if (!contract.kind || contract.version < 1 || !Number.isInteger(contract.version)) {
    throw new Error("Artifact contracts require a non-empty kind and a positive integer version.");
  }
  if (contract.manifest.kind !== contract.kind) {
    throw new Error(`Artifact contract kind "${contract.kind}" does not match its manifest.`);
  }
  return Object.freeze({
    ...contract,
    manifest: Object.freeze({ ...contract.manifest }),
    prompt: Object.freeze({ ...contract.prompt }),
    eventPorts: Object.freeze({ ...contract.eventPorts }),
    renderer: Object.freeze({ ...contract.renderer }),
    distribution: Object.freeze({ ...contract.distribution }),
  });
}

type BuiltInContractDefinition<TKind extends ArtifactKind = ArtifactKind> = ArtifactManifest<TKind> & {
  category: "analysis" | "comparison" | "data" | "decision" | "diagnostic" | "interactive" | "quality";
};

function toPascalCase(value: string) {
  return value.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`).join("");
}

function defineBuiltInArtifactContract<TKind extends ArtifactKind>(
  definition: BuiltInContractDefinition<TKind>,
): ArtifactContract<Artifact> {
  const manifest: ArtifactManifest<TKind> = {
    kind: definition.kind,
    name: definition.name,
    description: definition.description,
    whenToUse: definition.whenToUse,
    whenNotToUse: definition.whenNotToUse,
    interactionModel: definition.interactionModel,
  };
  const eventPorts = Object.fromEntries(
    Object.entries(artifactActionContracts)
      .filter(([, contract]) => contract.artifactKind === definition.kind)
      .map(([name, contract]) => [name, contract.payloadSchema]),
  ) as Record<string, ZodType<Record<string, unknown>>>;
  return defineArtifactContract({
    kind: definition.kind,
    version: 1,
    schema: artifactSchemas[definition.kind] as unknown as ZodType<Artifact>,
    manifest: manifest as ArtifactManifest<ArtifactKind>,
    prompt: {
      summary: definition.description,
      useWhen: definition.whenToUse,
      avoidWhen: definition.whenNotToUse,
    },
    category: definition.category,
    interactionModel: definition.interactionModel,
    commitPolicy: "atomic",
    eventPorts,
    renderer: {
      bindingId: `data-elements.react.${definition.kind}`,
      exportName: `${toPascalCase(definition.kind)}Artifact`,
    },
    distribution: {
      registryName: `${definition.kind}-artifact`,
      entryFile: `packages/react/src/${definition.kind}-artifact.tsx`,
      targetFile: `@components/data-elements/${definition.kind}-artifact.tsx`,
      clientBoundary: true,
      styleFiles: ["packages/react/src/styles.css"],
    },
  });
}

const builtInContractDefinitions = [
  {
    kind: "query",
    category: "data",
    name: "Query result",
    description: "Inspect a structured analytical query with chart, table, SQL, and lineage.",
    whenToUse: [
      "The user asked for rows, trends, rankings, distributions, or a database-backed metric.",
      "The result benefits from switching between a visualization and exact values.",
      "SQL provenance or data lineage improves trust in the result.",
    ],
    whenNotToUse: [
      "The answer is a single scalar with no useful drill-down.",
      "No authoritative data tool has produced validated rows.",
    ],
    interactionModel: "agent-action",
  },
  {
    kind: "calculator",
    category: "interactive",
    name: "Interactive calculator",
    description: "Explore a trusted, registered calculation with local controls and a live chart.",
    whenToUse: [
      "The user is evaluating what-if scenarios, sensitivity, forecasts, loans, or investments.",
      "Changing a small number of numeric assumptions should update a result immediately.",
    ],
    whenNotToUse: [
      "The requested formula is not available in the trusted calculator catalog.",
      "The result depends on authoritative server data that must be refreshed for every change.",
    ],
    interactionModel: "local",
  },
  {
    kind: "metric",
    category: "analysis",
    name: "Metric snapshot",
    description: "Show one or more high-signal values and their change in a compact surface.",
    whenToUse: [
      "The answer is primarily a small set of KPIs or status values.",
      "A compact summary is more useful than detailed rows.",
    ],
    whenNotToUse: [
      "The user needs row-level inspection or trend exploration.",
    ],
    interactionModel: "read-only",
  },
  {
    kind: "comparison",
    category: "comparison",
    name: "Structured comparison",
    description: "Compare multiple options across stable, named criteria.",
    whenToUse: [
      "The user wants to choose between two or more options.",
      "The trade-offs can be represented by a shared set of criteria.",
    ],
    whenNotToUse: [
      "The options do not share comparable criteria.",
      "The response is purely narrative and a matrix would add noise.",
    ],
    interactionModel: "agent-action",
  },
  {
    kind: "trend",
    category: "analysis",
    name: "Trend explorer",
    description: "Explain how a validated metric changed over a defined period.",
    whenToUse: [
      "The user asks how a metric changed over time or whether it is moving toward a target.",
      "The data tool returned a stable sequence of timestamped observations.",
      "A period change or concise analytical insight makes the direction easier to interpret.",
    ],
    whenNotToUse: [
      "Only a current scalar is available; use a metric snapshot instead.",
      "The values are model estimates for future dates; use a forecast instead.",
      "There are no validated timestamped observations.",
    ],
    interactionModel: "agent-action",
  },
  {
    kind: "anomaly",
    category: "diagnostic",
    name: "Anomaly investigation",
    description: "Surface validated deviations from an expected range with severity and evidence.",
    whenToUse: [
      "A detection tool identified unusual observations against a computed baseline or interval.",
      "The user asks what changed unexpectedly, where a spike occurred, or which values need attention.",
      "Expected values, severity, or confidence are available alongside the observations.",
    ],
    whenNotToUse: [
      "A value merely increased or decreased without a validated anomaly baseline.",
      "The model is guessing whether an observation is unusual.",
      "The user only needs a normal historical trend.",
    ],
    interactionModel: "agent-action",
  },
  {
    kind: "forecast",
    category: "analysis",
    name: "Forecast",
    description: "Compare observed history with a validated future estimate and optional confidence interval.",
    whenToUse: [
      "A forecasting tool returned future points for a time-indexed metric.",
      "The user asks what is likely to happen next or needs planning ranges and assumptions.",
      "Historical context should be shown beside predicted values.",
    ],
    whenNotToUse: [
      "No forecasting model or authoritative calculation produced the future values.",
      "The user wants to vary assumptions locally; use a registered calculator instead.",
      "The result contains only historical observations.",
    ],
    interactionModel: "agent-action",
  },
  {
    kind: "funnel",
    category: "analysis",
    name: "Conversion funnel",
    description: "Show ordered stages, volume, conversion, and drop-off through a defined process.",
    whenToUse: [
      "The user asks where entities drop out of a sequential journey or process.",
      "Each entity passes through consistently defined, ordered stages.",
      "Validated counts or measures are available for at least two stages.",
    ],
    whenNotToUse: [
      "The categories are unordered or mutually exclusive rather than sequential.",
      "Stage definitions or cohort boundaries are inconsistent.",
      "A general distribution or ranking would describe the data more faithfully.",
    ],
    interactionModel: "agent-action",
  },
  {
    kind: "data-quality",
    category: "quality",
    name: "Data quality report",
    description: "Summarize validated quality checks for a dataset with an overall score and check details.",
    whenToUse: [
      "A data quality system returned explicit check outcomes, an overall score, and observed values or thresholds.",
      "The user asks whether a dataset is complete, fresh, valid, unique, or trustworthy.",
      "Failures need concise remediation context.",
    ],
    whenNotToUse: [
      "No quality checks were executed against the dataset.",
      "The response is only a general warning or unsupported opinion about data trust.",
      "The user is asking for business metric performance rather than dataset health.",
    ],
    interactionModel: "agent-action",
  },
  {
    kind: "insight",
    category: "analysis",
    name: "Evidence-backed insight",
    description: "Present a concise finding with structured evidence, confidence, and safe next steps.",
    whenToUse: [
      "The agent has a high-signal analytical finding supported by validated values or tool outputs.",
      "The user benefits from a short conclusion, evidence, and bounded follow-up actions.",
      "The finding spans a few facts but does not require a full row-level query surface.",
    ],
    whenNotToUse: [
      "The finding is speculative or has no structured evidence.",
      "The answer is only narrative prose with no useful action or evidence surface.",
      "A dedicated trend, anomaly, forecast, funnel, or quality artifact represents the result more precisely.",
    ],
    interactionModel: "agent-action",
  },
  {
    kind: "breakdown",
    category: "analysis",
    name: "Contribution breakdown",
    description: "Rank categories by contribution and keep values, share, and change together.",
    whenToUse: [
      "The user asks which categories, segments, regions, products, or channels contributed most to a total.",
      "A trusted aggregation returned mutually understandable categories and a common metric.",
      "Rank, share of total, or category change is more useful than row-level detail.",
    ],
    whenNotToUse: [
      "The categories are sequential stages; use a funnel instead.",
      "The question concerns the shape of individual observations; use a distribution instead.",
      "The categories overlap in a way that makes shares misleading.",
    ],
    interactionModel: "agent-action",
  },
  {
    kind: "distribution",
    category: "analysis",
    name: "Distribution profile",
    description: "Show a validated histogram with count, center, spread, quantiles, and outlier context.",
    whenToUse: [
      "The user asks how a numeric metric is distributed, whether it is skewed, or where outliers occur.",
      "A statistical tool returned explicit bins and an ordered five-number summary.",
      "Mean and median together help distinguish a typical value from skew.",
    ],
    whenNotToUse: [
      "Only grouped category totals are available; use a breakdown instead.",
      "The user asks how a metric changes over time; use a trend instead.",
      "The model has not computed stable bins and summary statistics with a trusted tool.",
    ],
    interactionModel: "agent-action",
  },
  {
    kind: "cohort",
    category: "analysis",
    name: "Cohort retention",
    description: "Compare a percentage metric across cohort start dates and elapsed periods.",
    whenToUse: [
      "The user asks whether activation, retention, repeat use, or conversion improves across cohorts.",
      "Every row represents a stable cohort and every column represents the same elapsed period definition.",
      "Cohort size and incomplete recent periods must remain visible beside the heatmap.",
    ],
    whenNotToUse: [
      "Rows are calendar periods rather than cohorts aligned by age.",
      "Cohort membership or period definitions changed between rows.",
      "A single aggregate retention value answers the question.",
    ],
    interactionModel: "agent-action",
  },
  {
    kind: "experiment",
    category: "decision",
    name: "Experiment result",
    description: "Compare control and treatment with sample sizes, effect, uncertainty, and guardrails.",
    whenToUse: [
      "A controlled experiment or approved causal analysis produced both variant outcomes and an effect estimate.",
      "The user needs to judge practical lift together with statistical uncertainty.",
      "Sample sizes, confidence interval, method, and guardrail outcomes are available.",
    ],
    whenNotToUse: [
      "The comparison is observational and no causal method supports an experiment conclusion.",
      "Only point estimates are available without sample sizes or uncertainty.",
      "The model inferred significance instead of receiving it from a validated statistical tool.",
    ],
    interactionModel: "agent-action",
  },
  {
    kind: "driver",
    category: "analysis",
    name: "Change drivers",
    description: "Explain the signed contributions that bridge a starting value to an ending value.",
    whenToUse: [
      "The user asks what drove a metric change between two defined states or periods.",
      "An additive decomposition produced signed, non-overlapping driver contributions.",
      "The start, end, and reconciliation context should remain visible with the ranked drivers.",
    ],
    whenNotToUse: [
      "Drivers overlap or cannot be added meaningfully.",
      "The analysis only establishes correlation rather than contribution.",
      "The user wants category shares at one point in time; use a breakdown instead.",
    ],
    interactionModel: "agent-action",
  },
  {
    kind: "ranking",
    category: "analysis",
    name: "Ranked results",
    description: "Compare validated entities in an explicit order by one common metric.",
    whenToUse: [
      "The user asks for the top, bottom, best, worst, or ordered entities by one validated measure.",
      "Every item uses the same metric definition and has an explicit trusted rank and value.",
      "A highlighted item or concise insight helps explain the ordered result.",
    ],
    whenNotToUse: [
      "Items use different measures or cannot be compared on one stable scale.",
      "The result is a part-to-whole contribution analysis; use a breakdown instead.",
      "The model inferred ranks without authoritative values or ordering.",
    ],
    interactionModel: "agent-action",
  },
  {
    kind: "target",
    category: "decision",
    name: "Target progress",
    description: "Show an actual value against a trusted target, direction, deadline, and explicit status.",
    whenToUse: [
      "The user asks whether a metric is on track against a defined goal or service-level objective.",
      "An authoritative system supplied the actual, target, direction, and status explicitly.",
      "Baseline, deadline, or a concise insight provides useful progress context.",
    ],
    whenNotToUse: [
      "No trusted target or explicit status is available.",
      "The status would need to be guessed from prose or inferred from incomplete business rules.",
      "The user needs a historical series rather than current progress; use a trend instead.",
    ],
    interactionModel: "read-only",
  },
  {
    kind: "timeline",
    category: "analysis",
    name: "Event timeline",
    description: "Present validated events in temporal order with status, context, and optional ownership.",
    whenToUse: [
      "The user asks what happened, what is planned, or how a process evolved over time.",
      "Each event has an authoritative timestamp, label, description, and explicit status.",
      "Ordering and timezone context are important to interpreting the sequence.",
    ],
    whenNotToUse: [
      "The entries are unordered categories rather than dated events.",
      "Dates, statuses, or event descriptions are speculative or incomplete.",
      "The user needs a numeric time series; use a trend or forecast instead.",
    ],
    interactionModel: "agent-action",
  },
] as const satisfies readonly BuiltInContractDefinition[];

export const artifactContracts = builtInContractDefinitions.map((definition) => (
  defineBuiltInArtifactContract(definition)
)) as readonly ArtifactContract<Artifact>[];

export const artifactContractMap = Object.freeze(Object.fromEntries(
  artifactContracts.map((contract) => [contract.kind, contract]),
)) as Readonly<{ [TKind in ArtifactKind]: ArtifactContract<Extract<Artifact, { kind: TKind }>> }>;

export const artifactManifests = Object.freeze(
  artifactContracts.map((contract) => contract.manifest),
) as readonly ArtifactManifest[];

export function createArtifactToolDescription<TKind extends string>(manifest: ArtifactManifest<TKind>) {
  return [
    manifest.description,
    `Use when: ${manifest.whenToUse.join(" ")}`,
    `Do not use when: ${manifest.whenNotToUse.join(" ")}`,
    "Only provide validated structured data. Never provide JSX, JavaScript, HTML, CSS, or executable formulas.",
  ].join("\n");
}

export type CatalogEntry<TArtifact extends ArtifactLike = Artifact> = {
  kind: TArtifact["kind"];
  schema: ZodType<TArtifact>;
  manifest: ArtifactManifest<TArtifact["kind"]>;
};

function normalizeCatalogEntry<TArtifact extends ArtifactLike>(
  entry: ArtifactContract<TArtifact> | CatalogEntry<TArtifact>,
): ArtifactContract<TArtifact> {
  if ("version" in entry) return entry;
  return defineArtifactContract({
    ...entry,
    version: 1,
    prompt: {
      summary: entry.manifest.description,
      useWhen: entry.manifest.whenToUse,
      avoidWhen: entry.manifest.whenNotToUse,
    },
    category: "custom",
    interactionModel: entry.manifest.interactionModel,
    commitPolicy: "atomic",
    eventPorts: {},
    renderer: {
      bindingId: `custom.${entry.kind}`,
      exportName: `${toPascalCase(entry.kind)}Artifact`,
    },
    distribution: {
      registryName: `${entry.kind.replaceAll(".", "-")}-artifact`,
      entryFile: "",
      targetFile: "",
      clientBoundary: true,
      styleFiles: [],
    },
  });
}

function isBuiltInKind(kind: string): kind is ArtifactKind {
  return artifactKinds.includes(kind as ArtifactKind);
}

function assertExtensibleKind(kind: string) {
  if (!isBuiltInKind(kind) && !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(kind)) {
    throw new Error(`Custom artifact kind "${kind}" must be namespaced, for example "acme.heatmap".`);
  }
}

export function canonicalJson(value: unknown): string {
  const stack = new WeakSet<object>();
  const serialize = (current: unknown): string => {
    if (current === null || typeof current === "boolean" || typeof current === "string") return JSON.stringify(current);
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError("Canonical JSON cannot encode non-finite numbers.");
      return Object.is(current, -0) ? "0" : JSON.stringify(current);
    }
    if (Array.isArray(current)) {
      if (stack.has(current)) throw new TypeError("Canonical JSON cannot encode cyclic arrays.");
      stack.add(current);
      const result = `[${current.map((item) => serialize(item)).join(",")}]`;
      stack.delete(current);
      return result;
    }
    if (typeof current === "object") {
      if (stack.has(current)) throw new TypeError("Canonical JSON cannot encode cyclic objects.");
      stack.add(current);
      const object = current as Record<string, unknown>;
      const entries = Object.keys(object).sort().map((key) => {
        const nested = object[key];
        if (nested === undefined) throw new TypeError(`Canonical JSON cannot encode undefined at "${key}".`);
        return `${JSON.stringify(key)}:${serialize(nested)}`;
      });
      stack.delete(current);
      return `{${entries.join(",")}}`;
    }
    throw new TypeError(`Canonical JSON cannot encode ${typeof current}.`);
  };
  return serialize(value);
}

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, amount: number) {
  return (value >>> amount) | (value << (32 - amount));
}

export function sha256(value: string): string {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.byteLength] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = input.byteLength * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const before15 = words[index - 15]!;
      const before2 = words[index - 2]!;
      const sigma0 = rotateRight(before15, 7) ^ rotateRight(before15, 18) ^ (before15 >>> 3);
      const sigma1 = rotateRight(before2, 17) ^ rotateRight(before2, 19) ^ (before2 >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + sum1 + choice + SHA256_CONSTANTS[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d! + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0]! + a!) >>> 0;
    hash[1] = (hash[1]! + b!) >>> 0;
    hash[2] = (hash[2]! + c!) >>> 0;
    hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0;
    hash[5] = (hash[5]! + f!) >>> 0;
    hash[6] = (hash[6]! + g!) >>> 0;
    hash[7] = (hash[7]! + h!) >>> 0;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, "0")).join("");
}

export class ArtifactCatalog<TArtifact extends ArtifactLike = never> {
  readonly #entries = new Map<string, ArtifactContract<ArtifactLike>>();

  constructor(entries: readonly (ArtifactContract<TArtifact> | CatalogEntry<TArtifact>)[] = []) {
    for (const entry of entries) this.register(entry);
  }

  register<TNext extends ArtifactLike>(
    entry: ArtifactContract<TNext> | CatalogEntry<TNext>,
  ): ArtifactCatalog<TArtifact | TNext> {
    assertExtensibleKind(entry.kind);
    if (this.#entries.has(entry.kind)) {
      throw new Error(`Artifact kind "${entry.kind}" is already registered.`);
    }
    this.#entries.set(entry.kind, normalizeCatalogEntry(entry) as ArtifactContract<ArtifactLike>);
    return this as unknown as ArtifactCatalog<TArtifact | TNext>;
  }

  extend<TNext extends ArtifactLike>(entries: readonly (ArtifactContract<TNext> | CatalogEntry<TNext>)[]) {
    const catalog = new ArtifactCatalog<TArtifact>(this.entries());
    for (const entry of entries) catalog.register(entry);
    return catalog as unknown as ArtifactCatalog<TArtifact | TNext>;
  }

  has(kind: string): kind is TArtifact["kind"] {
    return this.#entries.has(kind);
  }

  get(kind: string) {
    return this.#entries.get(kind);
  }

  entries(): ArtifactContract<TArtifact>[] {
    return [...this.#entries.values()] as ArtifactContract<TArtifact>[];
  }

  parse(input: unknown): TArtifact {
    const limitIssues = validateStructuredValueLimits(input);
    if (limitIssues.length > 0) {
      throw new z.ZodError(limitIssues.map((issue) => ({ code: "custom", message: issue.message, path: issue.path })));
    }
    const envelope = z.object({ kind: z.string().min(1) }).passthrough().parse(input);
    const entry = this.#entries.get(envelope.kind);
    if (!entry) throw new Error(`Artifact kind "${envelope.kind}" is not registered.`);
    return entry.schema.parse(input) as TArtifact;
  }

  safeParse(input: unknown): { success: true; data: TArtifact } | { success: false; error: unknown } {
    try {
      return { success: true, data: this.parse(input) };
    } catch (error) {
      return { success: false, error };
    }
  }

  manifests() {
    return [...this.#entries.values()].map((entry) => entry.manifest);
  }

  parseEvent(kind: string, action: string, payload: unknown): Record<string, unknown> {
    const contract = this.#entries.get(kind);
    if (!contract) throw new Error(`Artifact kind "${kind}" is not registered.`);
    const schema = contract.eventPorts[action];
    if (!schema) throw new Error(`Action "${action}" is not registered for artifact kind "${kind}".`);
    return schema.parse(payload);
  }

  toJSONSchema(): Record<string, unknown> {
    const oneOf = this.entries().map((contract) => {
      const generated = z.toJSONSchema(contract.schema, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
      const { $schema: _, ...schema } = generated;
      return { ...schema, "x-data-elements-contract": `${contract.kind}@${contract.version}` };
    });
    return {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "Data Elements artifact",
      description: "A declarative artifact selected from the active, versioned catalog.",
      oneOf,
    };
  }

  fingerprint(): string {
    const contracts = this.entries().map((contract) => ({
      kind: contract.kind,
      version: contract.version,
      schema: z.toJSONSchema(contract.schema, { target: "draft-2020-12", io: "input" }),
      prompt: contract.prompt,
      category: contract.category,
      interactionModel: contract.interactionModel,
      commitPolicy: contract.commitPolicy,
      eventPorts: Object.fromEntries(Object.entries(contract.eventPorts).sort(([left], [right]) => left.localeCompare(right)).map(([name, schema]) => [name, z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" })])),
      renderer: contract.renderer,
      distribution: contract.distribution,
    })).sort((left, right) => left.kind.localeCompare(right.kind));
    return `sha256:${sha256(canonicalJson(contracts))}`;
  }
}

export const defaultArtifactCatalog = new ArtifactCatalog<Artifact>(artifactContracts);
export const ARTIFACT_CONTRACT_FINGERPRINT = defaultArtifactCatalog.fingerprint();

export type CalculatorInput = {
  key: string;
  label: string;
  symbol: string;
  unit?: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
};

export type CalculatorResult = {
  value: number;
  formula: string;
  substitutedFormula: string;
  series: Array<{ x: number; value: number }>;
};

export type CalculatorDefinition = {
  id: string;
  name: string;
  description: string;
  inputs: readonly CalculatorInput[];
  calculate(values: Readonly<Record<string, number>>): CalculatorResult;
};

function clamp(value: number, input: CalculatorInput) {
  return Math.min(input.max, Math.max(input.min, value));
}

export function normalizeCalculatorValues(
  definition: CalculatorDefinition,
  values: Readonly<Record<string, number>>,
) {
  return Object.fromEntries(definition.inputs.map((input) => [
    input.key,
    clamp(Number.isFinite(values[input.key]) ? values[input.key]! : input.defaultValue, input),
  ]));
}

export const calculatorCatalog = {
  "compound-interest": {
    id: "compound-interest",
    name: "Compound interest",
    description: "Explore how principal, annual rate, and time affect future value.",
    inputs: [
      { key: "principal", label: "Principal", symbol: "PV", unit: "$", min: 100, max: 100_000, step: 100, defaultValue: 10_000 },
      { key: "rate", label: "Annual rate", symbol: "r", unit: "%", min: 0, max: 20, step: 0.1, defaultValue: 5 },
      { key: "years", label: "Years", symbol: "n", min: 1, max: 50, step: 1, defaultValue: 20 },
    ],
    calculate(values) {
      const principal = values.principal ?? 10_000;
      const rate = (values.rate ?? 5) / 100;
      const years = Math.round(values.years ?? 20);
      const value = principal * (1 + rate) ** years;
      return {
        value,
        formula: "FV = PV(1 + r)ⁿ",
        substitutedFormula: `FV = ${principal.toLocaleString()}(1 + ${(rate * 100).toFixed(1)}%)${years} = ${value.toFixed(2)}`,
        series: Array.from({ length: years + 1 }, (_, x) => ({ x, value: principal * (1 + rate) ** x })),
      };
    },
  },
  "loan-payment": {
    id: "loan-payment",
    name: "Loan payment",
    description: "Explore monthly payment and remaining balance for an amortizing loan.",
    inputs: [
      { key: "principal", label: "Loan amount", symbol: "P", unit: "$", min: 1_000, max: 2_000_000, step: 1_000, defaultValue: 500_000 },
      { key: "rate", label: "Annual rate", symbol: "r", unit: "%", min: 0.1, max: 15, step: 0.05, defaultValue: 3.2 },
      { key: "years", label: "Term", symbol: "n", unit: "yr", min: 1, max: 40, step: 1, defaultValue: 30 },
    ],
    calculate(values) {
      const principal = values.principal ?? 500_000;
      const annualRate = (values.rate ?? 3.2) / 100;
      const years = Math.round(values.years ?? 30);
      const monthlyRate = annualRate / 12;
      const months = years * 12;
      const payment = principal * monthlyRate * (1 + monthlyRate) ** months / ((1 + monthlyRate) ** months - 1);
      let balance = principal;
      const series = [{ x: 0, value: balance }];
      for (let year = 1; year <= years; year += 1) {
        for (let month = 0; month < 12; month += 1) balance = balance * (1 + monthlyRate) - payment;
        series.push({ x: year, value: Math.max(0, balance) });
      }
      return {
        value: payment,
        formula: "PMT = P·r(1+r)ⁿ / ((1+r)ⁿ−1)",
        substitutedFormula: `Monthly payment = ${payment.toFixed(2)}`,
        series,
      };
    },
  },
} satisfies Record<string, CalculatorDefinition>;

export type CalculatorId = keyof typeof calculatorCatalog;

export function getCalculator(id: string): CalculatorDefinition | undefined {
  return calculatorCatalog[id as CalculatorId];
}
