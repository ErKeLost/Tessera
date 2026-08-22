# Publishing Tessera (Historical)

> **Historical, non-normative document.** This page preserves the retired
> Tessera Agent/Studio monorepo release process as design history. It is not an
> installation or publishing guide for the current Tessera Agent Generative UI
> proof. Do not use the former Agent package names, CLI examples, or Studio URL
> as supported interfaces. Current repository verification starts from the root
> commands in [`README.md`](../README.md).

The historical publishing process was handled by GitHub Actions. It kept
internal dependencies as `workspace:*` in the repository. Bun's publish packer
converted those ranges to the current package versions in generated npm
tarballs; the workflow checked the tarballs before publishing.

The retired process required an `NPM_TOKEN` repository secret with permission
for its then-current package scopes. The current proof does not define an Agent
package publication contract. Never put a registry token in the repository or
local package manifests.

The root preflight remains useful for checking the reference package graph and
workspace metadata. It is not an Agent/Studio installation test:

```bash
bun run release:check
```

Historically, a release committed matching versions in `package.json` and the
release package manifests, then pushed a matching tag. For version `0.1.0`:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The historical `Release npm packages` workflow also supported manual dispatch.
Its version had to match the committed package manifests; it built the
workspace, checked generated tarballs for unresolved `workspace:*` ranges, and
published in dependency order. Its former Agent CLI smoke check and local Studio
endpoint are intentionally not reproduced as runnable commands because neither
is a supported interface of the current Generative UI proof.

The underlying security guidance remains valid: use read-only database roles
where possible, load connection and model credentials from environment-backed
configuration, and never pass credentials on a command line where shell history
or process inspection can expose them.
