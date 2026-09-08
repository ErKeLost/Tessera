import type { TesseraAgentPermissionContext } from "./contracts";

/** Shared by the execution gate and the model-visible authorization projection. */
export function resolveAgentPermissions(context: TesseraAgentPermissionContext | undefined) {
  const mutationsAvailable = context?.accessMode === "read-write"
    && context.databaseActionsAvailable === true;
  return {
    mutationsAvailable,
    readApprovalUnsupported: context?.sqlStatements.read === "ask",
    sqlStatements: {
      // Read approvals have no host checkpoint/execution port yet. Fail closed.
      read: context?.sqlStatements.read === "allow" ? "allow" as const : "deny" as const,
      write: mutationsAvailable ? context.sqlStatements.write : "deny" as const,
      destructive: mutationsAvailable ? context.sqlStatements.destructive : "deny" as const,
      unknown: mutationsAvailable ? context.sqlStatements.unknown : "deny" as const,
    },
  };
}
