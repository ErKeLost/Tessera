import { canonicalStringify } from "@open-generative/protocol";

export type MaybePromise<T> = T | Promise<T>;

export function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalStringify(value)) as T;
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

export function immutableClone<T>(value: T): T {
  return deepFreeze(cloneCanonical(value));
}

export function exhaustive(value: never): never {
  throw new TypeError(`Unexpected discriminant: ${String(value)}`);
}
