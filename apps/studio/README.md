# Tessera Studio

Tessera Studio is the local web workspace for exploring and analyzing a
PostgreSQL or MySQL database. It is normally started through the `tessera`
command shipped by the `data-elements` package:

```bash
npx data-elements@latest studio postgresql://readonly:password@127.0.0.1:5432/warehouse
```

The Studio server runs on Bun because it uses Bun's embedded SQLite store for
local session state. Install Bun 1.3.14 or later before starting the server. A project can keep
the connection string and model-provider settings in a server-only
`tessera.config.ts` file and then run `npx data-elements@latest studio` from
that project directory.

The package exports the server factory and the `./main` command entry for
integrations that embed Tessera Studio.
