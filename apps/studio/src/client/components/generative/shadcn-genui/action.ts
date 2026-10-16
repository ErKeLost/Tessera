import { action } from "@openuidev/react-lang";
import { z } from "zod";

/**
 * The action prop for interactive blocks.
 *
 * `action()` tags the schema as an `ActionExpression`, so the generated system
 * prompt teaches the OpenUI 1.0 step syntax instead of the legacy object shape:
 * one bare step such as `@ToAssistant("Tell me more")`, or `Action([...])` when
 * a click runs several steps. The legacy `{ type, params }` objects still parse
 * and render unchanged, so older stored answers keep working.
 */
export const actionSchema = action().optional();

export type ActionSchema = z.infer<typeof actionSchema>;
