# Contributing

Use Bun for every package and script. New artifacts must include a versioned
schema, a catalog manifest, a trusted renderer, examples, and contract tests.
Do not accept arbitrary JSX, JavaScript, HTML, CSS, formulas, or unregistered
component names from a model.

```bash
bun install
bun run typecheck
bun test
bun run build
bun run smoke:docs
```
