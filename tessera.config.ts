const databaseUrl = process.env.DATABASE_URL?.trim();

// Keep the repository's development config usable before first-run setup.
// Studio replaces this loopback placeholder from its browser settings flow;
// deployed projects can still provide DATABASE_URL for an immediate connection.
export default {
  database: {
    url: databaseUrl || "postgresql://127.0.0.1:1/tessera",
    maxRows: 1_000,
    statementTimeoutMs: 15_000,
  },
};
