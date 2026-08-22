import type {
  ActionAccepted,
  ActionStatus,
  ApprovalRequested,
  EffectReceipt,
  JsonValue,
  Sha256Hash,
} from "@open-generative/protocol";

export type CapabilityExecutionRecord = {
  identityHash: Sha256Hash;
  accepted: ActionAccepted;
  status: ActionStatus;
  normalizedInput: JsonValue;
  authorityBindingHash: Sha256Hash;
  tenantBindingHash: Sha256Hash;
  surfaceSessionId: string;
  revisionId: string;
  approval?: ApprovalRequested;
  approvalConsumed: boolean;
  receipt?: EffectReceipt;
};

export interface CapabilityStore {
  claim(record: CapabilityExecutionRecord): Promise<
    | { status: "claimed"; record: CapabilityExecutionRecord }
    | { status: "existing"; record: CapabilityExecutionRecord }
  >;
  get(identityHash: Sha256Hash): Promise<CapabilityExecutionRecord | undefined>;
  getByInvocationId(invocationId: string): Promise<CapabilityExecutionRecord | undefined>;
  getByApprovalToken(token: string): Promise<CapabilityExecutionRecord | undefined>;
  consumeApproval(token: string): Promise<
    | { status: "consumed"; record: CapabilityExecutionRecord }
    | { status: "missing" | "already-consumed" }
  >;
  update(record: CapabilityExecutionRecord): Promise<void>;
}

export class InMemoryCapabilityStore implements CapabilityStore {
  readonly #records = new Map<Sha256Hash, CapabilityExecutionRecord>();
  readonly #approvalIndex = new Map<string, Sha256Hash>();
  readonly #invocationIndex = new Map<string, Sha256Hash>();

  async claim(record: CapabilityExecutionRecord) {
    const existing = this.#records.get(record.identityHash);
    if (existing) return { status: "existing" as const, record: cloneRecord(existing) };
    const stored = cloneRecord(record);
    this.#records.set(record.identityHash, stored);
    this.#invocationIndex.set(record.accepted.invocationId, record.identityHash);
    return { status: "claimed" as const, record: cloneRecord(stored) };
  }

  async get(identityHash: Sha256Hash) {
    const record = this.#records.get(identityHash);
    return record ? cloneRecord(record) : undefined;
  }

  async getByInvocationId(invocationId: string) {
    const identityHash = this.#invocationIndex.get(invocationId);
    return identityHash ? this.get(identityHash) : undefined;
  }

  async getByApprovalToken(token: string) {
    const identityHash = this.#approvalIndex.get(token);
    if (!identityHash) return undefined;
    return this.get(identityHash);
  }

  async consumeApproval(token: string) {
    const identityHash = this.#approvalIndex.get(token);
    if (!identityHash) return { status: "missing" as const };
    const record = this.#records.get(identityHash);
    if (!record) return { status: "missing" as const };
    if (record.approvalConsumed) return { status: "already-consumed" as const };
    const consumed = cloneRecord({ ...record, approvalConsumed: true });
    this.#records.set(identityHash, consumed);
    return { status: "consumed" as const, record: cloneRecord(consumed) };
  }

  async update(record: CapabilityExecutionRecord): Promise<void> {
    if (!this.#records.has(record.identityHash)) {
      throw new Error("Cannot update an unclaimed capability execution.");
    }
    const previous = this.#records.get(record.identityHash);
    if (previous?.approval && previous.approval.approvalToken !== record.approval?.approvalToken) {
      this.#approvalIndex.delete(previous.approval.approvalToken);
    }
    const stored = cloneRecord(record);
    this.#records.set(record.identityHash, stored);
    this.#invocationIndex.set(stored.accepted.invocationId, stored.identityHash);
    if (stored.approval) this.#approvalIndex.set(stored.approval.approvalToken, stored.identityHash);
  }
}

function cloneRecord(record: CapabilityExecutionRecord): CapabilityExecutionRecord {
  return structuredClone(record);
}
