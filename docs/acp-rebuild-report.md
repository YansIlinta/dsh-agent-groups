# ACP-native rebuild report

Date: 2026-08-23

## Upstream evidence

Exact repositories, commits, relevant files, interfaces, and license decisions are recorded in [upstream-architecture-study.md](upstream-architecture-study.md). The implementation uses the official `@agentclientprotocol/sdk` and launches the official Codex/Claude adapters or native Gemini ACP mode; it does not reproduce their provider translation layers.

## Architecture chosen

```text
Mission → Work Graph → Task → Attempt → Agent Turn
Team → Role → Member → Runtime Session → Turns
ACP provider → shared process/connection → member ACP sessions
```

`GroupHost` owns product state. An ACP agent owns its provider conversation state. Process exit, session loss, turn completion, task completion claim, and verification are distinct transitions.

## Runtime changes

- Generic `ACPAgentRuntimeProvider` built on the official TypeScript SDK and NDJSON transport.
- Built-in definitions for `codex-acp`, `claude-agent-acp`, and Gemini CLI native ACP.
- Custom no-shell ACP command definitions.
- Explicitly allowlisted, pinned `npx` profiles parsed from ACP Registry documents.
- Shared ACP process/connection with independently correlated member sessions.
- Runtime process placement is abstracted behind `RuntimeExecutor`; the shipped implementation is local/no-shell.
- Durable ACP session ids, normalized capabilities, queued turns, workspace, model, and reasoning selection.
- New members complete `initialize`, `session/new`, and advertised config-option application before being persisted as usable.
- Restart uses `session/resume` or `session/load`; unsupported or failed resume never creates a silent replacement conversation.
- Optional steering is invoked only when the agent advertises the `_meta` extension.
- Permissions and elicitation become explicit pending Host requests.
- Streaming message/reasoning/tool events remain ephemeral; lifecycle milestones are durable.

## Attempts, reconciliation, and workspaces

- Every task-bound turn gets an independently identified durable Attempt.
- Terminal Attempt outcomes are one-way and idempotent: completed, failed, cancelled, or lost.
- Terminal ordering is Attempt → bound Task → queued next turn, preventing late-event task corruption.
- A non-overlapping reconciler resumes durable sessions and drains durable FIFO turns with exponential backoff.
- Restart reconciliation marks durable running Attempts with no matching live turn as `lost` and fails the task without unsafe replay.
- Group workspace mode is explicit: shared directory or persistent detached Git worktree per member.
- Worktree directories are never silently overwritten or automatically deleted.

## Evidence from tests

The deterministic fake ACP subprocess covers:

- initialize and session/new;
- two sequential prompts on the same session id;
- process restart and same-session resume;
- parallel sessions on one ACP process;
- streaming message, reasoning, and tool events;
- permission resolution;
- cancellation and advertised steering;
- malformed JSON and process crash;
- resume failure.

Host integration tests cover late events, active member removal, queued future turns, failed steering fallback, request timeout, task Attempt idempotency, cancellation ordering, and restart reconciliation. Git tests create real repositories and verify isolated persistent worktrees.

At completion:

- TypeScript typecheck passes.
- Native client syntax check passes.
- Production build passes.
- 170 tests pass; one real-Codex credential smoke test is skipped by default.
- Real storage write/close/reopen/read durability verification passes.

## UI changes

The feature remains a DSH client plugin and uses the existing shell/sidebar/overlay integration rather than a separate application. Normal views remain Mission, Tasks, Team, Channel, Workspace, and Activity. Workspace mode is selected during group creation; task rows expose the latest Attempt. ACP session ids and negotiated capabilities remain in advanced runtime inspection.

## Licensing

- DeepSeek Harness and Agent Host Protocol: MIT-compatible reference/reuse boundary.
- ACP protocol, TypeScript SDK, official adapters, and Symphony: Apache-2.0-compatible dependency/reference boundary.
- Kandev: architecture/product reference only; no AGPL implementation source copied.

## Known limitations and remaining work

- ACP v1 has no stable universal authenticated-state query. Upstream `auth/status` is still an RFD. `session/new` is the current materialization check, but agents that defer credential validation can fail on their first prompt; that failure is surfaced loudly.
- Registry JSON is supplied by host configuration and requires an explicit allowlist. Automatic CDN refresh, signature/provenance policy, binary download verification, and platform-specific archive installation are not implemented.
- The reconciler currently guarantees session reattachment, durable queue draining, non-overlap, and backoff. Full desired-state scheduling—automatic role selection/spawn, stale task leases, retry budgets, and bounded mission-wide concurrency—remains future work.
- Local shared/worktree execution and the executor interface are implemented. Docker, SSH, and remote executor implementations remain future work.
- Worktree cleanup is deliberately manual until review/archive semantics can protect unmerged work.
- Real Codex and Claude launches were checked locally; end-to-end paid-provider prompts remain credential-gated. Gemini CLI was not installed in the validation environment.
- The native client follows DSH shell integration and tokens, but some `ag-*` layout wrappers remain; a final visual comparison against each current DSH responsive state is still worthwhile.
