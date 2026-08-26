import { existsSync, readFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { nitro } from "nitro/vite";
import { defineConfig, type Plugin } from "vite";

const studioRoot = fileURLToPath(new URL("./", import.meta.url));
const clientRoot = fileURLToPath(new URL("./src/client", import.meta.url));
const nitroDist = fileURLToPath(new URL("./dist/nitro", import.meta.url));
const nitroPublicIndex = fileURLToPath(new URL("./dist/nitro/public/index.html", import.meta.url));
const nitroServerEntry = fileURLToPath(new URL("./src/nitro-server.ts", import.meta.url));
const nitroLifecyclePlugin = fileURLToPath(new URL("./src/nitro-plugin.ts", import.meta.url));
const rendererTemplate = fileURLToPath(new URL("./src/client/index.html", import.meta.url));
const publicDirectory = fileURLToPath(new URL("./public", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
const configuredOpenGenerativeRoot = process.env.OPEN_GENERATIVE_ROOT?.trim();
const openGenerativeRoot = resolve(configuredOpenGenerativeRoot || resolve(workspaceRoot, "../open-generative"));
const hasLinkedOpenGenerativeWorkspace = existsSync(resolve(openGenerativeRoot, "package.json"));
const openGenerativeRestartFiles = hasLinkedOpenGenerativeWorkspace
  ? [
      resolve(openGenerativeRoot, "packages/mastra/dist/index.mjs"),
      resolve(openGenerativeRoot, "packages/ui/dist/renderer-release.json"),
    ]
  : [];
const studioPackage = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

function restartForOpenGenerativeBuilds(): Plugin {
  return {
    name: "tessera-open-generative-build-restart",
    apply: "serve",
    configureServer(server) {
      if (openGenerativeRestartFiles.length === 0) return;
      const watched = new Set(openGenerativeRestartFiles);
      let restartTimer: ReturnType<typeof setTimeout> | undefined;
      const scheduleRestart = (file: string) => {
        if (!watched.has(resolve(file))) return;
        if (restartTimer !== undefined) clearTimeout(restartTimer);
        restartTimer = setTimeout(() => {
          restartTimer = undefined;
          void server.restart().catch((error: unknown) => {
            server.config.logger.error(`Open Generative dev-server restart failed: ${String(error)}`);
          });
        }, 250);
      };
      server.watcher.add(openGenerativeRestartFiles);
      server.watcher.on("add", scheduleRestart);
      server.watcher.on("change", scheduleRestart);
      server.watcher.on("unlink", scheduleRestart);
      server.httpServer?.once("close", () => {
        if (restartTimer !== undefined) clearTimeout(restartTimer);
      });
    },
  };
}

export default defineConfig({
  root: clientRoot,
  publicDir: publicDirectory,
  plugins: [
    restartForOpenGenerativeBuilds(),
    nitro({
      compatibilityDate: "2026-08-22",
      defaultPreset: "node-server",
      hooks: {
        async compiled(nitroApp) {
          const template = nitroApp.options.renderer?.template;
          if (!template) throw new Error("Nitro did not generate the Studio renderer template.");
          await copyFile(template, nitroPublicIndex);
        },
      },
      output: { dir: nitroDist },
      plugins: [nitroLifecyclePlugin],
      renderer: { template: rendererTemplate },
      rootDir: studioRoot,
      serverDir: false,
      serverEntry: nitroServerEntry,
    }),
  ],
  define: {
    __TESSERA_STUDIO_VERSION__: JSON.stringify(studioPackage.version),
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      { find: "@", replacement: clientRoot },
    ],
  },
  ssr: {
    noExternal: [/^@open-generative\//],
  },
  optimizeDeps: {
    exclude: [
      "@open-generative/components",
      "@open-generative/mastra",
      "@open-generative/protocol",
      "@open-generative/ui",
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 4317,
    fs: {
      allow: [workspaceRoot, ...(hasLinkedOpenGenerativeWorkspace ? [openGenerativeRoot] : [])],
    },
    watch: { followSymlinks: true },
    // Let a second local dev session move to the next available port
    // instead of failing before the settings-first UI can open.
    strictPort: false,
  },
  build: {
    emptyOutDir: true,
    sourcemap: false,
  },
});
