import { existsSync, readFileSync, readdirSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
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
const studioPackage = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

/**
 * In dev, resolve every Tessera workspace package to its TypeScript source.
 *
 * Packages are consumed through `dist`, so a package edit used to need a
 * manual `build:packages` before Studio saw it — and a forgotten build silently
 * ran stale code. Aliasing to source makes the dev server watch the real files
 * and removes that failure mode. Production builds keep resolving `dist`.
 *
 * The browser never imports these packages at runtime (see
 * `src/protocol.ts`), so only the Nitro server pays for this.
 */
function workspaceSourceAliases() {
  const packagesRoot = fileURLToPath(new URL("../../packages", import.meta.url));
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const packageDirectory = join(packagesRoot, entry.name);
      const manifestPath = join(packageDirectory, "package.json");
      const sourcePath = join(packageDirectory, "src/index.ts");
      if (!existsSync(manifestPath) || !existsSync(sourcePath)) return [];
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
      if (typeof manifest.name !== "string" || !manifest.name.startsWith("@open-tessera/")) return [];
      return [{ find: manifest.name, replacement: sourcePath }];
    });
}

export default defineConfig(({ command }) => ({
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
      ...(command === "serve" ? workspaceSourceAliases() : []),
      { find: "@", replacement: clientRoot },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 4317,
    fs: {
      allow: [fileURLToPath(new URL("../../", import.meta.url))],
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
}));
