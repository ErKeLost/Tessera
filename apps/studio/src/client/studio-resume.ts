/** Identifies a Mastra tool continuation sent through the normal chat POST. */
export function isStudioResumePayload(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return (body.decision === "approve" || body.decision === "reject")
    && typeof body.threadId === "string"
    && typeof body.runId === "string"
    && typeof body.toolCallId === "string"
    && typeof body.requestId === "string"
    && typeof body.checkpointId === "string";
}
