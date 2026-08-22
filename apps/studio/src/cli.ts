#!/usr/bin/env node

import { runTesseraStudioCli } from "./main";

void runTesseraStudioCli().catch(() => {
  // Startup errors can contain credentials, so the CLI emits a fixed message.
  console.error("Tessera Studio could not start. Check tessera.config.ts and the local database configuration.");
  process.exitCode = 1;
});
