import { join } from "node:path";

const root = join(import.meta.dir, "..");
const docsDirectory = join(root, "apps", "docs");
const nextCli = join(docsDirectory, "node_modules", "next", "dist", "bin", "next");
const port = readPort(process.env.DATA_ELEMENTS_SMOKE_PORT);
const origin = `http://127.0.0.1:${port}`;

const server = Bun.spawn([
  "node",
  nextCli,
  "start",
  "--hostname",
  "127.0.0.1",
  "--port",
  String(port),
], {
  cwd: docsDirectory,
  env: {
    ...process.env,
    NODE_ENV: "production",
    OPENROUTER_API_KEY: "",
    ARTIFACT_BACKGROUND_ALLOWED_ORIGINS: "",
    ARTIFACT_BACKGROUND_ACCESS_TOKEN: "",
    ARTIFACT_BACKGROUND_SESSION_SECRET: "",
    UPSTASH_REDIS_REST_URL: "",
    UPSTASH_REDIS_REST_TOKEN: "",
    BACKGROUND_PERFORMANCE_LOG: "0",
    ARTIFACT_OTLP_LOGS_ENDPOINT: "",
  },
  stdout: "pipe",
  stderr: "pipe",
});

const stdoutPromise = new Response(server.stdout).text();
const stderrPromise = new Response(server.stderr).text();

try {
  await waitForReady(server, `${origin}/api/health`);

  const background = await fetch(`${origin}/background`);
  assertStatus(background, 200, "GET /background");
  assertHeader(background, "x-content-type-options", "nosniff");
  assertHeaderIncludes(background, "content-security-policy", "frame-ancestors 'none'");
  const html = await background.text();
  if (!html.includes("Artifact Playground")) {
    throw new Error("GET /background did not return the production Playground document.");
  }
  const htmlBytes = Buffer.byteLength(html);
  if (htmlBytes > 30_000) {
    throw new Error(`GET /background exceeded the 30 KB HTML budget (${htmlBytes} bytes).`);
  }

  const initialScripts = await assertInitialScriptBudget(html);

  const health = await fetch(`${origin}/api/health`);
  assertStatus(health, 200, "GET /api/health");
  assertHeader(health, "cache-control", "no-store, max-age=0");
  const healthPayload = await health.json() as { status?: unknown; readiness?: unknown };
  if (healthPayload.status !== "ok" || healthPayload.readiness !== "ready") {
    throw new Error("GET /api/health returned an invalid readiness payload.");
  }

  const access = await fetch(`${origin}/api/background/access`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  await assertJsonError(access, 400, "background_access_invalid_request");

  const paidRoute = await fetch(`${origin}/api/background`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  await assertJsonError(paidRoute, 503, "background_security_unconfigured");

  console.info(
    `Production docs smoke test passed (${htmlBytes} HTML bytes, ${initialScripts.count} scripts, ${initialScripts.bytes} raw JS bytes).`,
  );
} catch (error) {
  server.kill();
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (stdout.trim()) console.error(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
  throw error;
} finally {
  server.kill();
  await server.exited;
}

async function assertInitialScriptBudget(html: string): Promise<{ count: number; bytes: number }> {
  const sources = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]!);
  if (sources.length === 0 || sources.length > 18) {
    throw new Error(`GET /background exceeded the 18-script budget (${sources.length} scripts).`);
  }

  const chunks = await Promise.all(sources.map(async (source) => {
    const response = await fetch(new URL(source, origin));
    assertStatus(response, 200, `GET ${source}`);
    return new Uint8Array(await response.arrayBuffer());
  }));
  const bytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  if (bytes > 1_350_000) {
    throw new Error(`GET /background exceeded the 1.35 MB raw initial-JS budget (${bytes} bytes).`);
  }

  const code = chunks.map((chunk) => new TextDecoder().decode(chunk)).join("\n");
  for (const marker of ["recharts", "streamdown", "@streamdown/mermaid", "katex", "decodeArtifactPart"]) {
    if (code.includes(marker)) {
      throw new Error(`GET /background eagerly loaded deferred dependency marker: ${marker}.`);
    }
  }
  return { count: sources.length, bytes };
}

async function assertJsonError(response: Response, status: number, code: string): Promise<void> {
  assertStatus(response, status, `${response.url} error contract`);
  assertHeader(response, "cache-control", "no-store");
  const payload = await response.json() as { error?: { code?: unknown } };
  if (payload.error?.code !== code) {
    throw new Error(`${response.url} returned error code ${String(payload.error?.code)} instead of ${code}.`);
  }
}

function assertStatus(response: Response, status: number, label: string): void {
  if (response.status !== status) {
    throw new Error(`${label} returned ${response.status}; expected ${status}.`);
  }
}

function assertHeader(response: Response, name: string, expected: string): void {
  const actual = response.headers.get(name);
  if (actual !== expected) {
    throw new Error(`${response.url} returned ${name}: ${String(actual)}; expected ${expected}.`);
  }
}

function assertHeaderIncludes(response: Response, name: string, expected: string): void {
  const actual = response.headers.get(name);
  if (!actual?.includes(expected)) {
    throw new Error(`${response.url} returned ${name}: ${String(actual)}; expected it to include ${expected}.`);
  }
}

async function waitForReady(processHandle: ReturnType<typeof Bun.spawn>, url: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`The production docs server exited with code ${processHandle.exitCode}.`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is still binding its listener.
    }
    await Bun.sleep(100);
  }
  throw new Error("The production docs server did not become ready within 20 seconds.");
}

function readPort(value: string | undefined): number {
  if (!value) return 3199;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_024 || parsed > 65_535) {
    throw new TypeError("DATA_ELEMENTS_SMOKE_PORT must be an integer from 1024 through 65535.");
  }
  return parsed;
}
