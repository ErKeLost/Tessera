import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  resourceBindingIdSchema,
  resourceVersionIdSchema,
  sha256HashSchema,
  surfaceSessionIdSchema,
  opaqueServerCursorSchema,
  type OpaqueServerCursor,
  type ResourceBindingId,
  type ResourceVersionId,
  type Sha256Hash,
  type SurfaceSessionId,
} from "@open-generative/protocol";
import { z } from "zod";

const resourceCursorClaimsSchema = z.object({
  bindingId: resourceBindingIdSchema,
  surfaceSessionId: surfaceSessionIdSchema,
  resourceVersionId: resourceVersionIdSchema,
  actorBindingHash: sha256HashSchema,
  projectionHash: sha256HashSchema,
  policyProjectionHash: sha256HashSchema,
  offset: z.number().int().nonnegative(),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict();

export type ResourceCursorClaims = Readonly<{
  bindingId: ResourceBindingId;
  surfaceSessionId: SurfaceSessionId;
  resourceVersionId: ResourceVersionId;
  actorBindingHash: Sha256Hash;
  projectionHash: Sha256Hash;
  policyProjectionHash: Sha256Hash;
  offset: number;
  expiresAt: string;
}>;

export interface ResourceCursorCodec {
  encode(claims: ResourceCursorClaims): OpaqueServerCursor;
  decode(cursor: OpaqueServerCursor): ResourceCursorClaims;
}

export class EncryptedResourceCursorCodec implements ResourceCursorCodec {
  readonly #key: Uint8Array;

  constructor(key: Uint8Array) {
    if (key.byteLength !== 32) throw new TypeError("Resource cursor encryption key must be 32 bytes.");
    this.#key = new Uint8Array(key);
  }

  encode(claims: ResourceCursorClaims): OpaqueServerCursor {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from("open-generative.resource-cursor.v1", "utf8"));
    const plaintext = Buffer.from(JSON.stringify(claims), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return opaqueServerCursorSchema.parse(`v1.${Buffer.concat([iv, tag, ciphertext]).toString("base64url")}`);
  }

  decode(cursorInput: OpaqueServerCursor): ResourceCursorClaims {
    const cursor = opaqueServerCursorSchema.parse(cursorInput);
    const [version, encoded, extra] = cursor.split(".");
    if (version !== "v1" || !encoded || extra !== undefined) throw new ResourceCursorError("resource.cursor-invalid", "Resource cursor format is invalid.");
    try {
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.byteLength < 29) throw new Error("Cursor is truncated.");
      const iv = bytes.subarray(0, 12);
      const tag = bytes.subarray(12, 28);
      const ciphertext = bytes.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
      decipher.setAAD(Buffer.from("open-generative.resource-cursor.v1", "utf8"));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return resourceCursorClaimsSchema.parse(JSON.parse(plaintext.toString("utf8")));
    } catch {
      throw new ResourceCursorError("resource.cursor-invalid", "Resource cursor authentication failed.");
    }
  }
}

export class ResourceCursorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ResourceCursorError";
  }
}
