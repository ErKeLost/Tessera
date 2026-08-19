import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/browser.ts"],
  dts: { tsconfig: "tsconfig.build.json" },
  clean: true,
  format: ["esm"],
  sourcemap: true,
  deps: { neverBundle: [/^@data-elements\//, /^node:/, /^zod$/], dts: { neverBundle: true } },
});
