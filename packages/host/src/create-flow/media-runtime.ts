import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

export interface CommandTemplate {
  readonly command: string
  readonly args: readonly string[]
}

export interface MediaRuntimeCapabilities {
  readonly asr: { readonly configured: boolean; readonly command?: string }
  readonly tts: { readonly configured: boolean; readonly command?: string }
  readonly render: { readonly configured: boolean; readonly command: string }
}

export interface MediaCommandResult {
  readonly command: string
  readonly args: readonly string[]
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface TimelineRenderScene {
  readonly sceneId: string
  readonly visualPath: string
  readonly audioPath?: string
  readonly subtitlePath?: string
  readonly durationSec?: number
}

export class MediaRuntimeError extends Error {
  readonly command?: string
  readonly exitCode?: number
  readonly stderr?: string

  constructor(message: string, options?: { command?: string; exitCode?: number; stderr?: string }) {
    super(message)
    this.name = 'MediaRuntimeError'
    this.command = options?.command
    this.exitCode = options?.exitCode
    this.stderr = options?.stderr
  }
}

export interface LocalMediaRuntimeOptions {
  readonly asr?: CommandTemplate
  readonly tts?: CommandTemplate
  readonly ffmpegCommand?: string
  readonly timeoutMs?: number
}

/**
 * Local deterministic media execution for Create Flow.
 *
 * No shell is involved: executables and argv are passed directly to spawn().
 * ASR/TTS are intentionally adapter-shaped because local installations differ.
 * Configure them with CREATE_FLOW_{ASR,TTS}_COMMAND and a JSON argv template.
 *
 * The runtime also re-checks workspace containment at the media boundary. This
 * is intentionally stricter than lexical path validation in higher layers: an
 * in-workspace symlink must not allow a media command to read or write outside
 * the group workspace.
 */
export class LocalMediaRuntime {
  readonly asr?: CommandTemplate
  readonly tts?: CommandTemplate
  readonly ffmpegCommand: string
  readonly timeoutMs: number

  constructor(options: LocalMediaRuntimeOptions = {}) {
    this.asr = options.asr
    this.tts = options.tts
    this.ffmpegCommand = options.ffmpegCommand ?? 'ffmpeg'
    this.timeoutMs = options.timeoutMs ?? 30 * 60 * 1000
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): LocalMediaRuntime {
    return new LocalMediaRuntime({
      asr: commandTemplateFromEnv(env, 'CREATE_FLOW_ASR'),
      tts: commandTemplateFromEnv(env, 'CREATE_FLOW_TTS'),
      ffmpegCommand: env.CREATE_FLOW_FFMPEG_COMMAND?.trim() || 'ffmpeg',
      timeoutMs: positiveNumber(env.CREATE_FLOW_MEDIA_TIMEOUT_MS) ?? 30 * 60 * 1000,
    })
  }

  capabilities(): MediaRuntimeCapabilities {
    return {
      asr: { configured: this.asr !== undefined, ...(this.asr ? { command: this.asr.command } : {}) },
      tts: { configured: this.tts !== undefined, ...(this.tts ? { command: this.tts.command } : {}) },
      render: { configured: true, command: this.ffmpegCommand },
    }
  }

  async runTts(input: {
    cwd: string
    textPath: string
    outputPath: string
    voice?: string
    language?: string
  }): Promise<MediaCommandResult> {
    if (this.tts === undefined) {
      throw new MediaRuntimeError('local TTS is not configured; set CREATE_FLOW_TTS_COMMAND and CREATE_FLOW_TTS_ARGS_JSON')
    }
    await assertWorkspaceInput(input.cwd, input.textPath, 'TTS text input')
    await assertWorkspaceOutput(input.cwd, input.outputPath, 'TTS output')
    await mkdir(dirname(input.outputPath), { recursive: true })
    const result = await this.executeTemplate(this.tts, input.cwd, {
      input: input.textPath,
      text: input.textPath,
      output: input.outputPath,
      voice: input.voice ?? '',
      language: input.language ?? '',
      cwd: input.cwd,
    })
    await verifyOutputFile(input.cwd, input.outputPath, 'TTS output', true)
    return result
  }

  async runAsr(input: {
    cwd: string
    inputPath: string
    outputPath: string
    language?: string
  }): Promise<MediaCommandResult> {
    if (this.asr === undefined) {
      throw new MediaRuntimeError('local ASR is not configured; set CREATE_FLOW_ASR_COMMAND and CREATE_FLOW_ASR_ARGS_JSON')
    }
    await assertWorkspaceInput(input.cwd, input.inputPath, 'ASR input')
    await assertWorkspaceOutput(input.cwd, input.outputPath, 'ASR output')
    await mkdir(dirname(input.outputPath), { recursive: true })
    const result = await this.executeTemplate(this.asr, input.cwd, {
      input: input.inputPath,
      output: input.outputPath,
      language: input.language ?? '',
      cwd: input.cwd,
    })
    // An empty caption file can be a legitimate ASR result for silent media.
    await verifyOutputFile(input.cwd, input.outputPath, 'ASR output', false)
    return result
  }

  async renderVideo(input: {
    cwd: string
    visualPath: string
    audioPath: string
    subtitlePath?: string
    outputPath: string
    fps?: number
  }): Promise<MediaCommandResult> {
    await assertWorkspaceInput(input.cwd, input.visualPath, 'render visual input')
    await assertWorkspaceInput(input.cwd, input.audioPath, 'render audio input')
    if (input.subtitlePath) await assertWorkspaceInput(input.cwd, input.subtitlePath, 'render subtitle input')
    await assertWorkspaceOutput(input.cwd, input.outputPath, 'render output')
    await mkdir(dirname(input.outputPath), { recursive: true })
    const image = isStillImage(input.visualPath)
    const fps = clampFps(input.fps)
    const args: string[] = ['-y', '-nostdin']
    if (image) args.push('-loop', '1', '-framerate', String(fps), '-i', input.visualPath)
    else args.push('-stream_loop', '-1', '-i', input.visualPath)
    args.push('-i', input.audioPath)
    if (input.subtitlePath) args.push('-vf', `subtitles=${ffmpegFilterPath(input.subtitlePath)}`)
    args.push(
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-r', String(fps),
      '-shortest',
      '-movflags', '+faststart',
      input.outputPath,
    )
    const result = await this.execute(this.ffmpegCommand, args, input.cwd)
    await verifyOutputFile(input.cwd, input.outputPath, 'render output', true)
    return result
  }

  /**
   * Render a multi-scene timeline without a shell or server-side media daemon.
   * Every scene is normalized to the same H.264/AAC geometry first, then the
   * temporary segments are concatenated losslessly into the final MP4.
   */
  async renderTimeline(input: {
    cwd: string
    scenes: readonly TimelineRenderScene[]
    outputPath: string
    fps?: number
    width?: number
    height?: number
  }): Promise<MediaCommandResult> {
    if (input.scenes.length === 0) throw new MediaRuntimeError('timeline has no scenes')
    await assertWorkspaceOutput(input.cwd, input.outputPath, 'timeline output')
    for (const scene of input.scenes) {
      await assertWorkspaceInput(input.cwd, scene.visualPath, `timeline scene ${scene.sceneId} visual input`)
      if (scene.audioPath !== undefined) {
        await assertWorkspaceInput(input.cwd, scene.audioPath, `timeline scene ${scene.sceneId} audio input`)
      }
      if (scene.subtitlePath !== undefined) {
        await assertWorkspaceInput(input.cwd, scene.subtitlePath, `timeline scene ${scene.sceneId} subtitle input`)
      }
    }
    await mkdir(dirname(input.outputPath), { recursive: true })

    const fps = clampFps(input.fps)
    const width = clampDimension(input.width ?? 1280)
    const height = clampDimension(input.height ?? 720)
    const tempDir = join(dirname(input.outputPath), `.timeline-${randomUUID()}`)
    await mkdir(tempDir, { recursive: true })
    const results: MediaCommandResult[] = []

    try {
      const segmentPaths: string[] = []
      for (let index = 0; index < input.scenes.length; index += 1) {
        const scene = input.scenes[index]!
        if (scene.audioPath === undefined && scene.durationSec === undefined) {
          throw new MediaRuntimeError(`timeline scene ${scene.sceneId} needs audioPath or durationSec`)
        }
        const segmentPath = join(tempDir, `${String(index).padStart(4, '0')}.mp4`)
        segmentPaths.push(segmentPath)
        const args: string[] = ['-y', '-nostdin']
        if (isStillImage(scene.visualPath)) args.push('-loop', '1', '-framerate', String(fps), '-i', scene.visualPath)
        else args.push('-stream_loop', '-1', '-i', scene.visualPath)

        if (scene.audioPath !== undefined) args.push('-i', scene.audioPath)
        else args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')

        const filters = [
          `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
          'setsar=1',
          `fps=${fps}`,
        ]
        if (scene.subtitlePath !== undefined) filters.push(`subtitles=${ffmpegFilterPath(scene.subtitlePath)}`)

        args.push(
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-vf', filters.join(','),
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-ar', '48000',
          '-ac', '2',
          '-r', String(fps),
        )
        if (scene.durationSec !== undefined) args.push('-t', formatSeconds(scene.durationSec))
        else args.push('-shortest')
        args.push(segmentPath)
        results.push(await this.execute(this.ffmpegCommand, args, input.cwd))
        await verifyOutputFile(input.cwd, segmentPath, `timeline scene ${scene.sceneId} segment`, true)
      }

      const concatPath = join(tempDir, 'segments.ffconcat')
      await writeFile(concatPath, `${segmentPaths.map((path) => `file '${ffconcatPath(path)}'`).join('\n')}\n`, 'utf8')
      const concatArgs = [
        '-y',
        '-nostdin',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        input.outputPath,
      ]
      results.push(await this.execute(this.ffmpegCommand, concatArgs, input.cwd))
      await verifyOutputFile(input.cwd, input.outputPath, 'timeline output', true)
      return aggregateResults(this.ffmpegCommand, input.scenes.length, results)
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private executeTemplate(template: CommandTemplate, cwd: string, values: Record<string, string>): Promise<MediaCommandResult> {
    // Preserve empty substituted argv entries. Removing them can shift an
    // optional value flag onto the next token (for example --voice --output),
    // producing a command that is syntactically valid but semantically wrong.
    const args = template.args.map((arg) => substitute(arg, values))
    return this.execute(template.command, args, cwd)
  }

  private execute(command: string, args: readonly string[], cwd: string): Promise<MediaCommandResult> {
    return new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      const child = spawn(command, [...args], {
        cwd,
        shell: false,
        windowsHide: true,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const timer = setTimeout(() => {
        if (settled) return
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
        settled = true
        reject(new MediaRuntimeError(`media command timed out after ${this.timeoutMs}ms`, { command, stderr }))
      }, this.timeoutMs)
      timer.unref()

      child.stdout?.on('data', (chunk) => { stdout = appendCapped(stdout, chunk.toString()) })
      child.stderr?.on('data', (chunk) => { stderr = appendCapped(stderr, chunk.toString()) })
      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new MediaRuntimeError(`failed to start media command ${command}: ${error.message}`, { command, stderr }))
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const exitCode = code ?? -1
        if (exitCode !== 0) {
          reject(new MediaRuntimeError(`media command ${command} exited with code ${exitCode}`, { command, exitCode, stderr }))
          return
        }
        resolve({ command, args: [...args], exitCode, stdout, stderr })
      })
    })
  }
}

export function commandTemplateFromEnv(env: NodeJS.ProcessEnv, prefix: 'CREATE_FLOW_ASR' | 'CREATE_FLOW_TTS'): CommandTemplate | undefined {
  const command = env[`${prefix}_COMMAND`]?.trim()
  if (!command) return undefined
  const raw = env[`${prefix}_ARGS_JSON`]
  if (!raw) return { command, args: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new MediaRuntimeError(`${prefix}_ARGS_JSON must be a JSON array of strings: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new MediaRuntimeError(`${prefix}_ARGS_JSON must be a JSON array of strings`)
  }
  return { command, args: parsed }
}

function substitute(value: string, variables: Record<string, string>): string {
  return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) {
      throw new MediaRuntimeError(`unknown media command template placeholder {${key}}`)
    }
    return variables[key]!
  })
}

async function assertWorkspaceInput(cwd: string, path: string, label: string): Promise<void> {
  const candidate = await assertWorkspacePath(cwd, path, label, true)
  const info = await stat(candidate)
  if (!info.isFile()) throw new MediaRuntimeError(`${label} must be a file: ${path}`)
}

async function assertWorkspaceOutput(cwd: string, path: string, label: string): Promise<void> {
  await assertWorkspacePath(cwd, path, label, false)
}

async function verifyOutputFile(cwd: string, path: string, label: string, requireNonEmpty: boolean): Promise<void> {
  const candidate = await assertWorkspacePath(cwd, path, label, true)
  const info = await stat(candidate)
  if (!info.isFile()) throw new MediaRuntimeError(`${label} was not produced as a file: ${path}`)
  if (requireNonEmpty && info.size <= 0) throw new MediaRuntimeError(`${label} is empty: ${path}`)
}

async function assertWorkspacePath(cwd: string, path: string, label: string, mustExist: boolean): Promise<string> {
  const root = resolve(cwd)
  const candidate = resolve(cwd, path)
  if (!isPathContained(root, candidate)) {
    throw new MediaRuntimeError(`${label} escapes the media workspace: ${path}`)
  }

  let realRoot: string
  try {
    realRoot = await realpath(root)
  } catch (error) {
    throw new MediaRuntimeError(`media workspace is unavailable: ${root}: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (mustExist) {
    let realCandidate: string
    try {
      realCandidate = await realpath(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new MediaRuntimeError(`${label} does not exist: ${path}`)
      }
      throw error
    }
    if (!isPathContained(realRoot, realCandidate)) {
      throw new MediaRuntimeError(`${label} escapes the media workspace through a symlink: ${path}`)
    }
    return candidate
  }

  // Outputs may not exist yet. Resolve the nearest existing ancestor so a
  // symlinked parent directory cannot redirect writes outside the workspace.
  let probe = candidate
  while (true) {
    try {
      const realProbe = await realpath(probe)
      if (!isPathContained(realRoot, realProbe)) {
        throw new MediaRuntimeError(`${label} escapes the media workspace through a symlink: ${path}`)
      }
      return candidate
    } catch (error) {
      if (error instanceof MediaRuntimeError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(probe)
      if (parent === probe) {
        throw new MediaRuntimeError(`cannot resolve ${label} inside media workspace: ${path}`)
      }
      probe = parent
    }
  }
}

function isPathContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function positiveNumber(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function appendCapped(current: string, next: string, cap = 64 * 1024): string {
  const combined = current + next
  return combined.length <= cap ? combined : combined.slice(combined.length - cap)
}

function isStillImage(path: string): boolean {
  return ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'].includes(extname(path).toLowerCase())
}

function ffmpegFilterPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
}

function ffconcatPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/'/g, "'\\''")
}

function clampFps(value: number | undefined): number {
  return Math.max(1, Math.min(120, Math.round(value ?? 30)))
}

function clampDimension(value: number): number {
  const rounded = Math.max(16, Math.min(8192, Math.round(value)))
  return rounded % 2 === 0 ? rounded : rounded + 1
}

function formatSeconds(value: number): string {
  if (!Number.isFinite(value) || value <= 0) throw new MediaRuntimeError('scene durationSec must be a positive number')
  return String(Math.min(24 * 60 * 60, value))
}

function aggregateResults(command: string, sceneCount: number, results: readonly MediaCommandResult[]): MediaCommandResult {
  return {
    command,
    args: [`<timeline:${sceneCount}-scenes>`],
    exitCode: 0,
    stdout: results.map((result) => result.stdout).filter(Boolean).join('\n'),
    stderr: results.map((result) => result.stderr).filter(Boolean).join('\n'),
  }
}
