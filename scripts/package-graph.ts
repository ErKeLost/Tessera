export type PackageDefinition = Readonly<{
  directory: string;
  name: string;
  dependencies: readonly `@open-tessera/${string}`[];
}>;

export const packageGraph: readonly PackageDefinition[] = [
  { directory: "packages/tessera-schema", name: "@open-tessera/schema", dependencies: [] },
  { directory: "packages/tessera-runtime", name: "@open-tessera/runtime", dependencies: ["@open-tessera/schema"] },
  { directory: "packages/tessera-core", name: "@open-tessera/core", dependencies: ["@open-tessera/schema"] },
  { directory: "packages/tessera-capabilities", name: "@open-tessera/capabilities", dependencies: ["@open-tessera/runtime"] },
  { directory: "packages/tessera-compiler", name: "@open-tessera/compiler", dependencies: ["@open-tessera/capabilities", "@open-tessera/core", "@open-tessera/runtime", "@open-tessera/schema"] },
  { directory: "packages/database", name: "@open-tessera/database", dependencies: [] },
  { directory: "packages/data-agent", name: "@open-tessera/data-agent", dependencies: ["@open-tessera/database"] },
  { directory: "packages/tessera-agent", name: "@open-tessera/agent", dependencies: ["@open-tessera/data-agent", "@open-tessera/database"] },
  { directory: "packages/mongodb", name: "@open-tessera/mongodb", dependencies: ["@open-tessera/database"] },
  { directory: "packages/mysql", name: "@open-tessera/mysql", dependencies: ["@open-tessera/database"] },
  { directory: "packages/postgres", name: "@open-tessera/postgres", dependencies: ["@open-tessera/database"] },
  { directory: "packages/sqlite", name: "@open-tessera/sqlite", dependencies: ["@open-tessera/database"] },
  { directory: "packages/turso", name: "@open-tessera/turso", dependencies: ["@open-tessera/sqlite"] },
  { directory: "apps/studio", name: "@open-tessera/studio", dependencies: ["@open-tessera/agent", "@open-tessera/capabilities", "@open-tessera/compiler", "@open-tessera/data-agent", "@open-tessera/database", "@open-tessera/mongodb", "@open-tessera/mysql", "@open-tessera/postgres", "@open-tessera/runtime", "@open-tessera/schema", "@open-tessera/sqlite", "@open-tessera/turso"] },
];

export const packageByName = new Map(packageGraph.map((definition) => [definition.name, definition]));
