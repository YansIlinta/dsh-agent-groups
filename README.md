<div align="center">

# DSH Agent Groups

**Long-running AI teams, natively inside DeepSeek Harness.**  
让 Claude、Codex 与 DSH Agent 成为可持续协作的长期队友。

[![CI](https://github.com/YansIlinta/dsh-agent-groups/actions/workflows/ci.yml/badge.svg)](https://github.com/YansIlinta/dsh-agent-groups/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/YansIlinta/dsh-agent-groups)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-native-5B5BD6)](https://github.com/deepseek-ai/DeepSeek-Harness)

[Getting Started](#getting-started) · [Architecture](docs/architecture.md) · [Native UI](docs/native-ui.md) · [Development](docs/development.md) · [Codex Protocol](docs/CODEX_APP_SERVER_PROTOCOL.md)

</div>

## Overview

DSH Agent Groups is an independent plugin for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) that adds a durable workspace for running teams of AI agents.

Instead of treating Claude, Codex, or DSH subagents as disposable one-shot workers, Agent Groups models each member as a **long-lived teammate** with a persistent runtime session, task history, queued work, shared workspace context, and a durable place in the team.

The project does **not** patch or copy DSH source code. It uses DSH/Cordis extension surfaces and renders directly inside the normal DSH shell.

```text
User
  │
  ▼
Leader ───────────── orchestrates mission / tasks / verification
  │
  ├── DSH Member   ── persistent DSH session
  ├── Codex Member ── persistent Codex thread
  └── Claude Member── persistent Claude session
          │
          ▼
 shared workspace + task DAG + channel + activity timeline
```

## Why Agent Groups

| Capability | What it means |
| --- | --- |
| **Persistent teammates** | One member keeps the same provider conversation across tasks and Leader follow-ups. |
| **Multi-runtime teams** | A team can combine native DSH agents, OpenAI Codex, and Anthropic Claude. |
| **Leader-controlled orchestration** | The Leader decomposes work, assigns tasks, follows up, verifies results, and alone declares the mission complete. |
| **Durable state** | Groups, missions, tasks, messages, runtime metadata, notes, artifacts, and activity survive reloads and host restarts where supported. |
| **Native DSH UI** | Agent Groups appears in the DSH sidebar and opens inside the DSH shell. No iframe and no second dashboard. |
| **Explicit runtime semantics** | Process, session, turn, and task lifecycles are separate; a process exit is never silently treated as successful task completion. |
| **Enforced communication policy** | Leader↔Member private messaging is allowed; Member↔Member private messaging is blocked in the host service layer rather than relying on prompts. |

## Runtime model

A Group Member owns one runtime session. Tasks and corrections become turns inside that session.

```text
Group
  └── Member
       └── Runtime Session
            ├── Turn 1  ← Task A
            ├── Turn 2  ← Leader follow-up
            └── Turn 3  ← Task B
```

| Runtime | Session identity | Multi-turn behavior |
| --- | --- | --- |
| **DeepSeek Harness** | DSH member session | Native durable member; role/model/reasoning restored on resume. |
| **Codex** | Codex App Server thread | Tasks reuse the same thread; active work can be steered with provider-native turn steering. |
| **Claude** | Claude Agent SDK session id | Each new turn resumes the same Claude conversation with `options.resume`. |

Runtime providers expose a common session/turn contract, normalized events, interruption, pending approvals/input, and provider-specific resume behavior. See [Architecture](docs/architecture.md) for the invariants.

## Native workspace

Agent Groups is injected through DSH's client plugin system:

- **Sidebar:** `sidebar.footer.action` adds the Agent Groups entry.
- **Workspace:** `shell.overlay` hosts the full-frame Agent Groups page while keeping the DSH shell, theme, and navigation intact.
- **Components:** DSH UI primitives and `--dsw-alias-*` design tokens are reused; project-local styles are scoped with the `ag-` prefix.
- **Live data:** `/groups/api/*` provides the data API and `/groups/api/events` streams updates through SSE.

The workspace includes group overview, task board, team/runtime state, channel, Leader chat, shared workspace, activity timeline, profiles, and team configuration.

More detail: [Native UI notes](docs/native-ui.md).

## Getting started

### Requirements

- Node.js **20+**
- A local DeepSeek Harness installation
- Bash for the provided web-profile install/relaunch scripts
- Optional: an authenticated `codex` installation for Codex members
- Optional: an authenticated Claude/Claude Agent SDK environment for Claude members

The current CI compatibility target is **DeepSeek Harness `0.1.0-rc.6`**. Compatibility with newer DSH releases should be verified before treating them as supported.

### Build

```bash
git clone https://github.com/YansIlinta/dsh-agent-groups.git
cd dsh-agent-groups

cd packages/host
npm install
cd ../..

npm run build
npm run typecheck
npm test
```

### Install into the DSH web profile

```bash
npm run install-web-profile
npm run relaunch-web
```

The installer builds the native client bundle, copies `@dsh-agent-groups/host` into the local DSH profile module tree, installs the `group-leader` / `group-member` presets, and adds the plugin row to the web profile patch.

After DSH restarts, open the normal DSH web UI and choose **Agent Groups** from the sidebar footer.

## Basic workflow

1. Start or select an **Agent Group · Team Lead** session.
2. Open **Agent Groups** → **New Group**.
3. Choose a team template or configure roles and runtimes manually.
4. Give the group a mission.
5. Let the Leader decompose the mission into tasks and assign members.
6. Follow work from **Tasks**, **Team**, **Channel**, **Leader Chat**, **Workspace**, and **Activity**.
7. Send corrections to an active member, queue future work, answer approvals/input, or interrupt a turn when necessary.
8. The Leader verifies completion claims before completing the mission.

## Development

From the repository root:

```bash
npm run build
npm run typecheck
npm test
npm run build:native
```

Useful integration scripts:

```bash
node scripts/verify-durability.mjs
node scripts/demo-v02.mjs
```

See [Development guide](docs/development.md) for repository conventions, CI, local DSH integration, and runtime testing.

## Repository layout

```text
.
├── packages/
│   ├── host/               # host services, tools, runtimes, API, native client source
│   └── profiles/           # group-leader / group-member presets and profile fragments
├── scripts/                # build, install, relaunch, demo, durability helpers
├── docs/                   # architecture and implementation notes
├── AGENTS.md               # coding-agent rules and repository invariants
├── CONTRIBUTING.md         # contribution workflow
└── README.md
```

Inside `packages/host/src/` the main boundaries are:

- `group-host.ts` — product/service facade and runtime coordination
- `group-service.ts` / `task-service.ts` / `channel-service.ts` — durable domain behavior
- `runtime/` — DSH, Codex, Claude, session/turn abstractions, normalized events
- `native-client/` — DSH-native Agent Groups page
- `web/` — Agent Groups API + SSE
- `persistence.ts` / `store.ts` — durable schema and storage adapters

## Project status

Agent Groups is under active development. The persistent session model is implemented, but long-horizon runtime durability is still being hardened.

Current high-priority work includes making queued turns fully durable across host restarts, keeping active-vs-queued task state unambiguous, and ensuring deterministic retries after transient turn-start failures.

For implementation history, use Git history and pull requests rather than expanding the README into a version-by-version changelog.

## Documentation

- [Documentation index](docs/README.md)
- [Architecture and invariants](docs/architecture.md)
- [Development guide](docs/development.md)
- [Native UI integration](docs/native-ui.md)
- [Codex App Server protocol notes](docs/CODEX_APP_SERVER_PROTOCOL.md)

## Contributing

Bug reports, runtime compatibility findings, regression tests, and focused pull requests are welcome. Before changing runtime/session behavior, read [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md); lifecycle invariants are part of the product contract and should be protected by tests.

## License

[MIT](LICENSE)
