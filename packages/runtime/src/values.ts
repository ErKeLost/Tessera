import {
  DEFAULT_PROTOCOL_LIMITS,
  canonicalNodeSchema,
  canonicalStringify,
  createDiagnostic,
  valueExprSchema,
  type CanonicalNode,
  type Diagnostic,
  type EventPort,
  type JsonValue,
  type PathSegment,
  type ResourceBindingId,
  type StateId,
  type ValueExpr,
} from "@open-generative/protocol";
import { cloneCanonical, exhaustive } from "./utils";

export type ValueMaterializationContext = {
  state?: Readonly<Record<StateId, JsonValue>>;
  resources?: Readonly<Record<ResourceBindingId, JsonValue>>;
  event?: { port: EventPort; payload: JsonValue };
  context?: { locale?: string; timezone?: string };
};

export type ValueMaterializationOptions = {
  maxDepth?: number;
  maxValues?: number;
};

export type ValueMaterializationResult<T extends JsonValue = JsonValue> =
  | { ok: true; value: T }
  | { ok: false; diagnostic: Diagnostic };

export type ValueExprDependencies = {
  stateIds: readonly StateId[];
  resourceBindingIds: readonly ResourceBindingId[];
  eventPorts: readonly EventPort[];
  contextKeys: ReadonlyArray<"locale" | "timezone">;
};

type MaterializationBudget = {
  values: number;
  maxDepth: number;
  maxValues: number;
};

export function materializeValueExpr(
  input: ValueExpr,
  context: ValueMaterializationContext,
  options: ValueMaterializationOptions = {},
): ValueMaterializationResult {
  const parsed = valueExprSchema.safeParse(input);
  if (!parsed.success) {
    return failure("value.expression-invalid", parsed.error.message);
  }
  return materializeParsed(parsed.data, context, {
    values: 0,
    maxDepth: options.maxDepth ?? DEFAULT_PROTOCOL_LIMITS.maxDepth,
    maxValues: options.maxValues ?? DEFAULT_PROTOCOL_LIMITS.maxTotalValues,
  }, 0);
}

export function materializeValueMap(
  expressions: Readonly<Record<string, ValueExpr>>,
  context: ValueMaterializationContext,
  options: ValueMaterializationOptions = {},
): ValueMaterializationResult<Record<string, JsonValue>> {
  const output: Record<string, JsonValue> = {};
  const budget: MaterializationBudget = {
    values: 0,
    maxDepth: options.maxDepth ?? DEFAULT_PROTOCOL_LIMITS.maxDepth,
    maxValues: options.maxValues ?? DEFAULT_PROTOCOL_LIMITS.maxTotalValues,
  };
  for (const [key, expression] of Object.entries(expressions)) {
    const parsed = valueExprSchema.safeParse(expression);
    if (!parsed.success) return failure("value.expression-invalid", parsed.error.message);
    const result = materializeParsed(parsed.data, context, budget, 0);
    if (!result.ok) return result;
    output[key] = result.value;
  }
  return { ok: true, value: output };
}

export function materializeNodeProps(
  nodeInput: CanonicalNode,
  context: ValueMaterializationContext,
  options: ValueMaterializationOptions = {},
): ValueMaterializationResult<Record<string, JsonValue>> {
  const node = canonicalNodeSchema.safeParse(nodeInput);
  if (!node.success) return failure("value.node-invalid", node.error.message);
  return materializeValueMap(node.data.props, scopeValueMaterializationContext(
    collectValueExprDependencies(node.data.props),
    context,
  ), options);
}

export function collectValueExprDependencies(
  input: ValueExpr | Readonly<Record<string, ValueExpr>>,
): ValueExprDependencies {
  const states = new Set<StateId>();
  const resources = new Set<ResourceBindingId>();
  const events = new Set<EventPort>();
  const context = new Set<"locale" | "timezone">();
  const visit = (expression: ValueExpr): void => {
    if (expression.kind === "state-ref" || expression.kind === "state-id-ref") states.add(expression.stateId);
    else if (expression.kind === "resource-ref" || expression.kind === "resource-id-ref") resources.add(expression.bindingId);
    else if (expression.kind === "event-ref") events.add(expression.port);
    else if (expression.kind === "context-ref") context.add(expression.key);
    else if (expression.kind === "array") expression.items.forEach(visit);
    else if (expression.kind === "object") Object.values(expression.entries).forEach(visit);
    else if (expression.kind === "condition") expression.args.forEach(visit);
  };
  if (typeof input.kind === "string") visit(valueExprSchema.parse(input));
  else for (const expression of Object.values(input)) visit(valueExprSchema.parse(expression));
  return {
    stateIds: Object.freeze([...states].sort()),
    resourceBindingIds: Object.freeze([...resources].sort()),
    eventPorts: Object.freeze([...events].sort()),
    contextKeys: Object.freeze([...context].sort()),
  };
}

export function scopeValueMaterializationContext(
  dependencies: ValueExprDependencies,
  source: ValueMaterializationContext,
): ValueMaterializationContext {
  const state = {} as Record<StateId, JsonValue>;
  for (const stateId of dependencies.stateIds) {
    if (source.state && Object.prototype.hasOwnProperty.call(source.state, stateId)) {
      state[stateId] = cloneCanonical(source.state[stateId]!);
    }
  }
  const resources = {} as Record<ResourceBindingId, JsonValue>;
  for (const bindingId of dependencies.resourceBindingIds) {
    if (source.resources && Object.prototype.hasOwnProperty.call(source.resources, bindingId)) {
      resources[bindingId] = cloneCanonical(source.resources[bindingId]!);
    }
  }
  const scoped: ValueMaterializationContext = { state, resources };
  if (source.event && dependencies.eventPorts.includes(source.event.port)) {
    scoped.event = { port: source.event.port, payload: cloneCanonical(source.event.payload) };
  }
  if (source.context) {
    const scopedContext: { locale?: string; timezone?: string } = {};
    if (dependencies.contextKeys.includes("locale") && source.context.locale !== undefined) {
      scopedContext.locale = source.context.locale;
    }
    if (dependencies.contextKeys.includes("timezone") && source.context.timezone !== undefined) {
      scopedContext.timezone = source.context.timezone;
    }
    if (Object.keys(scopedContext).length > 0) scoped.context = scopedContext;
  }
  return scoped;
}

export function evaluateValueExprCondition(
  expression: ValueExpr,
  context: ValueMaterializationContext,
  options: ValueMaterializationOptions = {},
): ValueMaterializationResult<boolean> {
  const result = materializeValueExpr(expression, context, options);
  if (!result.ok) return result;
  return typeof result.value === "boolean"
    ? { ok: true, value: result.value }
    : failure("condition.non-boolean-result", "Condition expression did not resolve to a boolean.");
}

function materializeParsed(
  expression: ValueExpr,
  context: ValueMaterializationContext,
  budget: MaterializationBudget,
  depth: number,
): ValueMaterializationResult {
  budget.values += 1;
  if (budget.values > budget.maxValues) {
    return failure("value.total-limit", `Value expression exceeds ${budget.maxValues} materialized values.`);
  }
  if (depth > budget.maxDepth) {
    return failure("value.depth-limit", `Value expression exceeds depth ${budget.maxDepth}.`);
  }

  switch (expression.kind) {
    case "literal":
      return { ok: true, value: expression.value };
    case "array": {
      const output: JsonValue[] = [];
      for (const item of expression.items) {
        const result = materializeParsed(item, context, budget, depth + 1);
        if (!result.ok) return result;
        output.push(result.value);
      }
      return { ok: true, value: output };
    }
    case "object": {
      const output: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(expression.entries)) {
        const result = materializeParsed(item, context, budget, depth + 1);
        if (!result.ok) return result;
        output[key] = result.value;
      }
      return { ok: true, value: output };
    }
    case "state-ref":
      return materializeReference("state", expression.stateId, expression.path, context.state);
    case "state-id-ref":
      return { ok: true, value: expression.stateId };
    case "resource-ref":
      return materializeReference("resource", expression.bindingId, expression.path, context.resources);
    case "resource-id-ref":
      return { ok: true, value: expression.bindingId };
    case "event-ref": {
      if (!context.event || context.event.port !== expression.port) {
        return failure("value.event-unavailable", `Event port ${expression.port} is unavailable.`);
      }
      return materializePath(context.event.payload, expression.path, `event:${expression.port}`);
    }
    case "context-ref": {
      const value = context.context?.[expression.key];
      return value === undefined
        ? failure("value.context-unavailable", `Context ${expression.key} is unavailable.`)
        : { ok: true, value };
    }
    case "condition":
      return materializeCondition(expression.op, expression.args, context, budget, depth);
    default:
      return exhaustive(expression);
  }
}

function materializeReference(
  kind: "state" | "resource",
  id: string,
  path: PathSegment[] | undefined,
  source: Readonly<Record<string, JsonValue>> | undefined,
): ValueMaterializationResult {
  if (!source || !Object.prototype.hasOwnProperty.call(source, id)) {
    return failure(`value.${kind}-unavailable`, `${kind} ${id} is unavailable.`);
  }
  return materializePath(source[id]!, path, `${kind}:${id}`);
}

function materializePath(
  root: JsonValue,
  path: readonly PathSegment[] | undefined,
  label: string,
): ValueMaterializationResult {
  let current = root;
  for (const segment of path ?? []) {
    if (typeof segment === "number") {
      if (
        !Array.isArray(current)
        || segment >= current.length
        || !Object.prototype.hasOwnProperty.call(current, segment)
      ) {
        return failure("value.path-unavailable", `Path on ${label} is unavailable.`);
      }
      current = current[segment]!;
      continue;
    }
    if (
      current === null
      || Array.isArray(current)
      || typeof current !== "object"
      || !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return failure("value.path-unavailable", `Path on ${label} is unavailable.`);
    }
    current = current[segment]!;
  }
  return { ok: true, value: cloneCanonical(current) };
}

function materializeCondition(
  operator: Extract<ValueExpr, { kind: "condition" }>["op"],
  expressions: readonly ValueExpr[],
  context: ValueMaterializationContext,
  budget: MaterializationBudget,
  depth: number,
): ValueMaterializationResult {
  const values: JsonValue[] = [];
  for (const expression of expressions) {
    const result = materializeParsed(expression, context, budget, depth + 1);
    if (!result.ok) return result;
    values.push(result.value);
  }

  if (operator === "eq" || operator === "neq") {
    if (values.length !== 2) return invalidArity(operator, "exactly two operands");
    const equal = canonicalStringify(values[0]) === canonicalStringify(values[1]);
    return { ok: true, value: operator === "eq" ? equal : !equal };
  }
  if (operator === "not") {
    if (values.length !== 1) return invalidArity(operator, "exactly one operand");
    if (typeof values[0] !== "boolean") return invalidOperands(operator, "one boolean operand");
    return { ok: true, value: !values[0] };
  }
  if (operator === "and" || operator === "or") {
    if (values.length < 2) return invalidArity(operator, "at least two operands");
    if (values.some((value) => typeof value !== "boolean")) {
      return invalidOperands(operator, "boolean operands only");
    }
    return {
      ok: true,
      value: operator === "and"
        ? values.every((value) => value === true)
        : values.some((value) => value === true),
    };
  }
  if (values.length !== 2) return invalidArity(operator, "exactly two operands");
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    return invalidOperands(operator, "two finite number operands");
  }
  const left = values[0] as number;
  const right = values[1] as number;
  if (operator === "lt") return { ok: true, value: left < right };
  if (operator === "lte") return { ok: true, value: left <= right };
  if (operator === "gt") return { ok: true, value: left > right };
  return { ok: true, value: left >= right };
}

function invalidArity(operator: string, expected: string): ValueMaterializationResult {
  return failure("condition.invalid-arity", `${operator} requires ${expected}.`);
}

function invalidOperands(operator: string, expected: string): ValueMaterializationResult {
  return failure("condition.invalid-operands", `${operator} requires ${expected}; values are never coerced.`);
}

function failure<T extends JsonValue = JsonValue>(
  code: string,
  message: string,
): ValueMaterializationResult<T> {
  return {
    ok: false,
    diagnostic: createDiagnostic({
      phase: "validate",
      code,
      severity: "error",
      recoverable: true,
      modelCorrectable: false,
      message,
    }),
  };
}
