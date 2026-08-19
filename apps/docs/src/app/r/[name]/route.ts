import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const LOCAL_REGISTRY_ORIGIN = "http://localhost:3000";
const PRODUCTION_REGISTRY_ORIGIN = "https://data-elements.dev";

function normalizeOrigin(value: string) {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Registry origin must be a credential-free HTTP or HTTPS URL.");
  }
  return url.origin;
}

export function getRegistryOrigin(request: NextRequest) {
  if (process.env.DATA_ELEMENTS_PUBLIC_URL) {
    return normalizeOrigin(process.env.DATA_ELEMENTS_PUBLIC_URL);
  }
  if (process.env.DEPLOY_PRIME_URL) {
    return normalizeOrigin(process.env.DEPLOY_PRIME_URL);
  }
  if (process.env.URL) {
    return normalizeOrigin(process.env.URL);
  }
  if (process.env.VERCEL_URL) {
    return normalizeOrigin(process.env.VERCEL_URL);
  }
  if (process.env.NODE_ENV === "production") {
    return PRODUCTION_REGISTRY_ORIGIN;
  }
  return normalizeOrigin(request.nextUrl.origin);
}

export function rewriteRegistryDependencies(value: unknown, origin: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteRegistryDependencies(entry, origin));
  }
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (key === "registryDependencies" && Array.isArray(entry)) {
      return [key, entry.map((dependency) => (
        typeof dependency === "string" && dependency.startsWith(`${LOCAL_REGISTRY_ORIGIN}/`)
          ? `${origin}${dependency.slice(LOCAL_REGISTRY_ORIGIN.length)}`
          : dependency
      ))];
    }
    return [key, rewriteRegistryDependencies(entry, origin)];
  }));
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!/^[a-z0-9-]+\.json$/.test(name)) return NextResponse.json({ error: "Invalid registry item." }, { status: 400 });

  try {
    const path = join(process.cwd(), ".registry", name);
    const content = await readFile(path, "utf8");
    const payload: unknown = JSON.parse(content);
    return NextResponse.json(rewriteRegistryDependencies(payload, getRegistryOrigin(request)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ error: `Registry item "${name}" was not found.` }, { status: 404 });
    }
    console.error(`Failed to serve registry item "${name}":`, error);
    return NextResponse.json({ error: "Registry item could not be loaded." }, { status: 500 });
  }
}
