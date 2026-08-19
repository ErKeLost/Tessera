import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/browser.ts"],
  dts: { tsconfig: "tsconfig.build.json" },
  clean: true,
  format: ["esm"],
  sourcemap: true,
  deps: {
    neverBundle: [
      /^@data-elements\//,
      /^node:/,
      /^mysql2$/,
      /^mysql2\/promise$/,
      /^node-sql-parser$/,
    ],
    dts: { neverBundle: true },
  },
});
