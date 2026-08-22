export type PublishPackage = Readonly<{
  directory: string;
  files: readonly string[];
  dependencies?: readonly string[];
}>;

export const npmReleasePackages: readonly PublishPackage[] = [
  { directory: "packages/schema", files: ["dist/index.mjs", "dist/index.d.mts"] },
  { directory: "packages/core", files: ["dist/index.mjs", "dist/index.d.mts"] },
  { directory: "packages/runtime", files: ["dist/index.mjs", "dist/index.d.mts"] },
  { directory: "packages/capability-broker", files: ["dist/index.mjs", "dist/index.d.mts"] },
  { directory: "packages/compiler", files: ["dist/index.mjs", "dist/index.d.mts"] },
  { directory: "packages/database", files: ["dist/index.mjs", "dist/index.d.mts"] },
  { directory: "packages/mongodb", files: ["dist/index.mjs", "dist/index.d.mts"] },
  { directory: "packages/mysql", files: ["dist/index.mjs", "dist/index.d.mts"] },
  { directory: "packages/postgres", files: ["dist/index.mjs", "dist/index.d.mts"] },
  { directory: "packages/sqlite", files: ["dist/index.mjs", "dist/index.d.mts"] },
  { directory: "packages/turso", files: ["dist/index.mjs", "dist/index.d.mts"] },
  { directory: "packages/data-agent", files: ["dist/index.mjs", "dist/index.d.mts"] },
  {
    directory: "apps/studio",
    files: [
      "dist/index.mjs",
      "dist/main.mjs",
      "dist/nitro/public/index.html",
      "dist/nitro/server/index.mjs",
      "dist/nitro/server/package.json",
    ],
    dependencies: [
      "@data-elements/capability-broker",
      "@data-elements/compiler",
      "@data-elements/data-agent",
      "@data-elements/database",
      "@data-elements/mongodb",
      "@data-elements/mysql",
      "@data-elements/postgres",
      "@data-elements/sqlite",
      "@data-elements/turso",
      "@data-elements/runtime",
      "@data-elements/schema",
    ],
  },
  {
    directory: "packages/cli",
    files: ["index.js", "README.md", "LICENSE"],
    dependencies: ["@data-elements/studio"],
  },
];
