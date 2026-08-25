# Create Flow implementation map

Create Flow is the video-production specialization layered on top of the existing durable Agent Groups runtime.

The key rule is simple: **production state is not orchestration state**. `.create-flow/state.json` tracks artifacts, scenes and media jobs; Agent Groups still owns members, tasks, attempts, runtime sessions, verification and mission completion.

## Production flow

```text
TOPIC
  -> RESEARCH
  -> MATERIALS
  -> SCRIPT
  -> SCENES
  -> VOICE / CAPTIONS
  -> RENDER
  -> VERIFY
```

The model-facing production protocol lives in `leader-prompt.ts`. It guides the Leader through these stages but does not create a second scheduler or state machine.

## First entry by task

| You want to change... | Start here | Notes |
| --- | --- | --- |
| Artifact / scene / job state | `service.ts` | Workspace-scoped state and validation |
| TTS / ASR / FFmpeg behavior | `media-runtime.ts` | Deterministic subprocess boundary; no shell |
| Tools available to the Leader | `leader-tools.ts` | Keep tools narrow and typed |
| How the Flow Agent advances stages | `leader-prompt.ts` | Guidance only; durable authority stays in Agent Groups |
| Verified task -> production artifact mapping | `task-projector.ts` | Projection must remain idempotent |
| Create Flow HTTP endpoints | `web-api.ts` | `/groups/api/create-flow/*` |
| Create Flow UI | `../native-client/` | UI is a projection of Host state |
| Production-domain overview | `../../../../docs/create-flow.md` | User/developer-facing domain documentation |

## State ownership

```text
Agent Groups durable domain
  group
  members
  tasks + attempts
  messages
  runtime session metadata
  verification / mission completion

Group workspace
  .create-flow/state.json
    artifacts[]
    scenes[]
    jobs[]
  .create-flow/jobs/
  .create-flow/outputs/
```

Do not infer task success from a media job. A successful TTS, ASR or FFmpeg command only means the deterministic production operation completed.

## Scene timeline

A `CreateFlowScene` is an ordered production unit. It binds:

- a required workspace `visualPath`;
- optional narration text;
- optional `audioPath`;
- optional `subtitlePath`;
- optional explicit `durationSec`.

For renderability, a scene needs a visual plus either audio or a positive explicit duration. `service.ts` owns scene persistence and ordering; `media-runtime.ts` owns normalization and final concatenation.

The Leader should use explicit scene upsert/remove operations instead of silently mutating files and hoping the timeline follows.

## Media boundary

`LocalMediaRuntime` is deliberately deterministic:

- subprocesses use executable + argv with `shell: false`;
- paths are resolved through `CreateFlowService` and constrained to the group workspace;
- TTS and ASR are adapter-shaped local commands;
- FFmpeg owns single-shot and multi-scene rendering;
- the LLM never needs to manufacture raw FFmpeg command lines.

If a richer renderer is added later, preserve this boundary: the Flow Agent describes production intent; a typed runtime executes it.

## Tests

Focused tests currently live under `packages/host/test/` and use the `create-flow` prefix.

Useful command:

```bash
npm run test:create-flow
```

When changing this slice, cover the smallest relevant contract:

- workspace path escape rejection;
- state persistence and backward-compatible reads;
- idempotent task artifact projection;
- scene ordering/update/removal;
- timeline render inputs and output artifact creation;
- Leader production protocol gates when stage behavior changes.

For full validation, run `npm run verify` from the repository root.
