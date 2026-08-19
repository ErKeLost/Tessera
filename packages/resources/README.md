# `@data-elements/resources`

Server-side resolution of scoped Artifact UI resources, evidence, and claims.
Replayable control receipts and transient data envelopes are deliberately
separate APIs. No fetch location, credentials, raw bytes, or audit references
are returned to browser clients.

## Durable stores

`InMemory*` stores are local fixtures. A production host can inject the shared
`DurableStateStorePort` and select `DurableCommittedResourceStore`,
`DurableResourceSchemaRegistry`, `DurableResourceResolutionStore`, and
`DurableScopedResourceBindingCache` without changing `ResourceResolver` ports.

Partition committed contexts, schemas, and resolution idempotency at their
tenant/catalog authority boundary. The binding cache preserves TTL and explicit
eviction semantics, but it is non-authoritative: use Redis or Valkey for its
operational implementation and always reauthorize before delivery. Resource
source handlers, authorization, codecs, and redaction stay host-owned runtime
ports so they can enforce live credentials and revocations.
