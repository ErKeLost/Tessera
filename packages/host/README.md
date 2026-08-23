# @open-generative/host

High-level server facade for publishing governed Open Generative surfaces.

`createOpenGenerativeHost()` owns the official component catalog, validates
semantic chart grammar, publishes datasets through resource bindings, and
creates trusted surface events. It is server-only: raw dataset rows are kept
out of authored component props and are resolved through the resource gateway.

```ts
import { createOpenGenerativeHost } from "@open-generative/host";

const host = await createOpenGenerativeHost();
const surface = await host.presentDataChart({ authority, dataset, spec });
```

Use `@open-generative/react` and `@open-generative/ui` to render the resulting
surface event in a client application.
