# Data Elements

An embedded runtime for persistent, continuously editable semantic business
Artifacts, built as a Bun and Turborepo monorepo with tsdown packages and a
Fumadocs website.

Data Elements lets an existing admin or business system host governed Artifact
surfaces without asking a model to generate an application or executable UI
code. The model may propose declarations; the host owns data, authority,
effects, persistence, and final commits. React and shadcn/ui remain the default
renderer implementation and editable source distribution.

## Tessera

**Tessera** is the product built on this runtime: a local-first, governed data
analysis agent for PostgreSQL, MySQL, SQLite, and Turso. By default it inspects every
non-system schema visible to the configured database credential, executes
bounded read-only analysis, and returns a verified Markdown response with
compact execution progress and evidence rather than a generated application.

The naming boundary is deliberate:

| Name | Role |
| --- | --- |
| **Tessera** | User-facing data-analysis product |
| **Tessera Studio** | Local workspace connected to a configured database for Markdown chat, querying, and inspecting execution evidence |
| **Tessera Agent** | Governed agent that plans and runs database analysis |
| `tessera.config.ts` | Server-only project configuration |
| `tessera studio` | Local Studio command |
| **Data Elements** | Underlying Artifact runtime and editable component distribution |

Use this as the conventional project configuration:

```ts
// tessera.config.ts
import { defineTesseraConfig } from "@data-elements/studio";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required by Tessera Studio.");

export default defineTesseraConfig({
  database: {
    url: databaseUrl,
  },
});
```

Omit `database.schemas` for the default administrator-style discovery scope:
all non-system schemas that the configured database credential can read are
available to catalog discovery and analysis. Set `database.schemas` only when
you deliberately want to narrow that scope. This does not bypass native
database grants, and Agent SQL remains read-only in either case.

Tessera infers the database engine from the URL: `postgres://` or
`postgresql://` for PostgreSQL, `mysql://` for MySQL, `file:` or `sqlite:` for
SQLite, and `libsql:` or `turso:` for Turso. SQLite and Turso share SQLite SQL
semantics while keeping their local and remote connection configuration
separate. Set `database.dialect` only when you want an explicit guard against
connecting to a URL of the wrong database family.

Turso credentials stay separate from the URL. Set `database.authToken` in the
server-only config, or omit it and provide `TURSO_AUTH_TOKEN` in the server
environment.

`DATABASE_URL` and provider credentials remain server-only in the normal
project configuration. For a one-off local session, `tessera studio <database-url>`
can provide the database URL directly; `tessera.config.ts` remains the durable,
reviewable setup for a project. Tessera never logs the positional URL, but normal
shell history and process-list caveats still apply.

```bash
tessera studio
tessera studio postgresql://readonly:password@127.0.0.1:5432/warehouse
tessera studio mysql://readonly:password@127.0.0.1:3306/warehouse
tessera studio file:/absolute/path/to/warehouse.db
TURSO_AUTH_TOKEN=... tessera studio libsql://warehouse-org.turso.io
```

Studio and its SQLite/Turso connectors run on Node.js 24 or later and Bun 1.3
or later.

Host applications can start the same Studio through the library API:

```ts
import { startTesseraStudio } from "@data-elements/studio";

const studio = await startTesseraStudio({
  database: {
    url: process.env.DATABASE_URL!,
  },
});

console.log(studio.url);
```

The browser never receives the database URL, provider key, or a database driver.

The repository currently contains the v2 protocol, compiler, runtime,
capability/resource boundaries, adapters, and renderer foundation. The durable
create/edit/restore lifecycle and unified `ArtifactHost` facade are the target
architecture, not a claim of already shipped behavior.

## Why

- **Predictable selection** — every artifact declares when it should and should
  not be used.
- **Safe by construction** — models provide validated data, never executable
  JavaScript, HTML, CSS, or formulas.
- **Host embedded** — the same Artifact can live inline, in a panel, drawer, or
  fullscreen host placement without becoming a separate generated app.
- **Interaction first** — controls update local state and emit typed intents;
  host-owned capabilities execute authorized business effects.
- **Data native** — query lineage, SQL, tables, metrics, comparisons, and
  calculators are first-class.
- **shadcn distribution** — install source from the registry and make it yours.

## Product boundary

Generative UI is an optional authoring input, not the runtime or product
boundary. Data Elements does not generate applications, routes, HTML,
JavaScript, CSS, React code, iframes, or arbitrary executable components.

The normative product, lifecycle, security, storage, performance, and migration
design is documented in the
[Embedded Business Artifact Runtime target architecture](apps/docs/content/docs/concepts/embedded-artifact-runtime.mdx).

## Quick start

```bash
bun install
bun run dev
```

The docs app opens at `http://localhost:3000`.

The release-facing CLI contract is shown below. The `data-elements` npm
packages and `data-elements.dev` registry are not published yet, so these
commands become available only after the first public release:

```bash
npx data-elements@latest
```

Or add only the artifacts you need:

```bash
npx data-elements@latest add query-artifact metric-artifact
```

```ts
import { createArtifactUI } from "@data-elements/ai-sdk";
import { streamText } from "ai";

const artifactUI = createArtifactUI();
const turn = await artifactUI.prepareTurn({ messages });

const result = streamText({
  model,
  messages: turn.messages,
  system: turn.system,
  tools: turn.tools,
});
return turn.toUIMessageStreamResponse(result);
```

```tsx
import { decodeArtifactPart } from "@data-elements/runtime";
import { ArtifactRenderer } from "@/components/data-elements/artifact-ui";

const decoded = await decodeArtifactPart(dataArtifactPart.data.part, {
  contractFingerprint: dataArtifactPart.data.contractFingerprint,
});

if (!decoded.success) throw new Error("Artifact transport validation failed.");
return <ArtifactRenderer value={decoded.part} />;
```

The model emits a small declarative Surface DSL. The server compiler validates
and commits it to the framework-neutral v2 runtime protocol. The browser
revalidates the serialized wire value and contract fingerprint, brands it only
inside the local runtime, and renders it with React and shadcn/ui.

## Packages

| Package | Purpose |
| --- | --- |
| `@data-elements/schema` | Versioned Zod artifact and event protocol |
| `@data-elements/core` | Artifact catalog, safe calculator engine, selection manifests |
| `@data-elements/runtime` | Framework-neutral v2 IR, transactions, replay, migration, and typed actions |
| `@data-elements/compiler` | Server-only Surface DSL compiler, catalog slicing, validation, and bounded repair |
| `@data-elements/capability-broker` | Server-only grants, approval, reauthorization, idempotency, and effect receipts |
| `@data-elements/resources` | Scoped resource and evidence control/data planes |
| `@data-elements/react` | React/shadcn renderer, provider runtime, state bindings, and v1/v2 compatibility |
| `@data-elements/ai-sdk` | AI SDK `createArtifactUI()` and validated `data-artifact` wire streaming |
| `@data-elements/mastra` | Real Mastra `createTool()` integration over the shared commit boundary |
| `@data-elements/ag-ui` | Thin AG-UI custom-event transport adapter |
| `@data-elements/observability` | Structured, redacted runtime events |
| `@data-elements/devtools` | Bounded, secret-free diagnostic timeline |
| `@data-elements/evals` | Versioned conformance suites and statistical release gates |
| `@data-elements/release` | Immutable manifests, staged rollout, dual-read routing, and rollback |
| `data-elements` | shadcn installer, compatibility lock, preflight, and doctor CLI |

Turborepo coordinates package dependency order, incremental builds, tests,
typechecks, and the Fumadocs production build. Every publishable package is
bundled with tsdown.

The source references used during development are pinned as Git submodules in
`vendor/ai-elements`, `vendor/fumadocs`, `vendor/openui`,
`vendor/paper-shaders`, and `vendor/shadcn-ui`.

The lower-level DSL, normalized IR, transactional streaming, capability, and
shadcn distribution foundation remains documented in the
[protocol and compiler reference](apps/docs/content/docs/concepts/artifact-ui-architecture.mdx).

## Readiness

Phases 0-5 have a local reference implementation and deterministic repository
gates. This is not a claim of production readiness: the production canary,
provider/model matrix, accessibility matrix, and the declared 4,000+ eligible
zero-failure samples per gated provider/profile still require real deployment
data. The evaluation package reports `insufficient-data` rather than fabricating
those results.

## Deployment

The docs app is configured for Netlify through [`netlify.toml`](netlify.toml).
Set `DATA_ELEMENTS_PUBLIC_URL` to the canonical HTTPS origin in the Netlify
environment so generated registry dependencies use the deployed domain. The
Playground additionally needs a server-only `OPENROUTER_API_KEY`; configure it
in Netlify's environment settings, never in source control or a
`NEXT_PUBLIC_*` variable. In production it intentionally fails closed until the
following are also configured:

- `ARTIFACT_BACKGROUND_ALLOWED_ORIGINS`: the exact comma-separated HTTPS origin
  list permitted to call the Playground, for example
  `https://your-site.netlify.app`.
- `ARTIFACT_BACKGROUND_ACCESS_TOKEN`: a long random access token exchanged by
  the UI for an HttpOnly, same-site session cookie.
- `ARTIFACT_BACKGROUND_SESSION_SECRET`: a separate long random HMAC secret
  used to sign those session cookies.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`: the distributed
  Upstash Redis limiter. A process-local limiter is only used in development.

Set the optional rate, concurrency, session-TTL, and timing-log controls from
`.env.example` explicitly in the deployment environment. The model key and all
Playground access secrets must remain server-only. Do not place any of them in
source control, browser code, or a `NEXT_PUBLIC_*` variable.

The access-token flow is a closed-beta gate, not a tenant identity provider.
For a multi-user product, bind the route's admission seam to the host IdP and
tenant authorization layer before rollout. `/api/background` rejects an
admission before it reads the provider key or starts a model request.

The route sends `Server-Timing` values for input validation, DSL preparation,
and stream setup. Set `BACKGROUND_PERFORMANCE_LOG=1` for safe structured server
logs, or configure `ARTIFACT_OTLP_LOGS_ENDPOINT` for OTLP/HTTP JSON logs. The
exporter sends only durations, token counts, model identity, and outcome; it
does not send prompts, artifacts, cookies, or provider keys. It rejects
plaintext, credential-bearing, query-string, and fragment-bearing collector
URLs, and exporter failure never blocks a model response.

For durable Artifact runtime state, use `DurableArtifactRuntimeStore` with a
host-provided `DurableStateStorePort`. The package includes a driver-neutral
`PostgresDurableStateStore` and `POSTGRES_DURABLE_STATE_MIGRATION`, so a host
can use its existing transaction runner without adding a database driver to
browser bundles. Partition durable runtime state at a tenant or document
boundary; in-memory stores remain for local development and deterministic tests.

`GET /api/health` and `HEAD /api/health` are lightweight, non-cacheable
readiness probes. They report only application readiness and a sanitized build
revision; they deliberately do not call a model provider, database, or other
external dependency. Configure a Netlify monitor against that endpoint and
monitor provider availability separately.

The production app disables `X-Powered-By`, applies a Next/Fumadocs-compatible
security header set, and marks Next static assets immutable at Netlify. CI
checks recursive submodules, enforces the Bun lockfile, scans committed secrets
and high-severity dependencies, then boots the built Next app under Node to
verify the Playground routes, fail-closed API contracts, and initial HTML/JS
budgets. It also uploads a non-secret build-provenance artifact. Generate the
same local artifact with:

```bash
bun run provenance -- --output .artifacts/build-provenance.json
```
