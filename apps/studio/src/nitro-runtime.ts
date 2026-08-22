import { defineHandler, definePlugin } from "nitro";
import { createTesseraStudioService, type TesseraStudioRuntime } from "./server";
import { resolveStudioConfig } from "./studio-command";

let studioRuntime: Promise<TesseraStudioRuntime> | undefined;

function getStudioRuntime(): Promise<TesseraStudioRuntime> {
  studioRuntime ??= resolveStudioConfig({ config: {}, overrides: {} })
    .then((config) => createTesseraStudioService(config));
  return studioRuntime;
}

export const studioNitroHandler = defineHandler(async (event) => {
  const pathname = event.url.pathname;
  if (pathname !== "/health" && pathname !== "/api" && !pathname.startsWith("/api/")) {
    return;
  }
  return (await getStudioRuntime()).app.fetch(event.req);
});

export const studioNitroLifecycle = definePlugin((nitroApp) => {
  nitroApp.hooks.hook("close", async () => {
    const runtime = await studioRuntime;
    studioRuntime = undefined;
    await runtime?.close();
  });
});
