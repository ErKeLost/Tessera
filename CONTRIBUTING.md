# Contributing

Use Bun for installation, scripts, and tests. Public code must follow the
package graph in the architecture document and may not introduce reverse
dependencies from protocol/runtime into React, adapters, or host products.

Every public contract requires strict schemas, deterministic fixtures, negative
tests, and an explicit hash identity. Do not add compatibility exports, generic
JSON Patch, executable model output, unscoped resource access, or renderer-side
effects.

```bash
bun install
bun run check:naming
bun run check:boundaries
bun run typecheck
bun run test
bun run build
```
