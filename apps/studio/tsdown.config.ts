import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/main.ts"],
  dts: { tsconfig: "tsconfig.build.json" },
  clean: true,
  format: ["esm"],
  sourcemap: true,
  deps: {
    neverBundle: [/^@open-tessera\/(?:mongodb|mysql|postgres|sqlite|turso)$/, /^h3$/, /^node:/, /^srvx$/, /^zod$/],
    dts: { neverBundle: true },
  },
});
