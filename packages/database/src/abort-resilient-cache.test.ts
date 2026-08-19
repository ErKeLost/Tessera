import { describe, expect, test } from "bun:test";
import { createAbortResilientAsyncCache } from "./abort-resilient-cache";

describe("createAbortResilientAsyncCache", () => {
  test("does not let a cancelled caller poison a shared load", async () => {
    let resolveLoad: ((value: string[]) => void) | undefined;
    let loads = 0;
    const cache = createAbortResilientAsyncCache(async () => {
      loads += 1;
      return new Promise<string[]>((resolve) => {
        resolveLoad = resolve;
      });
    });
    const controller = new AbortController();
    const cancelled = cache.get(controller.signal);
    controller.abort();

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(loads).toBe(1);

    resolveLoad?.(["public"]);
    await expect(cache.get()).resolves.toEqual(["public"]);
    expect(loads).toBe(1);
  });

  test("retries after a failed load", async () => {
    let loads = 0;
    const cache = createAbortResilientAsyncCache(async () => {
      loads += 1;
      if (loads === 1) throw new Error("transient discovery failure");
      return ["public"];
    });

    await expect(cache.get()).rejects.toThrow("transient discovery failure");
    await expect(cache.get()).resolves.toEqual(["public"]);
    expect(loads).toBe(2);
  });
});
