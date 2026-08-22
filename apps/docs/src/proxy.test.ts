import { describe, expect, test } from "bun:test";
import { type NextFetchEvent, NextRequest } from "next/server";
import proxy from "./proxy";

const event = {} as NextFetchEvent;
const internalRewriteHeader = "x-tessera-default-locale-rewrite";

describe("documentation locale proxy", () => {
  test("rewrites the hidden default locale once without redirecting the internal request", async () => {
    const external = await proxy(
      new NextRequest("http://localhost:3000/docs/components/generative-ui-catalog"),
      event,
    );
    expect(external.headers.get("x-middleware-rewrite")).toBe(
      "http://localhost:3000/en/docs/components/generative-ui-catalog",
    );
    expect(external.headers.get(`x-middleware-request-${internalRewriteHeader}`)).toBe("en");

    const internal = await proxy(
      new NextRequest("http://localhost:3000/en/docs/components/generative-ui-catalog", {
        headers: { [internalRewriteHeader]: "en" },
      }),
      event,
    );
    expect(internal.headers.get("x-middleware-next")).toBe("1");
    expect(internal.headers.get("location")).toBeNull();
  });

  test("keeps one canonical external URL for each language", async () => {
    const english = await proxy(
      new NextRequest("http://localhost:3000/en/docs/components/generative-ui-catalog"),
      event,
    );
    expect(english.status).toBe(307);
    expect(english.headers.get("location")).toBe(
      "http://localhost:3000/docs/components/generative-ui-catalog",
    );

    const chinese = await proxy(
      new NextRequest("http://localhost:3000/zh/docs/components/generative-ui-catalog"),
      event,
    );
    expect(chinese.headers.get("x-middleware-next")).toBe("1");
  });
});
