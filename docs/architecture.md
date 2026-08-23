# Architecture

DSH Agent Groups is a product layer on top of DeepSeek Harness. It owns the team/domain model and durable runtime coordination while delegating actual model execution to runtime providers.

## System shape

```text
DSH shell
  ├── Agent Groups native client
  │    └── /groups/api/* + SSE
  │
  └── @dsh-agent-groups/host
       ├── GroupHost
       ├── durable domain services
       ├── Leader / Member tools
       └── RuntimeRegistry
            ├── DeepSeek Harness runtime
            ├── DSH native runtime
            └── ACPAgentRuntimeProvider
                 ├── codex-acp
                 ├── claude-agent-acp
                 └── gemini --acp
```

The host package is independent from the DSH source tree. It composes public DSH/Cordis services and stores Agent Groups state in its own durable domain.

## Domain model

The important durable entities are:

- **Group** — team identity, mission, workspace, template/team configuration, lifecycle state.
- **Member** — durable teammate identity plus role/runtime/model/reasoning and runtime-session metadata.
- **Mission / Workstream / Task** — work decomposition and dependency graph.
- **Task Attempt** — independently identified execution (`attemptId`, member, provider session, turn, timestamps and terminal outcome); stored inside its owning task record for storage-schema compatibility.
- **Task result** — summary, artifacts, changed files, tests, risks, unresolved items, completion claim.
- **Channel / private messages** — durable team communication with host-enforced direction rules.
- **Activity** — durable event timeline for important domain/runtime transitions.
- **Workspace notes / artifacts** — shared durable collaboration state.

`GroupHost` is the main enforcement and coordination boundary. Prompts describe expected behavior, but authorization and communication rules are enforced by host code.

## Runtime lifecycle

The central rule is that **process lifetime, session lifetime, turn lifetime, and task lifetime are different things**.

```text
Group Member
  └── RuntimeSession             one persistent provider conversation
       ├── Turn A ← Task A
       ├── Turn B ← follow-up
       └── Turn C ← Task B
```

A runtime provider can expose both a legacy process-oriented surface and the persistent session surface. External coding-agent runtimes use persistent sessions.

### Session

A `RuntimeSession` belongs to one Group Member and represents one provider conversation. Durable session metadata may include provider session/thread ids, model, reasoning level, last turn/task, workspace, and state. Credentials are never persisted by Agent Groups.

### Turn

A turn is one provider conversation step. The turn owns its immutable task binding, if any.

Important operations are intentionally distinct:

- `startTaskTurn` — start a new task/follow-up turn when idle.
- `steerActiveTurn` — inject guidance into the currently active turn when the provider supports it.
- `queueTaskTurn` — schedule a new task behind active work.
- `queueFollowup` — schedule guidance that could not be injected live.
- `interrupt` — cancel active provider work without treating it as successful completion.

### Task

A Group Task is a domain object. A completed provider turn may create a completion claim for the task bound to that turn; the claim is still subject to Leader/Verifier acceptance.

Each task turn creates one durable Attempt, idempotently keyed by the provider turn id. Reopening a task advances the attempt sequence. Attempt terminal states are `completed`, `failed`, `cancelled`, or `lost`; a process/session disconnect settles active work as `lost`, never as success, and late duplicate events cannot overwrite a terminal outcome.

Task assignment uses a durable dispatch outbox. `pending` means the Host has not crossed the runtime boundary; `dispatching` carries a lease while delivery is in progress. On recovery, a matching active or queued turn proves delivery and advances the record to `delivered`. A lease without a matching runtime binding becomes `ambiguous`: the task fails and requires an explicit retry, so the Host never risks replaying work that may already have reached the provider. Dispatch state is authoritative and is not reconstructed from the activity log.

### Workspace execution

Groups choose a workspace policy at creation. `shared` gives every member the snapshotted group directory. `worktree` validates that directory as a Git repository and creates a persistent detached worktree per member outside the repository. The member's resolved path is stored in its runtime-session metadata and reused across host restarts and task retries. Automatic removal is intentionally excluded: cleanup must be an explicit administrative operation so the host never destroys unreviewed work.

## Provider mappings

### DeepSeek Harness

A DSH Group Member maps to a durable DSH agent session. On resume, the member's provider/model/reasoning configuration is restored rather than silently inheriting a new global default.

### ACP external agents

An ACP Group Member maps to one durable ACP session. A configured adapter process and ACP connection are separate from member/session/turn/task lifetime. The Host persists the ACP session id and normalized negotiated capabilities. Restart recovery calls `session/resume` or `session/load`; when neither is advertised, recovery fails explicitly instead of silently creating an empty conversation.

Codex uses the official `codex-acp` adapter, Claude uses `claude-agent-acp`, and Gemini CLI is launched in its native ACP mode. Provider-specific App Server/SDK translation remains inside those upstream adapters.

Steering is used only when `initialize._meta.steering.supported` is advertised. Otherwise the Host persists the follow-up in the same member's future-turn FIFO.

## Completion invariants

The following rules are product invariants and should have regression tests whenever touched:

1. A process exit is not task success.
2. A session disconnect is not member removal.
3. A turn's `taskId` is fixed when the turn starts.
4. A late event from an old turn must never complete a newer task/turn.
5. A busy member must not run two turns concurrently.
6. New work for a busy member must be steered or queued, never silently rebound onto the active turn.
7. A failed steering attempt must not drop Leader guidance.
8. An interrupted turn does not count as successful task completion.
9. Provider approval/input requests must be visible and eventually resolved or safely timed out.
10. Credentials and secret values must not enter durable Agent Groups records or activity payloads.

## Communication boundary

The product deliberately treats the Leader as the coordination hub.

```text
Leader  ⇄  Member        private messages allowed
Member  ⇄  Member        private messages forbidden
Everyone → Group Channel durable shared feed
```

The restriction is enforced in host/service code and tool gating, not by relying on system prompts alone.

## Persistence and recovery

Agent Groups persists domain records through its DSH storage domain. Runtime provider identifiers are stored on the member so a new host process can attempt to reattach to the same provider conversation.

The future-turn FIFO is stored with the member runtime record; UI views receive only a truncated preview. A non-overlapping `RuntimeReconciler` reattaches sessions and drains this queue idempotently, with exponential backoff after failures. It never reconstructs intent from activity previews.

After reattachment, reconciliation compares every durable running Attempt with the Host's live immutable turn binding. An Attempt with no corresponding live provider turn becomes `lost`, its unfinished Task fails loudly, and the member releases that task. It is not automatically replayed because ACP v1 cannot universally prove that a detached remote prompt made no changes; the Leader must explicitly reopen/retry it.

ACP Registry metadata is treated as untrusted discovery input. Registry agents require an explicit local allowlist, only pinned `npx` distributions are accepted, subprocesses use argument arrays without a shell, and actual ACP initialization/session creation remains the runtime usability boundary. Registry credentials are neither accepted nor persisted by this layer.

Member materialization synchronously completes ACP `initialize`, `session/new`, and advertised model/thought-level configuration before the member is persisted as usable. Authentication/config/session errors therefore fail the spawn loudly instead of surfacing as a broken member on its first task. Advertised authentication methods are normalized into debug capabilities. ACP v1 does not currently provide a stable, universal authenticated-state query; upstream's `auth/status` remains an RFD, so agents that defer credential validation until the first model request can still fail that first turn and are reported as such rather than silently retried.

Process placement is behind a `RuntimeExecutor` boundary. The current `LocalRuntimeExecutor` performs no-shell subprocess launch and executable checks; ACP providers no longer call Node process spawning directly. Runtime discovery distinguishes `launchable` from `initialized`, and role spawn explicitly validates ACP initialization before session materialization. Docker/SSH/remote implementations can replace the executor without changing ACP session or product orchestration logic.

## Native UI boundary

The client is a DSH plugin bundle, not a standalone SPA. It registers into DSH client slots, calls the host API on the same origin, subscribes to SSE for live state, and reuses DSH design primitives/tokens. See [Native UI](native-ui.md).
