# DSH Agent Groups Documentation

The root [README](../README.md) is the product entry point. This directory keeps architecture, lifecycle rules, product specializations, provider notes, and development details out of the landing page.

## Start here

| Document | Purpose |
| --- | --- |
| [Architecture](architecture.md) | Domain model, runtime/session/turn lifecycle, completion rules, communication boundaries, and persistence invariants. |
| [Development](development.md) | Local setup, build/test commands, DSH web-profile integration, CI, and contribution workflow. |
| [Native UI](native-ui.md) | How Agent Groups integrates with DSH client slots, shell, theme tokens, API, and SSE. |
| [Create Flow](create-flow.md) | Video-production specialization, production stages, workspace state, local media runtime, and Leader operations. |
| [Codex App Server protocol](CODEX_APP_SERVER_PROTOCOL.md) | Protocol notes for the persistent Codex runtime transport. |

## Code maps

When the task is implementation rather than product reading, use the source maps instead of scanning large files:

| Map | Use it for |
| --- | --- |
| [`packages/host/src/README.md`](../packages/host/src/README.md) | Find the first owning Host/runtime/UI/domain module. |
| [`packages/host/src/create-flow/README.md`](../packages/host/src/create-flow/README.md) | Find Create Flow state, media, tools, protocol, projector, API, UI and tests. |
| [`AGENTS.md`](../AGENTS.md) | Repository-wide invariants and task-scoped skill entry points. |

## Suggested reading order

For contributors working on the core product layer:

1. Read the root [README](../README.md) for the product model.
2. Read the Host [code map](../packages/host/src/README.md) to locate the owning module.
3. Read [Architecture](architecture.md) before touching task/runtime semantics.
4. Read [Development](development.md) before running local integration or CI workflows.
5. Read [Native UI](native-ui.md) for changes under the DSH-native workspace.
6. Read provider protocol notes only when working on the relevant runtime adapter.

For Create Flow work:

1. Read [Create Flow](create-flow.md).
2. Read the [Create Flow implementation map](../packages/host/src/create-flow/README.md).
3. Use `npm run test:create-flow` while iterating.
4. Run `npm run verify` before considering the change complete.

## Documentation boundaries

Keep the root README focused on:

- what Agent Groups is;
- why persistent teammates matter;
- supported runtime behavior;
- how to install and start using it;
- where contributors should go next.

Keep implementation material under `docs/` and source-local README files, including:

- lifecycle invariants and recovery rules;
- product-specialization contracts such as Create Flow;
- provider protocol investigations;
- compatibility notes;
- DSH integration details;
- development and testing procedures;
- code maps that answer "where should I start?".

Version history belongs in Git history, pull requests, issues, and releases rather than accumulating as large V0.x sections in the README.

## Repository invariants

Before changing runtime/session behavior, also read [`AGENTS.md`](../AGENTS.md) and [`CONTRIBUTING.md`](../CONTRIBUTING.md). The repository treats lifecycle semantics and completion rules as product contracts, not implementation details.
