import type { Context } from '@deepseek-ai/cordis'
import type { GroupHost } from '../group-host.js'
import { registerGroupTool, strArg, strOptArg, numOptArg } from '../tools.js'
import type { CreateFlowArtifactKind, CreateFlowService, CreateFlowStage } from './service.js'

const string = 'string' as const
const number = 'number' as const

/** Install deterministic Create Flow production operations into Leader sessions. */
export function installCreateFlowLeaderTools(ctx: Context, host: GroupHost, createFlow: CreateFlowService): void {
  const groupIdFor = (actor: string): string => host.groups.resolveActorGroup(actor, 'leader').groupId

  registerGroupTool(ctx, host, {
    name: 'leader_create_flow_status',
    description: 'Read Create Flow artifacts, timeline scenes, local media jobs, workspace root, and ASR/TTS/FFmpeg capabilities for this group.',
    run: (_host, actor) => createFlow.status(groupIdFor(actor)),
  })

  registerGroupTool(ctx, host, {
    name: 'leader_create_flow_add_artifact',
    description: 'Register a topic, source, material, script, audio, captions, video, or other workspace artifact in the Create Flow production state.',
    parameters: {
      kind: { type: string, required: true, enum: ['topic', 'source', 'material', 'script', 'audio', 'captions', 'video', 'other'] },
      stage: { type: string, required: true, enum: ['topic', 'research', 'materials', 'script', 'voice', 'captions', 'render'] },
      title: { type: string, required: true },
      path: { type: string, description: 'Workspace-relative artifact path, if this artifact is a local file.' },
      sourceUrl: { type: string, description: 'Source URL for research/material provenance.' },
      mimeType: { type: string },
    },
    run: (_host, actor, args) => createFlow.addArtifact(groupIdFor(actor), actor, {
      kind: strArg(args, 'kind') as CreateFlowArtifactKind,
      stage: strArg(args, 'stage') as CreateFlowStage,
      title: strArg(args, 'title'),
      path: strOptArg(args, 'path'),
      sourceUrl: strOptArg(args, 'sourceUrl'),
      mimeType: strOptArg(args, 'mimeType'),
    }),
  })

  registerGroupTool(ctx, host, {
    name: 'leader_create_flow_upsert_scene',
    description: 'Add or update one production scene in the ordered Create Flow timeline. A scene binds its visual material to narration/audio, optional captions, and optional explicit duration.',
    parameters: {
      sceneId: { type: string, description: 'Existing scene id to update. Omit to create a new scene.' },
      order: { type: number, description: 'Zero-based scene order. Omit to append a new scene.' },
      title: { type: string },
      visualPath: { type: string, description: 'Workspace-relative image/video path. Required for a new scene.' },
      audioPath: { type: string, description: 'Workspace-relative narration/audio path.' },
      subtitlePath: { type: string, description: 'Optional workspace-relative SRT subtitle path for this scene.' },
      narration: { type: string, description: 'Narration/script text associated with this scene.' },
      durationSec: { type: number, description: 'Explicit scene duration in seconds. Required when the scene has no audio track.' },
    },
    run: (_host, actor, args) => createFlow.upsertScene(groupIdFor(actor), actor, {
      sceneId: strOptArg(args, 'sceneId'),
      order: numOptArg(args, 'order'),
      title: strOptArg(args, 'title'),
      visualPath: strOptArg(args, 'visualPath'),
      audioPath: strOptArg(args, 'audioPath'),
      subtitlePath: strOptArg(args, 'subtitlePath'),
      narration: strOptArg(args, 'narration'),
      durationSec: numOptArg(args, 'durationSec'),
    }),
  })

  registerGroupTool(ctx, host, {
    name: 'leader_create_flow_remove_scene',
    description: 'Remove one scene from the Create Flow timeline.',
    parameters: {
      sceneId: { type: string, required: true },
    },
    run: (_host, actor, args) => createFlow.removeScene(groupIdFor(actor), actor, strArg(args, 'sceneId')),
  })

  registerGroupTool(ctx, host, {
    name: 'leader_create_flow_tts',
    description: 'Run the configured local TTS adapter for script text and register the generated audio as a Create Flow artifact.',
    parameters: {
      text: { type: string, required: true },
      outputPath: { type: string, description: 'Workspace-relative output audio path. Defaults under .create-flow/outputs.' },
      voice: { type: string, description: 'Optional local TTS voice id/name.' },
      language: { type: string },
      title: { type: string },
    },
    run: (_host, actor, args) => createFlow.runTts(groupIdFor(actor), actor, {
      text: strArg(args, 'text'),
      outputPath: strOptArg(args, 'outputPath'),
      voice: strOptArg(args, 'voice'),
      language: strOptArg(args, 'language'),
      title: strOptArg(args, 'title'),
    }),
  })

  registerGroupTool(ctx, host, {
    name: 'leader_create_flow_asr',
    description: 'Run the configured local ASR adapter on a workspace audio/video file and register generated captions.',
    parameters: {
      inputPath: { type: string, required: true, description: 'Workspace-relative audio/video path.' },
      outputPath: { type: string, description: 'Workspace-relative subtitle output path. Defaults to .srt under .create-flow/outputs.' },
      language: { type: string },
      title: { type: string },
    },
    run: (_host, actor, args) => createFlow.runAsr(groupIdFor(actor), actor, {
      inputPath: strArg(args, 'inputPath'),
      outputPath: strOptArg(args, 'outputPath'),
      language: strOptArg(args, 'language'),
      title: strOptArg(args, 'title'),
    }),
  })

  registerGroupTool(ctx, host, {
    name: 'leader_create_flow_render',
    description: 'Render a single-shot MP4 locally with FFmpeg from one visual/image/video plus narration audio and optional SRT captions.',
    parameters: {
      visualPath: { type: string, required: true, description: 'Workspace-relative still image or video material.' },
      audioPath: { type: string, required: true, description: 'Workspace-relative narration/audio track.' },
      subtitlePath: { type: string, description: 'Optional workspace-relative SRT captions.' },
      outputPath: { type: string, description: 'Workspace-relative MP4 output. Defaults under .create-flow/outputs.' },
      fps: { type: number },
      title: { type: string },
    },
    run: (_host, actor, args) => createFlow.renderVideo(groupIdFor(actor), actor, {
      visualPath: strArg(args, 'visualPath'),
      audioPath: strArg(args, 'audioPath'),
      subtitlePath: strOptArg(args, 'subtitlePath'),
      outputPath: strOptArg(args, 'outputPath'),
      fps: numOptArg(args, 'fps'),
      title: strOptArg(args, 'title'),
    }),
  })

  registerGroupTool(ctx, host, {
    name: 'leader_create_flow_render_timeline',
    description: 'Render the ordered Create Flow scene timeline into one final MP4. Each scene is normalized and concatenated locally with FFmpeg.',
    parameters: {
      outputPath: { type: string, description: 'Workspace-relative MP4 output. Defaults under .create-flow/outputs.' },
      fps: { type: number, description: 'Output frames per second. Default 30.' },
      width: { type: number, description: 'Output width. Default 1280.' },
      height: { type: number, description: 'Output height. Default 720.' },
      title: { type: string },
    },
    run: (_host, actor, args) => createFlow.renderTimeline(groupIdFor(actor), actor, {
      outputPath: strOptArg(args, 'outputPath'),
      fps: numOptArg(args, 'fps'),
      width: numOptArg(args, 'width'),
      height: numOptArg(args, 'height'),
      title: strOptArg(args, 'title'),
    }),
  })
}
