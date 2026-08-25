# Create Flow development

Use this skill for changes to Create Flow production stages, artifacts, scenes, local media operations, production UI, or the Flow Agent protocol.

## Read first

1. `docs/create-flow.md` for the product/domain contract.
2. `packages/host/src/create-flow/README.md` for the implementation map.
3. `docs/architecture.md` only when the change crosses into durable Agent Groups lifecycle or completion semantics.

## Ownership rules

- Production state (`artifacts`, `scenes`, `jobs`) belongs to `create-flow/service.ts` and the group workspace.
- Deterministic TTS / ASR / FFmpeg execution belongs to `create-flow/media-runtime.ts`.
- Model-facing Create Flow actions belong to `create-flow/leader-tools.ts`.
- Stage guidance belongs to `create-flow/leader-prompt.ts`.
- Verified task artifact projection belongs to `create-flow/task-projector.ts`.
- HTTP endpoints belong to `create-flow/web-api.ts`.
- UI remains a view of Host state and belongs under `native-client/`.

## Non-negotiable boundary

Create Flow is not a second orchestrator. Media job completion is not task completion, and `.create-flow/state.json` is not authoritative for Agent Groups task/session/verification state.

Do not let prompt logic, UI state, or successful FFmpeg/TTS/ASR execution bypass Leader/Verifier acceptance.

## Media rules

- Keep subprocess invocation deterministic and `shell: false`.
- Keep media paths inside the group workspace.
- Prefer typed production intent over model-generated raw command lines.
- A scene needs a visual and either audio or a positive explicit duration before it is renderable.

## Validation

Start with:

```bash
npm run test:create-flow
```

Then run full verification for a completed change:

```bash
npm run verify
```

Add focused regression coverage when changing stage gates, artifact projection, scene persistence/order, path validation, or render behavior.
