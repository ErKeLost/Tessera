import { durableStateKey, type DurableStateStorePort } from "@data-elements/runtime";
import {
  InMemoryCommittedResourceStore,
  InMemoryResourceResolutionStore,
  InMemoryResourceSchemaRegistry,
  InMemoryScopedResourceBindingCache,
} from "./memory";
import type {
  CommittedResourceContext,
  CommittedResourceStorePort,
  RegisteredResourceSchema,
  ResourceResolutionClaim,
  ResourceResolutionReceipt,
  ResourceResolutionStorePort,
  ResourceSchemaRegistryPort,
  ScopedBindingCacheEntry,
  ScopedResourceBindingCachePort,
  StoredResourceResolution,
} from "./types";

export type DurableCommittedResourceStoreState = {
  formatVersion: 1;
  records: Array<[string, CommittedResourceContext]>;
};

export type DurableCommittedResourceStoreOptions = {
  state: DurableStateStorePort;
  /** Use a tenant partition; immutable committed contexts share its revision authority. */
  storageKey?: string;
};

/** Durable immutable committed-resource context store. */
export class DurableCommittedResourceStore implements CommittedResourceStorePort {
  readonly #state: DurableStateStorePort;
  readonly #storageKey: string;

  constructor(options: DurableCommittedResourceStoreOptions) {
    this.#state = options.state;
    this.#storageKey = options.storageKey ?? durableStateKey("resource-contexts");
  }

  async set(input: { documentId: string; branchId: string; revisionId: string; context: CommittedResourceContext }): Promise<void> {
    return this.#withStore(async (store) => {
      store.set(input);
    }, true);
  }

  async getCommittedResource(input: {
    documentId: string;
    branchId: string;
    revisionId: string;
    resourceId: string;
  }): Promise<CommittedResourceContext | undefined> {
    return this.#withStore((store) => store.getCommittedResource(input));
  }

  async #withStore<T>(operation: (store: InMemoryCommittedResourceStore) => Promise<T>, persist = false): Promise<T> {
    if (!persist) {
      const stored = await this.#state.read<DurableCommittedResourceStoreState>(this.#storageKey);
      return operation(new InMemoryCommittedResourceStore(readContextState(stored)));
    }
    return this.#state.transaction([this.#storageKey], async (transaction) => {
      const stored = await transaction.get<DurableCommittedResourceStoreState>(this.#storageKey);
      const store = new InMemoryCommittedResourceStore(readContextState(stored));
      const result = await operation(store);
      await transaction.set(this.#storageKey, { formatVersion: 1, ...store.exportState() } satisfies DurableCommittedResourceStoreState);
      return result;
    });
  }
}

export type DurableResourceSchemaRegistryState = {
  formatVersion: 1;
  records: Array<[string, RegisteredResourceSchema]>;
};

export type DurableResourceSchemaRegistryOptions = {
  state: DurableStateStorePort;
  /** Use a partition for the catalog/schema authority that owns these schemas. */
  storageKey?: string;
};

/** Durable immutable schema registry. */
export class DurableResourceSchemaRegistry implements ResourceSchemaRegistryPort {
  readonly #state: DurableStateStorePort;
  readonly #storageKey: string;

  constructor(options: DurableResourceSchemaRegistryOptions) {
    this.#state = options.state;
    this.#storageKey = options.storageKey ?? durableStateKey("resource-schemas");
  }

  async set(record: RegisteredResourceSchema): Promise<void> {
    return this.#withStore(async (store) => {
      store.set(record);
    }, true);
  }

  async get(schemaId: string, schemaVersion: number): Promise<RegisteredResourceSchema | undefined> {
    return this.#withStore((store) => store.get(schemaId, schemaVersion));
  }

  async #withStore<T>(operation: (store: InMemoryResourceSchemaRegistry) => Promise<T>, persist = false): Promise<T> {
    if (!persist) {
      const stored = await this.#state.read<DurableResourceSchemaRegistryState>(this.#storageKey);
      return operation(new InMemoryResourceSchemaRegistry(readSchemaState(stored)));
    }
    return this.#state.transaction([this.#storageKey], async (transaction) => {
      const stored = await transaction.get<DurableResourceSchemaRegistryState>(this.#storageKey);
      const store = new InMemoryResourceSchemaRegistry(readSchemaState(stored));
      const result = await operation(store);
      await transaction.set(this.#storageKey, { formatVersion: 1, ...store.exportState() } satisfies DurableResourceSchemaRegistryState);
      return result;
    });
  }
}

export type DurableResourceResolutionStoreState = {
  formatVersion: 1;
  records: Array<[string, StoredResourceResolution]>;
};

export type DurableResourceResolutionStoreOptions = {
  state: DurableStateStorePort;
  /** Isolate request-id idempotency at the tenant boundary. */
  storageKey?: string;
};

/** Durable resource control-plane receipt and idempotency store. */
export class DurableResourceResolutionStore implements ResourceResolutionStorePort {
  readonly #state: DurableStateStorePort;
  readonly #storageKey: string;

  constructor(options: DurableResourceResolutionStoreOptions) {
    this.#state = options.state;
    this.#storageKey = options.storageKey ?? durableStateKey("resource-resolutions");
  }

  async claim(record: StoredResourceResolution): Promise<ResourceResolutionClaim> {
    return this.#withStore((store) => store.claim(record), true);
  }

  async complete(
    identity: { tenantRef: string; actorRef: string; requestId: string },
    payloadHash: string,
    receipt: ResourceResolutionReceipt,
  ): Promise<void> {
    return this.#withStore((store) => store.complete(identity, payloadHash, receipt), true);
  }

  async get(identity: { tenantRef: string; actorRef: string; requestId: string }): Promise<StoredResourceResolution | undefined> {
    return this.#withStore((store) => store.get(identity));
  }

  async #withStore<T>(operation: (store: InMemoryResourceResolutionStore) => Promise<T>, persist = false): Promise<T> {
    if (!persist) {
      const stored = await this.#state.read<DurableResourceResolutionStoreState>(this.#storageKey);
      return operation(new InMemoryResourceResolutionStore(readResolutionState(stored)));
    }
    return this.#state.transaction([this.#storageKey], async (transaction) => {
      const stored = await transaction.get<DurableResourceResolutionStoreState>(this.#storageKey);
      const store = new InMemoryResourceResolutionStore(readResolutionState(stored));
      const result = await operation(store);
      await transaction.set(this.#storageKey, { formatVersion: 1, ...store.exportState() } satisfies DurableResourceResolutionStoreState);
      return result;
    });
  }
}

export type DurableScopedResourceBindingCacheState = {
  formatVersion: 1;
  entries: Array<[string, ScopedBindingCacheEntry]>;
};

export type DurableScopedResourceBindingCacheOptions = {
  state: DurableStateStorePort;
  /** A Redis/Valkey implementation is recommended for this non-authoritative cache. */
  storageKey?: string;
  now?: () => string;
};

/**
 * Durable scoped binding cache. It preserves TTL and explicit eviction
 * semantics; it must never be treated as authorization source of truth.
 */
export class DurableScopedResourceBindingCache implements ScopedResourceBindingCachePort {
  readonly #state: DurableStateStorePort;
  readonly #storageKey: string;
  readonly #now: () => string;

  constructor(options: DurableScopedResourceBindingCacheOptions) {
    this.#state = options.state;
    this.#storageKey = options.storageKey ?? durableStateKey("resource-bindings");
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async get(cacheKey: string): Promise<ScopedBindingCacheEntry | undefined> {
    return this.#withStore((store) => store.get(cacheKey), true);
  }

  async put(entry: ScopedBindingCacheEntry): Promise<void> {
    return this.#withStore((store) => store.put(entry), true);
  }

  async delete(cacheKey: string): Promise<void> {
    return this.#withStore((store) => store.delete(cacheKey), true);
  }

  async evictActor(tenantRef: string, actorRef: string): Promise<void> {
    return this.#withStore((store) => store.evictActor(tenantRef, actorRef), true);
  }

  async evictRevision(documentId: string, revisionId: string): Promise<void> {
    return this.#withStore((store) => store.evictRevision(documentId, revisionId), true);
  }

  async #withStore<T>(operation: (store: InMemoryScopedResourceBindingCache) => Promise<T>, persist = false): Promise<T> {
    if (!persist) {
      const stored = await this.#state.read<DurableScopedResourceBindingCacheState>(this.#storageKey);
      return operation(new InMemoryScopedResourceBindingCache({ now: this.#now, entries: readCacheState(stored).entries }));
    }
    return this.#state.transaction([this.#storageKey], async (transaction) => {
      const stored = await transaction.get<DurableScopedResourceBindingCacheState>(this.#storageKey);
      const store = new InMemoryScopedResourceBindingCache({ now: this.#now, entries: readCacheState(stored).entries });
      const result = await operation(store);
      await transaction.set(this.#storageKey, { formatVersion: 1, ...store.exportState() } satisfies DurableScopedResourceBindingCacheState);
      return result;
    });
  }
}

function readContextState(state: DurableCommittedResourceStoreState | undefined): Omit<DurableCommittedResourceStoreState, "formatVersion"> {
  if (!state) return { records: [] };
  if (state.formatVersion !== 1 || !Array.isArray(state.records)) throw new TypeError("Unsupported durable committed resource store state.");
  return state;
}

function readSchemaState(state: DurableResourceSchemaRegistryState | undefined): Omit<DurableResourceSchemaRegistryState, "formatVersion"> {
  if (!state) return { records: [] };
  if (state.formatVersion !== 1 || !Array.isArray(state.records)) throw new TypeError("Unsupported durable resource schema registry state.");
  return state;
}

function readResolutionState(state: DurableResourceResolutionStoreState | undefined): Omit<DurableResourceResolutionStoreState, "formatVersion"> {
  if (!state) return { records: [] };
  if (state.formatVersion !== 1 || !Array.isArray(state.records)) throw new TypeError("Unsupported durable resource resolution store state.");
  return state;
}

function readCacheState(state: DurableScopedResourceBindingCacheState | undefined): Omit<DurableScopedResourceBindingCacheState, "formatVersion"> {
  if (!state) return { entries: [] };
  if (state.formatVersion !== 1 || !Array.isArray(state.entries)) throw new TypeError("Unsupported durable scoped resource cache state.");
  return state;
}
