# Tessera Studio

Tessera Studio is the local web workspace for exploring and analyzing a
PostgreSQL, MySQL, SQLite, Turso, or MongoDB database. Start it with the executable
published by `@open-tessera/studio`:

```bash
npx @open-tessera/studio@latest postgresql://readonly:password@127.0.0.1:5432/warehouse
```

## What Studio does

- Chat with a database assistant using text and generated analysis views.
- Inspect the available catalog and run governed, read-only analysis.
- Show compact execution progress and query evidence alongside the response.
- Render the latest committed analysis view from verified query resources.
- Accept image attachments in a chat message, including pasted images.
- Keep local chat sessions in the Studio SQLite store.

Generated views are part of the Studio response pipeline. They are produced
after a successful database tool step and cannot perform another query or
execute model-authored code.

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

## Open Generative theme

Tessera resolves the generated UI theme on the server and exposes only its
allowlisted preset ID to the browser. Configure the shadcn Lyra/Taupe preset in
the project `.env` or deployment environment:

```bash
TESSERA_OPEN_GENERATIVE_THEME=b7VWPDLHc
```

Theme configuration affects presentation only. It is not added to Agent
prompts, request context, conversation memory, or model calls. Arbitrary theme
JSON and CSS are rejected; each accepted preset must be compiled into Studio's
local theme registry first.
