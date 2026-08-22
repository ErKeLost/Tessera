import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  dts: { tsconfig: "tsconfig.build.json" },
  clean: true,
  format: ["esm"],
  sourcemap: true,
  deps: {
    neverBundle: [/^@open-generative\//, /^@mastra\//, /^zod(?:\/|$)/],
    dts: { neverBundle: true },
  },
});
