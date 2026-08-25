# Create Flow

Create Flow is the video-production specialization of DSH Agent Groups.

It reuses the existing durable Agent Groups runtime instead of introducing a second orchestrator. A Create Flow group keeps the same long-lived member identities, provider sessions, task attempts, channel history, workspace state, runtime recovery and verification semantics as any other group.

## Production team

The built-in `content-team` template is presented as **Create Flow** and materializes five persistent production roles:

1. **Topic Strategist** — explores candidate subjects and selects a viable angle.
2. **Researcher** — searches sources and builds an evidence-backed research pack.
3. **Material Producer** — collects, organizes or creates usable production materials in the workspace.
4. **Scriptwriter** — turns the approved direction and evidence into a production-ready script.
5. **Video Producer** — prepares media inputs and verifies the deterministic local media output.

The **Create Flow Lead** remains the authority for task assignment, stage transitions, media-job scheduling and final verification.

## Production state

Create Flow keeps project/media state in the group workspace rather than changing the Agent Groups durable database schema:

```text
<group cwd>/.create-flow/state.json
<group cwd>/.create-flow/jobs/
<group cwd>/.create-flow/outputs/
```

The state file records typed artifacts and media jobs. Artifacts move through these stages:

`topic -> research -> materials -> script -> voice -> captions -> render`

The Agent Groups database continues to own team identity, tasks, attempts, messages and runtime sessions. The workspace owns production files.

## Local media runtime

Create Flow exposes deterministic local operations to the Leader and the native API:

- local TTS: script text -> narration audio
- local ASR: audio/video -> captions
- local FFmpeg render: visual material + narration + optional SRT -> MP4

Commands are launched with `spawn(executable, argv, { shell: false })`. Media paths are constrained to the current group workspace; `../` or absolute paths outside that workspace are rejected.

FFmpeg defaults to `ffmpeg` and can be overridden:

```bash
export CREATE_FLOW_FFMPEG_COMMAND=/path/to/ffmpeg
```

ASR and TTS are adapter-shaped because local installations differ. Configure each executable and its argv template as JSON. Supported placeholders are `{input}`, `{output}`, `{language}`, `{voice}`, `{text}` and `{cwd}` where applicable.

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

The process timeout defaults to 30 minutes and can be changed with `CREATE_FLOW_MEDIA_TIMEOUT_MS`.

## Leader operations

A Leader session gets additional Create Flow tools for:

- reading production state and local capabilities;
- registering topic/source/material/script/media artifacts;
- running local TTS;
- running local ASR;
- rendering the final MP4 with FFmpeg.

This is a tool/runtime boundary, not a second agent orchestration system. Topic, research, material and script decisions still run through normal persistent member tasks and verification.

## API

The Create Flow slice is available under the more-specific prefix:

```text
GET  /groups/api/create-flow/:groupId
POST /groups/api/create-flow/:groupId/artifacts
POST /groups/api/create-flow/:groupId/tts
POST /groups/api/create-flow/:groupId/asr
POST /groups/api/create-flow/:groupId/render
```

The native workbench can project this state as a production lane while continuing to use the existing Agent Groups team/task/channel surfaces.
