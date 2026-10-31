import {
  tesseraAgentIdentitySchema,
  type TesseraAgentIdentity,
} from "./contracts";

/**
 * Stable Mastra memory owner. This value stays server-side and is never a resource grant.
 *
 * Mastra copies the memory resource onto every model request as the
 * `x-resource-id` HTTP header, so the value has to be visible ASCII. A control
 * character such as the unit separator used by older builds makes strict
 * provider gateways reject the call with an empty `400` before the model runs,
 * which surfaces to users as an unexplained stream failure. Percent-encoding
 * keeps the id reversible, deterministic, and safe to forward as a header.
 */
export function tesseraAgentResourceId(identity: TesseraAgentIdentity): string {
  const validated = tesseraAgentIdentitySchema.parse(identity);
  return `tenant:${encodeResourcePart(validated.tenantId)}:subject:${encodeResourcePart(validated.subject)}`;
}

/** Percent-encodes one identity part after neutralizing unpaired surrogates. */
function encodeResourcePart(value: string): string {
  return encodeURIComponent(value.replace(LONE_SURROGATE, "\uFFFD"));
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;
