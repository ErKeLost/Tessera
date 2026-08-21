import { describe, expect, test } from "bun:test";
import {
  assistantReasoningHoldbackStart,
  isSafeAssistantReasoningFragment,
} from "./public-text";

describe("assistant reasoning safety", () => {
  test("allows SQL in native reasoning", () => {
    const reasoning = "Checked SELECT count(*) FROM orders against the requested period.";
    expect(isSafeAssistantReasoningFragment(reasoning)).toBeTrue();
    expect(assistantReasoningHoldbackStart(reasoning)).toBeUndefined();
  });

  test("holds split credentials, connection strings, JWTs, and opaque ids", () => {
    expect(assistantReasoningHoldbackStart("Checking api_")).toBe(9);
    expect(assistantReasoningHoldbackStart("postgres")).toBe(0);
    expect(assistantReasoningHoldbackStart("eyJabc123")).toBe(0);
    expect(assistantReasoningHoldbackStart("Using ent_1234")).toBe(6);
  });

  test("rejects completed credential-shaped reasoning", () => {
    expect(isSafeAssistantReasoningFragment("api_key=sk-test-secret-value")).toBeFalse();
    expect(isSafeAssistantReasoningFragment("postgresql://user:password@localhost/db")).toBeFalse();
    expect(isSafeAssistantReasoningFragment("Bearer private-access-token")).toBeFalse();
  });
});
