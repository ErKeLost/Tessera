# Tessera Studio architecture

## Runtime boundaries

```text
main.tsx
  QueryClientProvider          server state and cache
  BrowserRouter                URL state and route transitions
  StudioThemeProvider          theme preference
  TooltipProvider              shared UI primitives
    StudioApp                  glass preference + route tree
```

The application is split into four layers:

- `layout/`: persistent workspace chrome, sidebar, topbar, dock, command palette, and outlet context.
- `routes/`: page-level workflows for home, chat, data explorer, settings, and not-found states.
- `components/`: reusable UI and beUI-derived motion components.
- `api/`, `queries/`, `store/`: data access, React Query resources, and local UI preferences.

## Route map

| Route | Surface | State owner |
| --- | --- | --- |
| `/` | Full-bleed analysis home | `useStudioThreadMutations`, workspace queries |
| `/chat/:threadId` | Existing assistant workspace | Assistant UI + `useChat`; rendering boundary unchanged |
| `/data` | Catalog and table editor | Catalog query + lazy `TableEditor` |
| `/settings/:section` | Routed settings workbench | Settings form plus workspace invalidation |

The home route is outside the persistent sidebar shell so it stays focused and does not load session chrome. All other routes share `StudioRouteShell` and receive a typed outlet context.

## State ownership

- React Query owns connection, catalog, metadata, model label, thread list, and thread messages.
- Zustand owns glass surfaces, sidebar expansion, and command palette visibility.
- Assistant UI owns streaming messages, tool calls, reasoning, and artifact rendering.
- Server settings remain the authority for credentials and runtime configuration.

The `chat-glass` storage key accepts both the current persisted Zustand object and a legacy raw boolean. Glass surfaces use `data-glass="on"` plus `chat-glass-surface`.

## Design system

beUI components are used for the animated sidebar, prompt input, dock, command palette, motion buttons, popovers, and selects. The surrounding product uses a deep blue analytical canvas, restrained cyan accent, grain/dot texture, translucent surfaces, and responsive grid layouts. The settings route is a page workbench rather than a modal; the existing dialog remains available for other callers.

## Chat compatibility

`StudioAssistant`, the Assistant UI message tree, tool timeline, tool-call protocol, and Artifact renderer were not redesigned or rewritten. Product chrome routes into the existing chat surface through `StudioChatRoute` only.
