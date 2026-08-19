import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const clientRoot = fileURLToPath(new URL("./src/client", import.meta.url));
const clientDist = fileURLToPath(new URL("./dist/client", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
// Studio must render the workspace source during development and production
// builds. Resolving this package through its published `dist` entry makes the
// client silently retain an older Artifact renderer when that package has not
// been rebuilt yet.
const dataElementsReactSource = fileURLToPath(new URL("../../packages/react/src/index.ts", import.meta.url));
const dataElementsReactStyles = fileURLToPath(new URL("../../packages/react/src/styles.css", import.meta.url));
const apiPort = Number.parseInt(process.env.TESSERA_STUDIO_API_PORT ?? "4317", 10);
const apiTarget = `http://127.0.0.1:${Number.isInteger(apiPort) ? apiPort : 4317}`;

export default defineConfig({
  root: clientRoot,
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      // This subpath must precede the package root or Vite turns it into
      // `index.ts/styles.css` while resolving the source alias above.
      { find: "@data-elements/react/styles.css", replacement: dataElementsReactStyles },
      { find: "@data-elements/react", replacement: dataElementsReactSource },
      { find: "@", replacement: clientRoot },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 4318,
    fs: {
      allow: [workspaceRoot],
    },
    proxy: {
      "/api": {
        changeOrigin: true,
        // Client-side imports from `src/client/api` resolve to `/api/*.ts`.
        // Keep those source modules in Vite instead of forwarding them to the
        // Studio API, whose route namespace intentionally has no `.ts` files.
        bypass(request) {
          const url = request.url ?? "";
          return /\.(?:[cm]?[jt]sx?|css)(?:$|\?)/.test(url) ? url : undefined;
        },
        // The browser talks to Vite on :4318, while the API deliberately
        // accepts only its own loopback origin. Keep the dev proxy same-origin
        // from the API's perspective without widening the API allowlist.
        headers: {
          origin: apiTarget,
        },
        target: apiTarget,
      },
    },
    strictPort: true,
  },
  build: {
    emptyOutDir: true,
    outDir: clientDist,
    sourcemap: false,
  },
});
