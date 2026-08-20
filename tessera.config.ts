export default {
  database: {
    url: process.env.DATABASE_URL,
    maxRows: 1_000,
    statementTimeoutMs: 15_000,
  },
};
