import { readFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

const studioRoot = fileURLToPath(new URL("./", import.meta.url));
const clientRoot = fileURLToPath(new URL("./src/client", import.meta.url));
const nitroDist = fileURLToPath(new URL("./dist/nitro", import.meta.url));
const nitroPublicIndex = fileURLToPath(new URL("./dist/nitro/public/index.html", import.meta.url));
const nitroServerEntry = fileURLToPath(new URL("./src/nitro-server.ts", import.meta.url));
const nitroLifecyclePlugin = fileURLToPath(new URL("./src/nitro-plugin.ts", import.meta.url));
const rendererTemplate = fileURLToPath(new URL("./src/client/index.html", import.meta.url));
const publicDirectory = fileURLToPath(new URL("./public", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
const studioPackage = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  root: clientRoot,
  publicDir: publicDirectory,
  plugins: [
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
  server: {
    host: "127.0.0.1",
    port: 4317,
    fs: {
      allow: [workspaceRoot],
    },
    // Let a second local dev session move to the next available port
    // instead of failing before the settings-first UI can open.
    strictPort: false,
  },
  build: {
    emptyOutDir: true,
    sourcemap: false,
  },
});
