#!/usr/bin/env node

import { main } from "../dist/main.mjs";

try {
  await main();
} catch {
  // Do not expose connection strings or provider credentials in startup errors.
  console.error("Tessera Studio could not start. Check tessera.config.ts and the local database configuration.");
  process.exitCode = 1;
}
