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
            ├── Codex runtime
            └── Claude runtime
```

The host package is independent from the DSH source tree. It composes public DSH/Cordis services and stores Agent Groups state in its own durable domain.

## Domain model

The important durable entities are:

- **Group** — team identity, mission, workspace, template/team configuration, lifecycle state.
- **Member** — durable teammate identity plus role/runtime/model/reasoning and runtime-session metadata.
- **Mission / Workstream / Task** — work decomposition and dependency graph.
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

## Provider mappings

### DeepSeek Harness

A DSH Group Member maps to a durable DSH agent session. On resume, the member's provider/model/reasoning configuration is restored rather than silently inheriting a new global default.

### Codex

A Codex Group Member maps to one durable Codex App Server thread. One shared long-running `codex app-server` connection can host many member threads. Tasks become `turn/start` calls on the same thread; supported active-turn corrections use `turn/steer`; host restart/transport recovery reattaches with `thread/resume` when possible.

### Claude

A Claude Group Member maps to one Claude Agent SDK session. Each turn uses the SDK `query()` surface and resumes the previous provider conversation using its `session_id`.

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

Long-horizon durability work should prefer explicit durable queue/reconciliation state over reconstructing intent from truncated activity previews or in-memory-only queues.

## Native UI boundary

The client is a DSH plugin bundle, not a standalone SPA. It registers into DSH client slots, calls the host API on the same origin, subscribes to SSE for live state, and reuses DSH design primitives/tokens. See [Native UI](native-ui.md).
