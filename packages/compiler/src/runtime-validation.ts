import {
  canonicalStringify,
  type CanonicalNode,
  type DocumentContent,
  type JSONSchema,
  type JsonValue,
  type NodeId,
  type ResourceSelector,
  type ValueExpr,
} from "@open-generative/protocol";
import {
  actionContractRefKey,
  contractRefKey,
  type BindingPolicy,
  type ComponentContract,
} from "@open-generative/catalog";
import type {
  RuntimeValidationIssue,
  RuntimeValidationPort,
} from "@open-generative/runtime";
import { schemaIssueSummary, validateJsonSchema } from "./schema";
import type { CompilerAuthority, CompilerCatalogLike } from "./types";

type Issue = RuntimeValidationIssue;

export function createCatalogRuntimeValidationPort(
  catalog: CompilerCatalogLike,
  authority: CompilerAuthority,
): RuntimeValidationPort {
  return new CatalogRuntimeValidationPort(catalog, authority);
}

class CatalogRuntimeValidationPort implements RuntimeValidationPort {
  readonly #catalog: CompilerCatalogLike;
  readonly #authority: CompilerAuthority;

  constructor(catalog: CompilerCatalogLike, authority: CompilerAuthority) {
    this.#catalog = catalog;
    this.#authority = authority;
  }

  validateNode(input: {
    nodeId: NodeId;
    node: CanonicalNode;
    document: DocumentContent;
    phase: "preview" | "commit";
  }): readonly Issue[] {
    const contract = this.#catalog.componentByRef(input.node.contract);
    if (!contract) {
      return [issue("catalog.component-not-in-slice", "Node Contract is not present in the frozen CatalogSetSlice.", input.nodeId)];
    }
    return [
      ...validateNodeProps(contract, input.node, input.document, input.nodeId),
      ...validateNodeSlots(contract, input.node, input.document, input.nodeId),
      ...validateNodeEvents(this.#catalog, contract, input.node, input.document, input.nodeId),
    ];
  }

  validateDocument(input: {
    document: DocumentContent;
    phase: "commit";
  }): readonly Issue[] {
    const { document } = input;
    const issues: Issue[] = [];
    if (
      document.contracts.contractSetHash !== this.#catalog.slice.contractSetHash
      || canonicalStringify(document.contracts.manifestRefs) !== canonicalStringify(this.#catalog.slice.manifests)
    ) {
      issues.push(issue("catalog.document-lock-mismatch", "Document Contract lock does not match the frozen CatalogSetSlice."));
    }
    issues.push(...validateLimits(document, this.#catalog.slice.limits));
    issues.push(...validateActions(this.#catalog, document));
    issues.push(...validateResources(this.#catalog, this.#authority, document));
    issues.push(...validateCapabilities(this.#catalog, document));
    return issues;
  }

  commitPolicy(contract: CanonicalNode["contract"]): "progressive" | "atomic" {
    return this.#catalog.componentByRef(contract)?.commitPolicy ?? "atomic";
  }

  isNodeReady(input: {
    nodeId: NodeId;
    node: CanonicalNode;
    document: DocumentContent;
  }): boolean {
    const contract = this.#catalog.componentByRef(input.node.contract);
    if (!contract) return false;
    const readiness = contract.readiness;
    if (readiness.requiredBindings.length === 0) return true;
    const ready = readiness.requiredBindings.map((pointer) => {
      const expression = expressionAtPointer(input.node.props, pointer);
      return expression !== undefined && expressionDependenciesExist(expression, input.document);
    });
    return readiness.strategy === "all-required" ? ready.every(Boolean) : ready.some(Boolean);
  }
}

function validateNodeProps(
  contract: ComponentContract,
  node: CanonicalNode,
  document: DocumentContent,
  nodeId: NodeId,
): Issue[] {
  const issues: Issue[] = [];
  validateObjectShape(contract.resolvedPropsSchema, Object.keys(node.props), "", nodeId, issues);
  for (const [key, expression] of Object.entries(node.props)) {
    validatePropExpression(contract, document, expression, `/${escapePointer(key)}`, nodeId, issues);
  }
  return issues;
}

function validatePropExpression(
  contract: ComponentContract,
  document: DocumentContent,
  expression: ValueExpr,
  pointer: string,
  nodeId: NodeId,
  issues: Issue[],
): void {
  const policy = (contract.authoringBindings as Record<string, BindingPolicy>)[pointer];
  if (policy) {
    validateBindingExpression(policy, expression, document, pointer, nodeId, issues);
    return;
  }
  if (hasBindingBelow(contract, pointer)) {
    const schema = schemaAtPointer(contract.resolvedPropsSchema, pointer);
    if (expression.kind === "object") {
      validateObjectShape(schema, Object.keys(expression.entries), pointer, nodeId, issues);
      for (const [key, child] of Object.entries(expression.entries)) {
        validatePropExpression(contract, document, child, `${pointer}/${escapePointer(key)}`, nodeId, issues);
      }
      return;
    }
    if (expression.kind === "array") {
      validateArrayShape(schema, expression.items.length, pointer, nodeId, issues);
      expression.items.forEach((child, index) => {
        validatePropExpression(contract, document, child, `${pointer}/${index}`, nodeId, issues);
      });
      return;
    }
    issues.push(issue("component.binding-container-invalid", `Binding ${pointer} must be nested in a canonical object or array expression.`, nodeId));
    return;
  }

  const literal = literalExpressionValue(expression);
  if (!literal.ok) {
    issues.push(issue("component.binding-source-forbidden", `Dynamic expression at ${pointer} is not declared by the Component Contract.`, nodeId));
    return;
  }
  const schema = schemaAtPointer(contract.resolvedPropsSchema, pointer);
  if (schema === undefined) {
    issues.push(issue("component.prop-unknown", `Prop ${pointer} is not declared by the exact Component Contract.`, nodeId));
    return;
  }
  const parsed = validateJsonSchema(schema, literal.value);
  if (!parsed.success) {
    issues.push(issue("component.literal-invalid", `${pointer}: ${schemaIssueSummary(parsed)}`, nodeId));
  }
}

function validateBindingExpression(
  policy: BindingPolicy,
  expression: ValueExpr,
  document: DocumentContent,
  pointer: string,
  nodeId: NodeId,
  issues: Issue[],
): void {
  const canonical = validateJsonSchema(policy.canonicalExprSchema, expression);
  if (!canonical.success) {
    issues.push(issue("component.binding-expression-invalid", `${pointer}: ${schemaIssueSummary(canonical)}`, nodeId));
    return;
  }
  const sources = expressionSources(expression);
  for (const source of sources) {
    if (source === "event" || !policy.allowedSources.includes(source)) {
      issues.push(issue("component.binding-source-forbidden", `Binding ${pointer} does not allow ${source} expressions.`, nodeId));
    }
  }
  visitExpressions(expression, (candidate) => {
    if (candidate.kind === "state-ref" || candidate.kind === "state-id-ref") {
      const definition = document.stateDefinitions[candidate.stateId];
      if (!definition) {
        issues.push(issue("component.binding-state-missing", `Binding ${pointer} references missing state ${candidate.stateId}.`, nodeId));
      } else if (!policy.state || !policy.state.readableScopes.includes(definition.scope)) {
        issues.push(issue("component.binding-state-scope", `Binding ${pointer} cannot read state scope ${definition.scope}.`, nodeId));
      }
    }
    if (candidate.kind === "resource-ref" || candidate.kind === "resource-id-ref") {
      const declaration = document.resourceBindings[candidate.bindingId];
      if (!declaration) {
        issues.push(issue("component.binding-resource-missing", `Binding ${pointer} references missing resource ${candidate.bindingId}.`, nodeId));
      } else if (!policy.resource) {
        issues.push(issue("component.binding-resource-forbidden", `Binding ${pointer} has no resource policy.`, nodeId));
      } else {
        if (!policy.resource.kinds.includes(declaration.kind)) {
          issues.push(issue("component.binding-resource-kind", `Resource ${candidate.bindingId} has a kind forbidden by ${pointer}.`, nodeId));
        }
        if (!policy.resource.schemaConstraints.some((constraint) => constraint.schemaHash === declaration.schemaConstraint.schemaHash)) {
          issues.push(issue("component.binding-resource-schema", `Resource ${candidate.bindingId} has a schema outside ${pointer}.`, nodeId));
        }
        validateSelector(policy, declaration.selector, pointer, nodeId, issues);
      }
    }
  });
}

function validateSelector(
  policy: BindingPolicy,
  selector: ResourceSelector,
  pointer: string,
  nodeId: NodeId,
  issues: Issue[],
): void {
  const allowed = policy.resource?.selector;
  if (!allowed) return;
  if ((!allowed.allowProjection && selector.projection !== undefined)
    || (selector.projection?.length ?? 0) > allowed.maxProjectedColumns) {
    issues.push(issue("component.resource-projection-denied", `Resource selector exceeds projection policy for ${pointer}.`, nodeId));
  }
  if (!allowed.allowFilterState && selector.filterStateRef !== undefined) {
    issues.push(issue("component.resource-filter-denied", `Resource selector exceeds filter policy for ${pointer}.`, nodeId));
  }
  if ((!allowed.allowSort && selector.sort !== undefined) || (selector.sort?.length ?? 0) > allowed.maxSortKeys) {
    issues.push(issue("component.resource-sort-denied", `Resource selector exceeds sort policy for ${pointer}.`, nodeId));
  }
  if ((selector.windowLimit ?? 0) > allowed.maxWindowItems) {
    issues.push(issue("component.resource-window-denied", `Resource selector exceeds window policy for ${pointer}.`, nodeId));
  }
}

function validateNodeSlots(
  contract: ComponentContract,
  node: CanonicalNode,
  document: DocumentContent,
  nodeId: NodeId,
): Issue[] {
  const issues: Issue[] = [];
  for (const name of Object.keys(node.slots)) {
    if (!contract.slots[name]) issues.push(issue("component.slot-unknown", `Slot ${name} is not declared by the exact Component Contract.`, nodeId));
  }
  for (const [name, slot] of Object.entries(contract.slots)) {
    const children = node.slots[name] ?? [];
    if (children.length < slot.min || children.length > slot.max) {
      issues.push(issue("component.slot-cardinality", `Slot ${name} violates its frozen cardinality.`, nodeId));
    }
    const accepted = new Set(slot.accepts.map((selector) => contractRefKey(selector.contract)));
    for (const childId of children) {
      const child = document.nodes[childId];
      if (!child || !accepted.has(contractRefKey(child.contract))) {
        issues.push(issue("component.slot-contract-mismatch", `Slot ${name} contains a child outside its accepted Contracts.`, nodeId));
      }
    }
  }
  return issues;
}

function validateNodeEvents(
  catalog: CompilerCatalogLike,
  contract: ComponentContract,
  node: CanonicalNode,
  document: DocumentContent,
  nodeId: NodeId,
): Issue[] {
  const issues: Issue[] = [];
  for (const [port, actionId] of Object.entries(node.events)) {
    const event = Object.entries(contract.events).find(([name]) => name === port)?.[1];
    if (!event) {
      issues.push(issue("component.event-unknown", `Event port ${port} is not declared by the exact Component Contract.`, nodeId));
      continue;
    }
    const action = document.actions[actionId];
    if (!action) continue;
    if (action.kind === "host-intent") {
      const allowed = new Set(event.actionContracts.map(actionContractRefKey));
      if (!allowed.has(actionContractRefKey(action.contract)) || !catalog.actionByRef(action.contract)) {
        issues.push(issue("component.event-action-mismatch", `Event port ${port} targets an unauthorized Action Contract.`, nodeId));
      }
    }
  }
  return issues;
}

function validateActions(catalog: CompilerCatalogLike, document: DocumentContent): Issue[] {
  const issues: Issue[] = [];
  for (const [actionId, action] of Object.entries(document.actions)) {
    if (action.kind === "host-intent") {
      const contract = catalog.actionByRef(action.contract);
      if (!contract) {
        issues.push(issue("catalog.action-not-in-slice", `Action ${actionId} is outside the frozen CatalogSetSlice.`));
        continue;
      }
      validateObjectShape(contract.normalizedInputSchema, Object.keys(action.input), `/actions/${actionId}/input`, undefined, issues);
      for (const [key, expression] of Object.entries(action.input)) {
        const literal = literalExpressionValue(expression);
        const schema = schemaAtPointer(contract.normalizedInputSchema, `/${escapePointer(key)}`);
        if (literal.ok && schema !== undefined) {
          const parsed = validateJsonSchema(schema, literal.value);
          if (!parsed.success) issues.push(issue("action.input-literal-invalid", `${actionId}/${key}: ${schemaIssueSummary(parsed)}`));
        }
        const sources = expressionSources(expression);
        for (const source of sources) {
          if ((source === "state" || source === "resource") && !contract.reads.some((read) => read.source === source)) {
            issues.push(issue("action.read-not-declared", `Action ${actionId} reads ${source} without a Contract declaration.`));
          }
        }
      }
    } else {
      for (const transition of action.transitions) {
        if (transition.type !== "state.set") continue;
        const definition = document.stateDefinitions[transition.stateId];
        const literal = literalExpressionValue(transition.value);
        if (definition && literal.ok) {
          const parsed = validateJsonSchema(definition.schema, literal.value);
          if (!parsed.success) issues.push(issue("action.state-value-invalid", `Action ${actionId}: ${schemaIssueSummary(parsed)}`));
        }
      }
    }
  }
  return issues;
}

function validateResources(
  catalog: CompilerCatalogLike,
  authority: CompilerAuthority,
  document: DocumentContent,
): Issue[] {
  const authorizedResources = catalog.slice.resources.flatMap((slice) => {
    const authorized = authority.resources.find((candidate) => (
      candidate.source.bindingId === slice.source.bindingId
      && candidate.source.offerHash === slice.source.offerHash
    ));
    return authorized === undefined ? [] : [{ slice, authorized }];
  });
  const issues: Issue[] = [];
  for (const [bindingId, declaration] of Object.entries(document.resourceBindings)) {
    const allowed = authorizedResources.some(({ slice, authorized }) => (
      slice.descriptor.kind === declaration.kind
      && resourceAuthorityMatches(declaration, authorized.declaration)
      && selectorAllowedBySlice(declaration.selector, slice)
    ));
    if (!allowed) {
      issues.push(issue("authority.resource-not-authorized", `Resource ${bindingId} does not match an authorized frozen offer.`));
    }
  }
  for (const [evidenceId, binding] of Object.entries(document.evidenceBindings)) {
    if (!authority.evidence.some((entry) => canonicalStringify(entry.binding) === canonicalStringify(binding))) {
      issues.push(issue("authority.evidence-not-authorized", `Evidence ${evidenceId} does not match an authorized frozen offer.`));
    }
  }
  return issues;
}

function resourceAuthorityMatches(
  declaration: DocumentContent["resourceBindings"][keyof DocumentContent["resourceBindings"]],
  authorized: DocumentContent["resourceBindings"][keyof DocumentContent["resourceBindings"]],
): boolean {
  if (
    declaration.resourceKey !== authorized.resourceKey
    || declaration.kind !== authorized.kind
    || canonicalStringify(declaration.schemaConstraint) !== canonicalStringify(authorized.schemaConstraint)
    || canonicalStringify(declaration.resolution) !== canonicalStringify(authorized.resolution)
  ) return false;
  const allowed = authorized.selector;
  if (allowed.projection !== undefined) {
    if (declaration.selector.projection === undefined) return false;
    const columns = new Set(allowed.projection);
    if (declaration.selector.projection.some((column) => !columns.has(column))) return false;
  }
  if (allowed.filterStateRef !== undefined && declaration.selector.filterStateRef !== allowed.filterStateRef) return false;
  if (allowed.windowLimit !== undefined && (declaration.selector.windowLimit ?? Number.POSITIVE_INFINITY) > allowed.windowLimit) return false;
  return true;
}

function selectorAllowedBySlice(
  selector: ResourceSelector,
  slice: CompilerCatalogLike["slice"]["resources"][number],
): boolean {
  const policy = slice.selectorPolicy;
  const columns = new Set(slice.descriptor.columns.map(({ columnId }) => String(columnId)));
  return !(
    (!policy.allowProjection && selector.projection !== undefined)
    || (selector.projection?.length ?? 0) > policy.maxProjectedColumns
    || selector.projection?.some((column) => !columns.has(column))
    || (!policy.allowFilterState && selector.filterStateRef !== undefined)
    || (!policy.allowSort && selector.sort !== undefined)
    || (selector.sort?.length ?? 0) > policy.maxSortKeys
    || selector.sort?.some(({ columnId }) => !columns.has(columnId))
    || (selector.windowLimit ?? 0) > policy.maxWindowItems
  );
}

function validateCapabilities(catalog: CompilerCatalogLike, document: DocumentContent): Issue[] {
  return document.requirements.capabilities
    .filter((ref) => !catalog.actionByRef(ref))
    .map(() => issue("catalog.capability-not-in-slice", "Document requires an Action Contract outside the frozen CatalogSetSlice."));
}

function validateLimits(document: DocumentContent, limits: CompilerCatalogLike["slice"]["limits"]): Issue[] {
  const issues: Issue[] = [];
  if (Object.keys(document.nodes).length > limits.maxNodes) issues.push(issue("limit.nodes", "Document exceeds the frozen node limit."));
  if (Object.keys(document.actions).length > limits.maxActions) issues.push(issue("limit.actions", "Document exceeds the frozen action limit."));
  if (Object.keys(document.resourceBindings).length > limits.maxResourceBindings) issues.push(issue("limit.resources", "Document exceeds the frozen resource limit."));
  if (Object.keys(document.evidenceBindings).length > limits.maxEvidenceBindings) issues.push(issue("limit.evidence", "Document exceeds the frozen evidence limit."));
  if (documentDepth(document, document.rootNodeId, new Set()) > limits.maxDepth) issues.push(issue("limit.depth", "Document exceeds the frozen depth limit."));
  if (textBytes(document) > limits.maxTextBytes) issues.push(issue("limit.text", "Document exceeds the frozen text byte limit."));
  return issues;
}

function validateObjectShape(
  schema: JSONSchema | undefined,
  keys: readonly string[],
  pointer: string,
  nodeId: NodeId | undefined,
  issues: Issue[],
): void {
  const object = dereferenceSchema(schema, schema);
  if (!object || typeof object !== "object" || Array.isArray(object)) return;
  const properties = record(object.properties);
  const required = Array.isArray(object.required) ? object.required.filter((value): value is string => typeof value === "string") : [];
  for (const key of required) {
    if (!keys.includes(key)) issues.push(issue("component.prop-required", `${pointer || "/props"} is missing required property ${key}.`, nodeId));
  }
  if (object.additionalProperties === false && properties) {
    for (const key of keys) {
      if (!(key in properties)) issues.push(issue("component.prop-unknown", `${pointer || "/props"} contains unknown property ${key}.`, nodeId));
    }
  }
}

function validateArrayShape(
  schema: JSONSchema | undefined,
  length: number,
  pointer: string,
  nodeId: NodeId,
  issues: Issue[],
): void {
  const object = dereferenceSchema(schema, schema);
  if (!object || typeof object !== "object" || Array.isArray(object)) return;
  if (typeof object.minItems === "number" && length < object.minItems) issues.push(issue("component.array-cardinality", `${pointer} has too few items.`, nodeId));
  if (typeof object.maxItems === "number" && length > object.maxItems) issues.push(issue("component.array-cardinality", `${pointer} has too many items.`, nodeId));
}

function schemaAtPointer(root: JSONSchema, pointer: string): JSONSchema | undefined {
  const segments = pointer === "" ? [] : pointer.slice(1).split("/").map(unescapePointer);
  return schemaAt(root, segments, root, 0);
}

function schemaAt(
  schema: JSONSchema | undefined,
  segments: readonly string[],
  root: JSONSchema,
  depth: number,
): JSONSchema | undefined {
  if (schema === undefined || depth > 64) return undefined;
  const resolved = dereferenceSchema(schema, root);
  if (segments.length === 0) return withRootDefinitions(resolved, root);
  if (resolved === true || resolved === false || !resolved || Array.isArray(resolved)) return undefined;
  const [head, ...tail] = segments;
  const branches = Array.isArray(resolved.oneOf) ? resolved.oneOf : Array.isArray(resolved.anyOf) ? resolved.anyOf : undefined;
  if (branches) {
    const candidates = branches
      .map((branch) => schemaAt(branch as JSONSchema, segments, root, depth + 1))
      .filter((candidate): candidate is JSONSchema => candidate !== undefined);
    return candidates.length === 0 ? undefined : withRootDefinitions({ anyOf: candidates } as JSONSchema, root);
  }
  if (Array.isArray(resolved.allOf)) {
    const candidates = resolved.allOf
      .map((branch) => schemaAt(branch as JSONSchema, segments, root, depth + 1))
      .filter((candidate): candidate is JSONSchema => candidate !== undefined);
    return candidates.length === 0 ? undefined : withRootDefinitions({ allOf: candidates } as JSONSchema, root);
  }
  const properties = record(resolved.properties);
  if (properties && head! in properties) return schemaAt(properties[head!] as JSONSchema, tail, root, depth + 1);
  if (/^(?:0|[1-9][0-9]*)$/.test(head!) && resolved.items !== undefined) {
    return schemaAt(resolved.items as JSONSchema, tail, root, depth + 1);
  }
  if (resolved.additionalProperties && typeof resolved.additionalProperties === "object") {
    return schemaAt(resolved.additionalProperties as JSONSchema, tail, root, depth + 1);
  }
  return undefined;
}

function dereferenceSchema(schema: JSONSchema | undefined, root: JSONSchema | undefined): JSONSchema | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || typeof schema.$ref !== "string") return schema;
  if (!schema.$ref.startsWith("#/")) return schema;
  let current: unknown = root;
  for (const segment of schema.$ref.slice(2).split("/").map(unescapePointer)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return schema;
    current = (current as Record<string, unknown>)[segment];
  }
  return current as JSONSchema;
}

function withRootDefinitions(schema: JSONSchema | undefined, root: JSONSchema): JSONSchema | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || typeof root !== "object" || Array.isArray(root)) return schema;
  return root.$defs === undefined || schema.$defs !== undefined ? schema : { ...schema, $defs: root.$defs } as JSONSchema;
}

function expressionAtPointer(props: CanonicalNode["props"], pointer: string): ValueExpr | undefined {
  const segments = pointer.slice(1).split("/").map(unescapePointer);
  let expression = props[segments.shift() ?? ""];
  for (const segment of segments) {
    if (!expression) return undefined;
    if (expression.kind === "object") expression = expression.entries[segment];
    else if (expression.kind === "array" && /^(?:0|[1-9][0-9]*)$/.test(segment)) expression = expression.items[Number(segment)];
    else return undefined;
  }
  return expression;
}

function hasBindingBelow(contract: ComponentContract, pointer: string): boolean {
  return Object.keys(contract.authoringBindings).some((candidate) => candidate.startsWith(`${pointer}/`));
}

function literalExpressionValue(expression: ValueExpr): { ok: true; value: JsonValue } | { ok: false } {
  if (expression.kind === "literal") return { ok: true, value: expression.value };
  if (expression.kind === "array") {
    const values: JsonValue[] = [];
    for (const item of expression.items) {
      const value = literalExpressionValue(item);
      if (!value.ok) return value;
      values.push(value.value);
    }
    return { ok: true, value: values };
  }
  if (expression.kind === "object") {
    const value: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(expression.entries)) {
      const nested = literalExpressionValue(item);
      if (!nested.ok) return nested;
      value[key] = nested.value;
    }
    return { ok: true, value };
  }
  return { ok: false };
}

function expressionSources(expression: ValueExpr): Set<"literal" | "state" | "resource" | "context" | "event"> {
  const sources = new Set<"literal" | "state" | "resource" | "context" | "event">();
  visitExpressions(expression, (candidate) => {
    if (candidate.kind === "literal") sources.add("literal");
    else if (candidate.kind === "state-ref" || candidate.kind === "state-id-ref") sources.add("state");
    else if (candidate.kind === "resource-ref" || candidate.kind === "resource-id-ref") sources.add("resource");
    else if (candidate.kind === "context-ref") sources.add("context");
    else if (candidate.kind === "event-ref") sources.add("event");
  });
  return sources;
}

function visitExpressions(expression: ValueExpr, visit: (expression: ValueExpr) => void): void {
  visit(expression);
  if (expression.kind === "array") expression.items.forEach((item) => visitExpressions(item, visit));
  else if (expression.kind === "object") Object.values(expression.entries).forEach((item) => visitExpressions(item, visit));
  else if (expression.kind === "condition") expression.args.forEach((item) => visitExpressions(item, visit));
}

function expressionDependenciesExist(expression: ValueExpr, document: DocumentContent): boolean {
  let ready = true;
  visitExpressions(expression, (candidate) => {
    if ((candidate.kind === "state-ref" || candidate.kind === "state-id-ref") && !document.stateDefinitions[candidate.stateId]) ready = false;
    if ((candidate.kind === "resource-ref" || candidate.kind === "resource-id-ref") && !document.resourceBindings[candidate.bindingId]) ready = false;
  });
  return ready;
}

function documentDepth(document: DocumentContent, nodeId: NodeId, active: Set<NodeId>): number {
  if (active.has(nodeId)) return Number.POSITIVE_INFINITY;
  const node = document.nodes[nodeId];
  if (!node) return 0;
  const next = new Set(active).add(nodeId);
  const children = Object.values(node.slots).flat();
  return 1 + Math.max(0, ...children.map((child) => documentDepth(document, child, next)));
}

function textBytes(document: DocumentContent): number {
  let bytes = 0;
  const encoder = new TextEncoder();
  const visit = (value: unknown): void => {
    if (typeof value === "string") bytes += encoder.encode(value).byteLength;
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(document.meta);
  for (const node of Object.values(document.nodes)) visit(node.props);
  return bytes;
}

function issue(code: string, message: string, nodeId?: NodeId): Issue {
  return nodeId === undefined ? { code, message } : { code, message, nodeId };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function unescapePointer(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}
