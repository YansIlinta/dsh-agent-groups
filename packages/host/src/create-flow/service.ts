import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { GroupService } from '../group-service.js'
import type { ActivityService } from '../activity-service.js'
import type { GroupNotifier } from '../notifier.js'
import { LocalMediaRuntime, MediaRuntimeError, type MediaCommandResult, type MediaRuntimeCapabilities } from './media-runtime.js'

export type CreateFlowStage = 'topic' | 'research' | 'materials' | 'script' | 'voice' | 'captions' | 'render'
export type CreateFlowArtifactKind = 'topic' | 'source' | 'material' | 'script' | 'audio' | 'captions' | 'video' | 'other'
export type CreateFlowJobKind = 'tts' | 'asr' | 'render' | 'timeline_render'
export type CreateFlowJobStatus = 'running' | 'completed' | 'failed'

export interface CreateFlowArtifact {
  readonly artifactId: string
  readonly kind: CreateFlowArtifactKind
  readonly stage: CreateFlowStage
  readonly title: string
  readonly path?: string
  readonly sourceUrl?: string
  readonly mimeType?: string
  readonly createdBy: string
  readonly createdAt: number
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface CreateFlowScene {
  readonly sceneId: string
  readonly order: number
  readonly title: string
  readonly visualPath: string
  readonly audioPath?: string
  readonly subtitlePath?: string
  readonly narration?: string
  readonly durationSec?: number
  readonly createdBy: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface CreateFlowJob {
  readonly jobId: string
  readonly kind: CreateFlowJobKind
  readonly status: CreateFlowJobStatus
  readonly createdBy: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly input: Readonly<Record<string, unknown>>
  readonly outputPath?: string
  readonly command?: string
  readonly exitCode?: number
  readonly stderr?: string
  readonly error?: string
}

export interface CreateFlowState {
  readonly version: 1
  readonly groupId: string
  readonly artifacts: readonly CreateFlowArtifact[]
  readonly scenes: readonly CreateFlowScene[]
  readonly jobs: readonly CreateFlowJob[]
  readonly updatedAt: number
}

export interface CreateFlowStatus {
  readonly state: CreateFlowState
  readonly capabilities: MediaRuntimeCapabilities
  readonly workspaceRoot: string
}

export class CreateFlowService {
  private readonly groups: GroupService
  private readonly activity: ActivityService
  private readonly notifier: GroupNotifier
  private readonly media: LocalMediaRuntime
  private readonly stateLocks = new Map<string, Promise<void>>()

  constructor(options: {
    groups: GroupService
    activity: ActivityService
    notifier: GroupNotifier
    media?: LocalMediaRuntime
  }) {
    this.groups = options.groups
    this.activity = options.activity
    this.notifier = options.notifier
    this.media = options.media ?? LocalMediaRuntime.fromEnv()
  }

  async status(groupId: string): Promise<CreateFlowStatus> {
    const group = this.groups.requireGroup(groupId)
    return {
      state: await this.readState(group.groupId),
      capabilities: this.media.capabilities(),
      workspaceRoot: this.workspaceRoot(group.groupId),
    }
  }

  capabilities(): MediaRuntimeCapabilities {
    return this.media.capabilities()
  }

  async addArtifact(groupId: string, actor: string, input: {
    kind: CreateFlowArtifactKind
    stage: CreateFlowStage
    title: string
    path?: string
    sourceUrl?: string
    mimeType?: string
    metadata?: Readonly<Record<string, unknown>>
  }): Promise<CreateFlowArtifact> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    const artifact: CreateFlowArtifact = {
      artifactId: randomUUID(),
      kind: input.kind,
      stage: input.stage,
      title: input.title,
      ...(input.path !== undefined ? { path: this.relativeWorkspacePath(groupId, input.path) } : {}),
      ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
      ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
      createdBy: actor,
      createdAt: Date.now(),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    }
    await this.mutateState(groupId, (state) => ({ ...state, artifacts: [...state.artifacts, artifact] }))
    await this.record(groupId, actor, 'artifact_added', { artifactId: artifact.artifactId, kind: artifact.kind, stage: artifact.stage, path: artifact.path ?? null })
    return artifact
  }

  async upsertScene(groupId: string, actor: string, input: {
    sceneId?: string
    order?: number
    title?: string
    visualPath?: string
    audioPath?: string
    subtitlePath?: string
    narration?: string
    durationSec?: number
  }): Promise<CreateFlowScene> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    const now = Date.now()
    const sceneId = input.sceneId?.trim() || randomUUID()
    let nextScene: CreateFlowScene | undefined

    await this.mutateState(groupId, (state) => {
      const existing = state.scenes.find((scene) => scene.sceneId === sceneId)
      const order = normalizeOrder(input.order ?? existing?.order ?? nextSceneOrder(state.scenes))
      const visualPath = input.visualPath !== undefined
        ? this.relativeWorkspacePath(groupId, input.visualPath)
        : existing?.visualPath
      if (!visualPath) throw new Error('scene visualPath is required')

      const audioPath = input.audioPath !== undefined
        ? this.relativeWorkspacePath(groupId, input.audioPath)
        : existing?.audioPath
      const subtitlePath = input.subtitlePath !== undefined
        ? this.relativeWorkspacePath(groupId, input.subtitlePath)
        : existing?.subtitlePath
      const durationSec = input.durationSec !== undefined
        ? normalizeDuration(input.durationSec)
        : existing?.durationSec

      nextScene = {
        sceneId,
        order,
        title: input.title?.trim() || existing?.title || `Scene ${order + 1}`,
        visualPath,
        ...(audioPath ? { audioPath } : {}),
        ...(subtitlePath ? { subtitlePath } : {}),
        ...(input.narration !== undefined ? { narration: input.narration } : existing?.narration !== undefined ? { narration: existing.narration } : {}),
        ...(durationSec !== undefined ? { durationSec } : {}),
        createdBy: existing?.createdBy ?? actor,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      const scenes = existing
        ? state.scenes.map((scene) => scene.sceneId === sceneId ? nextScene! : scene)
        : [...state.scenes, nextScene]
      return { ...state, scenes: sortScenes(scenes) }
    })

    if (!nextScene) throw new Error(`failed to upsert scene ${sceneId}`)
    await this.record(groupId, actor, 'scene_upserted', {
      sceneId: nextScene.sceneId,
      order: nextScene.order,
      visualPath: nextScene.visualPath,
      audioPath: nextScene.audioPath ?? null,
      durationSec: nextScene.durationSec ?? null,
    })
    return nextScene
  }

  async removeScene(groupId: string, actor: string, sceneId: string): Promise<{ removed: boolean; sceneId: string }> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    let removed = false
    await this.mutateState(groupId, (state) => {
      const scenes = state.scenes.filter((scene) => scene.sceneId !== sceneId)
      removed = scenes.length !== state.scenes.length
      return removed ? { ...state, scenes } : state
    })
    if (removed) await this.record(groupId, actor, 'scene_removed', { sceneId })
    return { removed, sceneId }
  }

  async runTts(groupId: string, actor: string, input: {
    text: string
    outputPath?: string
    voice?: string
    language?: string
    title?: string
  }): Promise<{ job: CreateFlowJob; artifact: CreateFlowArtifact; command: MediaCommandResult }> {
    const group = this.requireDispatchable(groupId)
    const jobId = randomUUID()
    const root = this.workspaceRoot(group.groupId)
    const textPath = this.resolveWorkspacePath(group.groupId, `.create-flow/jobs/${jobId}.txt`)
    const outputPath = this.resolveWorkspacePath(group.groupId, input.outputPath ?? `.create-flow/outputs/voice-${jobId}.wav`)
    await mkdir(dirname(textPath), { recursive: true })
    await writeFile(textPath, input.text, 'utf8')
    await this.startJob(groupId, actor, {
      jobId,
      kind: 'tts',
      input: { textLength: input.text.length, outputPath: this.relativeWorkspacePath(groupId, outputPath), voice: input.voice, language: input.language },
      outputPath: this.relativeWorkspacePath(groupId, outputPath),
    })
    try {
      const command = await this.media.runTts({ cwd: root, textPath, outputPath, voice: input.voice, language: input.language })
      const job = await this.finishJob(groupId, actor, jobId, command)
      const artifact = await this.addArtifact(groupId, actor, {
        kind: 'audio',
        stage: 'voice',
        title: input.title ?? 'Generated voice',
        path: outputPath,
        mimeType: audioMime(outputPath),
        metadata: { jobId, voice: input.voice ?? null, language: input.language ?? null },
      })
      return { job, artifact, command }
    } catch (error) {
      await this.failJob(groupId, actor, jobId, error)
      throw error
    } finally {
      await unlink(textPath).catch(() => undefined)
    }
  }

  async runAsr(groupId: string, actor: string, input: {
    inputPath: string
    outputPath?: string
    language?: string
    title?: string
  }): Promise<{ job: CreateFlowJob; artifact: CreateFlowArtifact; command: MediaCommandResult }> {
    const group = this.requireDispatchable(groupId)
    const jobId = randomUUID()
    const root = this.workspaceRoot(group.groupId)
    const source = this.resolveWorkspacePath(group.groupId, input.inputPath)
    const outputPath = this.resolveWorkspacePath(group.groupId, input.outputPath ?? `.create-flow/outputs/captions-${jobId}.srt`)
    await this.startJob(groupId, actor, {
      jobId,
      kind: 'asr',
      input: { inputPath: this.relativeWorkspacePath(groupId, source), outputPath: this.relativeWorkspacePath(groupId, outputPath), language: input.language },
      outputPath: this.relativeWorkspacePath(groupId, outputPath),
    })
    try {
      const command = await this.media.runAsr({ cwd: root, inputPath: source, outputPath, language: input.language })
      const job = await this.finishJob(groupId, actor, jobId, command)
      const artifact = await this.addArtifact(groupId, actor, {
        kind: 'captions',
        stage: 'captions',
        title: input.title ?? 'Generated captions',
        path: outputPath,
        mimeType: 'application/x-subrip',
        metadata: { jobId, language: input.language ?? null },
      })
      return { job, artifact, command }
    } catch (error) {
      await this.failJob(groupId, actor, jobId, error)
      throw error
    }
  }

  async renderVideo(groupId: string, actor: string, input: {
    visualPath: string
    audioPath: string
    subtitlePath?: string
    outputPath?: string
    fps?: number
    title?: string
  }): Promise<{ job: CreateFlowJob; artifact: CreateFlowArtifact; command: MediaCommandResult }> {
    const group = this.requireDispatchable(groupId)
    const jobId = randomUUID()
    const root = this.workspaceRoot(group.groupId)
    const visualPath = this.resolveWorkspacePath(group.groupId, input.visualPath)
    const audioPath = this.resolveWorkspacePath(group.groupId, input.audioPath)
    const subtitlePath = input.subtitlePath ? this.resolveWorkspacePath(group.groupId, input.subtitlePath) : undefined
    const outputPath = this.resolveWorkspacePath(group.groupId, input.outputPath ?? `.create-flow/outputs/video-${jobId}.mp4`)
    await this.startJob(groupId, actor, {
      jobId,
      kind: 'render',
      input: {
        visualPath: this.relativeWorkspacePath(groupId, visualPath),
        audioPath: this.relativeWorkspacePath(groupId, audioPath),
        subtitlePath: subtitlePath ? this.relativeWorkspacePath(groupId, subtitlePath) : undefined,
        fps: input.fps ?? 30,
      },
      outputPath: this.relativeWorkspacePath(groupId, outputPath),
    })
    try {
      const command = await this.media.renderVideo({ cwd: root, visualPath, audioPath, subtitlePath, outputPath, fps: input.fps })
      const job = await this.finishJob(groupId, actor, jobId, command)
      const artifact = await this.addArtifact(groupId, actor, {
        kind: 'video',
        stage: 'render',
        title: input.title ?? 'Rendered video',
        path: outputPath,
        mimeType: 'video/mp4',
        metadata: { jobId, fps: input.fps ?? 30 },
      })
      return { job, artifact, command }
    } catch (error) {
      await this.failJob(groupId, actor, jobId, error)
      throw error
    }
  }

  async renderTimeline(groupId: string, actor: string, input: {
    outputPath?: string
    fps?: number
    width?: number
    height?: number
    title?: string
  } = {}): Promise<{ job: CreateFlowJob; artifact: CreateFlowArtifact; command: MediaCommandResult }> {
    const group = this.requireDispatchable(groupId)
    const state = await this.readState(groupId)
    const scenes = sortScenes(state.scenes)
    if (scenes.length === 0) throw new Error('Create Flow timeline has no scenes')

    const jobId = randomUUID()
    const root = this.workspaceRoot(group.groupId)
    const outputPath = this.resolveWorkspacePath(group.groupId, input.outputPath ?? `.create-flow/outputs/timeline-${jobId}.mp4`)
    const renderScenes = scenes.map((scene) => ({
      sceneId: scene.sceneId,
      visualPath: this.resolveWorkspacePath(groupId, scene.visualPath),
      ...(scene.audioPath ? { audioPath: this.resolveWorkspacePath(groupId, scene.audioPath) } : {}),
      ...(scene.subtitlePath ? { subtitlePath: this.resolveWorkspacePath(groupId, scene.subtitlePath) } : {}),
      ...(scene.durationSec !== undefined ? { durationSec: scene.durationSec } : {}),
    }))

    await this.startJob(groupId, actor, {
      jobId,
      kind: 'timeline_render',
      input: {
        sceneCount: scenes.length,
        sceneIds: scenes.map((scene) => scene.sceneId),
        fps: input.fps ?? 30,
        width: input.width ?? 1280,
        height: input.height ?? 720,
      },
      outputPath: this.relativeWorkspacePath(groupId, outputPath),
    })

    try {
      const command = await this.media.renderTimeline({
        cwd: root,
        scenes: renderScenes,
        outputPath,
        fps: input.fps,
        width: input.width,
        height: input.height,
      })
      const job = await this.finishJob(groupId, actor, jobId, command)
      const artifact = await this.addArtifact(groupId, actor, {
        kind: 'video',
        stage: 'render',
        title: input.title ?? 'Rendered timeline',
        path: outputPath,
        mimeType: 'video/mp4',
        metadata: {
          jobId,
          sceneCount: scenes.length,
          sceneIds: scenes.map((scene) => scene.sceneId),
          fps: input.fps ?? 30,
          width: input.width ?? 1280,
          height: input.height ?? 720,
        },
      })
      return { job, artifact, command }
    } catch (error) {
      await this.failJob(groupId, actor, jobId, error)
      throw error
    }
  }

  private requireDispatchable(groupId: string) {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    this.groups.assertDispatchable(group)
    return group
  }

  private workspaceRoot(groupId: string): string {
    const group = this.groups.requireGroup(groupId)
    return resolve(group.cwd ?? process.cwd())
  }

  private resolveWorkspacePath(groupId: string, path: string): string {
    const root = this.workspaceRoot(groupId)
    const candidate = resolve(root, path)
    const rel = relative(root, candidate)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return candidate
    throw new Error(`Create Flow path escapes the group workspace: ${path}`)
  }

  private relativeWorkspacePath(groupId: string, path: string): string {
    const root = this.workspaceRoot(groupId)
    const absolute = this.resolveWorkspacePath(groupId, path)
    return relative(root, absolute).replace(/\\/g, '/')
  }

  private statePath(groupId: string): string {
    return this.resolveWorkspacePath(groupId, '.create-flow/state.json')
  }

  private async readState(groupId: string): Promise<CreateFlowState> {
    const path = this.statePath(groupId)
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<CreateFlowState>
      return {
        version: 1,
        groupId,
        artifacts: Array.isArray(raw.artifacts) ? raw.artifacts as CreateFlowArtifact[] : [],
        scenes: Array.isArray(raw.scenes) ? sortScenes(raw.scenes as CreateFlowScene[]) : [],
        jobs: Array.isArray(raw.jobs) ? raw.jobs as CreateFlowJob[] : [],
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { version: 1, groupId, artifacts: [], scenes: [], jobs: [], updatedAt: Date.now() }
    }
  }

  private async mutateState(groupId: string, mutate: (state: CreateFlowState) => CreateFlowState): Promise<CreateFlowState> {
    const previous = this.stateLocks.get(groupId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    const tail = previous.then(() => gate)
    this.stateLocks.set(groupId, tail)
    await previous
    try {
      const current = await this.readState(groupId)
      const next = { ...mutate(current), version: 1 as const, groupId, updatedAt: Date.now() }
      const path = this.statePath(groupId)
      await mkdir(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      await rename(temp, path)
      this.notifier.emit(groupId, 'group', undefined)
      return next
    } finally {
      release()
      if (this.stateLocks.get(groupId) === tail) this.stateLocks.delete(groupId)
    }
  }

  private async startJob(groupId: string, actor: string, input: {
    jobId: string
    kind: CreateFlowJobKind
    input: Readonly<Record<string, unknown>>
    outputPath?: string
  }): Promise<CreateFlowJob> {
    const now = Date.now()
    const job: CreateFlowJob = {
      jobId: input.jobId,
      kind: input.kind,
      status: 'running',
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
      input: compactRecord(input.input),
      ...(input.outputPath ? { outputPath: input.outputPath } : {}),
    }
    await this.mutateState(groupId, (state) => ({ ...state, jobs: [...state.jobs, job] }))
    await this.record(groupId, actor, 'media_job_started', { jobId: job.jobId, kind: job.kind, outputPath: job.outputPath ?? null })
    return job
  }

  private async finishJob(groupId: string, actor: string, jobId: string, command: MediaCommandResult): Promise<CreateFlowJob> {
    let finished: CreateFlowJob | undefined
    await this.mutateState(groupId, (state) => ({
      ...state,
      jobs: state.jobs.map((job) => {
        if (job.jobId !== jobId) return job
        finished = {
          ...job,
          status: 'completed',
          updatedAt: Date.now(),
          command: command.command,
          exitCode: command.exitCode,
          ...(command.stderr ? { stderr: command.stderr.slice(-8_192) } : {}),
        }
        return finished
      }),
    }))
    if (!finished) throw new Error(`unknown Create Flow job: ${jobId}`)
    await this.record(groupId, actor, 'media_job_completed', { jobId, kind: finished.kind, outputPath: finished.outputPath ?? null })
    return finished
  }

  private async failJob(groupId: string, actor: string, jobId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    const mediaError = error instanceof MediaRuntimeError ? error : undefined
    await this.mutateState(groupId, (state) => ({
      ...state,
      jobs: state.jobs.map((job) => job.jobId === jobId ? {
        ...job,
        status: 'failed',
        updatedAt: Date.now(),
        error: message,
        ...(mediaError?.command ? { command: mediaError.command } : {}),
        ...(mediaError?.exitCode !== undefined ? { exitCode: mediaError.exitCode } : {}),
        ...(mediaError?.stderr ? { stderr: mediaError.stderr.slice(-8_192) } : {}),
      } : job),
    }))
    await this.record(groupId, actor, 'media_job_failed', { jobId, error: message })
  }

  private async record(groupId: string, actor: string, state: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
    await this.activity.append({
      groupId,
      type: 'group_status',
      actorId: actor,
      actorName: actor === 'User' ? 'User' : undefined,
      payload: { state: `create_flow_${state}`, ...payload },
    })
  }
}

function compactRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function audioMime(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.ogg')) return 'audio/ogg'
  if (lower.endsWith('.flac')) return 'audio/flac'
  return 'audio/wav'
}

function normalizeOrder(value: number): number {
  if (!Number.isFinite(value)) throw new Error('scene order must be numeric')
  return Math.max(0, Math.floor(value))
}

function normalizeDuration(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error('scene durationSec must be a positive number')
  return Math.min(24 * 60 * 60, value)
}

function nextSceneOrder(scenes: readonly CreateFlowScene[]): number {
  return scenes.length === 0 ? 0 : Math.max(...scenes.map((scene) => scene.order)) + 1
}

function sortScenes(scenes: readonly CreateFlowScene[]): CreateFlowScene[] {
  return [...scenes].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.sceneId.localeCompare(b.sceneId))
}
