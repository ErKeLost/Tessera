import { describe, expect, test } from "bun:test";
import {
  decodeOpenGenerativeAgUiEvent,
  isOpenGenerativeAgUiEvent,
} from "./client";

describe("AG-UI client adapter", () => {
  test("ignores unrelated custom events", async () => {
    const event = { type: "CUSTOM", name: "another.event", value: {} };
    expect(isOpenGenerativeAgUiEvent(event)).toBe(false);
    expect(await decodeOpenGenerativeAgUiEvent(event)).toBeUndefined();
  });

  test("rejects malformed Open Generative events", async () => {
    const event = { type: "CUSTOM", name: "open-generative.surface.event", value: {} };
    expect(isOpenGenerativeAgUiEvent(event)).toBe(false);
    expect(decodeOpenGenerativeAgUiEvent(event)).rejects.toThrow();
  });
});
