import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: { tsconfig: "./tsconfig.build.json" },
  deps: { dts: { neverBundle: true } },
  clean: true,
});
