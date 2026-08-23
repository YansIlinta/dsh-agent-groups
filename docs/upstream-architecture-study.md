# Upstream architecture study

Study date: 2026-08-23. All repositories were inspected from their current default branch at the exact commits below. Commit hashes are the reproducibility boundary; links to moving `main` branches are intentionally not treated as versions.

## Inspected revisions and licensing

| Upstream | Commit | License | Reuse decision |
| --- | --- | --- | --- |
| `deepseek-ai/deepseek-harness` 0.1.1-rc.2 | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | MIT | Public slot and UI contracts may be reused; Agent Groups remains a plugin. |
| `agentclientprotocol/agent-client-protocol` | `1c00740ec19622527f2483a95ea15ddb7604885c` | Apache-2.0 | Protocol/schema is authoritative. |
| `agentclientprotocol/typescript-sdk` 1.4.0 | `e6463f444093ed7c5f1cc937c3f32afb5853e906` | Apache-2.0 | Used directly as `@agentclientprotocol/sdk`; no local JSON-RPC reimplementation. |
| `agentclientprotocol/codex-acp` 1.6.2 | `ba5bcc3d7759250dde9d4d2286a1bec11b363208` | Apache-2.0 | Launched as the Codex adapter; translation code is not copied. |
| `agentclientprotocol/claude-agent-acp` 0.70.0 | `996d488589b8db7a0f9af3dfc7b886d9d47ebae9` | Apache-2.0 | Launched as the Claude adapter; translation code is not copied. |
| `google-gemini/gemini-cli` 0.56.0-nightly.20260806.g761f604c1 | `5411f113cafae26161b4969b0237b8e1e024e2c2` | Apache-2.0 | Launched directly with native `--acp`; no Gemini-specific host code. |
| `openai/symphony` | `8001b52e3062495a16e520e4ceaf8f9de868c4d0` | Apache-2.0 | Reconciliation/backoff/workspace lifecycle patterns are reimplemented against this repository's domain model. |
| `kdlbs/kandev` | `b15bf00783c24b00e9529f1158bcaf97056f1563` | AGPL-3.0 | Architecture/product reference only. No source copied. |
| `microsoft/agent-host-protocol` | `32477054f5e082f46b6ebd2d0804523cca6e3674` | MIT | Snapshot/action/replay reference for a future multi-client host; not introduced in V1. |

## DeepSeek Harness UI

Relevant source:

- `packages/client/ui-layout/src/client/AppFrame.tsx` and `AppFrame.module.css`: four render shares (`sidebar`, `conversation`, `details`, `shell.overlay`), the overlay layer, three-column sizing, and narrow viewport behavior.
- `packages/client/ui-layout/src/client/index.ts`: slot declarations and root registration.
- `packages/client/ui-sidebar/src/client/SidebarRoot.tsx` and `index.ts`: sidebar ownership and footer contributions.
- `packages/client/ui-primitives/src/Button.tsx`, `Tooltip.tsx`, and their CSS modules: focus, hover, disabled, sizing, and tooltip placement behavior.
- `packages/session-query/session-log-export/src/client/Dialog.tsx`: current dialog composition and dismissal pattern.
- `packages/client/ui-layout/tests/app-frame.client.spec.tsx`: narrow viewport and slot behavior are contract-tested, not incidental CSS.

Decision: keep the existing `sidebar.footer.action` + `shell.overlay` plugin shape. Do not add another router, sidebar, iframe, or design system. Primary screens remain Mission, Team, Tasks, Agents, Activity, and Artifacts. Protocol identifiers remain in the advanced runtime view.

## ACP protocol and TypeScript SDK

Authoritative implementation points:

- `typescript-sdk/src/acp.ts`: `ClientSideConnection`, typed requests, NDJSON stream, permission/input callbacks, and extension requests.
- `typescript-sdk/src/schema/types.gen.ts`: `InitializeResponse`, `AgentCapabilities`, `SessionCapabilities`, all session setup requests, config options, prompt updates, and stop reasons.
- `agent-client-protocol/schema/v1/schema.json` and `CHANGELOG.md`: stable wire union and release history.

Stable baseline operations are `initialize`, `authenticate`, `session/new`, `session/load`, `session/resume`, `session/list`, `session/delete`, `session/close`, `session/prompt`, `session/update`, `session/cancel`, session config, permission requests, and elicitation. `session/new`, `session/prompt`, `session/update`, and `session/cancel` are baseline; load/resume/list/close/delete and content types are capability-gated.

`session/update` is an open evolving union. The host maps known message/thought/tool variants and safely ignores unknown variants. `_meta` is opaque unless a specific extension has been advertised. The current adapters advertise steering at top-level `initialize._meta.steering.supported`; only then may the host call `_session/steering`. Stable ACP does not otherwise promise mid-turn steering.

Direct reuse: `@agentclientprotocol/sdk@1.4.0`, `ClientSideConnection`, `ndJsonStream`, and generated protocol types. Reimplementation: only the DSH product mapping (`ACP session → RuntimeSession`, prompt → Turn, update → normalized event).

## Codex ACP adapter

Relevant source:

- `src/CodexAcpServer.ts`: initialize capabilities, session state, prompt lifecycle, resume/load/list/close, config, request routing, and process failure.
- `src/CodexAppServerClient.ts`: Codex App Server thread/turn calls and steering.
- `src/AcpExtensions.ts` and `src/SteeringQueue.ts`: advertised `_session/steering`, serialized same-session steers, and outcomes (`injected`, `startedNewTurn`, `failed`).
- `src/CodexApprovalHandler.ts`, `CodexElicitationHandler.ts`, `CodexEventHandler.ts`, and `CodexToolCallMapper.ts`: approval/input and stream translation.
- `src/__tests__/CodexACPAgent/`: persistent-session, resume/load, close, model config, approval, malformed/failure, subagent, goal, and steering fixtures.

The adapter already owns Codex binary discovery, App Server process management, thread mapping, turn mapping, dynamic model/config options, approvals, streaming, cancellation, steering, goals, subagent metadata, and provider errors. Agent Groups therefore launches `npx -y @agentclientprotocol/codex-acp` and does not retain its provider-specific App Server translation as the default path.

## Claude ACP adapter

Relevant source:

- `src/acp-agent.ts`: SDK query lifecycle, session resume/load, streaming, cancellation, config, steering, and subagent behavior.
- `src/permissions/`: normalized permission choices and effects.
- `src/elicitation.ts`, `settings.ts`, `session-config-ids.ts`, and `goal-extension.ts`.
- `src/tests/session-load.test.ts`, `session-config-options.test.ts`, `elicitation.test.ts`, and the steering/subagent sections in `acp-agent.test.ts`.

The adapter owns Claude Agent SDK resume semantics, permission mapping, MCP/config, streaming, background subagent settlement, and `_session/steering`. Agent Groups launches `npx -y @agentclientprotocol/claude-agent-acp`; the legacy direct SDK provider remains source-compatible but is not registered as the default `claude` runtime.

Known upstream risks observed at this revision include background-subagent permission attribution/deadlock reports and edge cases around a steered turn settling. Host correctness therefore uses correlation, explicit pending requests, deadlines, and a durable fallback queue rather than timing assumptions.

## Gemini CLI ACP mode

Relevant source:

- `packages/cli/src/acp/acpStdioTransport.ts` and `acpRpcDispatcher.ts`: native stdio transport and dispatch.
- `acpSessionManager.ts`, `acpSession.ts`, and `acpResume.test.ts`: session creation and resume.
- `docs/cli/acp-mode.md` and `packages/cli/src/acp/README.md`: invocation and supported behavior.

Decision: the built-in definition is `{ command: "gemini", args: ["--acp"] }`. No Gemini branch exists in host logic.

## Symphony reconciliation

Relevant source:

- `SPEC.md`: authoritative tracker state, polling/reconciliation, bounded concurrency, retry state, workspace lifecycle, and observability.
- `elixir/lib/symphony_elixir/orchestrator.ex`: reconcile loop, running-entry ownership, retry/backoff, and stale-run handling.
- `elixir/lib/symphony_elixir/workspace.ex`: explicit workspace preparation/removal hooks.
- `elixir/test/symphony_elixir/orchestrator_status_test.exs` and backoff queue fixtures.

Adopted pattern: a non-overlapping idempotent `RuntimeReconciler` repeatedly converges durable members/queues toward live provider sessions, with bounded exponential backoff after failure. The Leader remains the semantic planner. Host restart reattaches the recorded provider session and drains the persisted future-turn FIFO; it never infers success from a subprocess exit.

Not yet copied from Symphony: tracker-specific issue claiming and workspace hook scripts. Agent Groups' task DAG remains authoritative.

## Kandev product architecture (reference only)

Relevant source and decisions:

- `docs/public/executors.md`, `sessions-and-review.md`, and `automation-and-mcp.md`: agent profiles, local/worktree/Docker/SSH executors, persistent task sessions, review, targeted messaging, and durable automation threads.
- `apps/backend/internal/agentctl/server/acp/`: generic ACP client boundary.
- `apps/backend/internal/backendapp/worktree.go`: worktree lifecycle.
- `docs/decisions/0034-agentclientprotocol-codex-acp.md`, `0044-acp-agent-compatibility-dialects.md`, `0003-executors-running-as-execution-id-source-of-truth.md`, and `2026-08-08-task-owned-worktree-lifetime.md`.

Useful product conclusions are that profiles, executors, sessions, tasks, and executions are different identities; a finished execution can leave a session repliable; capability dialects must be normalized at the adapter boundary; and shared/worktree modes have intentionally different conflict semantics. These ideas are clean-room reimplemented. AGPL-covered implementation code is not copied.

## Microsoft Agent Host Protocol

The repository's reducer/action/snapshot model demonstrates ordered authoritative actions and client replay. DSH Agent Groups already has a server-authoritative domain plus SSE. Introducing another protocol would add two authorities, so AHP remains a future reference for multi-client snapshot/replay only.

## Resulting implementation boundary

```text
GroupHost (product authority)
  └─ RuntimeReconciler (desired → actual)
      ├─ DSH native RuntimeSession
      └─ ACPAgentRuntimeProvider (one configured agent family)
          └─ ACP process / connection
              └─ ACP session per durable Member
                  └─ prompt turn per Task attempt/follow-up
```

The Host persists the ACP session id, negotiated normalized capabilities, last turn/task correlation, and future-turn FIFO. Authentication stays owned by the installed agent/adapter environment. No command definition environment values, credentials, raw approval payloads, or token deltas are persisted.
