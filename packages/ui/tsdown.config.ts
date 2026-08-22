import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  dts: { tsconfig: "tsconfig.build.json" },
  clean: true,
  format: ["esm"],
  sourcemap: true,
  deps: {
    neverBundle: [/^@open-generative\//, /^react/, /^recharts/, /^lucide-react/, /^radix-ui$/, /^class-variance-authority$/],
    dts: { neverBundle: true },
  },
});
