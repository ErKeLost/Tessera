import {
  DEFAULT_PROTOCOL_LIMITS,
  HASH_DOMAINS,
  canonicalEncode,
  canonicalStringify,
  hashCanonical,
  isoTimestampSchema,
  migrationReceiptIdSchema,
  type HashProvider,
  type MigrationReceiptId,
  type Sha256Hash,
} from "@open-generative/protocol";
import type { MaybePromise } from "./utils";
import { immutableClone } from "./utils";

export type DeterministicMigrationStep<T> = {
  id: string;
  lineage: string;
  fromRevision: string;
  toRevision: string;
  transform(value: Readonly<T>): MaybePromise<unknown>;
};

export type MigrationReceipt = {
  receiptId: MigrationReceiptId;
  lineage: string;
  source: { revision: string; contentHash: Sha256Hash };
  target: { revision: string; contentHash: Sha256Hash };
  migrationStepIds: string[];
  appliedAt: string;
};

export type MigrationExecution<T> = {
  value: Readonly<T>;
  receipt: Readonly<MigrationReceipt>;
};

export type ExecuteMigrationOptions<T> = {
  lineage: string;
  sourceRevision: string;
  targetRevision: string;
  receiptId: MigrationReceiptId;
  appliedAt: string;
  validate(value: unknown, revision: string): MaybePromise<T>;
  hashProvider?: HashProvider;
  maxBytes?: number;
  maxSteps?: number;
  verifyDeterminism?: boolean;
};

export class MigrationRegistryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MigrationRegistryError";
    this.code = code;
  }
}

export class DeterministicMigrationRegistry<T> {
  readonly #stepsByEdge = new Map<string, DeterministicMigrationStep<T>>();
  readonly #edgesById = new Map<string, string>();

  register(stepInput: DeterministicMigrationStep<T>): this {
    const step = normalizeStep(stepInput);
    if (step.fromRevision === step.toRevision) {
      throw new MigrationRegistryError("migration.self-edge", "Migration steps cannot target their source revision.");
    }
    const edge = edgeKey(step.lineage, step.fromRevision, step.toRevision);
    const existing = this.#stepsByEdge.get(edge);
    if (existing) {
      if (
        canonicalStepIdentity(existing) === canonicalStepIdentity(step)
        && existing.transform === step.transform
      ) return this;
      throw new MigrationRegistryError("migration.edge-ambiguous", `Migration edge ${edgeLabel(step)} is already registered.`);
    }
    const priorEdge = this.#edgesById.get(step.id);
    if (priorEdge && priorEdge !== edge) {
      throw new MigrationRegistryError("migration.id-reused", `Migration step ID ${step.id} is already bound to another edge.`);
    }
    if (this.#isReachable(step.lineage, step.toRevision, step.fromRevision)) {
      throw new MigrationRegistryError("migration.cycle", `Migration edge ${edgeLabel(step)} would create a cycle.`);
    }
    this.#stepsByEdge.set(edge, step);
    this.#edgesById.set(step.id, edge);
    return this;
  }

  plan(
    lineage: string,
    sourceRevision: string,
    targetRevision: string,
    maxSteps = 256,
  ): readonly DeterministicMigrationStep<T>[] {
    validateToken("lineage", lineage);
    validateToken("source revision", sourceRevision);
    validateToken("target revision", targetRevision);
    if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
      throw new MigrationRegistryError("migration.invalid-limit", "Migration maxSteps must be a positive integer.");
    }
    if (sourceRevision === targetRevision) return Object.freeze([]);

    const paths: DeterministicMigrationStep<T>[][] = [];
    let exceededLimit = false;
    const visit = (revision: string, path: DeterministicMigrationStep<T>[]): void => {
      if (paths.length > 1) return;
      if (path.length >= maxSteps) {
        exceededLimit = true;
        return;
      }
      for (const step of this.#outgoing(lineage, revision)) {
        const nextPath = [...path, step];
        if (step.toRevision === targetRevision) {
          paths.push(nextPath);
        } else {
          visit(step.toRevision, nextPath);
        }
        if (paths.length > 1) return;
      }
    };
    visit(sourceRevision, []);

    if (exceededLimit) {
      throw new MigrationRegistryError(
        "migration.path-limit",
        `Migration planning reached the ${maxSteps}-step limit before proving a complete, unambiguous path.`,
      );
    }
    if (paths.length > 1) {
      throw new MigrationRegistryError(
        "migration.path-ambiguous",
        `More than one migration path exists from ${sourceRevision} to ${targetRevision} in ${lineage}.`,
      );
    }
    if (paths.length === 0) {
      throw new MigrationRegistryError(
        "migration.path-missing",
        `No migration path exists from ${sourceRevision} to ${targetRevision} in ${lineage}.`,
      );
    }
    return Object.freeze(paths[0]!.map((step) => Object.freeze({ ...step })));
  }

  async execute(input: unknown, options: ExecuteMigrationOptions<T>): Promise<MigrationExecution<T>> {
    const receiptId = migrationReceiptIdSchema.parse(options.receiptId);
    const appliedAt = isoTimestampSchema.parse(options.appliedAt);
    const maxBytes = options.maxBytes ?? DEFAULT_PROTOCOL_LIMITS.maxDocumentBytes;
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new MigrationRegistryError("migration.invalid-byte-limit", "Migration maxBytes must be a positive integer.");
    }
    const plan = this.plan(
      options.lineage,
      options.sourceRevision,
      options.targetRevision,
      options.maxSteps,
    );
    let value = await options.validate(input, options.sourceRevision);
    enforceBudget(value, maxBytes, "source");
    const sourceHash = await migrationValueHash(
      options.lineage,
      options.sourceRevision,
      value,
      options.hashProvider,
    );

    for (const step of plan) {
      const first = await executeStep(step, value, options.validate, maxBytes);
      if (options.verifyDeterminism !== false) {
        const second = await executeStep(step, value, options.validate, maxBytes);
        if (canonicalStringify(first) !== canonicalStringify(second)) {
          throw new MigrationRegistryError(
            "migration.nondeterministic",
            `Migration step ${step.id} produced different canonical output for the same input.`,
          );
        }
      }
      value = first;
    }

    const target = await options.validate(value, options.targetRevision);
    enforceBudget(target, maxBytes, "target");
    const targetHash = await migrationValueHash(
      options.lineage,
      options.targetRevision,
      target,
      options.hashProvider,
    );
    return {
      value: immutableClone(target),
      receipt: immutableClone({
        receiptId,
        lineage: options.lineage,
        source: { revision: options.sourceRevision, contentHash: sourceHash },
        target: { revision: options.targetRevision, contentHash: targetHash },
        migrationStepIds: plan.map((step) => step.id),
        appliedAt,
      }),
    };
  }

  #outgoing(lineage: string, revision: string): DeterministicMigrationStep<T>[] {
    return [...this.#stepsByEdge.values()]
      .filter((step) => step.lineage === lineage && step.fromRevision === revision)
      .sort((left, right) => (
        left.toRevision.localeCompare(right.toRevision) || left.id.localeCompare(right.id)
      ));
  }

  #isReachable(lineage: string, sourceRevision: string, targetRevision: string): boolean {
    const pending = [sourceRevision];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const revision = pending.pop()!;
      if (revision === targetRevision) return true;
      if (visited.has(revision)) continue;
      visited.add(revision);
      for (const step of this.#outgoing(lineage, revision)) pending.push(step.toRevision);
    }
    return false;
  }
}

async function executeStep<T>(
  step: DeterministicMigrationStep<T>,
  source: T,
  validate: ExecuteMigrationOptions<T>["validate"],
  maxBytes: number,
): Promise<T> {
  const frozenInput = immutableClone(source);
  const before = canonicalStringify(frozenInput);
  const transformed = await step.transform(frozenInput);
  if (canonicalStringify(frozenInput) !== before) {
    throw new MigrationRegistryError("migration.input-mutated", `Migration step ${step.id} mutated its input.`);
  }
  const value = await validate(transformed, step.toRevision);
  enforceBudget(value, maxBytes, step.id);
  return immutableClone(value);
}

async function migrationValueHash(
  lineage: string,
  revision: string,
  value: unknown,
  provider?: HashProvider,
): Promise<Sha256Hash> {
  return hashCanonical(HASH_DOMAINS.operationPayload, {
    kind: "migration-value",
    lineage,
    revision,
    value,
  }, provider);
}

function normalizeStep<T>(step: DeterministicMigrationStep<T>): DeterministicMigrationStep<T> {
  validateToken("migration step ID", step.id);
  validateToken("lineage", step.lineage);
  validateToken("source revision", step.fromRevision);
  validateToken("target revision", step.toRevision);
  if (typeof step.transform !== "function") {
    throw new MigrationRegistryError("migration.transform-missing", "Migration transform must be a function.");
  }
  return Object.freeze({ ...step });
}

function validateToken(label: string, value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || value.includes("\u0000")) {
    throw new MigrationRegistryError("migration.identity-invalid", `${label} must be a non-empty bounded string without NUL.`);
  }
}

function enforceBudget(value: unknown, maxBytes: number, stage: string): void {
  const bytes = canonicalEncode(value).byteLength;
  if (bytes > maxBytes) {
    throw new MigrationRegistryError(
      "migration.byte-limit",
      `Migration stage ${stage} produced ${bytes} bytes, over the ${maxBytes}-byte limit.`,
    );
  }
}

function canonicalStepIdentity<T>(step: DeterministicMigrationStep<T>): string {
  return `${step.id}\u0000${step.lineage}\u0000${step.fromRevision}\u0000${step.toRevision}`;
}

function edgeKey(lineage: string, fromRevision: string, toRevision: string): string {
  return `${lineage}\u0000${fromRevision}\u0000${toRevision}`;
}

function edgeLabel<T>(step: DeterministicMigrationStep<T>): string {
  return `${step.lineage}:${step.fromRevision}->${step.toRevision}`;
}
