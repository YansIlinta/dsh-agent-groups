# Native UI Migration — actual findings & chosen approach

Short record of what DSH rc.6 really offers for frontend extension, and the
design the migration uses. No architecture essay.

## Inspected surfaces (read from the live rc.6 GUI + installed packages)

- **No page/router system exists in rc.6.** The shell has no navigation items,
  no page registry, no route table. The UI is a slot tree
  (`root → sidebar / conversation / details / settings / shell.overlay`),
  confirmed via the live Slot Inspect provider.
- **Client plugin mechanism is real and standard**: a package declares
  `"dsh": { "client": { "inject": [...], "platform": "web" } }` and ships a
  bundle at `exports["./client"]`; the host `dsh-client-modules` scanner
  serves it as `/plugins/<id>/client.js` (seen as `window.__DSH_BOOT__`
  entries on the DSH page). Bundle format:
  `window.__ModuleLoader__.load({ id, factory: (require) => {...} })`,
  CommonJS factories, require resolves shell-static modules
  (`react`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-runtime/client`,
  `@deepseek-ai/dsh-client-ui-primitives`, …).
- **Entry point**: `sidebar.footer.action` (list, root scope, additive,
  `replaceRisk: none`) — this is where "Agent Groups" appears in the native
  sidebar, beside Settings. Existing occupants confirm the registration shape
  (`slots.inject(name, () => slots.register({name, id, ...}, Component))`).
- **Page body**: `shell.overlay` (list, root scope, frame-wide floating
  layer) — the only non-destructive full-frame seat; the page lives there and
  keeps DSH sidebar/header/theme untouched.
- **Component system**: `@deepseek-ai/dsh-client-ui-primitives` (Button,
  Input, Modal, Menu, Pill, Tooltip, Toast, JsonTree, icon set) is a
  shell-static module — reusable directly. Styles come from the shell's own
  CSS; the page only adds its own prefixed (`ag-`) local stylesheet.
- **Theme**: `--dsw-alias-*` tokens globally available (bg-layer-1/2,
  border-l1/l2, label-primary/secondary, brand-primary, state-*).

## Approach

```
sidebar.footer.action  ── "Agent Groups" trigger
        │  (same bundle, shared open state)
        ▼
shell.overlay  ── AgentGroupsPage (groups list → group detail tabs)
        │
        ├── data:   existing /groups/api/* (fetch, same origin)
        ├── live:   existing /groups/api/events (EventSource, one per page)
        └── state:  localStorage { open, groupId, tab } → survives refresh
```

- Host/domain untouched; data API + SSE untouched.
- No iframe, no /groups/ navigation, no second app shell.
- CSS: single `ag-` prefixed stylesheet injected by the bundle, only
  `--dsw-alias-*` variables — no global selectors, no leak.
- Old standalone UI removed only after the native page is verified.