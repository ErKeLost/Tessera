# Tessera Agent

Tessera Agent is a local-first database analysis agent. It connects natural
language questions to governed database tools, verified evidence, durable
session memory, and generated analysis views inside Tessera Studio.

The repository contains the Agent runtime, Studio application, database
connectors, semantic analysis compiler, permission boundary, tests, and public
documentation for the Tessera product.

## Quick start

Run the published Studio executable with a database URL:

```bash
npx @open-tessera/studio@latest postgresql://readonly:password@127.0.0.1:5432/warehouse
```

Studio also supports MySQL, SQLite, Turso/libSQL, and MongoDB. It binds to
`127.0.0.1` by default and keeps database credentials, provider keys, and
private model memory on the server.

For a repeatable project setup, create a server-only `tessera.config.ts`:

```ts
import { defineTesseraConfig } from "@open-tessera/studio";

export default defineTesseraConfig({
  database: {
    url: process.env.DATABASE_URL!,
    maxRows: 5_000,
    statementTimeoutMs: 30_000,
  },
  llm: {
    model: "openrouter/qwen/qwen3.8-27b",
  },
});
```

## Product boundaries

- The model sees typed database tools, never connection credentials.
- Physical reads and semantic analysis use separate, bounded tool paths.
- Database mutations use typed actions, policy checks, and durable approval.
- Mastra persists private conversation context after every completed model step.
- AI SDK assembles a separate, sanitized browser transcript for refresh.
- Generated analysis views consume only verified query resources and cannot run
  another database operation.
- Studio includes the renderer and all 17 current chart recipes.

## Development

Tessera consumes Open Generative as a separate package boundary. For linked
development, keep both repositories next to each other and use Bun 1.4 or newer:

```bash
cd ../open-generative && bun install
cd ../open-tessera && bun install
bun run link:open-generative
bun run dev:studio
```

`bun run dev:studio` rebuilds and watches the sibling Open Generative packages
before starting Studio on `http://127.0.0.1:4317`. Set
`OPEN_GENERATIVE_ROOT=/absolute/path/to/open-generative` when the repositories
are not siblings. Tessera does not keep an in-repository Open Generative
workspace or compatibility copy.

The standard checks remain `bun run typecheck`, `bun run test`, and
`bun run build`. Run the documentation site with `bun --cwd apps/docs dev`.

Public documentation lives in [`apps/docs`](apps/docs). Architecture notes in
[`docs/architecture`](docs/architecture) are repository design records rather
than additional products or installable SDKs.
