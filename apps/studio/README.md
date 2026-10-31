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

## Source-specific Agents

Local Studio uses `.tessera/memory.db` for Mastra sessions and
`.tessera/actions.db` for action state. The Netlify runtime uses PostgreSQL
when `TESSERA_CLOUD=true`: configure `TESSERA_STORAGE_DATABASE_URL` as a
server-side secret and keep `TESSERA_ACCESS_KEY` stable for login and encrypted
settings. `DATABASE_URL` continues to mean the database being analysed; the
cloud storage URL is a separate connection. Cloud session tables are initialized
automatically through `@mastra/pg`. The local CLI continues using SQLite.

Studio keeps the database Agent as the default and can host a parallel Feishu
Agent through the same Mastra and Chat UI boundary. The Feishu implementation
uses only `search_feishu_documents` and `read_feishu_document`; it receives a
host-owned `TesseraFeishuReader`, so Feishu user access tokens and permission
checks stay server-side.

```ts
import { createTesseraStudioFeishuAgent } from "@open-tessera/studio";
import { createFeishuApiReader } from "@open-tessera/feishu";

const feishuAgent = createTesseraStudioFeishuAgent({
  reader: createFeishuApiReader({ tokenProvider }),
  memory,
  llm,
  model,
  mastra,
  defaultIdentity,
});

await createTesseraStudioRuntime(config, { feishuAgent });
```

The ordinary `/` entry uses the database Agent and displays no Feishu controls.
The `/feishu` entry, Feishu client user agent, or a Feishu workspace referrer
selects the Feishu experience. That experience displays no database explorer,
database settings, or database permissions. Threads keep their source type;
history is filtered by the current experience, and the server rejects switching
an existing thread to a different Agent type. Environment detection controls
presentation; OAuth and the downstream API remain the authorization boundary.

## Connecting Feishu

1. Create an enterprise app in the [Feishu developer console](https://open.feishu.cn/app).
2. Enable the user scopes `docx:document:readonly`, `wiki:wiki:readonly`,
   `docs:doc:readonly`, and `offline_access`. Publish the app version and make
   your account part of its available user range.
3. Set the app homepage to `https://YOUR_STUDIO_DOMAIN/feishu` and add
   `https://YOUR_STUDIO_DOMAIN/api/feishu/callback` to its redirect URL list.
4. Open the Feishu entry. Its authorization dialog accepts App ID and App
   Secret and starts the OAuth consent flow. App credentials and user tokens
   are encrypted in PostgreSQL on Netlify or in the local SQLite action store.
5. Configure the model in Settings, then paste a docx/Wiki URL or ask the Agent
   to search documents. Tokens refresh automatically; reconnect through the
   same dialog to renew or disconnect consent.

The current single-owner workspace shares its Feishu connection with everyone
who can sign in to that workspace. Reads are performed with that authorized
Feishu user's access token, never with an application-wide tenant token.
The current reader supports newer cloud documents and Wiki nodes containing
cloud documents, including paginated text. Sheets, Bitable, and attachments need
their own content adapters; a search result of one of those types does not imply
its contents were read. Feishu's document search also has a bounded result window
and must not be presented as a full tenant inventory.

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
