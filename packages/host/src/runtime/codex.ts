/**
 * Codex (OpenAI) runtime provider (V0.4): a real CLI-based External Coding
 * Agent tenant. `codex exec` runs per assigned task, inside the group's
 * workspace. The instance is CREATED lazily: `spawnAgent` only registers the
 * member handle — the process starts when the Leader assigns the first task
 * (`sendInput`), which matches how Agent Groups dispenses work. Exits come
 * back through `waitExit()` → the host records the member's result.
 *
 * Availability is credential-driven (per §32): the provider never stores or
 * asks for secrets — it uses the host's existing login (~/.codex/auth.json)
 * or OPENAI_API_KEY / CODEX_API_KEY environment variables. When none exist
 * the runtime reports `Not configured` and spawns fail with a clear error
 * instead of silently falling back.
 * @module @dsh-agent-groups/host
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runProcess, type ManagedProcess } from './process.js'
import { DEFAULT_REASONING_LEVELS, type AgentRuntimeProvider, type ModelDescriptor, type ReasoningOption, type RuntimeAgentConfig, type RuntimeAgentHandle, type RuntimeCapabilities } from './base.js'

/** Minimal PATH lookup (no extra deps). */
function which(bin: string): string | null {
  const path = (process.env.PATH ?? '').split(':')
  for (const dir of path) {
    const candidate = join(dir, bin)
    try {
      if (existsSync(candidate)) return candidate
    } catch { /* keep scanning */ }
  }
  return null
}

const CAPABILITIES: RuntimeCapabilities = {
  models: true,
  reasoningLevels: true,
  interactiveSession: false,
  workspace: true,
  toolControl: false,
  streaming: true,
}

/** Provider-owned model catalog for `codex exec` (the runtime's home — the
 * product layer never hardcodes model names). */
const MODELS: readonly ModelDescriptor[] = [
  { id: 'gpt-5.2', name: 'GPT-5.2', reasoningLevels: ['low', 'medium', 'high'] },
  { id: 'gpt-5.1', name: 'GPT-5.1', reasoningLevels: ['low', 'medium', 'high'] },
  { id: 'gpt-5', name: 'GPT-5', reasoningLevels: ['low', 'medium', 'high'] },
  { id: 'gpt-5-mini', name: 'GPT-5-mini', reasoningLevels: ['low', 'medium', 'high'] },
  { id: 'o3', name: 'o3', reasoningLevels: ['low', 'medium', 'high'] },
  { id: 'o4-mini', name: 'o4-mini', reasoningLevels: ['low', 'medium', 'high'] },
]

/** One pending codex instance: process spawned lazily on first task input. */
class CodexInstance {
  private managed: ManagedProcess | undefined
  private result: Promise<{ code: number; output: string }> | undefined
  private stopped = false

  constructor(
    private readonly bin: string,
    private readonly config: RuntimeAgentConfig,
  ) {}

  private ensureStarted(input: string): void {
    if (this.managed !== undefined || this.stopped) return
    const workspace = this.config.workspace
    if (workspace === undefined || workspace === '') {
      throw new Error('codex runtime requires an explicit workspace — the role has no workspace configured')
    }
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', workspace]
    if (this.config.model !== undefined && this.config.model !== '') args.push('-m', this.config.model)
    if (this.config.reasoningLevel !== undefined && this.config.reasoningLevel !== '') {
      args.push('-c', `model_reasoning_effort="${this.config.reasoningLevel}"`)
    }
    const brief = [
      `[Agent Groups · member ${this.config.role}]`,
      this.config.systemPrompt !== undefined ? this.config.systemPrompt : `You are the ${this.config.role} member of the Agent Groups team.`,
      '',
      'Work in this workspace and follow the task you are assigned.',
      '',
      '── TASK ──',
      input,
    ].join('\n')
    this.managed = runProcess(this.bin, {
      cwd: workspace,
      args,
      input: brief,
      timeoutMs: 30 * 60 * 1000,
    })
    this.result = this.managed.exitPromise.then((r) => ({ code: r.code ?? 1, output: r.output }))
  }

  sendTask(input: string): void {
    this.ensureStarted(input)
  }

  async waitExit(): Promise<{ code: number; output: string }> {
    if (this.result === undefined) return { code: 0, output: '' } // never assigned
    return this.result
  }

  stop(): void {
    this.stopped = true
    this.managed?.kill('SIGTERM')
  }
}

export class CodexRuntimeProvider implements AgentRuntimeProvider {
  readonly id = 'codex'
  readonly name = 'Codex (OpenAI)'
  readonly description = 'OpenAI Codex CLI — external coding agent, one `codex exec` process per assigned task.'

  private readonly bin: string | null
  private readonly instances = new Map<string, CodexInstance>()

  constructor(binPath?: string) {
    this.bin = binPath ?? which('codex')
  }

  /** Credential probe — existence only, never reads values. */
  isAvailable(): boolean {
    if (this.bin === null) return false
    const auth = join(homedir(), '.codex', 'auth.json')
    if (existsSync(auth)) return true
    const env = process.env as Record<string, string | undefined>
    return env.OPENAI_API_KEY !== undefined || env.CODEX_API_KEY !== undefined
  }

  getCapabilities(): RuntimeCapabilities {
    return CAPABILITIES
  }

  listModels(): readonly ModelDescriptor[] {
    return MODELS
  }

  listReasoningLevels(): readonly ReasoningOption[] {
    return DEFAULT_REASONING_LEVELS
  }

  async spawnAgent(config: RuntimeAgentConfig): Promise<RuntimeAgentHandle> {
    if (this.bin === null) throw new Error('codex CLI not found on PATH')
    if (config.workspace === undefined || config.workspace === '') {
      throw new Error('codex runtime requires an explicit workspace — the role has no workspace configured')
    }
    const instance = new CodexInstance(this.bin, config)
    this.instances.set(config.agentId, instance)
    const handle: RuntimeAgentHandle = {
      agentId: config.agentId,
      runtime: this.id,
      status: 'starting',
      waitExit: () => instance.waitExit(),
      sendInput: async (text: string) => { instance.sendTask(text) },
      stop: async () => { instance.stop() },
    }
    return handle
  }

  async stopAgent(handle: RuntimeAgentHandle): Promise<void> {
    await handle.stop()
    this.instances.delete(handle.agentId)
  }
}