/**
 * Process runtime base (V0.4): the shared machinery for CLI-based Coding
 * Agent runtimes — spawn one child process per agent instance, feed the
 * initial brief, collect output, wait for exit, kill on stop. Concrete
 * providers (codex, claude-code, …) declare binary detection, argument
 * construction and availability.
 * @module @dsh-agent-groups/host
 */

import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

export interface ProcessResult {
  readonly code: number | null
  readonly output: string
  readonly timedOut?: boolean
}

export interface RunOptions {
  readonly cwd: string
  readonly env?: Record<string, string>
  readonly args: readonly string[]
  readonly input?: string
  /** Hard wall-clock cap; the process is killed on expiry. */
  readonly timeoutMs?: number
}

export interface ManagedProcess {
  readonly stdout: Readable
  readonly stderr: Readable
  readonly exitPromise: Promise<ProcessResult>
  kill(signal?: NodeJS.Signals): void
}

function collect(readable: Readable): AsyncIterable<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return readable as any
}

/**
 * Spawn one agent process and manage its lifecycle. Output is concatenated
 * (stdout + stderr) with a cap to protect memory.
 */
export function runProcess(bin: string, options: RunOptions): ManagedProcess {
  interface ChildShape {
    stdout: Readable
    stderr: Readable
    stdin: Writable
    kill(signal?: NodeJS.Signals): void
    on(event: 'close', fn: (code: number | null) => void): void
  }
  const child = spawn(bin, [...options.args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as unknown as ChildShape

  const MAX_OUTPUT = 200_000
  let output = ''
  const append = (chunk: Buffer): void => {
    if (output.length >= MAX_OUTPUT) return
    output += chunk.toString('utf8').slice(0, MAX_OUTPUT - output.length)
  }

  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
    child.kill('SIGKILL')
  }, options.timeoutMs)

  const exitPromise = new Promise<ProcessResult>((resolve) => {
    child.on('close', (code: number | null) => {
      if (timer !== undefined) clearTimeout(timer)
      resolve({ code, output, timedOut: timer !== undefined && code === null })
    })
  })

  child.stdout.on('data', (chunk: Buffer) => append(chunk))
  child.stderr.on('data', (chunk: Buffer) => append(chunk))

  if (options.input !== undefined && options.input !== '') {
    child.stdin.write(options.input)
  }
  child.stdin.end()

  void collect(child.stdout)
  void collect(child.stderr)

  void child

  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exitPromise,
    kill: (signal) => { try { child.kill(signal) } catch { /* already gone */ } },
  }
}