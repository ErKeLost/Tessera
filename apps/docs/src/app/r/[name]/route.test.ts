import { afterEach, describe, expect, test } from "bun:test";
import type { NextRequest } from "next/server";
import { getRegistryOrigin, rewriteRegistryDependencies } from "./route";

const originalPublicUrl = process.env.DATA_ELEMENTS_PUBLIC_URL;
const originalDeployPrimeUrl = process.env.DEPLOY_PRIME_URL;
const originalNetlifyUrl = process.env.URL;
const originalVercelUrl = process.env.VERCEL_URL;

afterEach(() => {
  if (originalPublicUrl === undefined) delete process.env.DATA_ELEMENTS_PUBLIC_URL;
  else process.env.DATA_ELEMENTS_PUBLIC_URL = originalPublicUrl;
  if (originalDeployPrimeUrl === undefined) delete process.env.DEPLOY_PRIME_URL;
  else process.env.DEPLOY_PRIME_URL = originalDeployPrimeUrl;
  if (originalNetlifyUrl === undefined) delete process.env.URL;
  else process.env.URL = originalNetlifyUrl;
  if (originalVercelUrl === undefined) delete process.env.VERCEL_URL;
  else process.env.VERCEL_URL = originalVercelUrl;
});

describe("registry route", () => {
  test("only rewrites registry dependency URLs", () => {
    const payload = {
      content: 'const example = "http://localhost:3000/r/not-a-dependency.json";',
      items: [{
        registryDependencies: [
          "http://localhost:3000/r/all.json",
          "button",
          "https://example.com/r/external.json",
        ],
      }],
    };

    expect(rewriteRegistryDependencies(payload, "https://registry.example.com")).toEqual({
      ...payload,
      items: [{
        registryDependencies: [
          "https://registry.example.com/r/all.json",
          "button",
          "https://example.com/r/external.json",
        ],
      }],
    });
  });

  test("uses a configured public origin instead of request host headers", () => {
    process.env.DATA_ELEMENTS_PUBLIC_URL = "https://registry.example.com/path";
    delete process.env.VERCEL_URL;
    const request = {
      headers: new Headers({ host: "attacker.example", "x-forwarded-host": "attacker.example" }),
      nextUrl: new URL("http://localhost:3000/r/all.json"),
    } as unknown as NextRequest;

    expect(getRegistryOrigin(request)).toBe("https://registry.example.com");
  });

  test("rejects unsafe configured origins", () => {
    process.env.DATA_ELEMENTS_PUBLIC_URL = "file:///tmp/registry";
    const request = { nextUrl: new URL("http://localhost:3000/r/all.json") } as NextRequest;
    expect(() => getRegistryOrigin(request)).toThrow("HTTP or HTTPS");
  });

  test("uses the Netlify deploy URL when no canonical origin is configured", () => {
    delete process.env.DATA_ELEMENTS_PUBLIC_URL;
    delete process.env.VERCEL_URL;
    process.env.DEPLOY_PRIME_URL = "https://deploy-preview-42--artifact-agent.netlify.app";
    process.env.URL = "https://artifact-agent.netlify.app";
    const request = { nextUrl: new URL("http://localhost:3000/r/all.json") } as NextRequest;

    expect(getRegistryOrigin(request)).toBe("https://deploy-preview-42--artifact-agent.netlify.app");
  });
});
