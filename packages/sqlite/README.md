# @open-tessera/sqlite

Cross-runtime SQLite connector for Tessera Agent. It discovers the SQLite
catalog and executes bounded, parser-validated read-only queries through
`@libsql/client` on Node.js 24+ and Bun 1.3+.

```ts
import { createSqliteConnector } from "@open-tessera/sqlite";

const database = createSqliteConnector({
  connectionString: "file:/absolute/path/to/warehouse.db",
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

The connection string must use `file:` or `sqlite:` and reference an existing
database file. `file::memory:` is supported for temporary use. Query strings
and URL fragments are rejected. The connector exposes the SQLite `main` schema
and uses `?` parameters.

The public query surface accepts `SELECT` statements only. Queries run in read
transactions with statement timeouts, abort handling, and a configurable row
limit.
