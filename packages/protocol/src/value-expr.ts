import { z } from "zod";
import {
  eventPortSchema,
  resourceBindingIdSchema,
  stateIdSchema,
} from "./ids";
import {
  jsonScalarSchema,
  pathSchema,
  safeObjectKeySchema,
  type JsonScalar,
  type PathSegment,
} from "./json";

export const conditionOperators = ["eq", "neq", "lt", "lte", "gt", "gte", "and", "or", "not"] as const;
export const conditionOperatorSchema = z.enum(conditionOperators);
export type ConditionOperator = z.infer<typeof conditionOperatorSchema>;

export type ValueExpr =
  | { kind: "literal"; value: JsonScalar }
  | { kind: "array"; items: ValueExpr[] }
  | { kind: "object"; entries: Record<string, ValueExpr> }
  | { kind: "state-ref"; stateId: z.infer<typeof stateIdSchema>; path?: PathSegment[] }
  | { kind: "state-id-ref"; stateId: z.infer<typeof stateIdSchema> }
  | { kind: "resource-ref"; bindingId: z.infer<typeof resourceBindingIdSchema>; path?: PathSegment[] }
  | { kind: "resource-id-ref"; bindingId: z.infer<typeof resourceBindingIdSchema> }
  | { kind: "event-ref"; port: z.infer<typeof eventPortSchema>; path?: PathSegment[] }
  | { kind: "context-ref"; key: "locale" | "timezone" }
  | { kind: "condition"; op: ConditionOperator; args: ValueExpr[] };

export const valueExprSchema: z.ZodType<ValueExpr> = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: jsonScalarSchema }).strict(),
  z.object({ kind: z.literal("array"), items: z.array(valueExprSchema) }).strict(),
  z.object({ kind: z.literal("object"), entries: z.record(safeObjectKeySchema, valueExprSchema) }).strict(),
  z.object({ kind: z.literal("state-ref"), stateId: stateIdSchema, path: pathSchema.optional() }).strict(),
  z.object({ kind: z.literal("state-id-ref"), stateId: stateIdSchema }).strict(),
  z.object({ kind: z.literal("resource-ref"), bindingId: resourceBindingIdSchema, path: pathSchema.optional() }).strict(),
  z.object({ kind: z.literal("resource-id-ref"), bindingId: resourceBindingIdSchema }).strict(),
  z.object({ kind: z.literal("event-ref"), port: eventPortSchema, path: pathSchema.optional() }).strict(),
  z.object({ kind: z.literal("context-ref"), key: z.enum(["locale", "timezone"]) }).strict(),
  z.object({
    kind: z.literal("condition"),
    op: conditionOperatorSchema,
    args: z.array(valueExprSchema).max(16),
  }).strict().superRefine(validateConditionArity),
]));

function validateConditionArity(
  condition: { op: ConditionOperator; args: ValueExpr[] },
  context: z.RefinementCtx,
): void {
  const expected = condition.op === "not" ? 1 : condition.op === "and" || condition.op === "or" ? undefined : 2;
  if (expected !== undefined && condition.args.length !== expected) {
    context.addIssue({ code: "custom", message: `${condition.op} requires exactly ${expected} arguments.` });
  }
  if ((condition.op === "and" || condition.op === "or") && condition.args.length < 2) {
    context.addIssue({ code: "custom", message: `${condition.op} requires at least two arguments.` });
  }
}
