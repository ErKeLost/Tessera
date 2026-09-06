# @open-tessera/compiler

Server/build-only compiler for the Tessera Agent analysis artifact DSL. It
normalizes nested model output, slices a node catalog for each turn, compiles
provider-neutral JSON Schema and prompts, and validates output before creating
an `ArtifactPart`.

Do not import this package from a browser bundle. Hosts consume the validated
analysis output produced by this compiler.
