import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/browser.ts"],
  dts: { tsconfig: "tsconfig.build.json" },
  clean: true,
  format: ["esm"],
  sourcemap: true,
  deps: {
    neverBundle: [/^@open-tessera\//, /^node:/, /^pg$/, /^pgsql-ast-parser$/],
    dts: { neverBundle: true },
  },
});
