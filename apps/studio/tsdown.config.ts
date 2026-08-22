import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/main.ts"],
  dts: { tsconfig: "tsconfig.build.json" },
  clean: true,
  format: ["esm"],
  sourcemap: true,
  deps: {
    // Internal workspace packages are bundled so the published Studio CLI has
    // no runtime dependency on the retired @data-elements scope.
    alwaysBundle: [/^@data-elements\//],
    neverBundle: [/^h3$/, /^node:/, /^srvx$/, /^zod$/],
    dts: { neverBundle: true },
  },
});
