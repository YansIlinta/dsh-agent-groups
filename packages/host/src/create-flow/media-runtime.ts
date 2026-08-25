import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { extname, dirname } from 'node:path'

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
    await mkdir(dirname(input.outputPath), { recursive: true })
    return this.executeTemplate(this.tts, input.cwd, {
      input: input.textPath,
      text: input.textPath,
      output: input.outputPath,
      voice: input.voice ?? '',
      language: input.language ?? '',
      cwd: input.cwd,
    })
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
    await mkdir(dirname(input.outputPath), { recursive: true })
    return this.executeTemplate(this.asr, input.cwd, {
      input: input.inputPath,
      output: input.outputPath,
      language: input.language ?? '',
      cwd: input.cwd,
    })
  }

  async renderVideo(input: {
    cwd: string
    visualPath: string
    audioPath: string
    subtitlePath?: string
    outputPath: string
    fps?: number
  }): Promise<MediaCommandResult> {
    await mkdir(dirname(input.outputPath), { recursive: true })
    const image = isStillImage(input.visualPath)
    const fps = Math.max(1, Math.min(120, Math.round(input.fps ?? 30)))
    const args: string[] = ['-y']
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
    return this.execute(this.ffmpegCommand, args, input.cwd)
  }

  private executeTemplate(template: CommandTemplate, cwd: string, values: Record<string, string>): Promise<MediaCommandResult> {
    const args = template.args
      .map((arg) => substitute(arg, values))
      .filter((arg) => arg !== '')
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
        reject(new MediaRuntimeError(`media command timed out after ${this.timeoutMs}ms`, { command }))
      }, this.timeoutMs)
      timer.unref()

      child.stdout?.on('data', (chunk) => { stdout = appendCapped(stdout, chunk.toString()) })
      child.stderr?.on('data', (chunk) => { stderr = appendCapped(stderr, chunk.toString()) })
      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new MediaRuntimeError(`failed to start media command ${command}: ${error.message}`, { command }))
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
  return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => variables[key] ?? '')
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
  return path.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}
