import { describe, expect, test } from "bun:test";
import {
  ArtifactTransactionRuntime,
  DurableArtifactRuntimeStore,
  InMemoryDurableStateStore,
  PostgresDurableStateStore,
  type PostgresTransactionalClient,
  canonicalHash,
  durableStateKey,
  type DraftOperation,
} from "./index";
import { createContext, rootNodeOperation, TEST_FINGERPRINT, TEST_TIME } from "./test-fixtures";

describe("durable state adapters", () => {
  test("commits staged state atomically and requires declared keys", async () => {
    const state = new InMemoryDurableStateStore();
    await state.transaction(["test"], async (transaction) => {
      await transaction.set("test", { value: 1 });
    });
    await expect(state.transaction(["test"], async (transaction) => {
      await transaction.set("test", { value: 2 });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await state.transaction(["test"], async (transaction) => {
      expect(await transaction.get<{ value: number }>("test")).toEqual({ value: 1 });
      await expect(transaction.get("other")).rejects.toThrow("not declared");
    });
  });

  test("persists runtime transactions, revisions, and stream events across adapter instances", async () => {
    const state = new InMemoryDurableStateStore();
    const storageKey = durableStateKey("artifact-runtime", "tenant-a");
    const first = new DurableArtifactRuntimeStore({ state, storageKey, now: () => TEST_TIME });
    const runtime = new ArtifactTransactionRuntime({
      store: first,
      streamId: "stream-durable",
      catalog: {
        id: "catalog:test",
        version: "1",
        contractFingerprint: TEST_FINGERPRINT,
        nodeVersions: { "layout.stack": 1 },
      },
      now: () => TEST_TIME,
      nodeCommitPolicy: () => "progressive",
    });
    await runtime.initialize();
    expect((await runtime.begin("tx-durable", createContext())).status).toBe("begun");
    const operations: DraftOperation[] = [rootNodeOperation("Durable"), { op: "set-root", nodeId: "root" }];
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index]!;
      const result = await runtime.apply({
        type: "apply",
        transactionId: "tx-durable",
        seq: index + 1,
        opId: `durable:${index + 1}`,
        payloadHash: await canonicalHash(operation),
        operation,
      });
      expect(result.status === "accepted" || result.status === "buffered").toBe(true);
    }
    const committed = await runtime.finalize("tx-durable", await runtime.computeDraftHash("tx-durable"));
    expect(committed.status).toBe("committed");

    const restarted = new DurableArtifactRuntimeStore({ state, storageKey, now: () => TEST_TIME });
    const snapshot = await restarted.readRuntimeSnapshot("document-1", "main");
    expect(snapshot?.document.nodes.root?.props.title).toEqual({ kind: "literal", value: "Durable" });
    expect((await restarted.getTransaction("tx-durable"))?.status).toBe("committed");
    const events = await restarted.resume(
      "stream-durable",
      await restarted.initialCursor("stream-durable"),
      TEST_FINGERPRINT,
      "document-1",
      "main",
    );
    expect(events.status).toBe("events");
    if (events.status === "events") expect(events.events.some((event) => event.payload.type === "committed")).toBe(true);
  });

  test("maps the durable state contract to a host-owned Postgres transaction runner", async () => {
    const database = new FakePostgres();
    const state = new PostgresDurableStateStore({ transaction: database.transaction });
    await state.transaction(["record"], async (transaction) => {
      await transaction.set("record", { durable: true });
    });
    expect(await state.read<{ durable: boolean }>("record")).toEqual({ durable: true });
    await state.transaction(["record"], async (transaction) => {
      expect(await transaction.get<{ durable: boolean }>("record")).toEqual({ durable: true });
    });
    await expect(state.transaction(["record"], async (transaction) => {
      await transaction.delete("record");
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await state.transaction(["record"], async (transaction) => {
      expect(await transaction.get<{ durable: boolean }>("record")).toEqual({ durable: true });
    });
  });
});

class FakePostgres {
  #records = new Map<string, { present: boolean; value: unknown }>();

  readonly transaction = async <T>(operation: (client: PostgresTransactionalClient) => Promise<T>): Promise<T> => {
    const staged = structuredClone(this.#records);
    const client: PostgresTransactionalClient = {
      query: async <Row extends Record<string, unknown>>(
        statement: string,
        parameters: readonly unknown[] = [],
      ): Promise<{ rows: readonly Row[] }> => {
        if (statement.includes("INSERT INTO")) {
          for (const key of parameters[0] as string[]) {
            if (!staged.has(key)) staged.set(key, { present: false, value: null });
          }
          return { rows: [] };
        }
        if (statement.includes("SELECT state_key")) {
          const rows = (parameters[0] as string[])
            .sort()
            .map((key) => ({ state_key: key, ...(staged.get(key) ?? { present: false, value: null }) }));
          return { rows: rows as unknown as Row[] };
        }
        if (statement.includes("SELECT present, value")) {
          const record = staged.get(parameters[0] as string);
          const rows = record ? [record] : [];
          return { rows: rows as unknown as Row[] };
        }
        if (statement.includes("UPDATE")) {
          const [key, present, rawValue] = parameters as [string, boolean, string | null];
          staged.set(key, { present, value: rawValue === null ? null : JSON.parse(rawValue) });
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL: ${statement}`);
      },
    };
    const result = await operation(client);
    this.#records = staged;
    return result;
  };
}
