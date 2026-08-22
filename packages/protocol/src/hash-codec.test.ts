import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { decodeJson, encodeJson, JsonLinesDecoder, ProtocolError } from "./index";
import {
  canonicalStringify,
  hashCanonical,
  sha256HashSchema,
} from "./hash";
import { HASH_DOMAINS } from "./constants";

describe("canonical JSON and hash profile", () => {
  test("implements the fixed JCS ordering and a domain-separated golden vector", async () => {
    expect(canonicalStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(await hashCanonical(HASH_DOMAINS.documentContent, { b: 2, a: 1 })).toBe(
      sha256HashSchema.parse("sha256:450e6c1c04ae705d57862c4611b2a6f9a819b6efd0d534c5e2af77e14ba27331"),
    );
  });

  test("preserves Unicode instead of silently normalizing it", async () => {
    const composed = await hashCanonical(HASH_DOMAINS.documentContent, "é");
    const decomposed = await hashCanonical(HASH_DOMAINS.documentContent, "e\u0301");
    expect(composed).not.toBe(decomposed);
  });

  test("uses independent domains for identical values", async () => {
    const value = { stable: true };
    expect(await hashCanonical(HASH_DOMAINS.documentContent, value)).not.toBe(
      await hashCanonical(HASH_DOMAINS.componentContract, value),
    );
  });

  test("rejects every value outside the canonical JSON data model", () => {
    const sparse = new Array(1);
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "value", { enumerable: true, get: () => 1 });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => canonicalStringify({ value: undefined })).toThrow("Undefined value");
    expect(() => canonicalStringify(Number.NaN)).toThrow("Non-finite number");
    expect(() => canonicalStringify("\ud800")).toThrow("Unpaired high surrogate");
    expect(() => canonicalStringify(sparse)).toThrow("Sparse array");
    expect(() => canonicalStringify(accessor)).toThrow("Accessor property");
    expect(() => canonicalStringify(cyclic)).toThrow("Cyclic value");
    expect(() => canonicalStringify(1n)).toThrow("Unsupported bigint");
  });
});

describe("bounded strict JSON codec", () => {
  const schema = z.object({ value: z.string() }).strict();

  test("rejects duplicate and prototype-polluting keys before JSON.parse can collapse them", () => {
    expect(() => decodeJson('{"value":"a","value":"b"}', schema)).toThrow("Duplicate JSON object key");
    expect(() => decodeJson('{"value":"a","__proto__":{}}', schema)).toThrow("Forbidden JSON object key");
  });

  test("rejects malformed UTF-8 and oversized frames", () => {
    expect(() => decodeJson(new Uint8Array([0xc3, 0x28]), schema)).toThrow("not valid UTF-8");
    expect(() => decodeJson('{"value":"\\ud800"}', schema)).toThrow("unpaired Unicode surrogate");
    expect(() => decodeJson('{"value":"large"}', schema, { maxBytes: 8 })).toThrow("negotiated limit");
  });

  test("encodes canonical schema-validated bytes", () => {
    expect(new TextDecoder().decode(encodeJson({ value: "ok" }, schema))).toBe('{"value":"ok"}');
    expect(() => encodeJson({ value: "ok", extra: true } as never, schema)).toThrow("Unrecognized key");
  });

  test("decodes JSON Lines across a multi-byte UTF-8 boundary", () => {
    const bytes = new TextEncoder().encode('{"value":"汉字"}\n');
    const decoder = new JsonLinesDecoder(schema);
    expect([
      ...decoder.push(bytes.slice(0, 12)),
      ...decoder.push(bytes.slice(12)),
      ...decoder.finish(),
    ]).toEqual([{ value: "汉字" }]);
  });

  test("exposes stable diagnostics for transport failures", () => {
    try {
      decodeJson("{}", schema);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).diagnostics[0]?.code).toBe("decode.schema-invalid");
    }
  });
});
