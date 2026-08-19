# Tessera Studio

Tessera Studio is the local web workspace for exploring and analyzing a
PostgreSQL or MySQL database. It is normally started through the `tessera`
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

The Studio server runs on Bun because it uses Bun's embedded SQLite store for
local session state. Install Bun 1.3.14 or later before starting the server. A project can keep
the connection string and model-provider settings in a server-only
`tessera.config.ts` file and then run `npx data-elements@latest studio` from
that project directory.

## Local development

From this directory:

```bash
bun install
bun run dev
```

The API listens on `http://127.0.0.1:4317` and the Vite client is available at
`http://127.0.0.1:4318`. Run `bun test src` for the Studio test suite or
`bun run build:client` to create a production client build.

The package exports the server factory and the `./main` command entry for
integrations that embed Tessera Studio.
