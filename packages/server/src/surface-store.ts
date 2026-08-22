import type {
  CatalogSetSlice,
  RendererCapabilityManifest,
} from "@open-generative/catalog";
import type {
  ActionInvocationId,
  ActionStatus,
  ApprovalRequested,
  CommittedRevision,
  CorrelationId,
  ResourceBindingId,
  ResourceResolutionIdentity,
  ResourceResolutionResult,
  RequestId,
  Sha256Hash,
  StateId,
  StateValueSnapshot,
  StreamId,
  SurfaceSessionId,
  StreamPolicy,
  TransactionId,
} from "@open-generative/protocol";
import type { AuthorityContext } from "./authority";
import type { FinalizeTransactionInput } from "@open-generative/runtime";

export type SurfaceSessionRecord = {
  surfaceSessionId: SurfaceSessionId;
  streamId: StreamId;
  epoch: number;
  authority: AuthorityContext;
  audienceBindingHash: Sha256Hash;
  rendererCapabilityManifest: RendererCapabilityManifest;
  catalogSlice: CatalogSetSlice;
  committedRevision: CommittedRevision;
  activeTransaction?: Readonly<{
    transactionId: TransactionId;
    startedAt: string;
    deadlineAt: string;
  }>;
  activePreview?: Readonly<{
    transactionId: TransactionId;
    overlayHash: Sha256Hash;
    overlaySequence: number;
  }>;
  pendingRevisionPublication?: Readonly<{
    finalize: FinalizeTransactionInput;
  }>;
  streamPolicy: StreamPolicy;
  state: Record<StateId, StateValueSnapshot>;
  resources: Record<ResourceBindingId, ResourceResolutionResult>;
  resourceResolutionIdentities: Record<ResourceBindingId, ResourceResolutionIdentity>;
  actions: Record<ActionInvocationId, ActionStatus>;
  approvals: ApprovalRequested[];
  commandReceipts: Partial<Record<RequestId, SurfaceCommandReceipt>>;
  acknowledgedThrough: number;
  createdAt: string;
  expiresAt: string;
};

export type SurfaceCommandReceipt = Readonly<{
  payloadHash: Sha256Hash;
  correlationId: CorrelationId;
  firstSequence: number;
  lastSequence: number;
}>;

export type VersionedSurfaceSession = Readonly<{
  version: number;
  value: SurfaceSessionRecord;
}>;

export interface SurfaceSessionStore {
  create(record: SurfaceSessionRecord): Promise<"created" | "exists">;
  get(surfaceSessionId: SurfaceSessionId): Promise<VersionedSurfaceSession | undefined>;
  list(input: Readonly<{
    after?: SurfaceSessionId;
    limit: number;
  }>): Promise<VersionedSurfaceSession[]>;
  compareAndSet(
    surfaceSessionId: SurfaceSessionId,
    expectedVersion: number,
    value: SurfaceSessionRecord,
  ): Promise<"updated" | "conflict" | "missing">;
}

export class InMemorySurfaceSessionStore implements SurfaceSessionStore {
  readonly #sessions = new Map<SurfaceSessionId, VersionedSurfaceSession>();

  async create(record: SurfaceSessionRecord): Promise<"created" | "exists"> {
    if (this.#sessions.has(record.surfaceSessionId)) return "exists";
    this.#sessions.set(record.surfaceSessionId, { version: 1, value: structuredClone(record) });
    return "created";
  }

  async get(surfaceSessionId: SurfaceSessionId) {
    const value = this.#sessions.get(surfaceSessionId);
    return value ? structuredClone(value) : undefined;
  }

  async list(input: Readonly<{ after?: SurfaceSessionId; limit: number }>) {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new TypeError("Surface session list limit must be a positive integer.");
    }
    return [...this.#sessions.entries()]
      .filter(([surfaceSessionId]) => input.after === undefined || compareIds(surfaceSessionId, input.after) > 0)
      .sort(([left], [right]) => compareIds(left, right))
      .slice(0, input.limit)
      .map(([, session]) => structuredClone(session));
  }

  async compareAndSet(
    surfaceSessionId: SurfaceSessionId,
    expectedVersion: number,
    value: SurfaceSessionRecord,
  ): Promise<"updated" | "conflict" | "missing"> {
    const current = this.#sessions.get(surfaceSessionId);
    if (!current) return "missing";
    if (current.version !== expectedVersion) return "conflict";
    this.#sessions.set(surfaceSessionId, { version: current.version + 1, value: structuredClone(value) });
    return "updated";
  }
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
