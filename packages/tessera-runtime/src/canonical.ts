import { FORBIDDEN_OBJECT_KEYS } from "./constants";
import { throwDiagnostic } from "./diagnostics";

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
    if (!subtle) {
      throw new Error("Web Crypto is unavailable. Supply a portable HashProvider.");
    }
    const digest = await subtle.digest("SHA-256", bytes as BufferSource);
    return new Uint8Array(digest);
  },
});

export function canonicalize(value: unknown): string {
  const ancestors = new Set<object>();
  return serialize(value, ancestors, "$");
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

export async function canonicalHash(
  value: unknown,
  provider: HashProvider = webCryptoSha256Provider,
): Promise<string> {
  return bytesToHex(await provider.digest(canonicalBytes(value)));
}

export function canonicalHashSync(value: unknown, provider: SyncHashProvider): string {
  return bytesToHex(provider.digest(canonicalBytes(value)));
}

export function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

function serialize(value: unknown, ancestors: Set<object>, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        canonicalizationError("canonical.non-finite-number", `Non-finite number at ${path}.`);
      }
      return JSON.stringify(value);
    case "string":
      assertValidUnicode(value, path);
      return JSON.stringify(value);
    case "object":
      return serializeObject(value, ancestors, path);
    default:
      canonicalizationError(
        "canonical.unsupported-value",
        `Unsupported ${typeof value} value at ${path}.`,
      );
  }
}

function serializeObject(value: object, ancestors: Set<object>, path: string): string {
  if (ancestors.has(value)) {
    canonicalizationError("canonical.cycle", `Cyclic value at ${path}.`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item, index) => serialize(item, ancestors, `${path}[${index}]`)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      canonicalizationError("canonical.non-json-object", `Non-JSON object at ${path}.`);
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf16);
    const properties: string[] = [];
    for (const key of keys) {
      if (FORBIDDEN_OBJECT_KEYS.has(key)) {
        canonicalizationError("canonical.forbidden-key", `Forbidden object key at ${path}.${key}.`);
      }
      assertValidUnicode(key, `${path}.[key]`);
      const item = record[key];
      if (item === undefined) {
        canonicalizationError("canonical.undefined", `Undefined value at ${path}.${key}.`);
      }
      properties.push(`${JSON.stringify(key)}:${serialize(item, ancestors, `${path}.${key}`)}`);
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

function assertValidUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        canonicalizationError("canonical.invalid-unicode", `Unpaired high surrogate at ${path}.`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      canonicalizationError("canonical.invalid-unicode", `Unpaired low surrogate at ${path}.`);
    }
  }
}

function canonicalizationError(code: string, message: string): never {
  return throwDiagnostic({
    phase: "validate",
    code,
    severity: "fatal",
    recoverable: false,
    modelCorrectable: false,
    message,
  });
}
