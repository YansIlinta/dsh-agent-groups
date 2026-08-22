# Codex App Server protocol findings (V0.5)

Recorded on 2026-xx-xx against the environment's installed runtime:

| Artifact | Version / location |
| --- | --- |
| `codex` binary | `codex-cli 0.147.0` (`/home/ubuntu/.nvm/versions/node/v22.23.1/bin/codex`) |
| `@openai/codex` npm package | `0.147.0` — a platform-binary download wrapper only, no JS protocol API |
| TS bindings | `codex app-server generate-ts --out DIR` (93 files, ~1100 lines) against the same binary |
| JSON Schema | `codex app-server generate-json-schema --out DIR` |
| Official README | `codex-rs/app-server/README.md` at tag `rust-v0.147.0` (2492 lines) |

## Key protocol facts used by `runtime/codex-protocol.ts`

- Transport: stdio (`codex app-server`, default `--listen stdio://`), one JSON-RPC 2.0 message per line (the `jsonrpc` header is omitted on the wire).
- Handshake: client sends `initialize` (with `clientInfo`) → server answers `{id, result: InitializeResponse}` → client sends the `initialized` notification. Any other request before that is rejected (`Not initialized`).
- Client requests: `{ "method": "thread/start", "id": <string|number>, "params": {...} }`; responses `{ "id": ..., "result": XxxResponse }`, errors `{ "id": ..., "error": {code, message, data?} }`.
- Server notifications: `thread/started`, `thread/status/changed`, `thread/closed`, `turn/started`, `turn/completed`, `item/started`, `item/completed`, `item/agentMessage/delta`, `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`, `serverRequest/resolved`, `error`, `warning`/`configWarning`, …
- Server-initiated requests (need a client answer): `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, `item/tool/call`. Approvals are answered `{ "id": <same>, "result": { "decision": "accept" | "acceptForSession" | "decline" | "cancel" | … } }`; `request_user_input` is answered with `{ "result": { "answers": { <questionId>: { "answers": [ ... ] } } } }`.
- Turn lifecycle: `turn/start` returns the initial turn + emits `turn/started`; the server streams `item/*` deltas; the turn ends with `turn/completed` whose `turn.status` is `completed | interrupted | failed | inProgress` (wire type `TurnStatus`). `turn/steer` injects follow-up input into a RUNNING turn (precondition: `expectedTurnId` must match the active turn). `turn/interrupt` cancels by `(threadId, turnId)`.
- Threads are the durable conversation identity (`thread.id`, and `thread.sessionId` = the session-tree id). `thread/resume {threadId}` re-attaches a stored thread and re-subscribes the connection to its events.
- Model discovery: `model/list` → `{ data: [{ id, model, displayName, hidden, supportedReasoningEfforts: [{reasoningEffort, description}], defaultReasoningEffort, … }], nextCursor }`. This is the AUTHORITY for selectable models + reasoning efforts; Agent Groups uses it dynamically (fallback static catalog clearly marked).
- `thread/start` accepts `model`, `cwd`, `sandbox` (`read-only | workspace-write | danger-full-access`), `approvalPolicy` (`never | on-request | untrusted | {granular:{…}}`), `baseInstructions`; `turn/start` additionally accepts `effort` (model reasoning effort), `clientUserMessageId` (echoed back on the userMessage item).

## Design consequences for Agent Groups

- A member = one durable Codex **thread**; tasks and Leader follow-ups are **turns/steers on that thread** — never a new `codex exec` process.
- Turn ids are correlated by `(threadId, turnId)`; the provider ignores events whose turn id does not match the current active turn (late-event safety).
- `turn/completed` with `status: interrupted` is the only interrupt outcome; `turn/interrupt` just asks.
- Approval-style server requests are surfaced as `turn.approval.required` events with the wire request id; Agent Groups answers them via `respondToRequest` (default policy: decline — nothing hangs invisibly, nothing auto-approves).
- Credentials never enter the protocol layer: auth stays in the installed login/API keys; the provider only probes existence.

## Remaining limitations observed

- `thread/start` marks the project trusted when `cwd` + `workspace-write` are used; the trust marker lives in the user `config.toml` (provider behavior, outside Agent Groups).
- Approval answering is a host-side policy decision; there is no per-request timeout on the wire — an unanswered request parks the turn until answered or the session is interrupted/closed.
- The protocol is experimental (`codex app-server` is marked experimental) and versioned by the binary; Agent Groups pins behavior to the generated types for 0.147.0 and keeps the parser tolerant of unknown notification methods.