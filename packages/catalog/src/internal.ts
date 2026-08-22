import {
  canonicalStringify,
  hashCanonical,
  type HashDomain,
  type HashProvider,
  type Sha256Hash,
} from "@open-generative/protocol";
import type { z } from "zod";

export class CatalogIntegrityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CatalogIntegrityError";
    this.code = code;
  }
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export function canonicalKey(value: unknown): string {
  return canonicalStringify(value);
}

export function canonicalSet<T>(values: readonly T[]): T[] {
  const byKey = new Map<string, T>();
  for (const value of values) {
    const key = canonicalKey(value);
    if (byKey.has(key)) {
      throw new CatalogIntegrityError("catalog.duplicate-entry", `Duplicate canonical entry: ${key}`);
    }
    byKey.set(key, value);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => compareUtf16(left, right))
    .map(([, value]) => value);
}

export function sortedUniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareUtf16);
}

export function addCanonicalSetIssues<T>(
  values: readonly T[],
  context: z.RefinementCtx,
  path: PropertyKey,
): void {
  const keys = values.map(canonicalKey);
  const seen = new Set<string>();
  for (const [index, key] of keys.entries()) {
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        message: "Entries must be unique.",
        path: [path, index],
      });
    }
    seen.add(key);
  }
  const sorted = [...keys].sort(compareUtf16);
  if (keys.some((key, index) => key !== sorted[index])) {
    context.addIssue({
      code: "custom",
      message: "Entries must use canonical ordering.",
      path: [path],
    });
  }
}

export function addSortedUniqueStringIssues(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey,
): void {
  const expected = sortedUniqueStrings(values);
  if (expected.length !== values.length) {
    context.addIssue({ code: "custom", message: "Entries must be unique.", path: [path] });
  }
  if (values.some((value, index) => value !== expected[index])) {
    context.addIssue({ code: "custom", message: "Entries must use canonical ordering.", path: [path] });
  }
}

export async function computeHash(
  domain: HashDomain,
  value: unknown,
  provider?: HashProvider,
): Promise<Sha256Hash> {
  return provider === undefined
    ? hashCanonical(domain, value)
    : hashCanonical(domain, value, provider);
}

export function assertHash(actual: Sha256Hash, expected: Sha256Hash, code: string, label: string): void {
  if (actual !== expected) {
    throw new CatalogIntegrityError(code, `${label} integrity check failed: expected ${expected}, received ${actual}.`);
  }
}

function compareUtf16(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
