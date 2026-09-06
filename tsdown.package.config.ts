import { defineConfig } from "tsdown";

export default defineConfig({
  cwd: process.cwd(),
  entry: ["src/index.ts"],
  dts: { tsconfig: "tsconfig.build.json" },
  clean: true,
  format: ["esm"],
  sourcemap: true,
  deps: {
    neverBundle: [/^react(?:\/|$)/, /^react-dom(?:\/|$)/, /^recharts(?:\/|$)/],
    dts: { neverBundle: true },
  },
});
