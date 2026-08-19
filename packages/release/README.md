# `@data-elements/release`

Immutable release manifests, staged rollout decisions, and durable alias
promotion/rollback controls for Artifact UI.

## Durable release control

`InMemoryReleaseAliasStore` is a synchronous development fixture. Production
uses `DurableReleaseAliasStore` over a host-provided `DurableStateStorePort`:

```ts
const releases = new DurableReleaseAliasStore({
  state,
  storageKey: "artifact-releases:production:catalog-a",
});
```

Use one key per environment and catalog authority. `register()` makes a release
ID immutable, `compareAndSwapAlias()` preserves the simple legacy promotion
flow, and `runRollbackDrillAsync()` works with either synchronous fixtures or
asynchronous durable stores.

For production promotion and rollback, use `readAliasState()` plus
`transitionAlias()`. It compares both release ID and monotonically increasing
version, requires an idempotency key, and atomically records an immutable alias
event. This prevents the ABA case where an alias moves `r1 -> r2 -> r1` while a
stale caller still believes it owns `r1`.

The state adapter's transaction runner must commit or roll back the alias and
event together. Apply `POSTGRES_DURABLE_STATE_MIGRATION` before use when using
the built-in driver-neutral Postgres adapter. Keep registry objects write-once
with retention/versioning; database manifest immutability does not make an
object-store URL immutable by itself.
