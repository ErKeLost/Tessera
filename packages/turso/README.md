# @data-elements/turso

Cross-runtime Turso/libSQL connector for Data Elements on Node.js 24+ and Bun
1.3+. It reuses the SQLite catalog and read-only SQL policy while keeping Turso
connection credentials separate.

```ts
import { createTursoConnector } from "@data-elements/turso";

const database = createTursoConnector({
  connectionString: "libsql://warehouse-org.turso.io",
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const assessment = await database.assess();
const catalog = await database.introspect();
const result = await database.query({
  sql: 'SELECT "id", "name" FROM "customers" WHERE "active" = ?',
  parameters: [1],
  purpose: "List active customers",
});

await database.close();
```

Remote connections accept `libsql:`, `turso:`, HTTPS, and WSS URLs. HTTP and WS
are restricted to loopback development servers. Credentials, query strings,
and fragments are rejected in the URL; pass the credential as `authToken`.

Turso uses SQLite SQL semantics, the `main` schema, `?` parameters, read
transactions, statement timeouts, abort handling, and configurable row limits.
