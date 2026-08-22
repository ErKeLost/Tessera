import { z } from "zod";
import { brandedStringSchema, type BrandedString } from "./brand";
import {
  FORBIDDEN_OBJECT_KEYS,
  OPEN_GENERATIVE_HASH_PROFILE_ID,
  type HashDomain,
} from "./constants";
import { assertValidUnicode } from "./json";

export type Sha256Hash = BrandedString<"Sha256Hash">;

export const sha256HashSchema = brandedStringSchema<"Sha256Hash">(
  z.string().regex(/^sha256:[0-9a-f]{64}$/, "Expected a lowercase SHA-256 digest."),
);

export const hashProfileIdSchema = z.literal(OPEN_GENERATIVE_HASH_PROFILE_ID);
export type HashProfileId = z.infer<typeof hashProfileIdSchema>;

export const OPEN_GENERATIVE_HASH_PROFILE = Object.freeze({
  id: OPEN_GENERATIVE_HASH_PROFILE_ID,
  canonicalCodec: "RFC8785-JCS",
  characterEncoding: "UTF-8",
  unicodeNormalization: "preserve",
  invalidUnicode: "reject",
  numberNormalization: "ECMAScript-JSON",
  algorithm: "SHA-256",
  digestEncoding: "lowercase-hex",
} as const);

export interface HashProvider {
  readonly algorithm: "SHA-256";
  digest(bytes: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export interface SyncHashProvider extends HashProvider {
  digest(bytes: Uint8Array): Uint8Array;
}

export const webCryptoSha256Provider: HashProvider = Object.freeze({
  algorithm: "SHA-256" as const,
  async digest(bytes: Uint8Array): Promise<Uint8Array> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error("Web Crypto is unavailable. Supply a portable HashProvider.");
    const digest = await subtle.digest("SHA-256", bytes as BufferSource);
    return new Uint8Array(digest);
  },
});

export function canonicalStringify(value: unknown): string {
  return serialize(value, new Set<object>(), "$");
}

export function canonicalEncode(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalStringify(value));
}

export function domainSeparatedCanonicalBytes(domain: HashDomain, value: unknown): Uint8Array {
  const domainBytes = new TextEncoder().encode(domain);
  const contentBytes = canonicalEncode(value);
  const bytes = new Uint8Array(domainBytes.byteLength + contentBytes.byteLength);
  bytes.set(domainBytes, 0);
  bytes.set(contentBytes, domainBytes.byteLength);
  return bytes;
}

export async function hashCanonical(
  domain: HashDomain,
  value: unknown,
  provider: HashProvider = webCryptoSha256Provider,
): Promise<Sha256Hash> {
  assertSha256Provider(provider);
  return formatSha256Hash(await provider.digest(domainSeparatedCanonicalBytes(domain, value)));
}

export function hashCanonicalSync(
  domain: HashDomain,
  value: unknown,
  provider: SyncHashProvider,
): Sha256Hash {
  assertSha256Provider(provider);
  return formatSha256Hash(provider.digest(domainSeparatedCanonicalBytes(domain, value)));
}

export function formatSha256Hash(bytes: Uint8Array): Sha256Hash {
  if (bytes.byteLength !== 32) throw new TypeError("SHA-256 provider must return exactly 32 bytes.");
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return sha256HashSchema.parse(`sha256:${hex}`);
}

function assertSha256Provider(provider: HashProvider): void {
  if (provider.algorithm !== "SHA-256") throw new TypeError("Hash provider must implement SHA-256.");
}

function serialize(value: unknown, ancestors: Set<object>, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${path}.`);
      return JSON.stringify(value);
    }
    case "string":
      assertValidUnicode(value, path);
      return JSON.stringify(value);
    case "object":
      return serializeObject(value, ancestors, path);
    default:
      throw new TypeError(`Unsupported ${typeof value} value at ${path}.`);
  }
}

function serializeObject(value: object, ancestors: Set<object>, path: string): string {
  if (ancestors.has(value)) throw new TypeError(`Cyclic value at ${path}.`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new TypeError(`Sparse array at ${path}[${index}].`);
        }
        items.push(serialize(value[index], ancestors, `${path}[${index}]`));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Non-JSON object at ${path}.`);
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf16);
    const properties: string[] = [];
    for (const key of keys) {
      if (FORBIDDEN_OBJECT_KEYS.has(key)) throw new TypeError(`Forbidden object key at ${path}.${key}.`);
      assertValidUnicode(key, `${path}.[key]`);
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !("value" in descriptor)) throw new TypeError(`Accessor property at ${path}.${key}.`);
      if (descriptor.value === undefined) throw new TypeError(`Undefined value at ${path}.${key}.`);
      properties.push(`${JSON.stringify(key)}:${serialize(descriptor.value, ancestors, `${path}.${key}`)}`);
    }
    return `{${properties.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function compareUtf16(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
