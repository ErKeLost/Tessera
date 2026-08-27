import {
  tesseraAgentIdentitySchema,
  type TesseraAgentIdentity,
} from "./contracts";

/** Stable Mastra memory owner. This value stays server-side and is never a resource grant. */
export function tesseraAgentResourceId(identity: TesseraAgentIdentity): string {
  const validated = tesseraAgentIdentitySchema.parse(identity);
  return `tenant:${validated.tenantId}\u001fsubject:${validated.subject}`;
}
