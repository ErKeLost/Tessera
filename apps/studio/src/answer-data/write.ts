import { databaseActionSchema, type DatabaseAction } from "@open-tessera/database";
import type {
  TesseraDatabaseActionActor,
  TesseraDatabaseActionEffect,
  TesseraDatabaseActionService,
} from "../database-actions";
import type { AnswerActionRequest } from "./contracts";

/**
 * Answer writes.
 *
 * The browser sends the same model-facing mutation the Agent tool accepts. The
 * catalog envelope — connection ref, database ref, catalog fingerprint — is
 * composed here from the live catalog and from nowhere else, so the browser can
 * never pin an action to a stale catalog or a foreign connection. Execution and
 * approval stay inside the governed `TesseraDatabaseActionService`.
 */

export type AnswerActionCatalog = Readonly<{
  databaseName?: string;
  fingerprint: string;
}>;

/**
 * Mirrors the Agent's `execute_sql` mutation envelope so both paths send the
 * service one identical action shape. Kept side by side with the model schema
 * on purpose: if the envelope changes, both call sites change together.
 */
export function composeAnswerDatabaseAction(
  mutation: AnswerActionRequest["mutation"],
  catalog: AnswerActionCatalog,
): DatabaseAction {
  return databaseActionSchema.parse({
    version: 1,
    connectionRef: "tessera",
    ...(catalog.databaseName === undefined ? {} : { databaseRef: catalog.databaseName }),
    catalogFingerprint: catalog.fingerprint,
    ...mutation,
  });
}

export type SubmitAnswerDatabaseActionInput = Readonly<{
  actor: TesseraDatabaseActionActor;
  service: TesseraDatabaseActionService;
  catalog: AnswerActionCatalog;
  request: AnswerActionRequest;
  /** Stable id makes a transport retry replay-safe instead of executing twice. */
  requestId?: string;
}>;

export function submitAnswerDatabaseAction(
  input: SubmitAnswerDatabaseActionInput,
): Promise<TesseraDatabaseActionEffect> {
  const action = composeAnswerDatabaseAction(input.request.mutation, input.catalog);
  return input.service.submit({
    actor: input.actor,
    action,
    purpose: input.request.purpose,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  });
}
