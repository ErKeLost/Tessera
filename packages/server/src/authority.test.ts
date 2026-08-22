import { describe, expect, test } from "bun:test";
import { actorAuditRefSchema, sha256HashSchema } from "@open-generative/protocol";
import {
  createAuthorityContext,
  hashAudienceBinding,
  hashAuthorityContext,
} from "./authority";

const hash = (character: string) => sha256HashSchema.parse(`sha256:${character.repeat(64)}`);

describe("AuthorityContext", () => {
  test("separates the complete authority identity from its audience binding", () => {
    const base = createAuthorityContext({
      actorAuditRef: actorAuditRefSchema.parse("audit:actor-1"),
      actorBindingHash: hash("a"),
      tenantBindingHash: hash("b"),
      authorityPolicyRevision: "policy:1",
    });
    const changedPolicy = createAuthorityContext({
      ...base,
      authorityPolicyRevision: "policy:2",
    });

    expect(hashAuthorityContext(base)).not.toBe(hashAuthorityContext(changedPolicy));
    expect(hashAudienceBinding(base)).toBe(hashAudienceBinding(changedPolicy));
    expect(Object.isFrozen(base)).toBe(true);
  });
});
