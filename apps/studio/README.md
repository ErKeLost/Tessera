# Tessera Studio

Tessera Studio is the local web workspace for exploring and analyzing a
PostgreSQL, MySQL, SQLite, Turso, or MongoDB database. Start it with the executable
published by `@open-tessera/studio`:

```bash
npx @open-tessera/studio@latest postgresql://readonly:password@127.0.0.1:5432/warehouse
```

## What Studio does

- Chat with a database assistant using grounded text, tool state, and Evidence.
- Inspect the available catalog and run governed, read-only analysis.
- Show compact execution progress and query evidence alongside the response.
- Accept image attachments in a chat message, including pasted images.
- Keep local chat sessions in the Studio SQLite store.

The Studio server and its local session store run on Node.js 24 or later and
Bun 1.3 or later. A project can keep the connection string and model-provider settings in a server-only
`tessera.config.ts` file and then run `npx @open-tessera/studio@latest` from
that project directory.

SQLite accepts an existing local database through `file:` or `sqlite:`. Turso
accepts `libsql:` or `turso:` and reads its separate server-only credential from
`database.authToken` or `TURSO_AUTH_TOKEN`. SQLite and Turso connections are
always read-only in Studio.

```bash
npx @open-tessera/studio@latest file:/absolute/path/to/warehouse.db
TURSO_AUTH_TOKEN=... npx @open-tessera/studio@latest libsql://warehouse-org.turso.io
```

## Vercel AI Gateway

In Settings → Model, choose **Vercel AI Gateway**, select a model, and enter a
Gateway API key (or set `AI_GATEWAY_API_KEY` on the server). Leave Base URL empty
for Mastra's native Vercel integration. The settings and chat model pickers load
Vercel's public catalog of text models with tool support.

For a project configuration:

```ts
import { defineTesseraConfig } from "@open-tessera/studio";

export default defineTesseraConfig({
  database: { url: process.env.DATABASE_URL! },
  llm: { model: "vercel/openai/gpt-4.1-mini" },
});
```

OpenRouter remains the initial default. Switching gateways does not carry API
keys or custom endpoints between providers. A custom Base URL uses the
OpenAI-compatible chat completions protocol.

### Jev evaluation

The Vercel model settings also include a **Jev evaluation** panel. It calls
`typesafe-ai/jev` through AI SDK `experimental_evaluate`, independently of the
chat model. Enter text or JSON state and a JSON object of `boolean`, `choice`, or
`score` questions, then click **Run Jev evaluation**. Answers and token usage are
shown inline. The evaluation always uses Vercel's native gateway endpoint and
never saves or replaces the active chat configuration.

The same server-side `AI_GATEWAY_API_KEY` or Vercel key entered in the form is
used for both modes. If needed, create a key with
`vercel ai-gateway api-keys create --name tessera`, then configure it locally.

## Local development

From this directory:

```bash
bun install
bun run dev
```

Nitro serves both the API and Vite client at `http://127.0.0.1:4317`. Run
`bun test src` for the Studio test suite or `bun run build` to create the CLI,
library, and deployable Nitro server.

The Nitro production output is written to `dist/nitro`. Start it with Node.js
24 or Bun:

```bash
node dist/nitro/server/index.mjs
```

The standalone `studio` CLI remains available and uses the same H3
application and Studio runtime as the Nitro deployment.

The package exports the server factory and the `./main` command entry for
integrations that embed Tessera Studio.

## Continual harness

Studio uses an independent Reviewer/Planner harness to turn evidence-backed
corrections into thread-local editable domain memory. Automatic review is
enabled by default after 25 successful turns, with a 20-minute cooldown. It
cannot edit prompts, tools, database permissions, approval policy, SQL
boundaries, credentials, or connections.

```ts
studio: {
  continualHarness: {
    enabled: true,
    autoReviewInterval: 25,
    autoReviewCooldownMs: 20 * 60_000,
  },
}
```

Automatic changes remain isolated to the current thread. Cross-session memory
requires an explicit Host promotion through the exported continual-harness API.
See [the architecture guide](../../docs/architecture/tessera-agent-continual-harness.md)
for the state machine, validation policy, rollback flow, and Sandbox boundary.
