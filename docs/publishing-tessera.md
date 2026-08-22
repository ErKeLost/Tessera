# Publishing Tessera

Publishing is handled by GitHub Actions. Keep internal dependencies as
`workspace:*` in the repository. Bun's publish packer converts those ranges to
the current package versions in the generated npm tarballs; the workflow
checks the tarballs before publishing.

Before the first release, add an `NPM_TOKEN` repository secret with permission
to publish the `@data-elements` and `@open-tessera` scopes. Do not put the token in
the repository or local package manifests.

The local preflight is still useful before pushing a release tag. It builds the
package dependency graph and Studio client, runs the CLI tests, and verifies
the workspace package metadata:

```bash
bun run release:check
```

To publish, commit the version in `package.json` and all release package
manifests, then push a matching tag. For version `0.1.0`:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The `Release npm packages` workflow also supports manual dispatch. Enter a
version that exactly matches the committed package manifests. It builds the
workspace, verifies Bun's generated publish tarballs contain no `workspace:*`
range, publishes in dependency order, and runs an
`npx data-elements@<version> studio --help` smoke check.

After publishing, verify from an empty directory with Node.js 24+ or Bun 1.3+ installed:

```bash
npx data-elements@latest studio postgresql://readonly:password@127.0.0.1:5432/warehouse
```

Tessera listens on `http://127.0.0.1:4317` by default. Prefer a read-only
database user and a `tessera.config.ts` file that reads connection and model
credentials from environment variables. Passing a connection URL on the command
line can expose it through shell history or process inspection.
