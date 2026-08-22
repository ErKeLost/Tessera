import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/server.ts", "src/client.ts"],
  dts: { tsconfig: "tsconfig.build.json" },
  clean: true,
  format: ["esm"],
  sourcemap: true,
  deps: { neverBundle: [/^@open-generative\//, /^ai(?:\/|$)/], dts: { neverBundle: true } },
});
