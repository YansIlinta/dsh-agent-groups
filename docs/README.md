# DSH Agent Groups Documentation

The root [README](../README.md) is the product entry point. This directory keeps architecture, lifecycle rules, provider notes, and development details out of the project landing page.

## Start here

| Document | Purpose |
| --- | --- |
| [Architecture](architecture.md) | Domain model, runtime/session/turn lifecycle, completion rules, communication boundaries, and persistence invariants. |
| [Development](development.md) | Local setup, build/test commands, DSH web-profile integration, CI, and contribution workflow. |
| [Native UI](native-ui.md) | How Agent Groups integrates with DSH client slots, shell, theme tokens, API, and SSE. |
| [Codex App Server protocol](CODEX_APP_SERVER_PROTOCOL.md) | Protocol notes for the persistent Codex runtime transport. |

## Suggested reading order

For contributors working on the product layer:

1. Read the root [README](../README.md) for the product model.
2. Read [Architecture](architecture.md) before touching task/runtime semantics.
3. Read [Development](development.md) before running local integration or CI workflows.
4. Read [Native UI](native-ui.md) for changes under the DSH-native workspace.
5. Read provider protocol notes only when working on the relevant runtime adapter.

## Documentation boundaries

Keep the root README focused on:

- what Agent Groups is;
- why persistent teammates matter;
- supported runtime behavior;
- how to install and start using it;
- where contributors should go next.

Keep implementation material under `docs/`, including:

- lifecycle invariants and recovery rules;
- provider protocol investigations;
- compatibility notes;
- DSH integration details;
- development and testing procedures.

Version history belongs in Git history, pull requests, issues, and releases rather than accumulating as large V0.x sections in the README.

## Repository invariants

Before changing runtime/session behavior, also read [`AGENTS.md`](../AGENTS.md) and [`CONTRIBUTING.md`](../CONTRIBUTING.md). The repository treats lifecycle semantics and completion rules as product contracts, not implementation details.
