# Codex App Server protocol findings (V0.5)

Recorded on 2026-xx-xx against the environment's installed runtime:

| Artifact | Version / location |
| --- | --- |
| `codex` binary | `codex-cli 0.147.0` (`/home/ubuntu/.nvm/.../bin/codex` on the recording host; `C:\Users\...\AppData\Roaming\npm\node_modules\@openai\codex-win32-x64\vendor\...\bin\codex.exe` on Windows via the npm shim) |
| `@openai/codex` npm package | `0.147.0` — a platform-binary download wrapper only, no JS protocol API |
| TS bindings | `codex app-server generate-ts --out DIR` (642 files incl. `ts/v2/`; re-verified on the Windows install) |
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
- Approval-style server requests are surfaced as `turn.approval.required` events with the wire request id; Agent Groups answers them via `respondToRequest`. V0.6: every pending request carries a **deadline** — when it passes unanswered the provider executes the safe default (`decline` for the default policy, `cancel` for hold mode; never an approval) and emits `request.timeout` so nothing parks invisible forever.
- Credentials never enter the protocol layer: auth stays in the installed login/API keys; the provider only probes existence.

## V0.6 re-verification against the installed binary (Windows, codex-cli 0.147.0 via npm)

- `codex app-server generate-ts` / `generate-json-schema` were re-run against the installed binary: 642 TS files (the doc's "93 files" was the top-level-only count — the generated tree also has a `ts/v2/` subfolder) and JSON-schema bundles. The generated unions are the validation authority.
- **`thread/cancel` does NOT exist** in 0.147.0 (default or `--experimental`) — Agent Groups never calls it; interruption is `turn/interrupt` only.
- New fields the binary accepts but the notes above do not list: `approvalsReviewer` (`user | auto_review | guardian_subagent`), `modelProvider`, `serviceTier`, `developerInstructions`, `personality`, `ephemeral`, and `turn/start`'s `sandboxPolicy` object (the legacy `sandbox` string still works). Agent Groups keeps using the documented subset; unknown fields are never sent.
- `remoteControl/status/changed` arrives right after `initialize`; the daemon/proxy/`unix://` socket paths are Unix-only (Windows uses `--listen stdio://`).
- The provider probes the live binary rather than assuming a version: `model/list` is the model authority, `turn/steer` failures are typed and never silently dropped (V0.6), and the parser tolerates unknown notification methods.

## Remaining limitations observed

- `thread/start` marks the project trusted when `cwd` + `workspace-write` are used; the trust marker lives in the user `config.toml` (provider behavior, outside Agent Groups).
- The protocol is experimental (`codex app-server` is marked experimental) and versioned by the binary; Agent Groups pins behavior to the generated types for 0.147.0 and keeps the parser tolerant of unknown notification methods.