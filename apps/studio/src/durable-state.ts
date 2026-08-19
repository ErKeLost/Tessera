import { Database } from "bun:sqlite";
import type { DurableStateStorePort, DurableStateTransaction } from "@data-elements/runtime";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const STATE_DIRECTORY = ".tessera";
const STATE_DATABASE_FILE = "actions.db";

export type CreateTesseraDurableStateStoreOptions = Readonly<{
  /** Defaults to the Studio project directory. */
  rootDirectory?: string;
  /** Defaults to `actions.db` inside `.tessera`. */
  databaseFileName?: string;
}>;

export type TesseraDurableStateStore = Readonly<{
  state: DurableStateStorePort;
  close(): Promise<void>;
}>;

/**
 * Local SQLite state for durable capability grants, effects, and action runs.
 * Values are JSON and every callback is committed as one SQLite transaction.
 */
export function createTesseraDurableStateStore(
  options: CreateTesseraDurableStateStoreOptions = {},
): TesseraDurableStateStore {
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const databaseFileName = options.databaseFileName ?? STATE_DATABASE_FILE;
  if (!isFileName(databaseFileName)) throw new TypeError("Tessera durable state database name must be a file name.");

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
  readonly #database: Database;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(databasePath: string) {
    this.#database = new Database(databasePath);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS tessera_durable_state (
        state_key TEXT PRIMARY KEY NOT NULL,
        value_json TEXT NOT NULL
      );
    `);
  }

  async read<T>(key: string): Promise<T | undefined> {
    this.#assertOpen();
    return this.#readValue<T>(assertStateKey(key));
  }

  transaction<T>(
    keys: readonly string[],
    operation: (transaction: DurableStateTransaction) => Promise<T>,
  ): Promise<T> {
    this.#assertOpen();
    const declaredKeys = normalizeKeys(keys);

    return this.#enqueue(async () => {
      let transactionOpen = false;
      this.#database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;

      const staged = new Map<string, StagedValue>();
      const transaction: DurableStateTransaction = {
        get: async <T>(key: string): Promise<T | undefined> => {
          const declaredKey = assertDeclaredKey(key, declaredKeys);
          const value = staged.get(declaredKey);
          if (value) return value.present ? deserialize<T>(value.valueJson) : undefined;
          return this.#readValue<T>(declaredKey);
        },
        set: async <T>(key: string, value: T): Promise<void> => {
          staged.set(assertDeclaredKey(key, declaredKeys), { present: true, valueJson: serialize(value) });
        },
        delete: async (key: string): Promise<void> => {
          staged.set(assertDeclaredKey(key, declaredKeys), { present: false });
        },
      };

      try {
        const result = await operation(transaction);
        for (const [key, value] of staged) {
          if (value.present) this.#writeValue(key, value.valueJson);
          else this.#deleteValue(key);
        }
        this.#database.exec("COMMIT");
        transactionOpen = false;
        return result;
      } catch (error) {
        if (transactionOpen) this.#database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closed = true;
      this.#closePromise = this.#tail.then(() => {
        this.#database.close();
      });
    }
    return this.#closePromise;
  }

  #readValue<T>(key: string): T | undefined {
    const row = this.#database.query("SELECT value_json FROM tessera_durable_state WHERE state_key = ?").get(key) as
      | { value_json: string }
      | null;
    return row ? deserialize<T>(row.value_json) : undefined;
  }

  #writeValue(key: string, valueJson: string): void {
    this.#database.query(`
      INSERT INTO tessera_durable_state (state_key, value_json)
      VALUES (?, ?)
      ON CONFLICT(state_key) DO UPDATE SET value_json = excluded.value_json
    `).run(key, valueJson);
  }

  #deleteValue(key: string): void {
    this.#database.query("DELETE FROM tessera_durable_state WHERE state_key = ?").run(key);
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
  if (keys.length === 0) throw new TypeError("A durable transaction must declare at least one state key.");
  return [...new Set(keys.map(assertStateKey))].sort();
}

function assertStateKey(key: string): string {
  if (!key || key.length > 1_024 || /[\u0000-\u001f]/.test(key)) {
    throw new TypeError("Durable state keys must be printable strings up to 1024 characters.");
  }
  return key;
}

function assertDeclaredKey(key: string, declaredKeys: readonly string[]): string {
  const declaredKey = assertStateKey(key);
  if (!declaredKeys.includes(declaredKey)) {
    throw new Error(`State key was not declared for this transaction: ${declaredKey}.`);
  }
  return declaredKey;
}

function serialize(value: unknown): string {
  const valueJson = JSON.stringify(value);
  if (valueJson === undefined) throw new TypeError("Durable state values must be JSON serializable.");
  return valueJson;
}

function deserialize<T>(valueJson: string): T {
  return JSON.parse(valueJson) as T;
}

function isFileName(value: string): boolean {
  return value.length > 0 && !value.includes("/") && !value.includes("\\");
}
