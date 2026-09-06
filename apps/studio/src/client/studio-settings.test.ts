import { describe, expect, test } from "bun:test";
import { readPublicErrorMessage, readStudioSettingsSnapshot } from "./studio-settings";

describe("Studio settings permissions", () => {
  test("preserves a bounded server settings error for the form", () => {
    expect(readPublicErrorMessage({
      error: { message: "Tessera could not connect to the requested database." },
    })).toBe("Tessera could not connect to the requested database.");
    expect(readPublicErrorMessage({ error: { message: { unsafe: true } } })).toBeUndefined();
  });

  test("reads the compact database permission policy from the redacted settings snapshot", () => {
    const settings = readStudioSettingsSnapshot({
      settings: {
        database: { dialect: "postgres", accessMode: "read-write", urlConfigured: true },
        llm: {
          provider: "openrouter",
          model: "qwen/qwen3.8-27b",
          reasoningEffort: "low",
          apiKeyConfigured: true,
          apiKeySource: "environment",
        },
        limits: { maxRows: 1_000, timeoutMs: 30_000, maxSteps: 12 },
        permissions: {
          profile: "auto",
          sqlStatements: {
            read: "allow",
            write: "allow",
            destructive: "ask",
            unknown: "deny",
          },
        },
      },
    });

    expect(settings.permissions).toEqual({
      profile: "auto",
      sqlStatements: {
        read: "allow",
        write: "allow",
        destructive: "ask",
        unknown: "deny",
      },
    });
    expect(settings.llm).toMatchObject({
      apiKeyConfigured: true,
      apiKeySource: "environment",
    });
  });

  test("falls back to the conservative permission defaults for an invalid response", () => {
    const settings = readStudioSettingsSnapshot({
      settings: {
        permissions: {
          profile: "auto",
          sqlStatements: {
            read: "allow",
            write: "allow",
            destructive: "ask",
            unknown: "anything",
          },
        },
      },
    });

    expect(settings.permissions).toEqual({
      profile: "normal",
      sqlStatements: {
        read: "allow",
        write: "ask",
        destructive: "ask",
        unknown: "ask",
      },
    });
  });
});
