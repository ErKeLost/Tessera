import { defineHandler, definePlugin } from "nitro";
import { createTesseraStudioService, type TesseraStudioRuntime } from "./server";
import { resolveStudioConfig } from "./studio-command";
import { cloudSessionAuthenticated, handleCloudLogin } from "./cloud-auth";

let studioRuntime: Promise<TesseraStudioRuntime> | undefined;

function getStudioRuntime(): Promise<TesseraStudioRuntime> {
  studioRuntime ??= resolveStudioConfig({ config: {}, overrides: {} })
    .then((config) => createTesseraStudioService(config));
  return studioRuntime;
}

export const studioNitroHandler = defineHandler(async (event) => {
  const pathname = event.url.pathname;
  if (process.env.TESSERA_CLOUD === "true") {
    const secret = process.env.TESSERA_ACCESS_KEY;
    if (!secret) return new Response("Set TESSERA_ACCESS_KEY in the Netlify environment.", { status: 503 });
    if (pathname === "/auth/login") return handleCloudLogin(event.req, secret);
    if (pathname === "/health") return Response.json({ status: "ok", service: "tessera-studio" });
    if (!cloudSessionAuthenticated(event.req, secret)) {
      if (pathname.startsWith("/api/")) return Response.json({ error: { message: "Please sign in to the workspace." } }, { status: 401 });
      return handleCloudLogin(event.req, secret);
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      if (!process.env.TESSERA_STORAGE_DATABASE_URL && !process.env.NETLIFY_DB_URL) {
        return Response.json({ error: { code: "cloud_storage_required", message: "请在 Netlify 环境变量中配置 TESSERA_STORAGE_DATABASE_URL（PostgreSQL），然后重新部署。云端会话和飞书授权将保存在该数据库。" } }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
      const { createCloudStudioRequest } = await import("./cloud-runtime");
      return createCloudStudioRequest(event.req, secret);
    }
    return;
  }
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
