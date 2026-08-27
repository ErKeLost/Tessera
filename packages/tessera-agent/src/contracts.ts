import type { MastraModelConfig } from "@mastra/core/llm";
import type { Mastra } from "@mastra/core/mastra";
import type { Memory } from "@mastra/memory";
import type { OpenGenerativeHost } from "@open-generative/mastra";
import type {
  DataAgent,
  PlanningCapability,
  SemanticCatalog,
} from "@open-tessera/data-agent";
import type {
  DatabaseAction,
  DatabaseDialect,
  DatabasePermissionLevel,
} from "@open-tessera/database";
import { z } from "zod";

export const TESSERA_AGENT_TOOL_NAMES = [
  "list_database",
  "search_data_context",
  "prepare_analysis",
  "execute_sql",
] as const;

export type TesseraAgentToolName = (typeof TESSERA_AGENT_TOOL_NAMES)[number];
export type TesseraAgentToolState = "started" | "completed" | "blocked" | "failed";

export const tesseraAgentIdentitySchema = z.object({
  subject: z.string().trim().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
  tenantId: z.string().trim().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
  roles: z.array(z.string().trim().min(1).max(128)).max(64).readonly().optional(),
}).strict();

export type TesseraAgentIdentity = Readonly<z.infer<typeof tesseraAgentIdentitySchema>>;
export type TesseraAgentImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type TesseraAgentImageInput = Readonly<{
  dataUrl: string;
  mediaType: TesseraAgentImageMediaType;
}>;

/**
 * This is server-only turn state. A host constructs it after validating a
 * navigation hint against the live catalog; physical relation coordinates
 * never cross this boundary into Mastra or a browser stream.
 */
export type TesseraAgentTurnContext = Readonly<{
  workspace: Readonly<{
    hasLocalFilter: boolean;
    view?: "data" | "definition";
  }>;
  currentRelation?: Readonly<{
    capability: PlanningCapability;
    semanticCatalog: SemanticCatalog;
    truncated: boolean;
    omitted: Readonly<{
      entities: number;
      fields: number;
      metrics: number;
      relationships: number;
    }>;
  }>;
}>;

export type TesseraAgentErrorPhase =
  | "catalog"
  | "provider"
  | "tool-input"
  | "tool-output"
  | "persistence"
  | "presentation"
  | "stream"
  | "transport";

export type TesseraAgentDiagnostic = Readonly<{
  phase: TesseraAgentErrorPhase;
  error: unknown;
  tool?: TesseraAgentToolName;
  field?: string;
  reason?: string;
}>;

export type TesseraAgentRunInput = Readonly<{
  runId: string;
  threadId: string;
  message: string;
  images?: readonly TesseraAgentImageInput[];
  /** Server-bound transient page context. Never sourced directly from UI text. */
  turnContext?: TesseraAgentTurnContext;
  /** Server-owned transient instructions. Never sourced directly from user or browser text. */
  runtimeSignals?: readonly string[];
  signal: AbortSignal;
  identity?: TesseraAgentIdentity;
  /** Server-only data used to resume a Mastra runtime suspension. */
  resumeData?: unknown;
  /** Identifies the exact suspended tool when a run has multiple suspensions. */
  toolCallId?: string;
  /** Enables Mastra runtime suspension for transports that can resume a tool call. */
  allowRuntimeSuspension?: boolean;
  /** Implementations must never expose the raw error to a browser or model. */
  reportDiagnostic?: (diagnostic: TesseraAgentDiagnostic) => void;
}>;

export const tesseraAgentRunSchema = z.object({
  status: z.enum(["completed", "needs_input"]),
  message: z.string().max(30_000),
  evidence: z.array(z.object({
    queryId: z.string().min(1).max(256),
    label: z.string().min(1).max(512),
  }).strict()).max(50).optional(),
}).strict();

export type TesseraAgentRun = z.infer<typeof tesseraAgentRunSchema>;

export const tesseraAgentEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text-delta"),
    text: z.string().min(1).max(4_096),
  }).strict(),
  z.object({
    type: z.literal("tool"),
    tool: z.enum(TESSERA_AGENT_TOOL_NAMES),
    state: z.enum(["started", "completed", "blocked", "failed"]),
  }).strict(),
]);

export type TesseraAgentEvent = z.infer<typeof tesseraAgentEventSchema>;

/** Headless Agent boundary. HTTP and UI stream adapters belong to the host. */
export interface TesseraAgentRunner {
  run(input: TesseraAgentRunInput): Promise<TesseraAgentRun>;
  stream?(
    input: TesseraAgentRunInput,
    emit: (event: TesseraAgentEvent) => void | Promise<void>,
  ): Promise<TesseraAgentRun>;
}

export type TesseraAgentPermissionContext = Readonly<{
  accessMode: "read-only" | "read-write";
  databaseActionsAvailable: boolean;
  sqlStatements: Readonly<Record<"read" | "write" | "destructive" | "unknown", DatabasePermissionLevel>>;
}>;

export type TesseraAgentReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "none";

/** Normalized server-only model settings; environment lookup remains host-owned. */
export type TesseraAgentLlmConfig = Readonly<{
  model: string;
  apiKey?: string;
  baseUrl?: string;
  headers: Readonly<Record<string, string>>;
  reasoningEffort?: TesseraAgentReasoningEffort;
  temperature: number;
  maxOutputTokens: number;
  maxSteps: number;
  maxRetries: number;
}>;

export type TesseraAgentMutationActor = Readonly<{
  tenantRef: string;
  actorRef: string;
  roleRefs?: readonly string[];
}>;

export type TesseraAgentMutationEffect = Readonly<{
  summary: Readonly<{
    status: string;
    requestId: string;
  }>;
  approval?: Readonly<{
    checkpointId: string;
    status?: string;
  }>;
  review?: Readonly<{
    compiled?: Readonly<{
      sql: string;
      parameters: unknown[];
    }>;
  }>;
  receipt?: Readonly<{
    diagnostic?: Readonly<{
      code?: string;
      message?: string;
    }>;
  }>;
  result?: Readonly<{
    affectedRows?: number;
  }>;
}>;

/**
 * Narrow mutation port consumed by the Agent. Durable policy evaluation,
 * approval storage, compilation, and execution remain host responsibilities.
 */
export type TesseraAgentMutationPort = Readonly<{
  submit(input: Readonly<{
    actor: TesseraAgentMutationActor;
    action: DatabaseAction;
    purpose: string;
    requireApproval?: boolean;
  }>): Promise<TesseraAgentMutationEffect>;
  approve(input: Readonly<{
    actor: TesseraAgentMutationActor;
    requestId: string;
    checkpointId: string;
  }>): Promise<TesseraAgentMutationEffect>;
  reject(input: Readonly<{
    actor: TesseraAgentMutationActor;
    requestId: string;
    checkpointId: string;
  }>): Promise<TesseraAgentMutationEffect>;
}>;

export type TesseraAgentContinualTurn = Readonly<{
  runId: string;
  resourceId: string;
  threadId: string;
  userText: string;
  assistantMessage?: unknown;
  assistantText?: string;
}>;

/** The Agent only needs this small surface from a host-owned continual layer. */
export type TesseraAgentContinualPort = Readonly<{
  contextFor(input: Readonly<{ resourceId: string; threadId: string }>): Promise<string | undefined>;
  submitCompletedTurn(input: TesseraAgentContinualTurn): void;
}>;

export type TesseraAgentCoreOptions = Readonly<{
  dataAgent: DataAgent;
  databaseDialect?: DatabaseDialect;
  memory: Memory;
  llm: TesseraAgentLlmConfig;
  model: MastraModelConfig;
  /** Required host identity used only when a turn omits an authenticated principal. */
  defaultIdentity: TesseraAgentIdentity;
  /** Maps a principal to the private Mastra Memory resource owner. */
  resourceIdForIdentity?: (identity: TesseraAgentIdentity) => string;
  /** Produces a bounded, model-safe diagnostic without exposing credentials or connection details. */
  formatError?: (error: unknown) => string;
  permissionContext?: TesseraAgentPermissionContext;
  databaseActions?: TesseraAgentMutationPort;
  mastra: Mastra;
  continualHarness?: TesseraAgentContinualPort;
  openGenerativeHost?: OpenGenerativeHost | Promise<OpenGenerativeHost>;
}>;

export type TesseraSuspendedToolPayload = Readonly<{
  requestId: string;
  checkpointId: string;
  operation: string;
  target: string;
  purpose: string;
  compiled?: Readonly<{
    sql: string;
    parameters: unknown[];
  }>;
}>;
