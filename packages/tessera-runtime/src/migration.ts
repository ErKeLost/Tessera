import { artifactSchema, type Artifact as V1Artifact } from "@open-tessera/schema";
import type { HashProvider } from "./canonical";
import { canonicalHash, canonicalize, webCryptoSha256Provider } from "./canonical";
import { ARTIFACT_PROTOCOL, ARTIFACT_PROTOCOL_VERSION, DEFAULT_PROTOCOL_LIMITS } from "./constants";
import { ArtifactRuntimeError, createDiagnostic } from "./diagnostics";
import { projectArtifactSemanticContent, validateArtifactDocument } from "./document";
import type {
  ArtifactDocument,
  DocumentPolicy,
  JsonValue,
  MigrationReceipt,
  ProtocolLimits,
} from "./schemas";
import { lowerJsonValue } from "./values";

export type MigrationEntity = MigrationReceipt["entity"];

export type MigrationStep<T> = {
  id: string;
  entity: MigrationEntity;
  fromVersion: string;
  toVersion: string;
  transform(value: T): T | Promise<T>;
};

export type MigrationValidation<T> = (
  value: unknown,
  version: string,
) => T | Promise<T>;

export type ExecuteMigrationOptions<T> = {
  entity: MigrationEntity;
  sourceVersion: string;
  targetVersion: string;
  receiptId: string;
  appliedAt: string;
  validate: MigrationValidation<T>;
  hashProvider?: HashProvider;
  maxBytes?: number;
  warnings?: string[];
  droppedPaths?: string[];
};

export type MigrationExecution<T> = {
  value: T;
  receipt: MigrationReceipt;
};

export class MigrationRegistry<T> {
  readonly #steps = new Map<string, MigrationStep<T>>();

  register(step: MigrationStep<T>): this {
    const key = migrationEdgeKey(step.entity, step.fromVersion, step.toVersion);
    const existing = this.#steps.get(key);
    if (existing && existing.id !== step.id) {
      throw new Error(`Ambiguous migration edge ${key}.`);
    }
    if ([...this.#steps.values()].some((item) => item.id === step.id && migrationEdgeKey(item.entity, item.fromVersion, item.toVersion) !== key)) {
      throw new Error(`Migration ID ${step.id} is already registered for another edge.`);
    }
    this.#steps.set(key, step);
    return this;
  }

  plan(entity: MigrationEntity, sourceVersion: string, targetVersion: string): MigrationStep<T>[] {
    if (sourceVersion === targetVersion) return [];
    const paths: MigrationStep<T>[][] = [];
    const visit = (version: string, path: MigrationStep<T>[], visited: Set<string>): void => {
      if (paths.length > 1) return;
      for (const step of this.#steps.values()) {
        if (step.entity !== entity || step.fromVersion !== version || visited.has(step.toVersion)) continue;
        const next = [...path, step];
        if (step.toVersion === targetVersion) {
          paths.push(next);
          continue;
        }
        visit(step.toVersion, next, new Set([...visited, step.toVersion]));
      }
    };
    visit(sourceVersion, [], new Set([sourceVersion]));
    if (paths.length === 0) throw new Error(`No migration path from ${sourceVersion} to ${targetVersion}.`);
    if (paths.length > 1) throw new Error(`Ambiguous migration paths from ${sourceVersion} to ${targetVersion}.`);
    return paths[0]!;
  }

  async execute(input: unknown, options: ExecuteMigrationOptions<T>): Promise<MigrationExecution<T>> {
    const provider = options.hashProvider ?? webCryptoSha256Provider;
    const maxBytes = options.maxBytes ?? DEFAULT_PROTOCOL_LIMITS.maxDocumentBytes;
    const source = await options.validate(input, options.sourceVersion);
    enforceMigrationBudget(source, maxBytes, "source");
    const sourceHash = await canonicalHash(source, provider);
    const plan = this.plan(options.entity, options.sourceVersion, options.targetVersion);
    let value = source;
    for (const step of plan) {
      value = await step.transform(value);
      enforceMigrationBudget(value, maxBytes, step.id);
    }
    const target = await options.validate(value, options.targetVersion);
    enforceMigrationBudget(target, maxBytes, "target");
    const targetHash = await canonicalHash(target, provider);
    return {
      value: target,
      receipt: {
        receiptId: options.receiptId,
        entity: options.entity,
        source: { version: options.sourceVersion, contentHash: sourceHash },
        target: { version: options.targetVersion, contentHash: targetHash },
        migrationIds: plan.map((step) => step.id),
        warnings: [...(options.warnings ?? [])],
        droppedPaths: [...(options.droppedPaths ?? [])],
        appliedAt: options.appliedAt,
      },
    };
  }
}

export type V1ArtifactMigrationOptions = {
  documentId?: string;
  branchId: string;
  revisionId: string;
  receiptId: string;
  policy: DocumentPolicy;
  catalog: {
    id: string;
    version: string;
    contractFingerprint: string;
  };
  appliedAt: string;
  renderMode?: "strict" | "progressive";
  sequence?: number;
  parentRevisionIds?: string[];
  nodeType?: (artifact: V1Artifact) => string;
  hashProvider?: HashProvider;
  limits?: ProtocolLimits;
};

export type V1ArtifactMigrationResult = {
  document: ArtifactDocument;
  receipt: MigrationReceipt;
  source: V1Artifact;
};

export const V1_ARTIFACT_MIGRATION_ID = "data-elements.v1-artifact-to-v2-document/1" as const;

export async function migrateV1Artifact(
  input: unknown,
  options: V1ArtifactMigrationOptions,
): Promise<V1ArtifactMigrationResult> {
  const source = artifactSchema.parse(input);
  const provider = options.hashProvider ?? webCryptoSha256Provider;
  const sourceHash = await canonicalHash(source, provider);
  const sourceRecord = source as V1Artifact & Record<string, JsonValue | undefined>;
  const props: Record<string, ReturnType<typeof lowerJsonValue>> = {};
  for (const [key, value] of Object.entries(sourceRecord)) {
    if (
      key === "protocolVersion"
      || key === "kind"
      || key === "id"
      || key === "title"
      || key === "description"
      || key === "createdAt"
      || value === undefined
    ) continue;
    props[key] = lowerJsonValue(value);
  }

  const createdAt = source.createdAt ?? options.appliedAt;
  const documentId = options.documentId ?? source.id;
  const parentRevisionIds = options.parentRevisionIds ?? [];
  const document: ArtifactDocument = {
    protocol: ARTIFACT_PROTOCOL,
    protocolVersion: ARTIFACT_PROTOCOL_VERSION,
    documentId,
    revision: {
      revisionId: options.revisionId,
      parentRevisionIds,
      branchId: options.branchId,
      sequence: options.sequence ?? 1,
      contentHash: "pending",
      contractFingerprint: options.catalog.contractFingerprint,
      migrationReceiptIds: [options.receiptId],
      stateTransitionReceiptIds: [],
    },
    policy: options.policy,
    catalog: options.catalog,
    renderMode: options.renderMode ?? "strict",
    root: source.id,
    nodes: {
      [source.id]: {
        type: options.nodeType?.(source) ?? `artifact.${source.kind}`,
        typeVersion: 1,
        props,
      },
    },
    state: {},
    actions: {},
    resources: {},
    evidence: {},
    claims: {},
    meta: {
      title: source.title,
      description: source.description,
      createdAt,
      updatedAt: options.appliedAt,
    },
  };
  document.revision.contentHash = await canonicalHash(projectArtifactSemanticContent(document), provider);

  const validation = await validateArtifactDocument(document, {
    limits: options.limits,
    expectedContractFingerprint: options.catalog.contractFingerprint,
    verifyContentHash: true,
    hashProvider: provider,
  });
  if (!validation.success) throw new ArtifactRuntimeError(validation.diagnostics);

  const receipt: MigrationReceipt = {
    receiptId: options.receiptId,
    entity: "document",
    source: { version: "1.0", contentHash: sourceHash },
    target: { version: ARTIFACT_PROTOCOL_VERSION, contentHash: document.revision.contentHash },
    migrationIds: [V1_ARTIFACT_MIGRATION_ID],
    warnings: [
      "The v1 artifact has no formal evidence provenance; no evidence records were synthesized.",
    ],
    droppedPaths: [],
    appliedAt: options.appliedAt,
  };
  return { document: validation.document, receipt, source };
}

function enforceMigrationBudget(value: unknown, maxBytes: number, stage: string): void {
  const bytes = new TextEncoder().encode(canonicalize(value)).byteLength;
  if (bytes <= maxBytes) return;
  throw new ArtifactRuntimeError(createDiagnostic({
    phase: "normalize",
    code: "migration.byte-limit",
    severity: "fatal",
    recoverable: false,
    modelCorrectable: false,
    message: `Migration stage ${stage} produced ${bytes} bytes, over the ${maxBytes}-byte limit.`,
    location: { entity: { kind: "migration", id: stage } },
  }));
}

function migrationEdgeKey(entity: MigrationEntity, fromVersion: string, toVersion: string): string {
  return `${entity}\u0000${fromVersion}\u0000${toVersion}`;
}
