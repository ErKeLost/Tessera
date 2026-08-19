/**
 * A minimal transactional JSON state contract for server-side adapters.
 *
 * The application packages intentionally depend on this interface instead of a
 * database client. Hosts can provide Postgres, DynamoDB, or another durable
 * implementation without pulling that dependency into browser-facing bundles.
 */
export interface DurableStateTransaction {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface DurableStateStorePort {
  /** Reads one committed value without taking a writer lock. */
  read<T>(key: string): Promise<T | undefined>;
  /**
   * Runs a callback atomically for every declared key. Implementations must
   * serialise concurrent writers for those keys and commit no staged writes
   * when the callback rejects.
   */
  transaction<T>(keys: readonly string[], operation: (transaction: DurableStateTransaction) => Promise<T>): Promise<T>;
}

export type InMemoryDurableStateStoreOptions = {
  initial?: Readonly<Record<string, unknown>>;
};

/**
 * A deterministic test/local implementation. It deliberately serialises all
 * transactions, so it is never a substitute for an externally durable store.
 */
export class InMemoryDurableStateStore implements DurableStateStorePort {
  readonly #records = new Map<string, unknown>();
  #tail: Promise<void> = Promise.resolve();

  constructor(options: InMemoryDurableStateStoreOptions = {}) {
    for (const [key, value] of Object.entries(options.initial ?? {})) {
      this.#records.set(assertStateKey(key), clone(value));
    }
  }

  async read<T>(key: string): Promise<T | undefined> {
    const normalized = assertStateKey(key);
    return this.transaction([normalized], (transaction) => transaction.get<T>(normalized));
  }

  async transaction<T>(keys: readonly string[], operation: (transaction: DurableStateTransaction) => Promise<T>): Promise<T> {
    const normalized = normalizeKeys(keys);
    let release: (() => void) | undefined;
    const prior = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;

    const staged = new Map<string, { present: boolean; value?: unknown }>();
    const transaction: DurableStateTransaction = {
      get: async <T>(key: string): Promise<T | undefined> => {
        const normalizedKey = assertDeclaredKey(key, normalized);
        const candidate = staged.get(normalizedKey);
        if (candidate) return candidate.present ? clone(candidate.value) as T : undefined;
        const existing = this.#records.get(normalizedKey);
        return existing === undefined ? undefined : clone(existing) as T;
      },
      set: async <T>(key: string, value: T): Promise<void> => {
        const normalizedKey = assertDeclaredKey(key, normalized);
        staged.set(normalizedKey, { present: true, value: clone(value) });
      },
      delete: async (key: string): Promise<void> => {
        const normalizedKey = assertDeclaredKey(key, normalized);
        staged.set(normalizedKey, { present: false });
      },
    };

    try {
      const result = await operation(transaction);
      for (const [key, update] of staged) {
        if (update.present) this.#records.set(key, clone(update.value));
        else this.#records.delete(key);
      }
      return result;
    } finally {
      release?.();
    }
  }
}

export type PostgresQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> = {
  rows: readonly Row[];
};

export interface PostgresTransactionalClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>>;
}

export type PostgresTransactionRunner = <T>(
  operation: (client: PostgresTransactionalClient) => Promise<T>,
) => Promise<T>;

export type PostgresDurableStateStoreOptions = {
  /** A host-owned callback that opens, commits, and rolls back one SQL transaction. */
  transaction: PostgresTransactionRunner;
  /** Defaults to `data_elements_durable_state`. Identifiers are validated before interpolation. */
  tableName?: string;
};

/**
 * PostgreSQL implementation with no hard dependency on a particular driver.
 * Pass a runner backed by `pg`, Neon, Postgres.js, or the host's database layer.
 * The runner must use one database transaction and must not retry callbacks
 * after they return, because callers may create IDs inside the callback.
 */
export class PostgresDurableStateStore implements DurableStateStorePort {
  readonly #transaction: PostgresTransactionRunner;
  readonly #tableName: string;

  constructor(options: PostgresDurableStateStoreOptions) {
    this.#transaction = options.transaction;
    this.#tableName = assertSqlIdentifier(options.tableName ?? "data_elements_durable_state");
  }

  async read<T>(key: string): Promise<T | undefined> {
    const normalized = assertStateKey(key);
    return this.#transaction(async (client) => {
      const result = await client.query<{ present: boolean; value: unknown }>(
        `SELECT present, value
         FROM ${this.#tableName}
         WHERE state_key = $1`,
        [normalized],
      );
      const row = result.rows[0];
      return row?.present ? clone(parsePostgresJson(row.value)) as T : undefined;
    });
  }

  async transaction<T>(keys: readonly string[], operation: (transaction: DurableStateTransaction) => Promise<T>): Promise<T> {
    const normalized = normalizeKeys(keys);
    return this.#transaction(async (client) => {
      await client.query(
        `INSERT INTO ${this.#tableName} (state_key, present, value)
         SELECT keys.state_key, false, NULL::jsonb
         FROM unnest($1::text[]) AS keys(state_key)
         ON CONFLICT (state_key) DO NOTHING`,
        [normalized],
      );
      const result = await client.query<{ state_key: string; present: boolean; value: unknown }>(
        `SELECT state_key, present, value
         FROM ${this.#tableName}
         WHERE state_key = ANY($1::text[])
         ORDER BY state_key
         FOR UPDATE`,
        [normalized],
      );
      const staged = new Map<string, { present: boolean; value?: unknown }>();
      const dirty = new Set<string>();
      for (const row of result.rows) {
        staged.set(row.state_key, {
          present: row.present,
          ...(row.present ? { value: parsePostgresJson(row.value) } : {}),
        });
      }
      for (const key of normalized) {
        if (!staged.has(key)) throw new Error(`Durable state row was not locked: ${key}.`);
      }

      const transaction: DurableStateTransaction = {
        get: async <T>(key: string): Promise<T | undefined> => {
          const entry = staged.get(assertDeclaredKey(key, normalized));
          return entry?.present ? clone(entry.value) as T : undefined;
        },
        set: async <T>(key: string, value: T): Promise<void> => {
          const normalizedKey = assertDeclaredKey(key, normalized);
          staged.set(normalizedKey, { present: true, value: clone(value) });
          dirty.add(normalizedKey);
        },
        delete: async (key: string): Promise<void> => {
          const normalizedKey = assertDeclaredKey(key, normalized);
          staged.set(normalizedKey, { present: false });
          dirty.add(normalizedKey);
        },
      };

      const output = await operation(transaction);
      for (const key of dirty) {
        const update = staged.get(key);
        if (!update) continue;
        await client.query(
          `UPDATE ${this.#tableName}
           SET present = $2, value = $3::jsonb, updated_at = NOW()
           WHERE state_key = $1`,
          [key, update.present, update.present ? JSON.stringify(update.value) : null],
        );
      }
      return output;
    });
  }
}

/** SQL migration required by PostgresDurableStateStore. */
export const POSTGRES_DURABLE_STATE_MIGRATION = `
CREATE TABLE IF NOT EXISTS data_elements_durable_state (
  state_key TEXT PRIMARY KEY,
  present BOOLEAN NOT NULL DEFAULT FALSE,
  value JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export function durableStateKey(namespace: string, partition = "default"): string {
  if (!/^[a-z][a-z0-9-]{0,127}$/i.test(namespace)) {
    throw new TypeError("Durable state namespaces must be 1-128 alphanumeric or hyphen characters.");
  }
  if (!partition || partition.length > 512) throw new TypeError("Durable state partition must be 1-512 characters.");
  return `${namespace}:${encodeURIComponent(partition)}`;
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

function assertDeclaredKey(key: string, declared: readonly string[]): string {
  const normalized = assertStateKey(key);
  if (!declared.includes(normalized)) throw new Error(`State key was not declared for this transaction: ${normalized}.`);
  return normalized;
}

function assertSqlIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) throw new TypeError("Postgres table names must be simple SQL identifiers.");
  return identifier;
}

function parsePostgresJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Postgres durable state returned invalid JSON.");
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
