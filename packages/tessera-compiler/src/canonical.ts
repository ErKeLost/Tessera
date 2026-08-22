import { createHash } from "node:crypto";
import type { JsonValue } from "./types";

const forbiddenObjectKeys = new Set(["__proto__", "constructor", "prototype"]);

export function assertJsonValue(value: unknown, path = "$"): asserts value is JsonValue {
  const ancestors = new Set<object>();

  const visit = (current: unknown, currentPath: string): void => {
    if (
      current === null
      || typeof current === "string"
      || typeof current === "boolean"
    ) return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new TypeError(`Expected a finite number at ${currentPath}.`);
      }
      return;
    }
    if (typeof current !== "object") {
      throw new TypeError(`Expected JSON data at ${currentPath}.`);
    }
    if (ancestors.has(current)) {
      throw new TypeError(`Cyclic JSON data at ${currentPath}.`);
    }

    ancestors.add(current);
    if (Array.isArray(current)) {
      for (const [index, item] of current.entries()) {
        visit(item, `${currentPath}/${index}`);
      }
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`Expected a plain JSON object at ${currentPath}.`);
      }
      for (const [key, item] of Object.entries(current)) {
        if (forbiddenObjectKeys.has(key)) {
          throw new TypeError(`Forbidden object key at ${currentPath}/${key}.`);
        }
        visit(item, `${currentPath}/${escapeJsonPointer(key)}`);
      }
    }
    ancestors.delete(current);
  };

  visit(value, path);
}

export function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key]!)}`)
    .join(",")}}`;
}

export function hashJson(value: JsonValue): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function escapeJsonPointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
