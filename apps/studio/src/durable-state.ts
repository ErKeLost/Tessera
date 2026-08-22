import {
  createClient,
  type Client,
  type Transaction,
} from "@libsql/client";
import type {
  DurableStateStorePort,
  DurableStateTransaction,
} from "@open-tessera/runtime";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STATE_DIRECTORY = ".tessera";
const STATE_DATABASE_FILE = "actions.db";

export type CreateTesseraDurableStateStoreOptions = Readonly<{
  /** Defaults to the Studio project directory. */
  rootDirectory?: string;
  /** Defaults to actions.db inside .tessera. */
  databaseFileName?: string;
}>;

export type TesseraDurableStateStore = Readonly<{
  state: DurableStateStorePort;
  close(): Promise<void>;
}>;

/**
 * Cross-runtime local SQLite state for capability grants, effects, and action
 * runs. The libSQL driver supports both Node 24+ and Bun 1.3+.
 */
export function createTesseraDurableStateStore(
  options: CreateTesseraDurableStateStoreOptions = {},
): TesseraDurableStateStore {
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const databaseFileName = options.databaseFileName ?? STATE_DATABASE_FILE;
  if (!isFileName(databaseFileName)) {
    throw new TypeError("Tessera durable state database name must be a file name.");
  }

  const directory = join(rootDirectory, STATE_DIRECTORY);
  mkdirSync(directory, { recursive: true });

  const state = new SqliteDurableStateStore(join(directory, databaseFileName));
  return Object.freeze({
    state,
    close: () => state.close(),
  });
}

type StagedValue =
  | Readonly<{ present: true; valueJson: string }>
  | Readonly<{ present: false }>;

class SqliteDurableStateStore implements DurableStateStorePort {
  readonly #client: Client;
  readonly #ready: Promise<void>;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(databasePath: string) {
    this.#client = createClient({
      url: pathToFileURL(databasePath).href,
      timeout: 5_000,
    });
    this.#ready = this.#client.execute(
      "CREATE TABLE IF NOT EXISTS tessera_durable_state ("
      + "state_key TEXT PRIMARY KEY NOT NULL,"
      + "value_json TEXT NOT NULL"
      + ")",
    ).then(() => undefined);
  }

  async read<T>(key: string): Promise<T | undefined> {
    this.#assertOpen();
    await this.#ready;
    return this.#readValue<T>(assertStateKey(key), this.#client);
  }

  transaction<T>(
    keys: readonly string[],
    operation: (transaction: DurableStateTransaction) => Promise<T>,
  ): Promise<T> {
    this.#assertOpen();
    const declaredKeys = normalizeKeys(keys);

    return this.#enqueue(async () => {
      await this.#ready;
      const databaseTransaction = await this.#client.transaction("write");
      const staged = new Map<string, StagedValue>();
      const transaction: DurableStateTransaction = {
        get: async <T>(key: string): Promise<T | undefined> => {
          const declaredKey = assertDeclaredKey(key, declaredKeys);
          const value = staged.get(declaredKey);
          if (value) return value.present ? deserialize<T>(value.valueJson) : undefined;
          return this.#readValue<T>(declaredKey, databaseTransaction);
        },
        set: async <T>(key: string, value: T): Promise<void> => {
          staged.set(assertDeclaredKey(key, declaredKeys), {
            present: true,
            valueJson: serialize(value),
          });
        },
        delete: async (key: string): Promise<void> => {
          staged.set(assertDeclaredKey(key, declaredKeys), { present: false });
        },
      };

      try {
        const result = await operation(transaction);
        for (const [key, value] of staged) {
          if (value.present) {
            await databaseTransaction.execute({
              sql: "INSERT INTO tessera_durable_state (state_key, value_json) "
                + "VALUES (?, ?) ON CONFLICT(state_key) DO UPDATE "
                + "SET value_json = excluded.value_json",
              args: [key, value.valueJson],
            });
          } else {
            await databaseTransaction.execute({
              sql: "DELETE FROM tessera_durable_state WHERE state_key = ?",
              args: [key],
            });
          }
        }
        await databaseTransaction.commit();
        return result;
      } catch (error) {
        await databaseTransaction.rollback().catch(() => undefined);
        throw error;
      } finally {
        databaseTransaction.close();
      }
    });
  }

  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closed = true;
      this.#closePromise = this.#tail.then(async () => {
        await this.#ready.catch(() => undefined);
        this.#client.close();
      });
    }
    return this.#closePromise;
  }

  async #readValue<T>(
    key: string,
    executor: Pick<Client, "execute"> | Pick<Transaction, "execute">,
  ): Promise<T | undefined> {
    const result = await executor.execute({
      sql: "SELECT value_json FROM tessera_durable_state WHERE state_key = ?",
      args: [key],
    });
    const valueJson = result.rows[0]?.value_json;
    return typeof valueJson === "string" ? deserialize<T>(valueJson) : undefined;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.#tail.then(operation, operation);
    this.#tail = task.then(() => undefined, () => undefined);
    return task;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Tessera durable state store is closed.");
  }
}

function normalizeKeys(keys: readonly string[]): string[] {
  if (keys.length === 0) {
    throw new TypeError("A durable transaction must declare at least one state key.");
  }
  return [...new Set(keys.map(assertStateKey))].sort();
}

function assertStateKey(key: string): string {
  if (!key || key.length > 1_024 || /[\u0000-\u001f]/u.test(key)) {
    throw new TypeError("Durable state keys must be printable strings up to 1024 characters.");
  }
  return key;
}

function assertDeclaredKey(key: string, declaredKeys: readonly string[]): string {
  const declaredKey = assertStateKey(key);
  if (!declaredKeys.includes(declaredKey)) {
    throw new Error("State key was not declared for this transaction: " + declaredKey + ".");
  }
  return declaredKey;
}

function serialize(value: unknown): string {
  const valueJson = JSON.stringify(value);
  if (valueJson === undefined) {
    throw new TypeError("Durable state values must be JSON serializable.");
  }
  return valueJson;
}

function deserialize<T>(valueJson: string): T {
  return JSON.parse(valueJson) as T;
}

function isFileName(value: string): boolean {
  return value.length > 0 && !value.includes("/") && !value.includes("\\");
}
