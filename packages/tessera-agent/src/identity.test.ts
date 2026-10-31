import { describe, expect, test } from "bun:test";
import { tesseraAgentResourceId } from "./identity";

/**
 * Mastra forwards the memory resource to the provider as the `x-resource-id`
 * request header. Provider gateways reject a control character with an empty
 * `400`, so the id must stay visible ASCII.
 */
const HEADER_SAFE = /^[\u0020-\u007e]+$/u;

describe("tesseraAgentResourceId", () => {
  test("stays a header-safe ASCII value for a cloud identity", () => {
    const resourceId = tesseraAgentResourceId({ tenantId: "local-studio", subject: "local-user" });
    expect(resourceId).toMatch(HEADER_SAFE);
    expect(resourceId).toBe("tenant:local-studio:subject:local-user");
  });

  test("percent-encodes separators and non-ASCII identity parts", () => {
    const resourceId = tesseraAgentResourceId({ tenantId: "acme:prod", subject: "张 三" });
    expect(resourceId).toMatch(HEADER_SAFE);
    expect(resourceId).toBe(`tenant:acme%3Aprod:subject:${encodeURIComponent("张 三")}`);
  });

  test("keeps distinct identities distinct and deterministic", () => {
    const first = tesseraAgentResourceId({ tenantId: "acme", subject: "a:b" });
    const second = tesseraAgentResourceId({ tenantId: "acme", subject: "a%3Ab" });
    expect(first).toBe(tesseraAgentResourceId({ tenantId: "acme", subject: "a:b" }));
    expect(first).not.toBe(second);
    expect(first).toMatch(HEADER_SAFE);
    expect(second).toMatch(HEADER_SAFE);
    expect(tesseraAgentResourceId({ tenantId: "acme", subject: "a" }))
      .not.toBe(tesseraAgentResourceId({ tenantId: "acme2", subject: "a" }));
  });
});
