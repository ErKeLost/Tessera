import { describe, expect, test } from "bun:test";
import { safeStudioErrorDetails, sanitizeStudioErrorText } from "./studio-logger";

describe("Studio error diagnostics", () => {
  test("keeps database error detail, hint, position, code, and cause chain", () => {
    const cause = Object.assign(new Error("socket closed during execution"), { name: "ConnectionError" });
    const error = Object.assign(new Error('relation "invoice_lines" does not exist'), {
      name: "PostgresError",
      code: "42P01",
      detail: "The referenced relation was not found in the active search path.",
      hint: "Use the exact schema-qualified relation name.",
      position: "22",
      cause,
    });

    expect(safeStudioErrorDetails(error)).toEqual({
      diagnosticCode: "42P01",
      errorType: "PostgresError",
      errorMessage: [
        'relation "invoice_lines" does not exist',
        "Detail: The referenced relation was not found in the active search path.",
        "Hint: Use the exact schema-qualified relation name.",
        "Position: 22",
        "Caused by ConnectionError: socket closed during execution",
      ].join(" "),
    });
  });

  test("redacts credentials, URLs, SQL, and provider payloads without hiding the concrete cause", () => {
    const value = sanitizeStudioErrorText([
      "OpenRouter returned 401: invalid credentials.",
      "authorization: Bearer provider-token-secret",
      "postgresql://reader:database-password@db.internal/warehouse",
      "query: SELECT card_number FROM private.payments",
      'response body: {"error":{"message":"raw-provider-payload"}}',
    ].join(" "));

    expect(value).toContain("OpenRouter returned 401: invalid credentials.");
    expect(value).toContain("[REDACTED]");
    expect(value).toContain("[REDACTED_SQL]");
    expect(value).toContain("[REDACTED_PROVIDER_PAYLOAD]");
    expect(value).not.toContain("provider-token-secret");
    expect(value).not.toContain("database-password");
    expect(value).not.toContain("card_number");
    expect(value).not.toContain("raw-provider-payload");
  });
});
