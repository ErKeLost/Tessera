import {
  HASH_DOMAINS,
  ProtocolError,
  actionDefinitionSchema,
  authoringSnapshotProposalSchema,
  canonicalNodeSchema,
  canonicalOperationEnvelopeSchema,
  canonicalStringify,
  claimBindingSchema,
  documentContentSchema,
  evidenceBindingSchema,
  hashCanonical,
  hashDocumentContent,
  proposalOperationEnvelopeSchema,
  resourceBindingDeclarationSchema,
  stateDefinitionSchema,
  toProposalEntityKey,
  valueExprSchema,
  type ActionDefinition,
  type AuthoringActionDefinition,
  type AuthoringEntityRef,
  type AuthoringOperationNodeBody,
  type AuthoringProposalOperation,
  type AuthoringResourceBinding,
  type AuthoringSnapshotNode,
  type AuthoringSnapshotProposal,
  type AuthoringValue,
  type CanonicalEntityOperation,
  type CanonicalEntityRef,
  type CanonicalNode,
  type ClaimBinding,
  type DocumentContent,
  type EntityRevisionId,
  type EvidenceBinding,
  type HashProvider,
  type JsonValue,
  type OperationId,
  type ProposalEntityKind,
  type ProposalOperationEnvelope,
  type ResourceBindingDeclaration,
  type Sha256Hash,
  type StateDefinition,
  type TransactionIdentityMap,
  type ValueExpr,
} from "@open-generative/protocol";
import {
  applyCanonicalOperationChecked,
  type EntityRevisionIndex,
} from "@open-generative/runtime";
import { cloneCanonical, compareCanonical, diagnostic, exhaustive, offerKey, refKey } from "./internal";
import {
  createActionAuthoringInputSchema,
  schemaIssueSummary,
  validateJsonSchema,
} from "./schema";
import type {
  CompilerCatalogLike,
  FlowClassification,
  IdentityAllocationBatch,
  IdentityAllocationRequest,
  NormalizedCompilerOperation,
  NormalizedCompilerProposal,
  ProposalNormalizerInput,
} from "./types";

const ENTITY_KINDS = ["node", "state", "action", "resource", "evidence", "claim"] as const;
const CLASSIFICATION_RANK: Record<FlowClassification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

export class ProposalNormalizer {
  readonly #input: ProposalNormalizerInput;
  readonly #baseDocument: DocumentContent;
  #document: DocumentContent;
  #entityRevisions: EntityRevisionIndex;
  #identityMap: TransactionIdentityMap = {};
  #nextSequence = 1;
  readonly #operationIds = new Set<OperationId>();
  readonly #createdLocalEntities = new Set<string>();
  readonly #classifications = new Map<string, FlowClassification>();

  constructor(input: ProposalNormalizerInput) {
    this.#input = input;
    this.#baseDocument = cloneCanonical(input.baseDocument);
    this.#document = cloneCanonical(input.baseDocument);
    this.#entityRevisions = cloneCanonical(input.baseEntityRevisions);
    this.#seedAuthorityClassifications();
  }

  get document(): DocumentContent {
    return cloneCanonical(this.#document);
  }

  get entityRevisions(): EntityRevisionIndex {
    return cloneCanonical(this.#entityRevisions);
  }

  get finalOperationSequence(): number {
    return this.#nextSequence - 1;
  }

  async normalizeOperation(input: ProposalOperationEnvelope): Promise<NormalizedCompilerOperation> {
    const proposalEnvelope = proposalOperationEnvelopeSchema.parse(input);
    const proposalPayloadHash = await hashCanonical(
      HASH_DOMAINS.operationPayload,
      proposalEnvelope.operation,
      this.#input.hashProvider,
    );
    if (proposalPayloadHash !== proposalEnvelope.payloadHash) {
      throw compilerError("authoring", "proposal-operation.payload-hash-mismatch", "Authoring operation payload hash is invalid.");
    }
    if (proposalEnvelope.sequence !== this.#nextSequence) {
      throw compilerError(
        "normalize",
        "proposal-operation.sequence-invalid",
        "Authoring operation sequences must be contiguous and start at one.",
        "/sequence",
        this.#nextSequence,
      );
    }
    if (this.#operationIds.has(proposalEnvelope.operationId)) {
      throw compilerError("normalize", "proposal-operation.id-conflict", "Operation ID is already used in this proposal.", "/operationId");
    }
    for (const dependency of proposalEnvelope.dependsOn) {
      if (!this.#operationIds.has(dependency)) {
        throw compilerError("normalize", "proposal-operation.dependency-unavailable", "An operation dependency has not been accepted.", "/dependsOn");
      }
    }

    const create = localCreateTarget(proposalEnvelope.operation);
    if (create) {
      const key = `${create.kind}:${create.localId}`;
      if (this.#createdLocalEntities.has(key)) {
        throw compilerError("normalize", "proposal-entity.duplicate-create", "A proposal-local entity can be created only once.", "/operation/target");
      }
      if (!this.#input.writeScope.creatable.includes(create.kind)) {
        throw compilerError("policy", "write-scope.create-denied", `Creating ${create.kind} entities is outside the frozen WriteScope.`, "/operation/target");
      }
    }

    const allocation = await this.#allocateIdentities(proposalEnvelope);
    const operation = await this.#canonicalizeOperation(proposalEnvelope.operation, allocation);
    const envelope = canonicalOperationEnvelopeSchema.parse({
      transactionId: this.#input.transactionId,
      operationId: proposalEnvelope.operationId,
      sequence: proposalEnvelope.sequence,
      dependsOn: proposalEnvelope.dependsOn,
      payloadHash: await hashCanonical(HASH_DOMAINS.operationPayload, operation, this.#input.hashProvider),
      operation,
    });
    const applied = await applyCanonicalOperationChecked(
      this.#document,
      this.#entityRevisions,
      operation,
      this.#input.hashProvider,
    );
    if (!applied.ok) {
      throw compilerError("normalize", applied.conflict.code, applied.conflict.message, "/operation");
    }

    this.#document = applied.content;
    this.#entityRevisions = applied.entityRevisions;
    this.#identityMap = allocation.identityMap;
    this.#operationIds.add(proposalEnvelope.operationId);
    if (create) this.#createdLocalEntities.add(`${create.kind}:${create.localId}`);
    this.#nextSequence += 1;
    this.#enforceGenerationLimits();
    return { envelope, identityMapDelta: allocation.identityMapDelta };
  }

  async normalizeOperations(
    operations: readonly ProposalOperationEnvelope[],
  ): Promise<NormalizedCompilerProposal> {
    const normalized: NormalizedCompilerOperation[] = [];
    for (const operation of operations) normalized.push(await this.normalizeOperation(operation));
    return this.finalize(normalized);
  }

  async normalizeSnapshot(input: AuthoringSnapshotProposal): Promise<NormalizedCompilerProposal> {
    if (this.#nextSequence !== 1) {
      throw compilerError("normalize", "snapshot.non-empty-transaction", "Snapshot normalization requires an empty compiler transaction.");
    }
    const snapshot = authoringSnapshotProposalSchema.parse(input);
    const authoringOperations = flattenSnapshot(snapshot);
    const normalized: NormalizedCompilerOperation[] = [];
    let previousOperationId: OperationId | undefined;

    for (const [index, entry] of authoringOperations.entries()) {
      const envelope = await this.#snapshotEnvelope(entry.label, entry.operation, index + 1, previousOperationId);
      normalized.push(await this.normalizeOperation(envelope));
      previousOperationId = envelope.operationId;
    }

    const rootRef: AuthoringEntityRef<"node"> = { kind: "node", localId: snapshot.root.localId };
    const rootOperation: AuthoringProposalOperation = {
      op: "set-root",
      node: rootRef,
      expectedRootId: this.#document.rootNodeId,
    };
    const rootEnvelope = await this.#snapshotEnvelope("set-root", rootOperation, this.#nextSequence, previousOperationId);
    normalized.push(await this.normalizeOperation(rootEnvelope));
    previousOperationId = rootEnvelope.operationId;

    const metaOperation: AuthoringProposalOperation = {
      op: "set-meta",
      expectedMetaHash: this.#entityRevisions.metaHash,
      value: snapshot.meta,
    };
    const metaEnvelope = await this.#snapshotEnvelope("set-meta", metaOperation, this.#nextSequence, previousOperationId);
    normalized.push(await this.normalizeOperation(metaEnvelope));
    previousOperationId = metaEnvelope.operationId;

    const retained = collectSnapshotRetainedEntities(snapshot, this.#identityMap);
    for (const removal of snapshotRemovals(this.#baseDocument, this.#entityRevisions, retained)) {
      const envelope = await this.#snapshotEnvelope(removal.label, removal.operation, this.#nextSequence, previousOperationId);
      normalized.push(await this.normalizeOperation(envelope));
      previousOperationId = envelope.operationId;
    }
    return this.finalize(normalized);
  }

  async finalize(
    operations: readonly NormalizedCompilerOperation[] = [],
  ): Promise<NormalizedCompilerProposal> {
    const parsed = documentContentSchema.safeParse(this.#document);
    if (!parsed.success) {
      throw compilerError(
        "validate",
        "document.invalid",
        parsed.error.issues[0]?.message ?? "Normalized document is invalid.",
        parsed.error.issues[0] ? `/${parsed.error.issues[0]!.path.join("/")}` : "",
      );
    }
    this.#document = parsed.data;
    this.#validateCanonicalContracts();
    this.#validateInformationFlow();
    const contentHash = await hashDocumentContent(this.#document, this.#input.hashProvider);
    return {
      operations: [...operations],
      document: cloneCanonical(this.#document),
      entityRevisions: cloneCanonical(this.#entityRevisions),
      finalOperationSequence: this.finalOperationSequence,
      contentHash,
    };
  }

  async #allocateIdentities(envelope: ProposalOperationEnvelope): Promise<IdentityAllocationBatch> {
    const entities = collectIdentityRequests(envelope.operation);
    const allocation = await this.#input.identityAllocator.claim({
      transactionId: this.#input.transactionId,
      operationId: envelope.operationId,
      entities,
    });
    for (const request of entities) {
      const ref = allocation.identityMap[toProposalEntityKey(request.kind, request.localId)];
      if (!ref || ref.kind !== request.kind) {
        throw compilerError("normalize", "identity-map.missing", "Identity allocator did not return an exact kind-safe mapping.");
      }
    }
    return allocation;
  }

  async #canonicalizeOperation(
    operation: AuthoringProposalOperation,
    allocation: IdentityAllocationBatch,
  ): Promise<CanonicalEntityOperation> {
    const map = allocation.identityMap;
    switch (operation.op) {
      case "put-node": {
        const target = this.#putTarget("node", operation.target, map);
        return {
          op: "put-node",
          nodeId: target.id as never,
          ...(target.expectedEntityRevision === undefined ? {} : { expectedEntityRevision: target.expectedEntityRevision }),
          value: this.#canonicalizeNode(operation.value, map),
        };
      }
      case "remove-node": {
        const target = this.#updateTarget("node", operation.target.canonicalId, operation.target.expectedEntityRevision);
        return { op: "remove-node", nodeId: target.id as never, expectedEntityRevision: target.expectedEntityRevision };
      }
      case "put-state": {
        const target = this.#putTarget("state", operation.target, map);
        const value = await this.#canonicalizeState(target.id, operation.target, operation.value);
        this.#classifications.set(`state:${target.id}`, value.classification);
        return {
          op: "put-state",
          stateId: target.id as never,
          ...(target.expectedEntityRevision === undefined ? {} : { expectedEntityRevision: target.expectedEntityRevision }),
          value: value.definition,
        };
      }
      case "remove-state": {
        const target = this.#updateTarget("state", operation.target.canonicalId, operation.target.expectedEntityRevision);
        return { op: "remove-state", stateId: target.id as never, expectedEntityRevision: target.expectedEntityRevision };
      }
      case "put-action": {
        const target = this.#putTarget("action", operation.target, map);
        return {
          op: "put-action",
          actionId: target.id as never,
          ...(target.expectedEntityRevision === undefined ? {} : { expectedEntityRevision: target.expectedEntityRevision }),
          value: this.#canonicalizeAction(operation.value, map),
        };
      }
      case "remove-action": {
        const target = this.#updateTarget("action", operation.target.canonicalId, operation.target.expectedEntityRevision);
        return { op: "remove-action", actionId: target.id as never, expectedEntityRevision: target.expectedEntityRevision };
      }
      case "put-resource-binding": {
        const target = this.#putTarget("resource", operation.target, map);
        const value = this.#canonicalizeResource(operation.value, map, target.id);
        return {
          op: "put-resource-binding",
          bindingId: target.id as never,
          ...(target.expectedEntityRevision === undefined ? {} : { expectedEntityRevision: target.expectedEntityRevision }),
          value: value.declaration,
        };
      }
      case "remove-resource-binding": {
        const target = this.#updateTarget("resource", operation.target.canonicalId, operation.target.expectedEntityRevision);
        return { op: "remove-resource-binding", bindingId: target.id as never, expectedEntityRevision: target.expectedEntityRevision };
      }
      case "put-evidence": {
        const target = this.#putTarget("evidence", operation.target, map);
        const value = this.#canonicalizeEvidence(operation.value.source, target.id);
        return {
          op: "put-evidence",
          evidenceId: target.id as never,
          ...(target.expectedEntityRevision === undefined ? {} : { expectedEntityRevision: target.expectedEntityRevision }),
          value: value.binding,
        };
      }
      case "remove-evidence": {
        const target = this.#updateTarget("evidence", operation.target.canonicalId, operation.target.expectedEntityRevision);
        return { op: "remove-evidence", evidenceId: target.id as never, expectedEntityRevision: target.expectedEntityRevision };
      }
      case "put-claim": {
        const target = this.#putTarget("claim", operation.target, map);
        return {
          op: "put-claim",
          claimId: target.id as never,
          ...(target.expectedEntityRevision === undefined ? {} : { expectedEntityRevision: target.expectedEntityRevision }),
          value: claimBindingSchema.parse({
            nodeId: this.#resolveRef(operation.value.node, map),
            path: operation.value.path,
            kind: operation.value.kind,
            evidenceIds: operation.value.evidence.map((ref) => this.#resolveRef(ref, map)).sort(),
          }),
        };
      }
      case "remove-claim": {
        const target = this.#updateTarget("claim", operation.target.canonicalId, operation.target.expectedEntityRevision);
        return { op: "remove-claim", claimId: target.id as never, expectedEntityRevision: target.expectedEntityRevision };
      }
      case "set-root": {
        if (operation.expectedRootId === undefined) {
          throw compilerError("policy", "write-scope.root-precondition-required", "set-root requires the frozen root precondition.");
        }
        if (this.#input.writeScope.root?.expectedRootId !== operation.expectedRootId) {
          throw compilerError("policy", "write-scope.root-denied", "Root precondition is outside the frozen WriteScope.");
        }
        return {
          op: "set-root",
          nodeId: this.#resolveRef(operation.node, map) as never,
          expectedRootId: operation.expectedRootId,
        };
      }
      case "set-meta": {
        if (operation.expectedMetaHash === undefined) {
          throw compilerError("policy", "write-scope.meta-precondition-required", "set-meta requires the frozen metadata precondition.");
        }
        if (this.#input.writeScope.meta?.expectedMetaHash !== operation.expectedMetaHash) {
          throw compilerError("policy", "write-scope.meta-denied", "Metadata precondition is outside the frozen WriteScope.");
        }
        return { op: "set-meta", expectedMetaHash: operation.expectedMetaHash, value: operation.value };
      }
      default:
        return exhaustive(operation);
    }
  }

  #canonicalizeNode(value: AuthoringOperationNodeBody, map: TransactionIdentityMap): CanonicalNode {
    const contract = this.#input.catalog.componentBySliceId(value.component);
    if (!contract) {
      throw compilerError("normalize", "catalog.component-not-offered", "Node references a component outside the frozen CatalogSetSlice.", "/component");
    }
    const propsResult = validateJsonSchema(this.#input.catalog.authoringPropsSchema(contract.ref), value.props);
    if (!propsResult.success) {
      throw compilerError("authoring", "component.props-invalid", schemaIssueSummary(propsResult), "/props");
    }
    for (const slotName of Object.keys(value.slots)) {
      if (!contract.slots[slotName]) {
        throw compilerError("authoring", "component.slot-unknown", `Slot ${slotName} is not declared by the exact Component Contract.`, `/slots/${slotName}`);
      }
    }
    for (const [slotName, slot] of Object.entries(contract.slots)) {
      const count = value.slots[slotName]?.length ?? 0;
      if (count < slot.min || count > slot.max) {
        throw compilerError("authoring", "component.slot-cardinality", `Slot ${slotName} violates its frozen cardinality.`, `/slots/${slotName}`);
      }
    }
    for (const event of Object.keys(value.events)) {
      if (!(event in contract.events)) {
        throw compilerError("authoring", "component.event-unknown", `Event ${event} is not declared by the exact Component Contract.`, `/events/${event}`);
      }
    }
    return canonicalNodeSchema.parse({
      contract: contract.ref,
      props: Object.fromEntries(Object.entries(value.props).map(([key, authoring]) => [key, this.#canonicalizeValue(authoring, map)])),
      slots: Object.fromEntries(Object.entries(value.slots).map(([key, refs]) => [key, refs.map((ref) => this.#resolveRef(ref, map))])),
      events: Object.fromEntries(Object.entries(value.events).map(([key, ref]) => [key, this.#resolveRef(ref, map)])),
      evidence: value.evidence.map((ref) => this.#resolveRef(ref, map)).sort(),
    });
  }

  async #canonicalizeState(
    stateId: string,
    target: { localId: string } | { canonicalId: string },
    value: { schema: import("@open-generative/protocol").JSONSchema; initial: JsonValue },
  ): Promise<{ definition: StateDefinition; classification: FlowClassification }> {
    const initial = validateJsonSchema(value.schema, value.initial);
    if (!initial.success) {
      throw compilerError("authoring", "state.initial-invalid", schemaIssueSummary(initial), "/value/initial");
    }
    const decision = await this.#input.authority.statePolicy.decide({
      transactionId: this.#input.transactionId,
      stateId: stateId as never,
      ...( "localId" in target ? { proposalLocalId: target.localId as never } : {}),
      schema: value.schema,
      initial: value.initial,
    });
    this.#assertDocumentClassification(decision.classification, "State classification exceeds the document policy.");
    const schemaHash = await hashCanonical(
      HASH_DOMAINS.operationPayload,
      { kind: "state-schema", schema: value.schema },
      this.#input.hashProvider,
    );
    return {
      classification: decision.classification,
      definition: stateDefinitionSchema.parse({
        schema: value.schema,
        schemaHash,
        initial: value.initial,
        scope: decision.scope,
        persistence: decision.persistence,
        sensitivity: decision.sensitivity,
        modelVisibility: decision.modelVisibility,
        retention: decision.retention,
      }),
    };
  }

  #canonicalizeAction(value: AuthoringActionDefinition, map: TransactionIdentityMap): ActionDefinition {
    if (value.kind === "local-transition") {
      return actionDefinitionSchema.parse({
        kind: "local-transition",
        transitions: value.transitions.map((transition) => {
          if (transition.type === "node.focus") {
            return { type: transition.type, nodeId: this.#resolveRef(transition.node, map) };
          }
          if (transition.type === "state.reset") {
            return { type: transition.type, stateId: this.#resolveRef(transition.state, map) };
          }
          return {
            type: transition.type,
            stateId: this.#resolveRef(transition.state, map),
            value: this.#canonicalizeValue(transition.value, map),
          };
        }),
      });
    }
    const contract = this.#input.catalog.actionBySliceId(value.action);
    if (!contract) {
      throw compilerError("normalize", "catalog.action-not-offered", "Action references an ID outside the frozen CatalogSetSlice.", "/action");
    }
    const authority = this.#input.authority.actions.find((offer) => refKey(offer.contract) === refKey(contract.ref));
    if (!authority) {
      throw compilerError("policy", "action.offer-denied", "Exact Action Contract is not authorized for this turn.", "/action");
    }
    const authoringInput = validateJsonSchema(createActionAuthoringInputSchema(contract.normalizedInputSchema), value.input);
    if (!authoringInput.success) {
      throw compilerError("authoring", "action.input-invalid", schemaIssueSummary(authoringInput), "/input");
    }
    return actionDefinitionSchema.parse({
      kind: "host-intent",
      contract: contract.ref,
      input: Object.fromEntries(Object.entries(value.input).map(([key, authoring]) => [key, this.#canonicalizeValue(authoring, map)])),
    });
  }

  #canonicalizeResource(
    value: AuthoringResourceBinding,
    map: TransactionIdentityMap,
    targetId: string,
  ): { declaration: ResourceBindingDeclaration; classification: FlowClassification } {
    const slice = this.#input.catalog.slice.resources.find((entry) => entry.sliceResourceId === value.source);
    if (!slice) {
      throw compilerError("normalize", "catalog.resource-not-offered", "Resource references an ID outside the frozen CatalogSetSlice.", "/source");
    }
    const authority = this.#input.authority.resources.find((offer) => offerKey(offer.source) === offerKey(slice.source));
    if (!authority) {
      throw compilerError("policy", "resource.offer-hash-denied", "Resource offer identity or offerHash is not authorized for this turn.", "/source");
    }
    this.#assertDocumentClassification(authority.classification, "Resource classification exceeds the document policy.");
    const requested = value.selector;
    const policy = slice.selectorPolicy;
    const offeredColumns = new Set(slice.descriptor.columns.map((column) => String(column.columnId)));
    if (requested?.projection !== undefined) {
      if (!policy.allowProjection) throw compilerError("policy", "resource.projection-denied", "Resource projection is not offered.");
      if (requested.projection.length > policy.maxProjectedColumns) {
        throw compilerError("policy", "resource.projection-limit", "Resource projection exceeds the offered column limit.");
      }
      if (requested.projection.some((column) => !offeredColumns.has(column))) {
        throw compilerError("policy", "resource.column-denied", "Resource projection contains a column outside the offer.");
      }
    }
    if (requested?.filterState !== undefined && !policy.allowFilterState) {
      throw compilerError("policy", "resource.filter-denied", "Resource filter state is not offered.");
    }
    if (requested?.sort !== undefined) {
      if (!policy.allowSort) throw compilerError("policy", "resource.sort-denied", "Resource sorting is not offered.");
      if (requested.sort.length > policy.maxSortKeys) {
        throw compilerError("policy", "resource.sort-limit", "Resource sort exceeds the offered key limit.");
      }
      if (requested.sort.some((sort) => !offeredColumns.has(sort.columnId))) {
        throw compilerError("policy", "resource.sort-column-denied", "Resource sort contains a column outside the offer.");
      }
    }
    if (requested?.windowLimit !== undefined && requested.windowLimit > policy.maxWindowItems) {
      throw compilerError("policy", "resource.window-denied", "Resource window exceeds the offered maximum.");
    }
    const selector = {
      ...authority.declaration.selector,
      ...(requested?.projection === undefined ? {} : { projection: requested.projection }),
      ...(requested?.filterState === undefined ? {} : { filterStateRef: this.#resolveRef(requested.filterState, map) }),
      ...(requested?.sort === undefined ? {} : { sort: requested.sort }),
      ...(requested?.windowLimit === undefined ? {} : { windowLimit: requested.windowLimit }),
    };
    this.#classifications.set(`resource:${targetId}`, authority.classification);
    return {
      classification: authority.classification,
      declaration: resourceBindingDeclarationSchema.parse({
        ...authority.declaration,
        selector,
      }),
    };
  }

  #canonicalizeEvidence(source: string, targetId: string): { binding: EvidenceBinding; classification: FlowClassification } {
    const slice = this.#input.catalog.slice.evidence.find((entry) => entry.sliceEvidenceId === source);
    if (!slice) {
      throw compilerError("normalize", "catalog.evidence-not-offered", "Evidence references an ID outside the frozen CatalogSetSlice.", "/source");
    }
    const authority = this.#input.authority.evidence.find((offer) => offerKey(offer.source) === offerKey(slice.source));
    if (!authority) {
      throw compilerError("policy", "evidence.offer-hash-denied", "Evidence offer identity or offerHash is not authorized for this turn.", "/source");
    }
    this.#assertDocumentClassification(authority.classification, "Evidence classification exceeds the document policy.");
    this.#classifications.set(`evidence:${targetId}`, authority.classification);
    return { binding: evidenceBindingSchema.parse(authority.binding), classification: authority.classification };
  }

  #canonicalizeValue(value: AuthoringValue, map: TransactionIdentityMap): ValueExpr {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return { kind: "literal", value };
    }
    if (Array.isArray(value)) {
      return valueExprSchema.parse({ kind: "array", items: value.map((item) => this.#canonicalizeValue(item, map)) });
    }
    if ("object" in value) {
      return valueExprSchema.parse({
        kind: "object",
        entries: Object.fromEntries(Object.entries(value.object).map(([key, item]) => [key, this.#canonicalizeValue(item, map)])),
      });
    }
    if ("condition" in value) {
      return valueExprSchema.parse({
        kind: "condition",
        op: value.condition.op,
        args: value.condition.args.map((item) => this.#canonicalizeValue(item, map)),
      });
    }
    if (value.ref === "state") {
      return valueExprSchema.parse({ kind: "state-ref", stateId: this.#resolveRef(value.target, map), ...(value.path ? { path: value.path } : {}) });
    }
    if (value.ref === "resource") {
      return valueExprSchema.parse({ kind: "resource-ref", bindingId: this.#resolveRef(value.target, map), ...(value.path ? { path: value.path } : {}) });
    }
    if (value.ref === "event") {
      return valueExprSchema.parse({ kind: "event-ref", port: value.port, ...(value.path ? { path: value.path } : {}) });
    }
    return { kind: "context-ref", key: value.key };
  }

  #resolveRef<TKind extends ProposalEntityKind>(
    ref: AuthoringEntityRef<TKind>,
    map: TransactionIdentityMap,
  ): string {
    if ("localId" in ref) {
      const resolved = map[toProposalEntityKey(ref.kind, ref.localId)];
      if (!resolved || resolved.kind !== ref.kind) {
        throw compilerError("normalize", "identity-map.reference-missing", "Proposal-local reference has no kind-safe transaction mapping.");
      }
      return resolved.id;
    }
    if (!this.#isReadable(ref.kind, ref.canonicalId)) {
      throw compilerError("policy", "write-scope.read-denied", `Canonical ${ref.kind} reference is outside the frozen read scope.`);
    }
    return ref.canonicalId;
  }

  #putTarget(
    kind: ProposalEntityKind,
    target: { kind: ProposalEntityKind; localId: string } | { kind: ProposalEntityKind; canonicalId: string; expectedEntityRevision: EntityRevisionId },
    map: TransactionIdentityMap,
  ): { id: string; expectedEntityRevision?: EntityRevisionId } {
    if ("localId" in target) {
      const resolved = map[toProposalEntityKey(kind, target.localId)];
      if (!resolved || resolved.kind !== kind) throw compilerError("normalize", "identity-map.target-missing", "Create target has no kind-safe identity mapping.");
      return { id: resolved.id };
    }
    return this.#updateTarget(kind, target.canonicalId, target.expectedEntityRevision);
  }

  #updateTarget(
    kind: ProposalEntityKind,
    canonicalId: string,
    expectedEntityRevision: EntityRevisionId,
  ): { id: string; expectedEntityRevision: EntityRevisionId } {
    const expected = this.#input.writeScope.writable[kind][canonicalId];
    if (expected !== expectedEntityRevision) {
      throw compilerError("policy", "write-scope.update-denied", `Canonical ${kind} update is outside the frozen WriteScope.`);
    }
    return { id: canonicalId, expectedEntityRevision };
  }

  #isReadable(kind: ProposalEntityKind, id: string): boolean {
    return this.#input.writeScope.readable[kind].includes(id as never)
      || this.#input.writeScope.writable[kind][id] !== undefined;
  }

  #enforceGenerationLimits(): void {
    const limits = this.#input.catalog.slice.limits;
    if (Object.keys(this.#document.nodes).length > limits.maxNodes) throw compilerError("validate", "limit.nodes", "Document exceeds the frozen node limit.");
    if (Object.keys(this.#document.actions).length > limits.maxActions) throw compilerError("validate", "limit.actions", "Document exceeds the frozen action limit.");
    if (Object.keys(this.#document.resourceBindings).length > limits.maxResourceBindings) throw compilerError("validate", "limit.resources", "Document exceeds the frozen resource-binding limit.");
    if (Object.keys(this.#document.evidenceBindings).length > limits.maxEvidenceBindings) throw compilerError("validate", "limit.evidence", "Document exceeds the frozen evidence-binding limit.");
    if (this.finalOperationSequence > limits.maxOperations) throw compilerError("validate", "limit.operations", "Proposal exceeds the frozen operation limit.");
  }

  #validateCanonicalContracts(): void {
    for (const [nodeId, node] of Object.entries(this.#document.nodes)) {
      const contract = this.#input.catalog.componentByRef(node.contract);
      if (!contract) throw compilerError("validate", "catalog.component-contract-missing", "Canonical node contract is outside the frozen CatalogSetSlice.", `/nodes/${nodeId}/contract`);
      for (const [slotName, children] of Object.entries(node.slots)) {
        const slot = contract.slots[slotName];
        if (!slot) throw compilerError("validate", "component.slot-unknown", `Canonical slot ${slotName} is not declared.`, `/nodes/${nodeId}/slots/${slotName}`);
        if (children.length < slot.min || children.length > slot.max) throw compilerError("validate", "component.slot-cardinality", `Canonical slot ${slotName} violates cardinality.`, `/nodes/${nodeId}/slots/${slotName}`);
        const accepted = new Set(slot.accepts.map((selector) => refKey(selector.contract)));
        for (const childId of children) {
          const child = this.#document.nodes[childId];
          if (child && !accepted.has(refKey(child.contract))) {
            throw compilerError("validate", "component.slot-contract-denied", "Child Component Contract is not accepted by the exact slot contract.", `/nodes/${nodeId}/slots/${slotName}`);
          }
        }
      }
      for (const [eventPort, actionId] of Object.entries(node.events)) {
        const event = Object.entries(contract.events).find(([port]) => port === eventPort)?.[1];
        if (!event) throw compilerError("validate", "component.event-unknown", `Canonical event ${eventPort} is not declared.`, `/nodes/${nodeId}/events/${eventPort}`);
        const action = this.#document.actions[actionId];
        if (action?.kind === "host-intent" && !event.actionContracts.some((candidate) => refKey(candidate) === refKey(action.contract))) {
          throw compilerError("validate", "component.event-action-denied", "Event is bound to an Action Contract not accepted by the component.", `/nodes/${nodeId}/events/${eventPort}`);
        }
      }
    }
  }

  #validateInformationFlow(): void {
    const policy = this.#input.authority.informationFlow;
    for (const [nodeId, node] of Object.entries(this.#document.nodes)) {
      const sink = policy.componentSinks?.find((entry) => refKey(entry.contract) === refKey(node.contract))?.maxClassification
        ?? policy.maxDocumentClassification;
      for (const expression of Object.values(node.props)) this.#assertSink(expressionClassification(expression, this.#classifications), sink, `/nodes/${nodeId}/props`);
      for (const evidenceId of node.evidence) this.#assertSink(this.#classifications.get(`evidence:${evidenceId}`) ?? "public", sink, `/nodes/${nodeId}/evidence`);
    }
    for (const [actionId, action] of Object.entries(this.#document.actions)) {
      if (action.kind !== "host-intent") continue;
      const authority = this.#input.authority.actions.find((offer) => refKey(offer.contract) === refKey(action.contract));
      const sink = minClassification(
        authority?.maxInputClassification ?? policy.maxDocumentClassification,
        policy.actionSinks?.find((entry) => refKey(entry.contract) === refKey(action.contract))?.maxClassification
          ?? policy.maxDocumentClassification,
      );
      for (const expression of Object.values(action.input)) this.#assertSink(expressionClassification(expression, this.#classifications), sink, `/actions/${actionId}/input`);
    }
  }

  #assertSink(source: FlowClassification, sink: FlowClassification, path: string): void {
    if (CLASSIFICATION_RANK[source] > CLASSIFICATION_RANK[sink]) {
      throw compilerError("policy", "information-flow.sink-denied", "Information classification exceeds the authorized sink.", path);
    }
  }

  #assertDocumentClassification(classification: FlowClassification, message: string): void {
    if (CLASSIFICATION_RANK[classification] > CLASSIFICATION_RANK[this.#input.authority.informationFlow.maxDocumentClassification]) {
      throw compilerError("policy", "information-flow.document-denied", message);
    }
  }

  #seedAuthorityClassifications(): void {
    for (const offer of this.#input.authority.resources) {
      this.#classifications.set(`resource:${offer.source.bindingId}`, offer.classification);
      for (const id of offer.existingBindingIds ?? []) this.#classifications.set(`resource:${id}`, offer.classification);
    }
    for (const offer of this.#input.authority.evidence) {
      this.#classifications.set(`evidence:${offer.source.evidenceId}`, offer.classification);
      for (const id of offer.existingEvidenceIds ?? []) this.#classifications.set(`evidence:${id}`, offer.classification);
    }
  }

  async #snapshotEnvelope(
    label: string,
    operation: AuthoringProposalOperation,
    sequence: number,
    dependency?: OperationId,
  ): Promise<ProposalOperationEnvelope> {
    const identity = await hashCanonical(HASH_DOMAINS.operationPayload, { label, operation }, this.#input.hashProvider);
    return proposalOperationEnvelopeSchema.parse({
      operationId: `snapshot-${identity.slice("sha256:".length)}`,
      sequence,
      dependsOn: dependency ? [dependency] : [],
      payloadHash: await hashCanonical(HASH_DOMAINS.operationPayload, operation, this.#input.hashProvider),
      operation,
    });
  }
}

function collectIdentityRequests(operation: AuthoringProposalOperation): IdentityAllocationRequest[] {
  const requests: IdentityAllocationRequest[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.kind === "string" && typeof record.localId === "string" && ENTITY_KINDS.includes(record.kind as never)) {
      requests.push({ kind: record.kind as ProposalEntityKind, localId: record.localId });
    }
    Object.values(record).forEach(visit);
  };
  visit(operation);
  return requests.sort(compareCanonical).filter((entry, index, values) => (
    index === 0 || `${entry.kind}:${entry.localId}` !== `${values[index - 1]!.kind}:${values[index - 1]!.localId}`
  ));
}

function localCreateTarget(operation: AuthoringProposalOperation): { kind: ProposalEntityKind; localId: string } | undefined {
  if (!("target" in operation) || !("localId" in operation.target)) return undefined;
  return { kind: operation.target.kind, localId: operation.target.localId };
}

type SnapshotOperation = { label: string; operation: AuthoringProposalOperation };

function flattenSnapshot(snapshot: AuthoringSnapshotProposal): SnapshotOperation[] {
  const output: SnapshotOperation[] = [];
  for (const entity of [...snapshot.stateDefinitions].sort(compareCanonical)) {
    output.push({ label: `put-state:${entity.localId}`, operation: { op: "put-state", target: { kind: "state", localId: entity.localId }, value: entity.value } });
  }
  for (const entity of [...snapshot.resourceBindings].sort(compareCanonical)) {
    output.push({ label: `put-resource:${entity.localId}`, operation: { op: "put-resource-binding", target: { kind: "resource", localId: entity.localId }, value: entity.value } });
  }
  for (const entity of [...snapshot.evidenceBindings].sort(compareCanonical)) {
    output.push({ label: `put-evidence:${entity.localId}`, operation: { op: "put-evidence", target: { kind: "evidence", localId: entity.localId }, value: entity.value } });
  }
  for (const entity of [...snapshot.actions].sort(compareCanonical)) {
    output.push({ label: `put-action:${entity.localId}`, operation: { op: "put-action", target: { kind: "action", localId: entity.localId }, value: entity.value } });
  }
  const visitNode = (node: AuthoringSnapshotNode): void => {
    const slots: AuthoringOperationNodeBody["slots"] = {};
    for (const [slot, children] of Object.entries(node.slots ?? {})) {
      slots[slot] = children.map((child) => {
        if ("component" in child) {
          visitNode(child);
          return { kind: "node", localId: child.localId };
        }
        return child;
      });
    }
    output.push({
      label: `put-node:${node.localId}`,
      operation: {
        op: "put-node",
        target: { kind: "node", localId: node.localId },
        value: {
          component: node.component,
          props: node.props ?? {},
          slots,
          events: node.events ?? {},
          evidence: node.evidence ?? [],
        },
      },
    });
  };
  visitNode(snapshot.root);
  for (const entity of [...snapshot.claims].sort(compareCanonical)) {
    output.push({ label: `put-claim:${entity.localId}`, operation: { op: "put-claim", target: { kind: "claim", localId: entity.localId }, value: entity.value } });
  }
  return output;
}

function collectSnapshotRetainedEntities(
  snapshot: AuthoringSnapshotProposal,
  identityMap: TransactionIdentityMap,
): Record<ProposalEntityKind, Set<string>> {
  const retained = Object.fromEntries(ENTITY_KINDS.map((kind) => [kind, new Set<string>()])) as Record<ProposalEntityKind, Set<string>>;
  for (const [key, ref] of Object.entries(identityMap)) {
    if (key.includes(":")) retained[ref.kind].add(ref.id);
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.kind === "string" && typeof record.canonicalId === "string" && ENTITY_KINDS.includes(record.kind as never)) {
      retained[record.kind as ProposalEntityKind].add(record.canonicalId);
    }
    Object.values(record).forEach(visit);
  };
  visit(snapshot);
  return retained;
}

function snapshotRemovals(
  base: DocumentContent,
  revisions: EntityRevisionIndex,
  retained: Record<ProposalEntityKind, Set<string>>,
): SnapshotOperation[] {
  const output: SnapshotOperation[] = [];
  const add = (
    kind: ProposalEntityKind,
    records: Record<string, unknown>,
    revisionMap: Record<string, EntityRevisionId>,
    op: "remove-node" | "remove-state" | "remove-action" | "remove-resource-binding" | "remove-evidence" | "remove-claim",
  ): void => {
    for (const id of Object.keys(records).sort()) {
      if (retained[kind].has(id)) continue;
      const revision = revisionMap[id];
      if (!revision) continue;
      output.push({
        label: `${op}:${id}`,
        operation: { op, target: { kind, canonicalId: id, expectedEntityRevision: revision } } as AuthoringProposalOperation,
      });
    }
  };
  add("claim", base.claims, revisions.claims, "remove-claim");
  add("node", base.nodes, revisions.nodes, "remove-node");
  add("action", base.actions, revisions.actions, "remove-action");
  add("evidence", base.evidenceBindings, revisions.evidence, "remove-evidence");
  add("resource", base.resourceBindings, revisions.resources, "remove-resource-binding");
  add("state", base.stateDefinitions, revisions.states, "remove-state");
  return output;
}

function expressionClassification(
  expression: ValueExpr,
  classifications: ReadonlyMap<string, FlowClassification>,
): FlowClassification {
  if (expression.kind === "state-ref") return classifications.get(`state:${expression.stateId}`) ?? "public";
  if (expression.kind === "resource-ref") return classifications.get(`resource:${expression.bindingId}`) ?? "public";
  if (expression.kind === "array") return maxClassification(expression.items.map((item) => expressionClassification(item, classifications)));
  if (expression.kind === "object") return maxClassification(Object.values(expression.entries).map((item) => expressionClassification(item, classifications)));
  if (expression.kind === "condition") return maxClassification(expression.args.map((item) => expressionClassification(item, classifications)));
  return "public";
}

function maxClassification(values: readonly FlowClassification[]): FlowClassification {
  return values.reduce<FlowClassification>((current, value) => (
    CLASSIFICATION_RANK[value] > CLASSIFICATION_RANK[current] ? value : current
  ), "public");
}

function minClassification(left: FlowClassification, right: FlowClassification): FlowClassification {
  return CLASSIFICATION_RANK[left] < CLASSIFICATION_RANK[right] ? left : right;
}

function compilerError(
  phase: Parameters<typeof diagnostic>[0]["phase"],
  code: string,
  message: string,
  path?: string,
  expected?: JsonValue,
): ProtocolError {
  return new ProtocolError(diagnostic({ phase, code, message, path, expected }));
}

export async function normalizeAuthoringProposal(
  input: ProposalNormalizerInput,
  proposal: AuthoringSnapshotProposal | readonly ProposalOperationEnvelope[],
): Promise<NormalizedCompilerProposal> {
  const normalizer = new ProposalNormalizer(input);
  return Array.isArray(proposal)
    ? normalizer.normalizeOperations(proposal)
    : normalizer.normalizeSnapshot(proposal as AuthoringSnapshotProposal);
}

export async function createAuthoringOperationEnvelope(input: {
  operationId: OperationId;
  sequence: number;
  dependsOn?: readonly OperationId[];
  operation: AuthoringProposalOperation;
  hashProvider?: HashProvider;
}): Promise<ProposalOperationEnvelope> {
  return proposalOperationEnvelopeSchema.parse({
    operationId: input.operationId,
    sequence: input.sequence,
    dependsOn: input.dependsOn ?? [],
    payloadHash: await hashCanonical(HASH_DOMAINS.operationPayload, input.operation, input.hashProvider),
    operation: input.operation,
  });
}
