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

export type SurfaceSessionRecord = {
  surfaceSessionId: SurfaceSessionId;
  streamId: StreamId;
  epoch: number;
  authority: AuthorityContext;
  audienceBindingHash: Sha256Hash;
  rendererCapabilityManifest: RendererCapabilityManifest;
  catalogSlice: CatalogSetSlice;
  committedRevision: CommittedRevision;
  activePreview?: Readonly<{
    transactionId: TransactionId;
    overlayHash: Sha256Hash;
    overlaySequence: number;
  }>;
  streamPolicy: StreamPolicy;
  state: Record<StateId, StateValueSnapshot>;
  resources: Record<ResourceBindingId, ResourceResolutionResult>;
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
