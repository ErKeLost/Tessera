import { describe, expect, test } from "bun:test";
import { migrationReceiptIdSchema } from "@open-generative/protocol";
import {
  DeterministicMigrationRegistry,
  MigrationRegistryError,
} from "./migrations";
import {
  findRevisionHeads,
  findRevisionMergeBases,
  findUniqueRevisionMergeBase,
  walkRevisionAncestors,
} from "./revision-dag";
import { InMemoryRuntimeStore } from "./store";
import { createStoredRevision } from "./test-fixtures";

describe("revision DAG", () => {
  test("walks ancestors deterministically and preserves every valid merge base", async () => {
    const store = new InMemoryRuntimeStore<unknown>();
    const a = await createStoredRevision({ revisionId: "revision-a" });
    const b = await createStoredRevision({ revisionId: "revision-b", parentRevisionIds: ["revision-a"] });
    const c = await createStoredRevision({ revisionId: "revision-c", parentRevisionIds: ["revision-a"] });
    const x = await createStoredRevision({
      revisionId: "revision-x",
      parentRevisionIds: ["revision-b", "revision-c"],
    });
    const y = await createStoredRevision({
      revisionId: "revision-y",
      parentRevisionIds: ["revision-b", "revision-c"],
    });
    for (const revision of [a, b, c, x, y]) store.seedRevision(revision);

    const walk = await walkRevisionAncestors(
      store,
      a.revision.envelope.documentId,
      [x.revision.envelope.revisionId],
    );
    expect(walk.complete).toBe(true);
    expect(walk.revisions.map((item) => String(item.revision.envelope.revisionId))).toEqual([
      "revision-a",
      "revision-b",
      "revision-c",
      "revision-x",
    ]);

    const unique = await findUniqueRevisionMergeBase(
      store,
      a.revision.envelope.documentId,
      b.revision.envelope.revisionId,
      c.revision.envelope.revisionId,
    );
    expect(unique.status).toBe("unique");
    if (unique.status === "unique") expect(String(unique.base.revision.envelope.revisionId)).toBe("revision-a");

    const ambiguous = await findRevisionMergeBases(
      store,
      a.revision.envelope.documentId,
      x.revision.envelope.revisionId,
      y.revision.envelope.revisionId,
    );
    expect(ambiguous.bases.map((item) => String(item.revision.envelope.revisionId))).toEqual([
      "revision-b",
      "revision-c",
    ]);
    expect((await findRevisionHeads(store, a.revision.envelope.documentId))
      .map((item) => String(item.revision.envelope.revisionId))).toEqual(["revision-x", "revision-y"]);
  });

  test("reports cycles and traversal limits instead of silently truncating", async () => {
    const store = new InMemoryRuntimeStore<unknown>();
    const p = await createStoredRevision({ revisionId: "revision-p", parentRevisionIds: ["revision-q"] });
    const q = await createStoredRevision({ revisionId: "revision-q", parentRevisionIds: ["revision-p"] });
    store.seedRevision(p);
    store.seedRevision(q);
    const cyclic = await walkRevisionAncestors(
      store,
      p.revision.envelope.documentId,
      [p.revision.envelope.revisionId],
    );
    expect(cyclic.complete).toBe(false);
    expect(cyclic.issues.some((item) => item.code === "revision.cycle")).toBe(true);

    const limited = await walkRevisionAncestors(
      store,
      p.revision.envelope.documentId,
      [p.revision.envelope.revisionId],
      { maxRevisions: 1 },
    );
    expect(limited.issues.some((item) => item.code === "revision.walk-limit")).toBe(true);
  });
});

describe("deterministic migration registry", () => {
  test("plans one unambiguous path and emits reproducible receipts", async () => {
    const registry = new DeterministicMigrationRegistry<MigrationValue>()
      .register({
        id: "step-1-to-2",
        lineage: "contract:data.metric",
        fromRevision: "1",
        toRevision: "2",
        transform: (value) => ({ version: 2, history: [...value.history, "1->2"] }),
      })
      .register({
        id: "step-2-to-3",
        lineage: "contract:data.metric",
        fromRevision: "2",
        toRevision: "3",
        transform: (value) => ({ version: 3, history: [...value.history, "2->3"] }),
      });
    expect(registry.plan("contract:data.metric", "1", "3").map((step) => step.id)).toEqual([
      "step-1-to-2",
      "step-2-to-3",
    ]);
    const options = {
      lineage: "contract:data.metric",
      sourceRevision: "1",
      targetRevision: "3",
      receiptId: migrationReceiptIdSchema.parse("migration-receipt-1"),
      appliedAt: "2026-08-22T02:00:00Z",
      validate: validateMigrationValue,
    };
    const first = await registry.execute({ version: 1, history: [] }, options);
    const second = await registry.execute({ history: [], version: 1 }, options);
    expect(second).toEqual(first);
    expect(first.value).toEqual({ version: 3, history: ["1->2", "2->3"] });
    expect(first.receipt.migrationStepIds).toEqual(["step-1-to-2", "step-2-to-3"]);
  });

  test("rejects ambiguous paths, cycles, and nondeterministic transforms", async () => {
    const ambiguous = new DeterministicMigrationRegistry<MigrationValue>()
      .register(step("a-b", "a", "b"))
      .register(step("b-d", "b", "d"))
      .register(step("a-c", "a", "c"))
      .register(step("c-d", "c", "d"));
    expect(() => ambiguous.plan("lineage", "a", "d")).toThrow(MigrationRegistryError);
    expect(() => ambiguous.register(step("d-a", "d", "a"))).toThrow("would create a cycle");

    let counter = 0;
    const nondeterministic = new DeterministicMigrationRegistry<MigrationValue>().register({
      id: "random-step",
      lineage: "lineage",
      fromRevision: "1",
      toRevision: "2",
      transform: () => ({ version: 2, history: [String(++counter)] }),
    });
    await expect(nondeterministic.execute({ version: 1, history: [] }, {
      lineage: "lineage",
      sourceRevision: "1",
      targetRevision: "2",
      receiptId: migrationReceiptIdSchema.parse("migration-receipt-2"),
      appliedAt: "2026-08-22T02:00:00Z",
      validate: validateMigrationValue,
    })).rejects.toThrow("different canonical output");
  });

  test("only re-registers the exact transform and rejects truncated path proofs", () => {
    const transform = (value: Readonly<MigrationValue>) => ({
      version: 2,
      history: [...value.history, "1->2"],
    });
    const exactStep = {
      id: "exact-step",
      lineage: "lineage",
      fromRevision: "1",
      toRevision: "2",
      transform,
    };
    const exact = new DeterministicMigrationRegistry<MigrationValue>().register(exactStep);
    expect(exact.register({ ...exactStep })).toBe(exact);
    expect(() => exact.register({
      ...exactStep,
      transform: (value) => ({ version: 2, history: [...value.history, "different"] }),
    })).toThrow("already registered");

    const truncated = new DeterministicMigrationRegistry<MigrationValue>()
      .register(step("a-b", "a", "b"))
      .register(step("a-z", "a", "z"))
      .register(step("b-c", "b", "c"));
    expect(() => truncated.plan("lineage", "a", "z", 1)).toThrow("before proving a complete");
  });
});

type MigrationValue = { version: number; history: string[] };

function validateMigrationValue(value: unknown, revision: string): MigrationValue {
  if (
    value === null
    || typeof value !== "object"
    || (value as MigrationValue).version !== Number(revision)
    || !Array.isArray((value as MigrationValue).history)
  ) throw new TypeError(`Invalid migration value for revision ${revision}.`);
  return value as MigrationValue;
}

function step(id: string, fromRevision: string, toRevision: string) {
  return {
    id,
    lineage: "lineage",
    fromRevision,
    toRevision,
    transform: (_value: Readonly<MigrationValue>) => ({ version: Number.NaN, history: [] }),
  };
}
