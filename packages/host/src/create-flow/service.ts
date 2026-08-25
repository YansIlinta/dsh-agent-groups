import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { GroupService } from '../group-service.js'
import type { ActivityService } from '../activity-service.js'
import type { GroupNotifier } from '../notifier.js'
import { LocalMediaRuntime, MediaRuntimeError, type MediaCommandResult, type MediaRuntimeCapabilities } from './media-runtime.js'

export type CreateFlowStage = 'topic' | 'research' | 'materials' | 'script' | 'voice' | 'captions' | 'render'
export type CreateFlowArtifactKind = 'topic' | 'source' | 'material' | 'script' | 'audio' | 'captions' | 'video' | 'other'
export type CreateFlowJobKind = 'tts' | 'asr' | 'render'
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
        jobs: Array.isArray(raw.jobs) ? raw.jobs as CreateFlowJob[] : [],
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { version: 1, groupId, artifacts: [], jobs: [], updatedAt: Date.now() }
    }
  }

  private async mutateState(groupId: string, mutate: (state: CreateFlowState) => CreateFlowState): Promise<CreateFlowState> {
    const previous = this.stateLocks.get(groupId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    this.stateLocks.set(groupId, previous.then(() => gate))
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
      if (this.stateLocks.get(groupId) === gate) this.stateLocks.delete(groupId)
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
