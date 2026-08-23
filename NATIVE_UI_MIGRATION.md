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
## V0.5 — runtime session surface (parity notes)

- **Member status** now shows BOTH the durable lifecycle badge and a live
  **runtime-session chip** (Idle / Working / Waiting for input / Needs
  approval / Disconnected / Failed / Starting / Closed), rendered with the
  existing `ag-badge` token classes (`--dsw-alias-state-*`); no second design
  system was introduced.
- **Pending provider requests** (approvals / input) are surfaced as a compact
  panel on the Team tab with Accept / Decline / Answer actions
  (`POST /groups/:id/members/:member/runtime/respond`); the Host contract
  enforces membership/role checks, never prompts.
- **Member inspection** (click a row) shows Role / Runtime / Model /
  Reasoning / Session state / Current task / Current turn / Last activity;
  provider thread/session ids live in the "Advanced (debug)" line — kept out
  of the primary surface by design (requirement §15).
- **Known divergence (documented, requirement §17):** the page still uses one
  `ag-` prefixed local stylesheet scoped to the shell overlay, because rc.6
  does not export a public stylesheet/component bundle for a standalone
  full-frame page; every color/spacing value derives from `--dsw-alias-*`
  tokens and DSH primitives (`Button`, icon set) are used for interactive
  chrome. No DSH source code was copied into this repository.

## V0.6 — slot catalog re-verification + runtime surface additions

- The installed rc.6 slot catalog was re-inspected (`CLIENT_SLOT_API`, 42
  entries): `sidebar.footer.action` (list/root, additive) and `shell.overlay`
  (list/root, additive) remain valid, non-destructive seats — the bundle keeps
  them. The catalog also exposes more additive slots
  (`conversation.session.header.actions`, `conversation.chat.assistant-actions`,
  `conversation.composer.dock`, `settings.section`, `tool.view.cordis`, …);
  none replaces the full-frame Agent Groups surface non-destructively, so no
  slot change was made (verified against the installed bundle, not a
  historical RC).
- Team tab additions: member rows now show a **queued** chip (future task
  turns + queued corrections, from the Host's authoritative
  `runtimeQueuedTurns`), the member inspector lists each queued turn
  (task/correction, preview, task id), and member actions distinguish **Send
  correction** (steering into current work / queued next turn) from
  **Interrupt turn**. The Tasks tab gained a **New Task** form that assigns to
  a member (busy members queue the task as a future turn). Runtime state chips
  include `Reconnecting`.
- Thread/session ids remain in the "Advanced (debug)" line only.
