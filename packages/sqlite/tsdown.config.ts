import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/browser.ts"],
  dts: { tsconfig: "tsconfig.build.json" },
  clean: true,
  format: ["esm"],
  sourcemap: true,
  deps: {
    neverBundle: [
      /^@open-tessera\//,
      /^@libsql\/client$/,
      /^node:/,
      /^node-sql-parser$/,
    ],
    dts: { neverBundle: true },
  },
});
