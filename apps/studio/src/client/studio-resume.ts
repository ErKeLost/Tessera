const resumeFields = ["threadId", "runId", "toolCallId", "decision", "requestId", "checkpointId"] as const;

/** Builds the AI SDK reconnect URL from the current direct resume payload. */
export function studioResumeApi(body: unknown): string {
  const values = body && typeof body === "object" ? body as Record<string, unknown> : undefined;
  const params = new URLSearchParams();
  if (values !== undefined) {
    for (const key of resumeFields) {
      if (typeof values[key] === "string") params.set(key, values[key]);
    }
  }
  const query = params.toString();
  return query ? `/api/chat/resume?${query}` : "/api/chat/resume";
}
