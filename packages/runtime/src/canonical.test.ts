import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  canonicalHash,
  canonicalize,
  createJsonCodec,
  evaluatePresentationCondition,
  JsonLinesDecoder,
  resolveArtifactValue,
} from "./index";

describe("canonical JSON and portable hashing", () => {
  test("implements deterministic RFC 8785-style ordering and SHA-256", async () => {
    expect(canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(await canonicalHash({ b: 2, a: 1 })).toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
  });

  test("rejects values that have no canonical JSON representation", () => {
    expect(() => canonicalize({ value: undefined })).toThrow("Undefined value");
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow("Non-finite");
    expect(() => canonicalize("\ud800")).toThrow("Unpaired high surrogate");
  });
});

describe("bounded JSON codec", () => {
  const schema = z.object({ value: z.string() }).strict();

  test("rejects duplicate keys before JSON.parse can collapse them", () => {
    const codec = createJsonCodec(schema);
    expect(() => codec.decode('{"value":"a","value":"b"}')).toThrow("Duplicate JSON object key");
  });

  test("decodes byte chunks across a multi-byte UTF-8 boundary", () => {
    const bytes = new TextEncoder().encode('{"value":"汉字"}\n');
    const decoder = new JsonLinesDecoder(schema);
    const first = decoder.push(bytes.slice(0, 12));
    const second = decoder.push(bytes.slice(12));
    const final = decoder.finish();
    expect([...first, ...second, ...final]).toEqual([{ value: "汉字" }]);
  });

  test("enforces frame byte limits before parsing", () => {
    const codec = createJsonCodec(schema, { maxBytes: 8 });
    expect(() => codec.decode('{"value":"large"}')).toThrow("negotiated limit");
  });
});

describe("tagged value algebra", () => {
  test("resolves own-property paths without prototype lookup", () => {
    const resolved = resolveArtifactValue(
      { kind: "state-ref", stateId: "filter", path: ["selection", 0] },
      { state: { filter: { selection: ["active"] } } },
    );
    expect(resolved).toEqual({ ok: true, value: "active" });

    const blocked = resolveArtifactValue(
      { kind: "state-ref", stateId: "filter", path: ["toString"] },
      { state: { filter: {} } },
    );
    expect(blocked.ok).toBe(false);
  });

  test("conditions do not coerce and fail closed", () => {
    const valid = evaluatePresentationCondition({
      kind: "condition",
      op: "gt",
      args: [{ kind: "literal", value: 2 }, { kind: "literal", value: 1 }],
    }, {});
    expect(valid.value).toBe(true);

    const invalid = evaluatePresentationCondition({
      kind: "condition",
      op: "gt",
      args: [{ kind: "literal", value: "2" }, { kind: "literal", value: 1 }],
    }, {});
    expect(invalid.value).toBe(false);
    expect(invalid.diagnostic?.code).toBe("condition.invalid-operands");
  });
});
