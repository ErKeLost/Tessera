# Tessera Studio

Tessera Studio is the local web workspace for exploring and analyzing a
PostgreSQL, MySQL, SQLite, or Turso database. It is normally started through the `tessera`
command shipped by the `data-elements` package:

```bash
npx data-elements@latest studio postgresql://readonly:password@127.0.0.1:5432/warehouse
```

## What Studio does

- Chat with a database assistant using regular Markdown responses.
- Inspect the available catalog and run governed, read-only analysis.
- Show compact execution progress and query evidence alongside the response.
- Accept image attachments in a chat message, including pasted images.
- Keep local chat sessions in the Studio SQLite store.

Studio deliberately does not generate or render structured result cards. A
completed analysis is presented as Markdown plus its execution progress and
evidence, which keeps the conversation layout stable for long answers and
database results.

The Studio server and its local session store run on Node.js 24 or later and
Bun 1.3 or later. A project can keep the connection string and model-provider settings in a server-only
`tessera.config.ts` file and then run `npx data-elements@latest studio` from
that project directory.

SQLite accepts an existing local database through `file:` or `sqlite:`. Turso
accepts `libsql:` or `turso:` and reads its separate server-only credential from
`database.authToken` or `TURSO_AUTH_TOKEN`. SQLite and Turso connections are
always read-only in Studio.

```bash
npx data-elements@latest studio file:/absolute/path/to/warehouse.db
TURSO_AUTH_TOKEN=... npx data-elements@latest studio libsql://warehouse-org.turso.io
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

The standalone `tessera studio` CLI remains available and uses the same H3
application and Studio runtime as the Nitro deployment.

The package exports the server factory and the `./main` command entry for
integrations that embed Tessera Studio.
