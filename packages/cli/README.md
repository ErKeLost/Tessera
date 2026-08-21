# Tessera and Data Elements CLI

The CLI and `data-elements.dev` registry are implemented and tested in this
repository but are not publicly published yet. The `npx` commands below are the
release interface; use `node packages/cli/index.js` with
`DATA_ELEMENTS_REGISTRY_URL=http://localhost:3000/r/` for repository-local
development.

`data-elements` remains the backwards-compatible installer for editable
artifact components. `tessera` is the public command for the local database
analysis workspace.

## Tessera Studio

Start Studio from any directory inside a Tessera project with a configured
PostgreSQL, MySQL, SQLite, or Turso database. The published one-off command is:

```bash
npx data-elements@latest studio
```

After installing `data-elements` globally, the equivalent command is:

```bash
tessera studio
```

The command searches upward for `tessera.config.ts`. Keep database connection
strings and model-provider keys in that server-only config file, normally by
reading environment variables there.

For an explicit one-off connection, pass one supported database URL as a
positional argument. It overrides `database.url` for that run only. Tessera never
logs the URL, but it can still appear in your shell history and process
listings, so a config plus environment variable remains the recommended project
setup.

```bash
tessera studio postgresql://readonly:password@127.0.0.1:5432/warehouse
tessera studio mysql://readonly:password@127.0.0.1:3306/warehouse
tessera studio file:/absolute/path/to/warehouse.db
TURSO_AUTH_TOKEN=... tessera studio libsql://warehouse-org.turso.io
```

SQLite accepts `file:` and `sqlite:` URLs that reference an existing local
database file. Turso accepts `libsql:` and `turso:` URLs; keep its credential
outside the URL in `database.authToken` or `TURSO_AUTH_TOKEN`.

Choose a config file or local listener explicitly when needed:

```bash
tessera studio --config ./config/tessera.config.ts --host 127.0.0.1 --port 4310
```

Studio accepts at most one positional database URL. Only `--config`, `--host`,
and `--port` are valid options. The CLI runs the built Studio with the current
Bun runtime or with Node.js 24+, through an argument array with no shell.

Install the complete editable component catalog:

```bash
npx data-elements@latest
```

Install one or more artifacts:

```bash
npx data-elements@latest add query-artifact metric-artifact
```

Verify the installed compatibility lock and every locked source hash:

```bash
npx data-elements@latest doctor
```

The CLI delegates to the official shadcn CLI and follows the package manager
that invoked it. Generated source is installed under the components directory
configured in the host project's `components.json`.

## Prerequisites

- Node.js 24 or later
- Bun 1.3 or later
- A React project with Tailwind CSS
- A valid shadcn `components.json` (the shadcn CLI can initialize one when it is missing)

The default command installs the `artifact-ui` item. It copies only editable
React UI source; the browser-safe schema, core, and runtime remain exact-version
npm dependencies.

Before an update, the CLI reads `data-elements.lock.json` from the components
alias configured by `components.json`. An unchanged official installation can
be updated normally. If a locked file was changed, removed, or has an invalid
hash, the installation becomes `custom/unverified` and the CLI refuses to
overwrite it.

Use `--force` only when you intend to replace local changes:

```bash
npx data-elements@latest --force
```

`--force` is an overwrite operation, not a three-way merge. Preserve or commit
local changes before using it. `add` accepts any published registry item and
removes duplicate names before invoking shadcn. Set
`DATA_ELEMENTS_REGISTRY_URL` only when testing a local registry; remote
registries must use HTTPS.
