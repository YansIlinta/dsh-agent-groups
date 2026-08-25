# `packages/host/src/` code map

This file answers one question: **where should a change start?**

Do not treat `group-host.ts` as the default place for new behavior just because it is the main coordination facade. Find the smallest owning boundary first, then follow one import/call chain deeper only when needed.

## Product assembly

```text
index.ts
  -> constructs durable services and runtime registry
  -> registers DSH / ACP runtime providers
  -> mounts web routes and native client integration

leader.ts
  -> Leader-facing tools
  -> generic Team Lead protocol
  -> Create Flow production protocol

member.ts
  -> Member-facing tools and protocol
```

## Domain and orchestration

| Concern | Start here | Continue with |
| --- | --- | --- |
| Group/member lifecycle | `group-service.ts` | `group-host.ts`, `persistence.ts` |
| Mission/task DAG and state | `task-service.ts` | `group-host.ts`, `core-types.ts` |
| Runtime coordination | `group-host.ts` | `runtime/`, `runtime-reconciler.ts` |
| Leader tools | `leader-tools.ts` | `leader.ts`, `leader-prompt.ts` |
| Member tools | `member-tools.ts` | `member.ts` |
| Shared/private communication | `channel-service.ts` | `leader-tools.ts`, `member-tools.ts` |
| Activity timeline | `activity-service.ts` | `notifier.ts` |
| Persistence schema | `persistence.ts` | `store.ts`, `core-types.ts` |
| Team/role configuration | `runtime/team-config.ts` | `template-registry.ts`, `profile-registry.ts` |

## Runtime layer

Start in `runtime/base.ts` for normalized contracts. Provider-specific code belongs under `runtime/` rather than in product services.

```text
runtime/base.ts
  -> session / turn / runtime contracts
runtime/registry.ts
  -> provider discovery and usability
runtime/deepseek-harness.ts
  -> persistent DSH member sessions
runtime/acp.ts
  -> normalized ACP runtime
runtime/codex.ts / runtime/claude.ts
  -> provider-specific integration where still required
runtime/executor.ts
  -> process placement / no-shell execution boundary
```

Before changing runtime/session semantics, read `../../../docs/architecture.md` and the runtime invariants in `../../../AGENTS.md`.

## Create Flow

Create Flow is an additive production specialization. Its local production state does **not** replace Agent Groups task/session/completion state.

Start at [`create-flow/README.md`](create-flow/README.md) instead of scanning the whole host package.

Main boundaries:

```text
create-flow/service.ts
  -> artifacts, scenes, jobs, workspace state
create-flow/media-runtime.ts
  -> deterministic local TTS / ASR / FFmpeg operations
create-flow/leader-tools.ts
  -> model-facing Create Flow tools
create-flow/leader-prompt.ts
  -> production-stage operating protocol
create-flow/task-projector.ts
  -> verified task artifacts -> production stages
create-flow/web-api.ts
  -> /groups/api/create-flow/*
```

## Native client and HTTP surface

| Concern | Start here |
| --- | --- |
| DSH-native workspace | `native-client/` |
| HTTP API / SSE | `web/` |
| Create Flow API | `create-flow/web-api.ts` |

UI state is a view of Host state. Do not move task/session authority into the client.

## Change discipline

- Prefer a small service/module change over adding another branch to `group-host.ts`.
- Keep provider translation inside runtime/provider modules.
- Keep deterministic media execution out of prompts and model-generated shell commands.
- Add focused regression coverage near the owning boundary.
- If a change affects process/session/turn/task lifetime, verification, recovery, or credentials, treat it as an architecture change rather than a local refactor.
