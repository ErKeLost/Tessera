import {
  HASH_DOMAINS,
  canonicalStringify,
  createDiagnostic,
  hashCanonical,
  operationIdSchema,
  proposalOperationEnvelopeSchema,
  type AuthoringProposalOperation,
  type AuthoringValue,
  type Diagnostic,
  type EntityRevisionId,
  type NodeId,
  type ProposalLocalId,
  type ProposalOperationEnvelope,
  type ResourceBindingId,
} from "@open-generative/protocol";
import { deepFreeze } from "./internal";
import {
  OpenGenerativeLanguageDecoder,
  languageNodeLocalId,
  languageValueToAuthoringValue,
  type CompiledOpenGenerativeLanguage,
  type OpenGenerativeLanguageExpression,
  type OpenGenerativeLanguageStatement,
} from "./language";
import type { CompilerCatalogLike, CompilerTurnOutcome } from "./types";

export type OpenGenerativeLanguageSessionContext = Readonly<{
  abortSignal?: AbortSignal;
}>;

export type OpenGenerativeLanguageUpdate = Readonly<{
  acceptedStatements: number;
  renderable: boolean;
  outcome?: CompilerTurnOutcome;
}>;

export interface OpenGenerativeLanguageSession {
  start(): Promise<void>;
  pushTextDelta(delta: string): Promise<OpenGenerativeLanguageUpdate>;
  finish(): Promise<CompilerTurnOutcome>;
  abort(reason?: "timeout" | "cancelled"): Promise<CompilerTurnOutcome>;
}

export interface OpenGenerativeCompilerTurnPort {
  start(): Promise<CompilerTurnOutcome | undefined>;
  pushDecodedOperation(operation: ProposalOperationEnvelope): Promise<CompilerTurnOutcome | undefined>;
  finishDecodedOperations(): Promise<CompilerTurnOutcome>;
  cancel(
    reason?: "rejected" | "timeout" | "cancelled",
    ...diagnostics: Diagnostic[]
  ): Promise<CompilerTurnOutcome>;
}

type NodePlan = Readonly<{
  localId: ProposalLocalId<"node">;
  component: string;
  props: Readonly<Record<string, AuthoringValue>>;
  slots: Readonly<Record<string, readonly ProposalLocalId<"node">[]>>;
}>;

type Projection = Readonly<{
  rootLocalId: ProposalLocalId<"node">;
  nodes: readonly NodePlan[];
}>;

export class OpenGenerativeLanguageCompilerSession implements OpenGenerativeLanguageSession {
  readonly #compiled: CompiledOpenGenerativeLanguage;
  readonly #catalog: CompilerCatalogLike;
  readonly #turn: OpenGenerativeCompilerTurnPort;
  readonly #context: OpenGenerativeLanguageSessionContext;
  readonly #decoder = new OpenGenerativeLanguageDecoder();
  readonly #statements = new Map<string, OpenGenerativeLanguageExpression>();
  readonly #applied = new Map<string, string>();
  readonly #resourceBindings: ReadonlyMap<string, ResourceBindingId>;
  readonly #expectedRootId: NodeId;
  readonly #supersededRootRevision?: EntityRevisionId;
  #started = false;
  #rootSet = false;
  #supersededRootRemoved = false;
  #sequence = 1;
  #previousOperationId?: ReturnType<typeof operationIdSchema.parse>;
  #outcome?: CompilerTurnOutcome;
  #failure?: unknown;

  constructor(input: Readonly<{
    compiled: CompiledOpenGenerativeLanguage;
    catalog: CompilerCatalogLike;
    turn: OpenGenerativeCompilerTurnPort;
    expectedRootId: NodeId;
    supersededRootRevision?: EntityRevisionId;
    context?: OpenGenerativeLanguageSessionContext;
  }>) {
    this.#compiled = input.compiled;
    this.#catalog = input.catalog;
    this.#turn = input.turn;
    this.#context = input.context ?? {};
    this.#expectedRootId = input.expectedRootId;
    this.#supersededRootRevision = input.supersededRootRevision;
    this.#resourceBindings = new Map(input.compiled.resources.map((resource) => [
      resource.alias,
      resource.bindingId,
    ]));
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#context.abortSignal?.throwIfAborted();
    this.#started = true;
    const outcome = await this.#turn.start();
    if (outcome) this.#outcome = outcome;
  }

  async pushTextDelta(delta: string): Promise<OpenGenerativeLanguageUpdate> {
    if (this.#outcome) return { acceptedStatements: 0, renderable: this.#rootSet, outcome: this.#outcome };
    if (this.#failure) return { acceptedStatements: 0, renderable: this.#rootSet };
    this.#context.abortSignal?.throwIfAborted();
    try {
      const statements = this.#decoder.push(delta);
      await this.#accept(statements);
      return {
        acceptedStatements: statements.length,
        renderable: this.#rootSet,
        ...(this.#outcome === undefined ? {} : { outcome: this.#outcome }),
      };
    } catch (error) {
      this.#failure = error;
      return { acceptedStatements: 0, renderable: this.#rootSet };
    }
  }

  async finish(): Promise<CompilerTurnOutcome> {
    if (this.#outcome) return this.#outcome;
    this.#context.abortSignal?.throwIfAborted();
    try {
      if (!this.#failure) await this.#accept(this.#decoder.finish());
      if (this.#failure) {
        return this.#cancelForFailure(this.#failure);
      }
      if (!this.#rootSet) {
        return this.#cancelForFailure(new TypeError("OGL output did not resolve a root component."));
      }
      this.#outcome = await this.#turn.finishDecodedOperations();
      return this.#outcome;
    } catch (error) {
      return this.#cancelForFailure(error);
    }
  }

  async abort(reason: "timeout" | "cancelled" = "cancelled"): Promise<CompilerTurnOutcome> {
    if (this.#outcome) return this.#outcome;
    await this.start();
    this.#outcome = await this.#turn.cancel(reason);
    return this.#outcome;
  }

  async #accept(statements: readonly OpenGenerativeLanguageStatement[]): Promise<void> {
    if (statements.length === 0) return;
    await this.start();
    for (const statement of statements) this.#statements.set(statement.name, statement.expression);
    const projection = projectProgram({
      statements: this.#statements,
      catalog: this.#catalog,
      compiled: this.#compiled,
      resources: this.#resourceBindings,
    });
    if (!projection) return;
    for (const node of projection.nodes) {
      const signature = canonicalStringify(node);
      if (this.#applied.get(node.localId) === signature) continue;
      const outcome = await this.#pushOperation({
        op: "put-node",
        target: { kind: "node", localId: node.localId },
        value: {
          component: node.component as never,
          props: { ...node.props },
          slots: Object.fromEntries(Object.entries(node.slots).map(([slot, children]) => [
            slot,
            children.map((localId) => ({ kind: "node" as const, localId })),
          ])),
          events: {},
          evidence: [],
        },
      });
      if (outcome) {
        this.#outcome = outcome;
        return;
      }
      this.#applied.set(node.localId, signature);
    }
    if (!this.#rootSet) {
      const outcome = await this.#pushOperation({
        op: "set-root",
        node: { kind: "node", localId: projection.rootLocalId },
        expectedRootId: this.#expectedRootId,
      });
      if (outcome) {
        this.#outcome = outcome;
        return;
      }
      this.#rootSet = true;
    }
    if (this.#rootSet && !this.#supersededRootRemoved && this.#supersededRootRevision !== undefined) {
      const outcome = await this.#pushOperation({
        op: "remove-node",
        target: {
          kind: "node",
          canonicalId: this.#expectedRootId,
          expectedEntityRevision: this.#supersededRootRevision,
        },
      });
      if (outcome) {
        this.#outcome = outcome;
        return;
      }
      this.#supersededRootRemoved = true;
    }
  }

  async #pushOperation(
    operation: AuthoringProposalOperation,
  ): Promise<CompilerTurnOutcome | undefined> {
    if (this.#sequence > this.#compiled.maxOperations) {
      return this.#cancelForFailure(new TypeError("OGL output exceeds the frozen operation limit."));
    }
    const operationId = operationIdSchema.parse(
      `language-${this.#sequence}-${(await hashCanonical(HASH_DOMAINS.operationPayload, operation)).slice("sha256:".length, "sha256:".length + 20)}`,
    );
    const envelope: ProposalOperationEnvelope = proposalOperationEnvelopeSchema.parse({
      operationId,
      sequence: this.#sequence,
      dependsOn: this.#previousOperationId ? [this.#previousOperationId] : [],
      payloadHash: await hashCanonical(HASH_DOMAINS.operationPayload, operation),
      operation,
    });
    this.#sequence += 1;
    this.#previousOperationId = operationId;
    return this.#turn.pushDecodedOperation(envelope);
  }

  async #cancelForFailure(error: unknown): Promise<CompilerTurnOutcome> {
    if (this.#outcome) return this.#outcome;
    await this.start();
    const diagnostics: Diagnostic[] = [createDiagnostic({
      phase: "decode",
      code: error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "language.output-invalid",
      message: error instanceof Error ? error.message : "Open Generative Language output is invalid.",
      severity: "error",
      recoverable: false,
      modelCorrectable: true,
    })];
    this.#outcome = await this.#turn.cancel("rejected", ...diagnostics);
    return this.#outcome;
  }
}

export function createOpenGenerativeLanguageSession(input: ConstructorParameters<
  typeof OpenGenerativeLanguageCompilerSession
>[0]): OpenGenerativeLanguageCompilerSession {
  return new OpenGenerativeLanguageCompilerSession(input);
}

function projectProgram(input: Readonly<{
  statements: ReadonlyMap<string, OpenGenerativeLanguageExpression>;
  catalog: CompilerCatalogLike;
  compiled: CompiledOpenGenerativeLanguage;
  resources: ReadonlyMap<string, ResourceBindingId>;
}>): Projection | undefined {
  const rootExpression = input.statements.get("root");
  if (!rootExpression) return undefined;
  const nodes = new Map<string, NodePlan>();
  const active = new Set<string>();
  const root = resolveNode(rootExpression, "root", input, nodes, active, true);
  if (!root) return undefined;
  return deepFreeze({
    rootLocalId: root.localId,
    nodes: [...nodes.values()],
  });
}

function resolveNode(
  expression: OpenGenerativeLanguageExpression,
  identity: string,
  input: Readonly<{
    statements: ReadonlyMap<string, OpenGenerativeLanguageExpression>;
    catalog: CompilerCatalogLike;
    compiled: CompiledOpenGenerativeLanguage;
    resources: ReadonlyMap<string, ResourceBindingId>;
  }>,
  output: Map<string, NodePlan>,
  active: Set<string>,
  required: boolean,
): NodePlan | undefined {
  if (expression.kind === "reference") {
    const target = input.statements.get(expression.name);
    if (!target) return required ? undefined : undefined;
    if (active.has(expression.name)) throw new TypeError(`OGL component cycle includes ${expression.name}.`);
    active.add(expression.name);
    const resolved = resolveNode(target, expression.name, input, output, active, required);
    active.delete(expression.name);
    return resolved;
  }
  if (expression.kind !== "call") {
    if (required) throw new TypeError(`OGL node ${identity} must be a component call.`);
    return undefined;
  }
  const localId = languageNodeLocalId(identity);
  const descriptor = resolveCall(expression, identity, input, output, active);
  if (!descriptor) return undefined;
  const node = deepFreeze({ localId, ...descriptor });
  output.set(localId, node);
  return node;
}

function resolveCall(
  call: Extract<OpenGenerativeLanguageExpression, { kind: "call" }>,
  identity: string,
  input: Readonly<{
    statements: ReadonlyMap<string, OpenGenerativeLanguageExpression>;
    catalog: CompilerCatalogLike;
    compiled: CompiledOpenGenerativeLanguage;
    resources: ReadonlyMap<string, ResourceBindingId>;
  }>,
  output: Map<string, NodePlan>,
  active: Set<string>,
): Omit<NodePlan, "localId"> | undefined {
  const component = (type: string) => {
    const match = input.compiled.components.find((candidate) => candidate.type === type);
    if (!match) throw new TypeError(`Component type ${type} is outside the frozen Catalog Slice.`);
    return match.sliceComponentId;
  };
  const value = (expression: OpenGenerativeLanguageExpression) => (
    languageValueToAuthoringValue(expression, input.resources)
  );
  const child = (
    expression: OpenGenerativeLanguageExpression,
    slotIdentity: string,
    required: boolean,
  ) => resolveNode(expression, slotIdentity, input, output, active, required);
  const children = (
    expression: OpenGenerativeLanguageExpression,
    slotIdentity: string,
  ): ProposalLocalId<"node">[] => {
    if (expression.kind !== "array") throw new TypeError(`${call.callee} children must be an array.`);
    return expression.items.flatMap((entry, index) => {
      const resolved = child(entry, `${slotIdentity}.${index + 1}`, false);
      return resolved ? [resolved.localId] : [];
    });
  };

  switch (call.callee) {
    case "Report": {
      expectArity(call, 3);
      const body = child(call.arguments[2]!, `${identity}.body`, true);
      if (!body) return undefined;
      return {
        component: component("analysis.report"),
        props: compactProps({
          title: value(call.arguments[0]!),
          description: nullableOptional(value(call.arguments[1]!)),
        }),
        slots: { body: [body.localId] },
      };
    }
    case "Stack": {
      expectArity(call, 2);
      return {
        component: component("layout.stack"),
        props: { gap: value(call.arguments[0]!) },
        slots: { body: children(call.arguments[1]!, `${identity}.body`) },
      };
    }
    case "Grid": {
      expectArity(call, 3);
      return {
        component: component("layout.grid"),
        props: {
          columns: value(call.arguments[0]!),
          gap: value(call.arguments[1]!),
        },
        slots: { body: children(call.arguments[2]!, `${identity}.body`) },
      };
    }
    case "Metric": {
      expectArity(call, 4);
      assertResource(call.arguments[1]!, input.resources);
      return {
        component: component("data.metric"),
        props: {
          label: value(call.arguments[0]!),
          data: value(call.arguments[1]!),
          valueColumn: value(call.arguments[2]!),
          format: value(call.arguments[3]!),
        },
        slots: {},
      };
    }
    case "Chart": {
      expectArity(call, 2);
      const resource = assertResource(call.arguments[0]!, input.resources);
      const metadata = input.compiled.resources.find((candidate) => candidate.alias === resource.alias)!;
      const spec = withChartDefaults(call.arguments[1]!, call.arguments[0]!, metadata);
      return {
        component: component("data.chart"),
        props: { spec: value(spec) },
        slots: {},
      };
    }
    case "Insight": {
      expectArity(call, 3);
      return {
        component: component("analysis.insight"),
        props: {
          title: value(call.arguments[0]!),
          body: value(call.arguments[1]!),
          tone: value(call.arguments[2]!),
        },
        slots: {},
      };
    }
    case "Component": {
      expectArity(call, 3);
      const type = literalString(call.arguments[0]!, "Component type");
      if (call.arguments[1]!.kind !== "object" || call.arguments[2]!.kind !== "object") {
        throw new TypeError("Component props and slots must be objects.");
      }
      const slotOutput: Record<string, readonly ProposalLocalId<"node">[]> = {};
      for (const [slot, slotValue] of Object.entries(call.arguments[2]!.properties)) {
        slotOutput[slot] = children(slotValue, `${identity}.${slot}`);
      }
      return {
        component: component(type),
        props: Object.fromEntries(Object.entries(call.arguments[1]!.properties).map(([key, entry]) => [key, value(entry)])),
        slots: slotOutput,
      };
    }
    default:
      throw new TypeError(`Unknown OGL component call ${call.callee}.`);
  }
}

function withChartDefaults(
  input: OpenGenerativeLanguageExpression,
  resource: OpenGenerativeLanguageExpression,
  metadata: CompiledOpenGenerativeLanguage["resources"][number],
): OpenGenerativeLanguageExpression {
  if (input.kind !== "object") throw new TypeError("Chart spec must be an object.");
  const properties: Record<string, OpenGenerativeLanguageExpression> = {
    ...input.properties,
    data: resource,
  };
  const title = typeof literalValue(properties.title) === "string"
    ? properties.title!
    : literal(metadata.label);
  properties.title ??= title;
  properties.equivalentView ??= literal("table");
  properties.accessibility ??= object({ label: title });
  const recipe = literalValue(properties.recipe);
  const numeric = metadata.columns.filter((column) => column.type === "number");
  const temporal = metadata.columns.filter((column) => column.type === "string" && /date|time/iu.test(column.label));
  const categorical = metadata.columns.filter((column) => !numeric.includes(column));
  const firstNumeric = numeric[0]?.id;
  const secondNumeric = numeric[1]?.id ?? firstNumeric;
  const firstCategory = categorical[0]?.id;
  const firstTemporal = temporal[0]?.id ?? firstCategory;
  const metric = (column: string | undefined, aggregate: string): OpenGenerativeLanguageExpression | undefined => (
    column === undefined ? undefined : object({ column: literal(column), aggregate: literal(aggregate) })
  );
  const set = (key: string, expression: OpenGenerativeLanguageExpression | undefined) => {
    if (properties[key] === undefined && expression !== undefined) properties[key] = expression;
  };
  if (typeof recipe === "string") {
    const valueColumn = literalStringOrUndefined(properties.valueColumn)
      ?? literalStringOrUndefined(properties.revenueColumn)
      ?? literalStringOrUndefined(properties.earnedColumn)
      ?? literalStringOrUndefined(properties.sessionsColumn)
      ?? firstNumeric;
    const summary = () => set("summary", metric(valueColumn, "sum"));
    const change = () => set("change", metric(valueColumn, "last"));
    const period = () => set("periodLabel", literal(metadata.label));
    switch (recipe) {
      case "steps-bars":
        set("unitLabel", literal("Value"));
        set("locale", literal("en-US"));
        break;
      case "pipeline-stage-bars":
      case "revenue-per-account-scatter":
      case "visitors-radial":
      case "visitors-radar":
      case "active-users-heatmap":
      case "visitors-stacked-area":
        summary();
        change();
        period();
        break;
      case "tracked-time-sankey":
        summary();
        period();
        set("unitLabel", literal("Value"));
        break;
      case "sleep-score":
        set("score", metric(literalStringOrUndefined(properties.scoreColumn) ?? valueColumn, "average"));
        set("locale", literal("en-US"));
        break;
      case "activity-calendar":
        summary();
        break;
      case "revenue-smooth-area":
        set("timeColumn", firstTemporal === undefined ? undefined : literal(firstTemporal));
        set("revenueColumn", firstNumeric === undefined ? undefined : literal(firstNumeric));
        summary();
        change();
        break;
      case "sign-up-funnel":
        summary();
        change();
        set("conversion", metric(literalStringOrUndefined(properties.conversionColumn) ?? secondNumeric, "average"));
        period();
        break;
      case "earned-so-far-bars":
        summary();
        change();
        break;
      case "contributions-heatmap":
        summary();
        change();
        if (properties.highlights === undefined && valueColumn !== undefined) {
          properties.highlights = {
            kind: "array",
            items: ["sum", "average", "maximum", "count"].map((aggregate) => metric(valueColumn, aggregate)!),
          };
        }
        break;
      case "sessions-conversion-combo":
        set("sessionsSummary", metric(literalStringOrUndefined(properties.sessionsColumn) ?? valueColumn, "sum"));
        set("conversionSummary", metric(literalStringOrUndefined(properties.conversionColumn) ?? secondNumeric, "average"));
        change();
        period();
        break;
      case "devices-bars":
        set("deviceColumn", firstCategory === undefined ? undefined : literal(firstCategory));
        set("valueColumn", firstNumeric === undefined ? undefined : literal(firstNumeric));
        summary();
        break;
      case "activity-rings":
        break;
    }
  }
  return { kind: "object", properties };
}

function expectArity(
  call: Extract<OpenGenerativeLanguageExpression, { kind: "call" }>,
  expected: number,
): void {
  if (call.arguments.length !== expected) {
    throw new TypeError(`${call.callee} expects exactly ${expected} arguments.`);
  }
}

function assertResource(
  expression: OpenGenerativeLanguageExpression,
  resources: ReadonlyMap<string, ResourceBindingId>,
): Extract<OpenGenerativeLanguageExpression, { kind: "resource" }> {
  if (expression.kind !== "resource") throw new TypeError("Expected a governed @resource alias.");
  if (!resources.has(expression.alias)) throw new TypeError(`Unknown governed resource @${expression.alias}.`);
  return expression;
}

function literal(value: string | number | boolean | null): OpenGenerativeLanguageExpression {
  return { kind: "literal", value };
}

function object(
  properties: Readonly<Record<string, OpenGenerativeLanguageExpression>>,
): OpenGenerativeLanguageExpression {
  return { kind: "object", properties };
}

function literalValue(expression: OpenGenerativeLanguageExpression | undefined): unknown {
  return expression?.kind === "literal" ? expression.value : undefined;
}

function literalStringOrUndefined(expression: OpenGenerativeLanguageExpression | undefined): string | undefined {
  const value = literalValue(expression);
  return typeof value === "string" ? value : undefined;
}

function literalString(expression: OpenGenerativeLanguageExpression, label: string): string {
  const value = literalValue(expression);
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}

function nullableOptional(value: AuthoringValue): AuthoringValue | undefined {
  return value === null ? undefined : value;
}

function compactProps(
  input: Readonly<Record<string, AuthoringValue | undefined>>,
): Readonly<Record<string, AuthoringValue>> {
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, AuthoringValue] => (
    entry[1] !== undefined
  )));
}
