import { describe, expect, test } from "bun:test";
import {
  analyzeJsonDocument,
  formatJsonDocument,
  isJsonColumnType,
  MAX_JSON_CELL_WRITE_CHARS,
} from "./json-cell-editor";

describe("JSON cell editor helpers", () => {
  test("recognizes only scalar JSON database types", () => {
    expect(isJsonColumnType("json")).toBe(true);
    expect(isJsonColumnType(" JSONB ")).toBe(true);
    expect(isJsonColumnType("jsonb[]")).toBe(false);
    expect(isJsonColumnType("jsonpath")).toBe(false);
    expect(isJsonColumnType("text")).toBe(false);
  });

  test("formats JSON without changing number tokens or duplicate keys", () => {
    const source = '{"large":900719925474099312345,"duplicate":1,"duplicate":2,"text":"a, { b }"}';
    const formatted = formatJsonDocument(source);

    expect(formatted).toContain("900719925474099312345");
    expect(formatted.match(/"duplicate"/gu)).toHaveLength(2);
    expect(formatted).toContain('"text": "a, { b }"');
    expect(analyzeJsonDocument(formatted)).toMatchObject({
      compact: source,
      syntaxValid: true,
      withinWriteLimit: true,
    });
  });

  test("reports concrete syntax failures", () => {
    const result = analyzeJsonDocument('{"missing": }');

    expect(result.syntaxValid).toBe(false);
    expect(result.withinWriteLimit).toBe(false);
    expect(result.error).toStartWith("Invalid JSON:");
  });

  test("enforces the governed compact write boundary", () => {
    const atLimit = `"${"a".repeat(MAX_JSON_CELL_WRITE_CHARS - 2)}"`;
    const overLimit = `"${"a".repeat(MAX_JSON_CELL_WRITE_CHARS - 1)}"`;

    expect(analyzeJsonDocument(atLimit)).toMatchObject({
      syntaxValid: true,
      withinWriteLimit: true,
    });
    expect(analyzeJsonDocument(overLimit)).toMatchObject({
      syntaxValid: true,
      withinWriteLimit: false,
    });
  });
});
