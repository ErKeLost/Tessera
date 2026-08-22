import { createHash } from "node:crypto";
import {
  actorAuditRefSchema,
  canonicalEncode,
  sha256HashSchema,
  type ActorAuditRef,
  type Sha256Hash,
} from "@open-generative/protocol";

export type AuthorityContext = Readonly<{
  actorAuditRef: ActorAuditRef;
  actorBindingHash: Sha256Hash;
  tenantBindingHash: Sha256Hash;
  authorityPolicyRevision: string;
}>;

export function createAuthorityContext(input: AuthorityContext): AuthorityContext {
  return Object.freeze({
    actorAuditRef: actorAuditRefSchema.parse(input.actorAuditRef),
    actorBindingHash: sha256HashSchema.parse(input.actorBindingHash),
    tenantBindingHash: sha256HashSchema.parse(input.tenantBindingHash),
    authorityPolicyRevision: input.authorityPolicyRevision,
  });
}

export function hashAuthorityContext(authority: AuthorityContext): Sha256Hash {
  return serverHash("open-generative.authority-context\0", authority);
}

export function hashAudienceBinding(authority: AuthorityContext): Sha256Hash {
  return serverHash("open-generative.audience-binding\0", {
    actorBindingHash: authority.actorBindingHash,
    tenantBindingHash: authority.tenantBindingHash,
  });
}

function serverHash(domain: string, value: unknown): Sha256Hash {
  const hash = createHash("sha256");
  hash.update(domain, "utf8");
  hash.update(canonicalEncode(value));
  return sha256HashSchema.parse(`sha256:${hash.digest("hex")}`);
}
