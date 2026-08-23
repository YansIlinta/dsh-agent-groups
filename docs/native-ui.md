# Native UI Integration

This document records how DSH Agent Groups integrates into the DeepSeek Harness web client without introducing a second application shell.

## Findings

The DSH client extension surface used by this project is slot-based rather than a conventional plugin page/router registry.

The two important additive seats are:

- `sidebar.footer.action` — adds the **Agent Groups** entry to the existing DSH sidebar.
- `shell.overlay` — provides a frame-wide surface for the Agent Groups workspace while retaining the DSH shell around it.

The host package declares a DSH web client bundle through its package metadata. The generated bundle is served from the DSH plugin path and loaded by the shell's client module loader.

## Chosen layout

```text
DSH shell
  │
  ├── sidebar.footer.action
  │      └── Agent Groups trigger
  │
  └── shell.overlay
         └── AgentGroupsPage
              ├── group list
              └── group workspace
                   ├── Overview
                   ├── Tasks
                   ├── Team
                   ├── Channel
                   ├── Leader Chat
                   ├── Workspace
                   ├── Activity
                   ├── Profiles
                   └── Configuration
```

The workspace uses the existing host API (`/groups/api/*`) and one SSE stream (`/groups/api/events`) for live updates.

## Design rules

### No second shell

Agent Groups does not add a standalone `/groups/` application, iframe, duplicate navigation system, or independent visual shell. The normal DSH sidebar/header/theme remain authoritative.

### Reuse DSH primitives

Interactive chrome should prefer `@deepseek-ai/dsh-client-ui-primitives` components exposed by the DSH client runtime.

The current integration can use primitives such as buttons, inputs, menus, modals, pills, tooltips, toasts, JSON views, and the DSH icon set when available.

### Theme compatibility

Project-local CSS uses the `ag-` prefix and derives visual values from the DSH `--dsw-alias-*` token family (background, border, label, brand, and state colors).

Do not copy DSH source CSS into this repository. If DSH does not expose a public full-page layout primitive, keep the smallest scoped local stylesheet needed for the Agent Groups surface.

## Runtime states in the UI

Member presentation should keep domain lifecycle and provider-session state distinct.

Runtime session states include:

- Starting
- Idle
- Working
- Waiting for input
- Needs approval
- Interrupted
- Disconnected
- Reconnecting
- Failed
- Closed

Provider session/thread identifiers are debugging metadata and should stay out of the primary member surface.

## Pending requests

Provider approval/input requests are surfaced on the Team/runtime surface and answered through the host API. The client displays the request; the host remains responsible for membership/role authorization and safe timeout behavior.

## Steering and queueing

The UI should describe runtime behavior truthfully:

- **Send correction** may steer active work when the provider supports it.
- If live steering is unsupported or fails, the correction becomes a queued next turn on the same member session.
- Assigning new work to a busy member queues a future task turn rather than rebinding the active turn.
- **Interrupt turn** is distinct from task completion or member removal.

Queued work should be rendered from authoritative host state, not inferred from ephemeral output text.

## State restoration

Page navigation state (open/group/tab) may be stored locally for convenience, but product/domain state comes from the durable host API.

A browser refresh should restore the page without pretending local UI state is authoritative runtime state.

## Compatibility

The slot catalog and shell-static modules are version-sensitive DSH integration points. When updating the supported DSH version:

1. re-inspect the available client slots;
2. verify `sidebar.footer.action` and `shell.overlay` remain additive and valid;
3. verify required shell-static modules/primitives still resolve;
4. run the native bundle build and syntax check;
5. manually inspect the page inside the real DSH shell.

The current CI target is DSH `0.1.0-rc.6`; newer DSH versions require explicit compatibility verification.
