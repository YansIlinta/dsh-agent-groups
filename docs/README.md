# DSH Agent Groups Documentation

The root [README](../README.md) is the product entry point. This directory keeps implementation details that would otherwise make the project page difficult to scan.

## Guides

| Document | Purpose |
| --- | --- |
| [Architecture](architecture.md) | Domain model, runtime/session lifecycle, completion rules, communication boundaries, and persistence invariants. |
| [Development](development.md) | Local setup, build/test commands, DSH web-profile integration, CI, and contribution workflow. |
| [Native UI](native-ui.md) | How Agent Groups integrates with the DSH client slot system and theme without a second application shell. |
| [Codex App Server protocol](CODEX_APP_SERVER_PROTOCOL.md) | Protocol notes for the persistent Codex runtime transport. |

## Documentation policy

Keep the root README focused on what the project is, what it can do, how to get started, and where to go next.

Implementation investigations, provider protocol details, compatibility notes, and design invariants belong under `docs/`. Version history belongs in Git history, pull requests, issues, and releases rather than accumulating as large V0.x sections in the README.
