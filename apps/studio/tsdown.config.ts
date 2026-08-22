import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/main.ts"],
  dts: { tsconfig: "tsconfig.build.json" },
  clean: true,
  format: ["esm"],
  sourcemap: true,
  deps: {
    // Internal workspace packages are bundled so the published Studio CLI has
    // no runtime dependency on workspace-only packages from either scope.
    alwaysBundle: [/^@data-elements\//, /^@open-tessera\//],
    neverBundle: [/^h3$/, /^node:/, /^srvx$/, /^zod$/],
    dts: { neverBundle: true },
  },
});
