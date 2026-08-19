const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required by Tessera Studio.");
}

export default {
  database: {
    url: databaseUrl,
    maxRows: 1_000,
    statementTimeoutMs: 15_000,
  },
};
