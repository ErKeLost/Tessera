import { durableStateKey, type DurableStateStorePort } from "@open-tessera/runtime";
import {
  InMemoryActionInvocationStore,
  InMemoryCapabilityGrantStore,
  InMemoryEffectStore,
} from "./store";
import type {
  ActionInvocationStorePort,
  ActionStepReceipt,
  ActionInvocation,
  CapabilityGrant,
  CapabilityGrantStorePort,
  EffectClaimResult,
  EffectStorePort,
  MessageTemplateGrant,
  StoredActionInvocation,
  StoredEffect,
} from "./types";

export type DurableCapabilityGrantStoreState = {
  formatVersion: 1;
  grantSetVersion: number;
  capabilities: CapabilityGrant[];
  templates: MessageTemplateGrant[];
};

export type DurableCapabilityGrantStoreOptions = {
  state: DurableStateStorePort;
  /** Isolate grant state per tenant or per host authorization authority. */
  storageKey?: string;
};

/**
 * Durable authority-store adapter. Capability handlers intentionally remain a
 * process-local registry: executable code must be deployed, not deserialized
 * from a database. Grants and template versions are durable and atomic.
 */
export class DurableCapabilityGrantStore implements CapabilityGrantStorePort {
  readonly #state: DurableStateStorePort;
  readonly #storageKey: string;

  constructor(options: DurableCapabilityGrantStoreOptions) {
    this.#state = options.state;
    this.#storageKey = options.storageKey ?? durableStateKey("capability-grants");
  }

  async getCapability(capabilityId: string): Promise<CapabilityGrant | undefined> {
    return this.#withStore((store) => store.getCapability(capabilityId));
  }

  async getMessageTemplate(templateGrantId: string): Promise<MessageTemplateGrant | undefined> {
    return this.#withStore((store) => store.getMessageTemplate(templateGrantId));
  }

  async listCapabilities(): Promise<CapabilityGrant[]> {
    return this.#withStore((store) => store.listCapabilities());
  }

  async listMessageTemplates(): Promise<MessageTemplateGrant[]> {
    return this.#withStore((store) => store.listMessageTemplates());
  }

  async getGrantSetVersion(): Promise<number> {
    return this.#withStore((store) => store.getGrantSetVersion());
  }

  async setCapability(grant: CapabilityGrant): Promise<void> {
    return this.#withStore(async (store) => {
      store.setCapability(grant);
    }, true);
  }

  async deleteCapability(capabilityId: string, nextGrantSetVersion?: number): Promise<void> {
    return this.#withStore(async (store) => {
      store.deleteCapability(capabilityId, nextGrantSetVersion);
    }, true);
  }

  async setMessageTemplate(template: MessageTemplateGrant): Promise<void> {
    return this.#withStore(async (store) => {
      store.setMessageTemplate(template);
    }, true);
  }

  async setGrantSetVersion(version: number): Promise<void> {
    return this.#withStore(async (store) => {
      store.setGrantSetVersion(version);
    }, true);
  }

  async #withStore<T>(operation: (store: InMemoryCapabilityGrantStore) => Promise<T>, persist = false): Promise<T> {
    if (!persist) {
      const stored = await this.#state.read<DurableCapabilityGrantStoreState>(this.#storageKey);
      return operation(new InMemoryCapabilityGrantStore(readGrantState(stored)));
    }
    return this.#state.transaction([this.#storageKey], async (transaction) => {
      const stored = await transaction.get<DurableCapabilityGrantStoreState>(this.#storageKey);
      const state = readGrantState(stored);
      const store = new InMemoryCapabilityGrantStore(state);
      const result = await operation(store);
      await transaction.set(this.#storageKey, { formatVersion: 1, ...store.exportState() } satisfies DurableCapabilityGrantStoreState);
      return result;
    });
  }
}

export type DurableEffectStoreState = {
  formatVersion: 1;
  effects: StoredEffect[];
};

export type DurableEffectStoreOptions = {
  state: DurableStateStorePort;
  /** Isolate effect idempotency and call budgets at the tenant boundary. */
  storageKey?: string;
};

/** Durable idempotency, approval, cancellation, and effect-receipt store. */
export class DurableEffectStore implements EffectStorePort {
  readonly #state: DurableStateStorePort;
  readonly #storageKey: string;

  constructor(options: DurableEffectStoreOptions) {
    this.#state = options.state;
    this.#storageKey = options.storageKey ?? durableStateKey("capability-effects");
  }

  async claim(effect: StoredEffect): Promise<EffectClaimResult> {
    return this.#withStore((store) => store.claim(effect), true);
  }

  async get(requestId: string): Promise<StoredEffect | undefined> {
    return this.#withStore((store) => store.get(requestId));
  }

  async compareAndSwap(requestId: string, expectedVersion: number, next: StoredEffect): Promise<boolean> {
    return this.#withStore((store) => store.compareAndSwap(requestId, expectedVersion, next), true);
  }

  async countCalls(actorContextRef: string, capabilityId: string, since: string): Promise<number> {
    return this.#withStore((store) => store.countCalls(actorContextRef, capabilityId, since));
  }

  async #withStore<T>(operation: (store: InMemoryEffectStore) => Promise<T>, persist = false): Promise<T> {
    if (!persist) {
      const stored = await this.#state.read<DurableEffectStoreState>(this.#storageKey);
      return operation(new InMemoryEffectStore({ effects: readEffectState(stored).effects }));
    }
    return this.#state.transaction([this.#storageKey], async (transaction) => {
      const stored = await transaction.get<DurableEffectStoreState>(this.#storageKey);
      const store = new InMemoryEffectStore({ effects: readEffectState(stored).effects });
      const result = await operation(store);
      await transaction.set(this.#storageKey, { formatVersion: 1, ...store.exportState() } satisfies DurableEffectStoreState);
      return result;
    });
  }
}

export type DurableActionInvocationStoreState = {
  formatVersion: 1;
  records: StoredActionInvocation[];
};

export type DurableActionInvocationStoreOptions = {
  state: DurableStateStorePort;
  /** Isolate action replay records at the tenant boundary. */
  storageKey?: string;
};

/** Durable action trigger and local-step receipt store. */
export class DurableActionInvocationStore implements ActionInvocationStorePort {
  readonly #state: DurableStateStorePort;
  readonly #storageKey: string;

  constructor(options: DurableActionInvocationStoreOptions) {
    this.#state = options.state;
    this.#storageKey = options.storageKey ?? durableStateKey("capability-actions");
  }

  async create(record: StoredActionInvocation): Promise<{ status: "created" | "replayed" | "conflict"; record: StoredActionInvocation }> {
    return this.#withStore((store) => store.create(record), true);
  }

  async get(invocationId: string): Promise<StoredActionInvocation | undefined> {
    return this.#withStore((store) => store.get(invocationId));
  }

  async getByTriggerRequest(actorContextRef: string, requestId: string): Promise<StoredActionInvocation | undefined> {
    return this.#withStore((store) => store.getByTriggerRequest(actorContextRef, requestId));
  }

  async compareAndSwap(invocationId: string, expectedVersion: number, next: StoredActionInvocation): Promise<boolean> {
    return this.#withStore((store) => store.compareAndSwap(invocationId, expectedVersion, next), true);
  }

  async commitLocalStep(input: {
    invocationId: string;
    expectedVersion: number;
    receipt: ActionStepReceipt;
    nextInvocation: ActionInvocation;
  }): Promise<{ status: "committed" | "replayed" | "conflict"; record: StoredActionInvocation }> {
    return this.#withStore((store) => store.commitLocalStep(input), true);
  }

  async #withStore<T>(operation: (store: InMemoryActionInvocationStore) => Promise<T>, persist = false): Promise<T> {
    if (!persist) {
      const stored = await this.#state.read<DurableActionInvocationStoreState>(this.#storageKey);
      return operation(new InMemoryActionInvocationStore({ records: readActionState(stored).records }));
    }
    return this.#state.transaction([this.#storageKey], async (transaction) => {
      const stored = await transaction.get<DurableActionInvocationStoreState>(this.#storageKey);
      const store = new InMemoryActionInvocationStore({ records: readActionState(stored).records });
      const result = await operation(store);
      await transaction.set(this.#storageKey, { formatVersion: 1, ...store.exportState() } satisfies DurableActionInvocationStoreState);
      return result;
    });
  }
}

function readGrantState(state: DurableCapabilityGrantStoreState | undefined): Omit<DurableCapabilityGrantStoreState, "formatVersion"> {
  if (!state) return { grantSetVersion: 0, capabilities: [], templates: [] };
  if (state.formatVersion !== 1 || !Array.isArray(state.capabilities) || !Array.isArray(state.templates)) {
    throw new TypeError("Unsupported durable capability grant store state.");
  }
  return state;
}

function readEffectState(state: DurableEffectStoreState | undefined): Omit<DurableEffectStoreState, "formatVersion"> {
  if (!state) return { effects: [] };
  if (state.formatVersion !== 1 || !Array.isArray(state.effects)) throw new TypeError("Unsupported durable effect store state.");
  return state;
}

function readActionState(state: DurableActionInvocationStoreState | undefined): Omit<DurableActionInvocationStoreState, "formatVersion"> {
  if (!state) return { records: [] };
  if (state.formatVersion !== 1 || !Array.isArray(state.records)) {
    throw new TypeError("Unsupported durable action invocation store state.");
  }
  return state;
}
