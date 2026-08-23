export type PackageDefinition = Readonly<{
  directory: string;
  name: string;
  dependencies: readonly (`@open-generative/${string}` | `@open-tessera/${string}`)[];
}>;

export const packageGraph: readonly PackageDefinition[] = [
  { directory: "packages/protocol", name: "@open-generative/protocol", dependencies: [] },
  { directory: "packages/catalog", name: "@open-generative/catalog", dependencies: ["@open-generative/protocol"] },
  { directory: "packages/runtime", name: "@open-generative/runtime", dependencies: ["@open-generative/protocol"] },
  { directory: "packages/compiler", name: "@open-generative/compiler", dependencies: ["@open-generative/protocol", "@open-generative/catalog", "@open-generative/runtime"] },
  { directory: "packages/resources", name: "@open-generative/resources", dependencies: ["@open-generative/protocol"] },
  { directory: "packages/capabilities", name: "@open-generative/capabilities", dependencies: ["@open-generative/protocol", "@open-generative/catalog"] },
  { directory: "packages/server", name: "@open-generative/server", dependencies: ["@open-generative/protocol", "@open-generative/catalog", "@open-generative/compiler", "@open-generative/runtime", "@open-generative/resources", "@open-generative/capabilities"] },
  { directory: "packages/client", name: "@open-generative/client", dependencies: ["@open-generative/protocol", "@open-generative/catalog", "@open-generative/runtime"] },
  { directory: "packages/react", name: "@open-generative/react", dependencies: ["@open-generative/protocol", "@open-generative/catalog", "@open-generative/client"] },
  { directory: "packages/components", name: "@open-generative/components", dependencies: ["@open-generative/protocol", "@open-generative/catalog"] },
  { directory: "packages/ai-sdk", name: "@open-generative/ai-sdk", dependencies: ["@open-generative/protocol", "@open-generative/compiler", "@open-generative/server", "@open-generative/client"] },
  { directory: "packages/ag-ui", name: "@open-generative/ag-ui", dependencies: ["@open-generative/protocol", "@open-generative/server", "@open-generative/client"] },
  { directory: "packages/mastra", name: "@open-generative/mastra", dependencies: ["@open-generative/protocol", "@open-generative/compiler", "@open-generative/server", "@open-generative/resources", "@open-generative/capabilities"] },
  { directory: "packages/host", name: "@open-generative/host", dependencies: ["@open-generative/capabilities", "@open-generative/catalog", "@open-generative/compiler", "@open-generative/components", "@open-generative/protocol", "@open-generative/resources", "@open-generative/runtime", "@open-generative/server"] },
  { directory: "packages/tessera-schema", name: "@open-tessera/schema", dependencies: [] },
  { directory: "packages/tessera-runtime", name: "@open-tessera/runtime", dependencies: ["@open-tessera/schema"] },
  { directory: "packages/tessera-core", name: "@open-tessera/core", dependencies: ["@open-tessera/schema"] },
  { directory: "packages/tessera-capabilities", name: "@open-tessera/capabilities", dependencies: ["@open-tessera/runtime"] },
  { directory: "packages/tessera-compiler", name: "@open-tessera/compiler", dependencies: ["@open-tessera/capabilities", "@open-tessera/core", "@open-tessera/runtime", "@open-tessera/schema"] },
  { directory: "packages/ui", name: "@open-generative/ui", dependencies: ["@open-generative/protocol", "@open-generative/catalog", "@open-generative/client", "@open-generative/react", "@open-generative/components"] },
  { directory: "packages/database", name: "@open-tessera/database", dependencies: [] },
  { directory: "packages/data-agent", name: "@open-tessera/data-agent", dependencies: ["@open-tessera/database"] },
  { directory: "packages/mongodb", name: "@open-tessera/mongodb", dependencies: ["@open-tessera/database"] },
  { directory: "packages/mysql", name: "@open-tessera/mysql", dependencies: ["@open-tessera/database"] },
  { directory: "packages/postgres", name: "@open-tessera/postgres", dependencies: ["@open-tessera/database"] },
  { directory: "packages/sqlite", name: "@open-tessera/sqlite", dependencies: ["@open-tessera/database"] },
  { directory: "packages/turso", name: "@open-tessera/turso", dependencies: ["@open-tessera/sqlite"] },
  { directory: "apps/studio", name: "@open-tessera/studio", dependencies: ["@open-generative/components", "@open-generative/host", "@open-generative/mastra", "@open-generative/protocol", "@open-generative/ui", "@open-tessera/capabilities", "@open-tessera/compiler", "@open-tessera/data-agent", "@open-tessera/database", "@open-tessera/mongodb", "@open-tessera/mysql", "@open-tessera/postgres", "@open-tessera/runtime", "@open-tessera/schema", "@open-tessera/sqlite", "@open-tessera/turso"] },
];

export const packageByName = new Map(packageGraph.map((definition) => [definition.name, definition]));
