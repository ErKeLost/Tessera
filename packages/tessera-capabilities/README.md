# `@open-tessera/capabilities`

Server-only capability grants, authorization, approvals, idempotent execution,
validated output publication, and durable effect receipts for Artifact UI v2.

The package intentionally fails when selected by a browser bundler. Browser
clients consume only the sanitized view types emitted by a trusted host.

## Durable stores

`InMemoryEffectStore` and `InMemoryActionInvocationStore` are deterministic
development fixtures. A production host should provide a single
`DurableStateStorePort` (for example `PostgresDurableStateStore` from
`@open-tessera/runtime`) and use:

```ts
const grants = new DurableCapabilityGrantStore({ state, storageKey: "capability-grants:tenant-a" });
const effects = new DurableEffectStore({ state, storageKey: "capability-effects:tenant-a" });
const actions = new DurableActionInvocationStore({ state, storageKey: "capability-actions:tenant-a" });
```

The three keys should be partitioned at the tenant or equivalent authorization
boundary. The effect store persists request idempotency, approvals,
cancellation, receipts, and CAS versions. The action store persists trigger
replay identity and local-step receipts. Capability handlers intentionally stay
in the process-local registry because executable code must be deployed by the
host, never loaded from durable data.
