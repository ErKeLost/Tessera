# @open-tessera/compiler

Server/build-only compiler for the Data Elements Artifact Authoring DSL. It
normalizes nested model output, slices a node catalog for each turn, compiles
provider-neutral JSON Schema and prompts, and validates output before creating
an `ArtifactPart`.

Do not import this package from a browser bundle. React renderers consume the
validated protocol output produced by an adapter, not this compiler.
