/**
 * Claude Code runtime provider (Phase 4).
 *
 * This provider is intentionally symmetric to CodexRuntimeProvider: it uses
 * the same Agent Groups Bridge protocol, the same stdout marker parser, and
 * the same GroupHost single source of truth. Claude Code is another external
 * coding agent tenant; users do not need a second management model.
 *
 * The current implementation uses Claude Code's headless/print mode
 * (`claude -p`). stdout marker parsing is the active bridge path; raw output
 * remains only as fallback completion / diagnostics.
 *
 * @module @dsh-agent-groups/host
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runProcess, type ManagedProcess } from './process.js'
import { DEFAULT_REASONING_LEVELS, type AgentRuntimeProvider, type ModelDescriptor, type ReasoningOption, type RuntimeAgentConfig, type RuntimeAgentHandle, type RuntimeCapabilities } from './base.js'
import { runtimeMessageText, type RuntimeMessage } from './message.js'
import { parseBridgeAction, codexBridgeInstructions, executeBridgeAction } from './codex-bridge.js'
import type { ExternalAgentBridge } from './bridge.js'
import { compileAgentPrompt } from '../prompt-compiler.js'

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

/** Provider-owned Claude model catalog. */
const MODELS: readonly ModelDescriptor[] = [
  { id: 'claude-opus-4-1', name: 'Claude Opus 4.1', reasoningLevels: ['low', 'medium', 'high'] },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', reasoningLevels: ['low', 'medium', 'high'] },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', reasoningLevels: ['low', 'medium', 'high'] },
]

/** One pending Claude Code instance: spawned lazily on first task input. */
class ClaudeInstance {
  private managed: ManagedProcess | undefined
  private result: Promise<{ code: number; output: string }> | undefined
  private stopped = false
  private stdoutBuffer = ''
  private readonly pending = new Set<Promise<void>>()

  constructor(
    private readonly bin: string,
    private readonly config: RuntimeAgentConfig,
    private readonly getBridge: () => ExternalAgentBridge | undefined,
  ) {}

  private async ensureStarted(input: string): Promise<void> {
    if (this.managed !== undefined || this.stopped) return
    const workspace = this.config.workspace
    if (workspace === undefined || workspace === '') {
      throw new Error('claude-code runtime requires an explicit workspace — the role has no workspace configured')
    }
    const args = ['-p', '--output-format', 'json', '--verbose']
    if (this.config.model !== undefined && this.config.model !== '') args.push('--model', this.config.model)
    const brief = await this.buildBrief(input)
    this.managed = runProcess(this.bin, {
      cwd: workspace,
      args,
      input: brief,
      timeoutMs: 30 * 60 * 1000,
    })
    this.attachBridgeParser()
    this.result = this.managed.exitPromise.then((r) => ({ code: r.code ?? 1, output: r.output }))
  }

  private legacyBrief(input: string): string {
    return [
      `[Agent Groups · member ${this.config.role}]`,
      this.config.systemPrompt !== undefined ? this.config.systemPrompt : `You are the ${this.config.role} member of the Agent Groups team.`,
      '',
      'Work in this workspace and follow the task you are assigned.',
      '',
      '── TASK ──',
      input,
    ].join('\n')
  }

  private async buildBrief(input: string): Promise<string> {
    const bridge = this.getBridge()
    if (bridge === undefined) return this.legacyBrief(input)

    try {
      const context = await bridge.getContextDelta(this.config.agentId, undefined, this.config.groupId)
      const task = context.currentTask
      const compiled = compileAgentPrompt({
        groupProtocol: 'You are a Group Member in an Agent Groups team. You can actively interact through the bridge markers below.',
        runtimeInstructions: codexBridgeInstructions(),
        rolePreset: this.config.systemPrompt ?? `You are the ${this.config.role} member of the Agent Groups team.`,
        currentTask: task === undefined
          ? input
          : {
              subject: task.subject,
              description: task.description,
              kind: task.kind,
              acceptanceCriteria: task.acceptanceCriteria,
              writeScopes: task.writeScopes,
              blockedBy: task.blockedBy,
            },
        relevantContext: context.channelMessages.slice(-10).map((message) => ({
          title: `Channel: ${message.senderName}`,
          content: message.text,
        })),
        maxContextTokens: 12_000,
      })
      return compiled.text
    } catch {
      return this.legacyBrief(input)
    }
  }

  private attachBridgeParser(): void {
    const bridge = this.getBridge()
    if (this.managed === undefined || bridge === undefined) return
    this.managed.stdout.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString('utf8')
      const lines = this.stdoutBuffer.split('\n')
      this.stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const action = parseBridgeAction(line)
        if (action === undefined) continue
        const pending = executeBridgeAction(bridge, this.config.agentId, action).finally(() => {
          this.pending.delete(pending)
        })
        this.pending.add(pending)
      }
    })
  }

  sendTask(input: string): Promise<void> {
    return this.ensureStarted(input)
  }

  async waitExit(): Promise<{ code: number; output: string }> {
    if (this.result === undefined) return { code: 0, output: '' } // never assigned
    const result = await this.result
    await Promise.allSettled([...this.pending])
    return result
  }

  stop(): void {
    this.stopped = true
    this.managed?.kill('SIGTERM')
  }
}

export interface ClaudeRuntimeOptions {
  readonly binPath?: string
  readonly getBridge?: () => ExternalAgentBridge | undefined
}

export class ClaudeCodeRuntimeProvider implements AgentRuntimeProvider {
  readonly id = 'claude-code'
  readonly name = 'Claude Code'
  readonly description = 'Anthropic Claude Code CLI — bridge-aware external coding agent runtime.'

  private readonly bin: string | null
  private readonly getBridge: () => ExternalAgentBridge | undefined
  private readonly instances = new Map<string, ClaudeInstance>()

  constructor(binPathOrOptions?: string | ClaudeRuntimeOptions) {
    if (typeof binPathOrOptions === 'string') {
      this.bin = binPathOrOptions
      this.getBridge = () => undefined
    } else {
      this.bin = binPathOrOptions?.binPath ?? which('claude')
      this.getBridge = binPathOrOptions?.getBridge ?? (() => undefined)
    }
  }

  isAvailable(): boolean {
    if (this.bin === null) return false
    const claudeDir = join(homedir(), '.claude')
    if (existsSync(claudeDir)) return true
    const env = process.env as Record<string, string | undefined>
    return env.ANTHROPIC_API_KEY !== undefined || env.CLAUDE_CODE_API_KEY !== undefined
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
    if (this.bin === null) throw new Error('claude CLI not found on PATH')
    if (config.workspace === undefined || config.workspace === '') {
      throw new Error('claude-code runtime requires an explicit workspace — the role has no workspace configured')
    }
    const instance = new ClaudeInstance(this.bin, config, this.getBridge)
    this.instances.set(config.agentId, instance)
    const handle: RuntimeAgentHandle = {
      agentId: config.agentId,
      runtime: this.id,
      status: 'starting',
      waitExit: () => instance.waitExit(),
      sendInput: async (text: string) => { await instance.sendTask(text) },
      deliver: async (message) => { await instance.sendTask(runtimeMessageText(message)) },
      stop: async () => { instance.stop() },
    }
    return handle
  }

  async stopAgent(handle: RuntimeAgentHandle): Promise<void> {
    await handle.stop()
    this.instances.delete(handle.agentId)
  }

  async deliver(handle: RuntimeAgentHandle, message: RuntimeMessage<unknown>): Promise<void> {
    if (handle.deliver !== undefined) {
      await handle.deliver(message)
    } else if (handle.sendInput !== undefined) {
      await handle.sendInput(runtimeMessageText(message))
    }
  }
}
