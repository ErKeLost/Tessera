import { describe, expect, test } from "bun:test";
import { getSwipeThemeKeyframes, normalizeSwipeDirection } from "./swipe-theme-provider";

describe("SwipeThemeProvider", () => {
  test("normalizes the short direction names", () => {
    expect(normalizeSwipeDirection("left")).toBe("left-to-right");
    expect(normalizeSwipeDirection("right")).toBe("right-to-left");
    expect(normalizeSwipeDirection("top")).toBe("top-to-bottom");
    expect(normalizeSwipeDirection("bottom")).toBe("bottom-to-top");
  });

  test("reveals a new theme from the selected corner", () => {
    expect(getSwipeThemeKeyframes("top-right", 98)).toEqual([
      { clipPath: "polygon(100% 0, 100% 0, 100% 0)" },
      { clipPath: "polygon(100% 0, -100% 0, 100% 200%)" },
    ]);
  });
});
