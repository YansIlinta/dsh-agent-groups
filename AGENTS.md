# AGENTS.md

Instructions for coding agents working in this repository.

## Read first

Before changing runtime/session behavior, read:

1. `README.md` for the current product surface.
2. `docs/architecture.md` for lifecycle and completion invariants.
3. `docs/development.md` for build/test commands.
4. Provider-specific notes only when relevant (for example `docs/CODEX_APP_SERVER_PROTOCOL.md`).

Do not reconstruct architecture from old version descriptions in Git history unless the task explicitly requires historical behavior.

## Repository map

```text
packages/host/src/
  group-host.ts          product facade + runtime coordination
  group-service.ts       group/member lifecycle
  task-service.ts        task DAG and task state
  channel-service.ts     public/private communication
  runtime/               runtime contracts + DSH/Codex/Claude providers
  native-client/         DSH-native UI source
  web/                   HTTP API + SSE
  persistence.ts         durable schemas
  store.ts               storage adapters

packages/profiles/       DSH presets/profile fragments
scripts/                 build/install/demo/durability helpers
docs/                    implementation and architecture notes
```

## Runtime invariants

These are not optional implementation details:

- Process lifetime, session lifetime, turn lifetime, and task lifetime are separate.
- A process exit must never imply successful task completion.
- One Group Member represents one durable runtime conversation where the provider supports resume.
- A turn's task binding is immutable after the turn starts.
- A busy member must not run two turns concurrently.
- New task work for a busy member must be queued; it must not retarget the active turn.
- A failed active-turn steer must not silently drop Leader guidance.
- Late provider events must be correlated so an old turn cannot complete a newer task.
- Interrupt/cancel is not success.
- Completion claims still require Leader/Verifier acceptance.
- Provider credentials and secret-bearing payloads must never enter durable records/activity.

If a requested change conflicts with an invariant, call that out in the PR rather than weakening the invariant implicitly.

## Communication rules

Leader↔Member private messaging is allowed. Member↔Member private messaging is forbidden by host/service policy. Do not move this boundary into prompts only.

## Native UI rules

- Keep Agent Groups inside the DSH shell.
- Do not add an iframe or second app shell.
- Prefer DSH UI primitives.
- Use DSH `--dsw-alias-*` theme tokens.
- Prefix project-local styles/classes with `ag-`.
- Treat UI state as a view of host state, not the source of runtime truth.

## Working style

- Prefer the smallest auditable change that fixes the behavior.
- Add a regression test before or alongside runtime/state-machine fixes.
- Do not claim a provider feature works because a mock accepts it; preserve real provider semantics in the abstraction.
- Do not silently add fallback behavior that changes runtimes/models when the requested runtime is unavailable.
- Avoid large opportunistic rewrites of `group-host.ts`, `runtime/codex.ts`, or `runtime/claude.ts` while fixing a narrow bug.
- Keep README changes product-facing; put protocol investigations and internal design notes in `docs/`.

## Validation

For normal changes run:

```bash
npm run typecheck
npm test
npm run build
node --check packages/host/lib/client.js
```

Run the smallest relevant integration helper as well when touching durability, native UI, installation, or runtime provider behavior.

Do not report a task as complete if required validation did not run; state exactly what was and was not verified.
