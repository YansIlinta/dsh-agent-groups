# Create Flow

Create Flow is the video-production specialization of DSH Agent Groups.

It reuses the existing durable Agent Groups runtime instead of introducing a second orchestrator. A Create Flow group keeps the same long-lived member identities, provider sessions, task attempts, channel history, runtime recovery and verification semantics as any other group.

For source ownership and first-entry files, see [`packages/host/src/create-flow/README.md`](../packages/host/src/create-flow/README.md).

## Product shape

```text
User
  -> Create Flow Lead
       -> persistent production Members
            Topic Strategist
            Researcher
            Material Producer
            Scriptwriter
            Video Producer
       -> normal Agent Groups tasks / attempts / verification
       -> Create Flow production state
            artifacts
            scenes
            local media jobs
       -> deterministic local media runtime
            TTS
            ASR
            FFmpeg single-shot / timeline render
```

The **Create Flow Lead** remains the authority for task assignment, stage transitions, media-job scheduling and final verification. The production protocol helps the Leader advance the workflow, but it does not create a second scheduler or completion state machine.

## Production stages

The intended production flow is:

```text
topic
  -> research
  -> materials
  -> script
  -> scenes
  -> voice / captions
  -> render
  -> verify
```

The stage gates are deliberately stricter than “a file exists”:

- topic direction should be accepted before downstream work depends on it;
- factual research should preserve source provenance;
- script work should be verified before scene assembly when it is a required prerequisite;
- scene edits should be revisited when script/material inputs change materially;
- TTS, ASR and FFmpeg success create production outputs but do not verify the owning Agent Groups task;
- mission completion still requires the normal Leader/Verifier path.

The model-facing stage guidance lives in `packages/host/src/create-flow/leader-prompt.ts`.

## Production team

The built-in `content-team` template is presented as **Create Flow** and materializes five persistent production roles:

1. **Topic Strategist** — explores candidate subjects and selects a viable angle.
2. **Researcher** — searches sources and builds an evidence-backed research pack.
3. **Material Producer** — collects, organizes or creates usable production materials in the workspace.
4. **Scriptwriter** — turns the approved direction and evidence into a production-ready script.
5. **Video Producer** — prepares media inputs and verifies deterministic local media output.

These are durable Agent Groups Members. Follow-up work can continue in the same provider session instead of spawning a disposable one-shot agent for every stage.

## State ownership

Create Flow keeps production/media state in the group workspace rather than changing the Agent Groups durable database schema:

```text
<group cwd>/.create-flow/state.json
<group cwd>/.create-flow/jobs/
<group cwd>/.create-flow/outputs/
```

`state.json` contains three production collections:

- `artifacts[]` — topic/source/material/script/audio/captions/video records;
- `scenes[]` — ordered timeline units;
- `jobs[]` — local TTS/ASR/render execution records.

The Agent Groups durable domain continues to own:

- group/member identity;
- tasks and attempts;
- runtime sessions and turn bindings;
- messages and activity;
- verification and mission completion.

`.create-flow/state.json` is therefore a production projection, not a replacement source of truth for orchestration.

## Scene timeline

A scene binds one production visual to its timing/audio context:

```text
CreateFlowScene
  sceneId
  order
  title
  visualPath
  audioPath?
  subtitlePath?
  narration?
  durationSec?
```

A renderable scene needs:

- a workspace-local `visualPath`; and
- either an `audioPath` or a positive explicit `durationSec`.

Scenes are persisted and sorted by `CreateFlowService`. The Leader can explicitly add/update/remove scenes and then render the ordered timeline into a final MP4.

The multi-scene renderer normalizes each scene to a common H.264/AAC geometry and frame rate, writes temporary segments, then concatenates them into the final output. Temporary timeline files are removed after the operation.

## Local media runtime

Create Flow exposes deterministic local operations to the Leader and native API:

- local TTS: script text -> narration audio;
- local ASR: audio/video -> captions;
- single-shot FFmpeg render: visual + narration + optional SRT -> MP4;
- timeline FFmpeg render: ordered scenes -> normalized segments -> final MP4.

Commands are launched with executable + argv and `shell: false`. Media paths are resolved through the group workspace; `../` or absolute paths outside that workspace are rejected.

The intent boundary is important: the Flow Agent chooses production actions and typed inputs; the media runtime owns raw command construction.

## Environment variables

FFmpeg defaults to `ffmpeg` and can be overridden:

```bash
export CREATE_FLOW_FFMPEG_COMMAND=/path/to/ffmpeg
```

ASR and TTS are adapter-shaped because local installations differ. Configure each executable and argv template as JSON. Supported placeholders are `{input}`, `{output}`, `{language}`, `{voice}`, `{text}` and `{cwd}` where applicable.

Example Whisper-style ASR adapter:

```bash
export CREATE_FLOW_ASR_COMMAND=python
export CREATE_FLOW_ASR_ARGS_JSON='["/opt/local_asr.py","--input","{input}","--output","{output}","--language","{language}"]'
```

Example local TTS adapter:

```bash
export CREATE_FLOW_TTS_COMMAND=python
export CREATE_FLOW_TTS_ARGS_JSON='["/opt/local_tts.py","--text-file","{text}","--output","{output}","--voice","{voice}"]'
```

The process timeout defaults to 30 minutes and can be changed with:

```bash
export CREATE_FLOW_MEDIA_TIMEOUT_MS=1800000
```

## Leader operations

A Leader session gets Create Flow operations for:

- reading production state and local capabilities;
- registering production artifacts;
- adding/updating/removing timeline scenes;
- running local TTS;
- running local ASR;
- rendering a single-shot MP4;
- rendering the ordered scene timeline.

These tools are deterministic production operations. Topic, research, material, script, review and acceptance decisions still run through normal persistent member tasks.

## API

Create Flow uses a specific API prefix so the production surface stays separate from the broader Agent Groups API:

```text
GET    /groups/api/create-flow/:groupId
POST   /groups/api/create-flow/:groupId/artifacts
POST   /groups/api/create-flow/:groupId/scenes
DELETE /groups/api/create-flow/:groupId/scenes/:sceneId
POST   /groups/api/create-flow/:groupId/tts
POST   /groups/api/create-flow/:groupId/asr
POST   /groups/api/create-flow/:groupId/render
POST   /groups/api/create-flow/:groupId/timeline/render
```

The native workbench projects this state while continuing to use the existing Agent Groups team/task/channel/runtime surfaces.

## Development

Start from the implementation map rather than scanning the whole Host package:

```text
packages/host/src/create-flow/README.md
```

Focused iteration:

```bash
npm run test:create-flow
```

Full validation:

```bash
npm run verify
```

Relevant regression coverage should stay focused on production contracts such as path containment, artifact projection, scene ordering/persistence, timeline inputs/output, API wiring and Leader stage gates.

## Design rule

Create Flow may become richer as a production system, but it should remain a specialization on top of Agent Groups:

```text
Flow Agent = production reasoning + typed production actions
Agent Groups = durable orchestration + runtime/session/task authority
Media Runtime = deterministic local execution
Native Workbench = view and operator surface
```

Keeping these boundaries separate is what allows Create Flow to grow without duplicating the hard lifecycle, recovery and verification logic already owned by Agent Groups.
