import { describe, expect, test } from "bun:test";
import { eventOriginatedWithinCurrentTarget } from "./event-boundary";

describe("portal-aware event boundary", () => {
  test("accepts events whose DOM path crosses the current target", () => {
    const cell = {} as EventTarget;
    const shadowHost = {} as EventTarget;

    expect(eventOriginatedWithinCurrentTarget({
      currentTarget: cell,
      nativeEvent: { composedPath: () => [shadowHost, cell] },
    })).toBe(true);
  });

  test("rejects React portal events outside the current target DOM tree", () => {
    const cell = {} as EventTarget;
    const popover = {} as EventTarget;

    expect(eventOriginatedWithinCurrentTarget({
      currentTarget: cell,
      nativeEvent: { composedPath: () => [popover] },
    })).toBe(false);
  });
});
