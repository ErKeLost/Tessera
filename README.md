# Tessera Agent Generative UI

This repository is the complete Generative UI reference implementation and
validation ground for the Tessera Agent. Models propose declarative UI;
the host owns contracts, data, identity, validation, state, authority, effects,
persistence, and commits.

The implementation uses the final Open Generative architecture from the start,
not an MVP or a temporary Data Agent protocol. Its currently enabled component
catalog, recipes, fixtures, and product acceptance criteria are intentionally
limited to Tessera data-analysis workflows. After this reference proves the
architecture, the framework-neutral core will be extracted into a separate
Open Generative project.

Existing Agent, Studio, and Workbench sources are outside this Generative UI
workstream. This implementation does not modify them; Tessera Agent integration
is handled as a separate task after the reference contracts are proven here.

## Invariants

- Models never generate executable JSX, JavaScript, HTML, CSS, SQL, URLs, or
  tool names.
- Every component is defined by one immutable, revisioned contract.
- Resource payloads never enter model proposals or canonical documents.
- Every external effect is a typed host intent with authorization and receipts.
- React is the first official binding; it is not the protocol.
- A surface has one rendering chain:
  `SurfaceEventStream -> SurfaceController -> GenerativeSurface -> RendererRegistry`.

## Current Proof

The repository is successful only when one governed query execution can publish
typed, provenance-linked pinned resources and render useful combinations of
metric, chart, table, query details, filters, and explanatory content without
copying rows into model proposals, canonical documents, or transport history.

The measurable proof plan is documented in
[`docs/architecture/tessera-data-agent-generative-ui-proof.md`](docs/architecture/tessera-data-agent-generative-ui-proof.md).

## Future Extraction Boundaries

The `@open-generative/*` names below describe the package boundaries implemented
by this reference and reserved for extraction into the future Open Generative
project. They do not name a second current product: the current product proof and
acceptance profile remain Tessera Agent.

| Package | Responsibility |
| --- | --- |
| `@open-generative/protocol` | Canonical schemas, wire protocols, hashes, IDs, diagnostics |
| `@open-generative/catalog` | Component contracts, manifests, slices, generated contract views |
| `@open-generative/compiler` | Proposal decode, normalize, validate, and commit gates |
| `@open-generative/runtime` | Deterministic document, preview, state, migration, and replay reducers |
| `@open-generative/server` | HostServer, sessions, transactions, authority orchestration |
| `@open-generative/client` | SurfaceController, trusted stream reduction, command transport |
| `@open-generative/resources` | Resource publication, grants, projection, windows, evidence |
| `@open-generative/capabilities` | Action policy, approval, idempotency, effects, receipts |
| `@open-generative/react` | GenerativeSurface and React RendererRegistry |
| `@open-generative/components` | Official framework-neutral component contracts and ChartSpec |
| `@open-generative/ui` | Official React UI components and node renderers |
| `@open-generative/ai-sdk` | AI SDK server/client transport adapter |
| `@open-generative/mastra` | Server-only Mastra adapter |
| `@open-generative/ag-ui` | AG-UI server/client event adapter |

The complete target architecture and the future extraction boundary are documented in
[`docs/architecture/open-generative-architecture.md`](docs/architecture/open-generative-architecture.md).

```bash
bun install
bun run typecheck
bun run test
bun run build
```
