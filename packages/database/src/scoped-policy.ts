import { createHash } from "node:crypto";
import { z } from "zod";
import {
  databaseActionKindSchema,
  databaseActionRiskSchema,
  databaseActionSchema,
  databaseColumnRefSchema,
  databaseConnectionRefSchema,
  databaseIdentifierSchema,
  databaseRelationRefSchema,
  classifyDatabaseAction,
  collectDatabaseActionColumns,
  createDatabaseActionHash,
  type DatabaseAction,
  type DatabaseActionClassification,
  type DatabaseActionKind,
  type DatabaseActionRisk,
  type DatabaseColumnRef,
  type DatabaseRelationRef,
} from "./actions";
import {
  createDatabasePermissionPolicy,
  databasePermissionLevelSchema,
  databasePermissionProfileSchema,
  databaseSqlStatementClassSchema,
  evaluateDatabaseSqlPermission,
  type DatabasePermissionLevel,
  type DatabasePermissionProfile,
  type DatabaseSqlStatementClass,
} from "./permissions";

const policyIdentifierSchema = z.string().min(1).max(256);
const sqlStatementOverridesSchema = z.object({
  read: databasePermissionLevelSchema.optional(),
  write: databasePermissionLevelSchema.optional(),
  destructive: databasePermissionLevelSchema.optional(),
  unknown: databasePermissionLevelSchema.optional(),
}).strict();

/** Which authenticated identities a policy or rule may match. */
export const databasePermissionSubjectScopeSchema = z.object({
  tenantRefs: z.array(policyIdentifierSchema).min(1).max(256).optional(),
  actorRefs: z.array(policyIdentifierSchema).min(1).max(1_024).optional(),
  roleRefs: z.array(policyIdentifierSchema).min(1).max(256).optional(),
}).strict();

/** Which database resources a policy or rule may match. */
export const databasePermissionResourceScopeSchema = z.object({
  connectionRefs: z.array(databaseConnectionRefSchema).min(1).max(128).optional(),
  databaseRefs: z.array(databaseIdentifierSchema).min(1).max(128).optional(),
  schemaRefs: z.array(databaseIdentifierSchema).min(1).max(1_024).optional(),
  relationRefs: z.array(databaseRelationRefSchema).min(1).max(10_000).optional(),
  columnRefs: z.array(databaseColumnRefSchema).min(1).max(50_000).optional(),
  /** Server-issued row constraints. They are never accepted in a model action. */
  rowPredicateRefs: z.array(policyIdentifierSchema).min(1).max(1_024).optional(),
}).strict();

export const databasePermissionActorSchema = z.object({
  tenantRef: policyIdentifierSchema,
  actorRef: policyIdentifierSchema,
  roleRefs: z.array(policyIdentifierSchema).max(256).default([]),
}).strict();

export const databaseScopedPermissionRuleSchema = z.object({
  id: policyIdentifierSchema,
  permission: databasePermissionLevelSchema,
  actionKinds: z.array(databaseActionKindSchema).min(1).max(16).optional(),
  statementClasses: z.array(databaseSqlStatementClassSchema).min(1).max(4).optional(),
  risks: z.array(databaseActionRiskSchema).min(1).max(4).optional(),
  subject: databasePermissionSubjectScopeSchema.optional(),
  resource: databasePermissionResourceScopeSchema.optional(),
}).strict();

/**
 * A session/project grant is deliberately tied to concrete action kinds. It
 * can resolve ASK to ALLOW, but never bypasses an effective DENY rule.
 */
export const databaseActionPermissionGrantSchema = z.object({
  id: policyIdentifierSchema,
  mode: z.enum(["session", "project"]),
  actionKinds: z.array(databaseActionKindSchema).min(1).max(16),
  subject: databasePermissionSubjectScopeSchema.optional(),
  resource: databasePermissionResourceScopeSchema.optional(),
  expiresAt: z.iso.datetime().optional(),
}).strict();

export const databaseScopedPermissionPolicyInputSchema = z.object({
  policyId: policyIdentifierSchema.default("database"),
  policyVersion: policyIdentifierSchema.default("1"),
  profile: databasePermissionProfileSchema.optional(),
  sqlStatements: sqlStatementOverridesSchema.optional(),
  /**
   * This outer scope is a hard authorization boundary. An action outside it
   * is denied before profile defaults or ordered rules are considered.
   */
  subject: databasePermissionSubjectScopeSchema.optional(),
  resource: databasePermissionResourceScopeSchema.optional(),
  /** Rules are evaluated in array order; the last matching rule wins. */
  rules: z.array(databaseScopedPermissionRuleSchema).max(1_024).default([]),
}).strict();

export type DatabasePermissionSubjectScope = z.infer<typeof databasePermissionSubjectScopeSchema>;
export type DatabasePermissionResourceScope = z.infer<typeof databasePermissionResourceScopeSchema>;
export type DatabasePermissionActor = z.infer<typeof databasePermissionActorSchema>;
export type DatabaseScopedPermissionRule = z.infer<typeof databaseScopedPermissionRuleSchema>;
export type DatabaseActionPermissionGrant = z.infer<typeof databaseActionPermissionGrantSchema>;
export type DatabaseScopedPermissionPolicyInput = z.input<typeof databaseScopedPermissionPolicyInputSchema>;

export type DatabaseScopedPermissionPolicy = Readonly<{
  policyId: string;
  policyVersion: string;
  policyHash: `sha256:${string}`;
  profile: DatabasePermissionProfile;
  sqlStatements: Readonly<Record<DatabaseSqlStatementClass, DatabasePermissionLevel>>;
  subject?: DatabasePermissionSubjectScope;
  resource?: DatabasePermissionResourceScope;
  rules: readonly DatabaseScopedPermissionRule[];
}>;

export type DatabaseActionPolicyEvaluationInput = Readonly<{
  action: DatabaseAction | unknown;
  actor: DatabasePermissionActor;
  /** A server binding can elevate risk, but cannot lower the action's default risk. */
  riskFloor?: DatabaseActionRisk;
  /** Server-generated row constraints bound into the eventual compiled query. */
  trustedRowPredicateRefs?: readonly string[];
  grants?: readonly DatabaseActionPermissionGrant[];
  now?: Date;
}>;

export type DatabasePolicyOutcome = "allow" | "require-approval" | "deny";

export type DatabaseActionPolicyEvaluation = Readonly<{
  action: DatabaseAction;
  actionHash: `sha256:${string}`;
  policyHash: `sha256:${string}`;
  statementClass: DatabaseActionClassification["statementClass"];
  risk: DatabaseActionRisk;
  permission: DatabasePermissionLevel;
  outcome: DatabasePolicyOutcome;
  source: "scope" | "profile" | "rule" | "grant";
  matchedRuleIds: readonly string[];
  matchedGrantId?: string;
  reasonCodes: readonly string[];
}>;

/** Creates an immutable, hash-addressable Datus-style profile and scoped rule set. */
export function createDatabaseScopedPermissionPolicy(
  input: DatabaseScopedPermissionPolicyInput = {},
): DatabaseScopedPermissionPolicy {
  const parsed = databaseScopedPermissionPolicyInputSchema.parse(input);
  const base = createDatabasePermissionPolicy({
    profile: parsed.profile,
    sqlStatements: parsed.sqlStatements,
  });
  const policy = {
    policyId: parsed.policyId,
    policyVersion: parsed.policyVersion,
    profile: base.profile,
    sqlStatements: base.sqlStatements,
    ...(parsed.subject === undefined ? {} : { subject: parsed.subject }),
    ...(parsed.resource === undefined ? {} : { resource: parsed.resource }),
    rules: parsed.rules,
  };
  return Object.freeze({
    ...policy,
    policyHash: createScopedPolicyHash(policy),
    rules: Object.freeze([...policy.rules]),
  });
}

/**
 * Evaluates a typed database action before any compiler or connector is
 * invoked. ASK is represented as require-approval for the Broker/Mastra flow.
 */
export function evaluateDatabaseActionPolicy(
  policy: DatabaseScopedPermissionPolicy,
  input: DatabaseActionPolicyEvaluationInput,
): DatabaseActionPolicyEvaluation {
  const action = databaseActionSchema.parse(input.action);
  const actor = databasePermissionActorSchema.parse(input.actor);
  const classification = classifyDatabaseAction(action);
  const risk = maxRisk(classification.risk, input.riskFloor);
  const trustedRowPredicateRefs = input.trustedRowPredicateRefs ?? [];
  const matchedRuleIds: string[] = [];

  if (!databaseActorMatchesSubjectScope(actor, policy.subject)
    || !databaseActionMatchesResourceScope(action, policy.resource, trustedRowPredicateRefs)) {
    return freezeEvaluation({
      action,
      policy,
      statementClass: classification.statementClass,
      risk,
      permission: "deny",
      source: "scope",
      matchedRuleIds,
      reasonCodes: ["scope.denied"],
    });
  }

  const baseline = evaluateDatabaseSqlPermission(policy, classification.statementClass).permission;
  let permission = baseline;
  let source: DatabaseActionPolicyEvaluation["source"] = "profile";
  for (const rule of policy.rules) {
    if (!matchesRule(rule, action, actor, classification.statementClass, risk, trustedRowPredicateRefs)) continue;
    matchedRuleIds.push(rule.id);
    permission = rule.permission;
    source = "rule";
  }

  let matchedGrantId: string | undefined;
  if (permission === "ask") {
    const grant = (input.grants ?? [])
      .map((candidate) => databaseActionPermissionGrantSchema.parse(candidate))
      .find((candidate) => isDatabaseActionPermissionGrantActive(candidate, input.now)
        && candidate.actionKinds.includes(action.kind)
        && databaseActorMatchesSubjectScope(actor, candidate.subject)
        && databaseActionMatchesResourceScope(action, candidate.resource, trustedRowPredicateRefs));
    if (grant) {
      permission = "allow";
      source = "grant";
      matchedGrantId = grant.id;
    }
  }

  return freezeEvaluation({
    action,
    policy,
    statementClass: classification.statementClass,
    risk,
    permission,
    source,
    matchedRuleIds,
    ...(matchedGrantId === undefined ? {} : { matchedGrantId }),
    reasonCodes: reasonCodesFor(permission, source, policy, action.kind, classification.statementClass, risk, matchedRuleIds, matchedGrantId),
  });
}

/** True when an authenticated actor is inside an optional subject scope. */
export function databaseActorMatchesSubjectScope(
  actorInput: DatabasePermissionActor,
  scope?: DatabasePermissionSubjectScope,
): boolean {
  if (!scope) return true;
  if (scope.tenantRefs && !scope.tenantRefs.includes(actorInput.tenantRef)) return false;
  if (scope.actorRefs && !scope.actorRefs.includes(actorInput.actorRef)) return false;
  if (scope.roleRefs && !actorInput.roleRefs.some((role) => scope.roleRefs!.includes(role))) return false;
  return true;
}

/**
 * True when an action is inside an optional resource scope. Column scopes are
 * allow lists: every referenced column must be listed for the action relation.
 */
export function databaseActionMatchesResourceScope(
  actionInput: DatabaseAction | unknown,
  scope?: DatabasePermissionResourceScope,
  trustedRowPredicateRefs: readonly string[] = [],
): boolean {
  if (!scope) return true;
  const action = databaseActionSchema.parse(actionInput);
  if (scope.connectionRefs && !scope.connectionRefs.includes(action.connectionRef)) return false;
  if (scope.databaseRefs && (action.databaseRef === undefined || !scope.databaseRefs.includes(action.databaseRef))) return false;
  if (scope.schemaRefs && !scope.schemaRefs.includes(action.relation.schema)) return false;
  if (scope.relationRefs && !actionRelations(action).every((relation) => (
    scope.relationRefs!.some((candidate) => sameRelation(candidate, relation))
  ))) return false;
  if (scope.columnRefs && !columnsMatchScope(action, scope.columnRefs)) return false;
  if (scope.rowPredicateRefs && !trustedRowPredicateRefs.some((ref) => scope.rowPredicateRefs!.includes(ref))) return false;
  return true;
}

/** Session grants expire independently from the policy and are safe to re-check at execution. */
export function isDatabaseActionPermissionGrantActive(
  grantInput: DatabaseActionPermissionGrant | unknown,
  now: Date = new Date(),
): boolean {
  const grant = databaseActionPermissionGrantSchema.parse(grantInput);
  return grant.expiresAt === undefined || Date.parse(grant.expiresAt) > now.getTime();
}

function matchesRule(
  rule: DatabaseScopedPermissionRule,
  action: DatabaseAction,
  actor: DatabasePermissionActor,
  statementClass: DatabaseActionClassification["statementClass"],
  risk: DatabaseActionRisk,
  trustedRowPredicateRefs: readonly string[],
): boolean {
  if (rule.actionKinds && !rule.actionKinds.includes(action.kind)) return false;
  if (rule.statementClasses && !rule.statementClasses.includes(statementClass)) return false;
  if (rule.risks && !rule.risks.includes(risk)) return false;
  return databaseActorMatchesSubjectScope(actor, rule.subject)
    && databaseActionMatchesResourceScope(action, rule.resource, trustedRowPredicateRefs);
}

function columnsMatchScope(action: DatabaseAction, allowedColumns: readonly DatabaseColumnRef[]): boolean {
  const columns = collectDatabaseActionColumns(action);
  if (columns.length === 0) return false;
  return columns.every((column) => allowedColumns.some((candidate) => (
    candidate.column === column && sameRelation(candidate, action.relation)
  )));
}

function sameRelation(left: DatabaseRelationRef, right: DatabaseRelationRef): boolean {
  return left.schema === right.schema && left.table === right.table;
}

function actionRelations(action: DatabaseAction): readonly DatabaseRelationRef[] {
  if (action.kind === "data.ddl" && action.operation.kind === "rename-table") {
    return [action.relation, action.operation.to];
  }
  return [action.relation];
}

function maxRisk(defaultRisk: DatabaseActionRisk, floor?: DatabaseActionRisk): DatabaseActionRisk {
  if (!floor) return defaultRisk;
  const order: readonly DatabaseActionRisk[] = ["low", "medium", "high", "critical"];
  return order.indexOf(floor) > order.indexOf(defaultRisk) ? floor : defaultRisk;
}

type UnevaluatedDatabaseActionPolicyEvaluation = Omit<
  DatabaseActionPolicyEvaluation,
  "actionHash" | "policyHash" | "outcome"
> & {
  policy: DatabaseScopedPermissionPolicy;
};

function freezeEvaluation(input: UnevaluatedDatabaseActionPolicyEvaluation): DatabaseActionPolicyEvaluation {
  const { policy, ...evaluation } = input;
  return Object.freeze({
    ...evaluation,
    actionHash: createDatabaseActionHash(evaluation.action),
    policyHash: policy.policyHash,
    outcome: outcomeForPermission(evaluation.permission),
    matchedRuleIds: Object.freeze([...evaluation.matchedRuleIds]),
    reasonCodes: Object.freeze([...evaluation.reasonCodes]),
  });
}

function outcomeForPermission(permission: DatabasePermissionLevel): DatabasePolicyOutcome {
  switch (permission) {
    case "allow": return "allow";
    case "ask": return "require-approval";
    case "deny": return "deny";
  }
}

function reasonCodesFor(
  permission: DatabasePermissionLevel,
  source: DatabaseActionPolicyEvaluation["source"],
  policy: DatabaseScopedPermissionPolicy,
  actionKind: DatabaseActionKind,
  statementClass: DatabaseActionClassification["statementClass"],
  risk: DatabaseActionRisk,
  matchedRuleIds: readonly string[],
  matchedGrantId?: string,
): readonly string[] {
  if (source === "grant") return [`grant.${matchedGrantId}`, `action.${actionKind}`];
  if (source === "rule") return [`rule.${matchedRuleIds.at(-1)}`, `action.${actionKind}`, `risk.${risk}`];
  if (source === "scope") return ["scope.denied"];
  return [`profile.${policy.profile}.${statementClass}.${permission}`, `action.${actionKind}`, `risk.${risk}`];
}

function createScopedPolicyHash(policy: Omit<DatabaseScopedPermissionPolicy, "policyHash">): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalPolicyJson(policy)).digest("hex")}`;
}

function canonicalPolicyJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Object.is(value, -0) ? "0" : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPolicyJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalPolicyJson(item)}`)
      .join(",")}}`;
  }
  throw new TypeError(`Database policy JSON cannot encode ${typeof value}.`);
}
