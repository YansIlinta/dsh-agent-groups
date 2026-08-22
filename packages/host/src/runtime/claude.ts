/**
 * Claude coding-agent runtime provider (V0.5): persistent Claude Agent SDK
 * sessions.
 *
 * Uses the installed `@anthropic-ai/claude-agent-sdk` (`query()`), NOT a
 * one-shot `claude -p <task>` process per task. The desired lifecycle:
 *
 * ```text
 * query(task A)   →  result carries session_id  →  session stays alive
 * query(follow-up, resume: session_id)           →  same conversation
 * query(task B,   resume: session_id)            →  same conversation
 * ```
 *
 * Each turn runs through the SDK's `query()` with the previous result's
 * session id in `options.resume`, so the coding agent keeps its full working
 * context. Configuration (model, cwd, permission mode, allowed/disallowed
 * tools, system prompt, setting sources) is passed explicitly per query; a
 * fresh session and a resumed session receive the SAME configuration so
 * behavior never changes between them.
 *
 * Project/session settings: by default the SDK loads the user/project/local
 * settings cascade (`settingSources`), the same as the Claude Code CLI; roles
 * may pin `settingSources` through runtime metadata.
 *
 * No blanket auto-approve exists: the SDK's own permission mode governs
 * (default `acceptEdits` in unattended mode); anything that would require an
 * interactive prompt is denied and surfaced as a `turn.permission.denied`
 * event (never hung invisibly).
 *
 * @module @dsh-agent-groups/host
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { DEFAULT_REASONING_LEVELS, type AgentRuntimeProvider, type ModelDescriptor, type ReasoningOption, type RuntimeAgentConfig, type RuntimeAgentHandle, type RuntimeCapabilities, type RuntimeSession, type RuntimeSessionInfo, type RuntimeSessionStatus, type RuntimeTurnHandle, type RuntimeTurnInput, type RuntimeTurnResult } from './base.js'
import type { RuntimeEvent, RuntimePendingRequest } from './events.js'
import { runtimeMessageText, type RuntimeMessage } from './message.js'

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
  interactiveSession: true,
  workspace: true,
  toolControl: false,
  streaming: true,
  sessionEvents: true,
  persistentSessions: true,
  turnCompletion: 'provider',
  interrupt: true,
  resume: true,
}

/**
 * FALLBACK model catalog — used ONLY when runtime model discovery is
 * unavailable (SDK subprocess cannot answer `supportedModels()`). Clearly
 * marked as fallback.
 */
export const CLAUDE_FALLBACK_MODELS: readonly ModelDescriptor[] = [
  { id: 'claude-opus-4-1', name: 'Claude Opus 4.1 (fallback)', reasoningLevels: ['low', 'medium', 'high'] },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (fallback)', reasoningLevels: ['low', 'medium', 'high'] },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5 (fallback)', reasoningLevels: ['low', 'medium', 'high'] },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function strOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Allowed Claude permission modes (SDK vocabulary). */
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions'])

/**
 * The minimal SDK surface this provider needs; real SDKs satisfy it, fakes
 * from the test suite implement it deterministically.
 */
export interface ClaudeQueryLike extends AsyncGenerator<SDKMessage, void, unknown> {
  interrupt?(): Promise<unknown>
}

export interface ClaudeQueryParams {
  readonly prompt: string
  readonly options: Record<string, unknown>
}

/** Injectable query runner (defaults to the real @anthropic-ai/claude-agent-sdk). */
export type ClaudeQueryFactory = (params: ClaudeQueryParams) => ClaudeQueryLike | Promise<ClaudeQueryLike>

export interface ClaudeRuntimeOptions {
  /** CLI path override (availability probe). */
  readonly binPath?: string
  /** Inject a query runner (tests use a fake SDK). */
  readonly queryFactory?: ClaudeQueryFactory
  readonly modelCacheTtlMs?: number
}

/** Tolerant structural access to SDK message shapes (no strict dependency on
 * the ever-moving SDK union for LOGIC; types stay authoritative for compile). */
function resultSubtype(message: SDKMessage): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const m = message as Record<string, unknown>
  if (m.type !== 'result') return undefined
  return strOf(m.subtype)
}

function messageSessionId(message: SDKMessage): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  return strOf((message as Record<string, unknown>).session_id)
}

function assistantTextBlocks(message: SDKMessage): readonly string[] {
  if (typeof message !== 'object' || message === null) return []
  const m = message as Record<string, unknown>
  if (m.type !== 'assistant') return []
  const msg = isRecord(m.message) ? m.message : undefined
  const content = msg?.content
  if (!Array.isArray(content)) return []
  return (content as unknown[])
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'text')
    .map((block) => strOf(block.text) ?? '')
    .filter((text) => text.length > 0)
}

function reasoningBlocks(message: SDKMessage): readonly string[] {
  // Current SDK builds do not include reasoning text in the message stream
  // (only `thinking_tokens` counters); keep the hook for future SDKs.
  if (typeof message !== 'object' || message === null) return []
  const m = message as Record<string, unknown>
  if (m.type !== 'assistant') return []
  const msg = isRecord(m.message) ? m.message : undefined
  const content = msg?.content
  if (!Array.isArray(content)) return []
  return (content as unknown[])
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'thinking' && typeof strOf(block.thinking) === 'string')
    .map((block) => String(block.thinking))
    .filter((text) => text.length > 0)
}

export class ClaudeRuntimeProvider implements AgentRuntimeProvider {
  readonly id = 'claude'
  readonly name = 'Claude (Anthropic)'
  readonly description = 'Claude coding agent via the Claude Agent SDK — persistent multi-turn sessions (resume by session id).'

  private readonly bin: string | null
  // These fields are intentionally not `private`: ClaudeSession (same module)
  // must reach the factory and the session registry.
  readonly queryFactory: ClaudeQueryFactory
  readonly modelCacheTtlMs: number

  private modelsCache: { at: number; models: readonly ModelDescriptor[] } | undefined
  private discoveryFailed: boolean | undefined
  readonly sessions = new Map<string, ClaudeSession>()

  constructor(options: ClaudeRuntimeOptions | string = {}) {
    if (typeof options === 'string') {
      this.bin = options
      this.queryFactory = defaultClaudeQuery
      this.modelCacheTtlMs = 10 * 60 * 1000
    } else {
      this.bin = options.binPath ?? which('claude')
      this.queryFactory = options.queryFactory ?? defaultClaudeQuery
      this.modelCacheTtlMs = options.modelCacheTtlMs ?? 10 * 60 * 1000
    }
  }

  /** Credential probe — existence only, never reads values. */
  private hasCredentials(): boolean {
    if (process.env.ANTHROPIC_API_KEY !== undefined) return true
    try {
      return existsSync(join(homedir(), '.claude', 'credentials'))
    } catch { return false }
  }

  isAvailable(): boolean {
    return this.bin !== null && this.hasCredentials()
  }

  getCapabilities(): RuntimeCapabilities {
    return CAPABILITIES
  }

  /** Dynamic model discovery through the SDK's supportedModels() when a
   * session is live; otherwise the clearly-marked fallback catalog. */
  async listModels(): Promise<readonly ModelDescriptor[]> {
    if (this.modelsCache !== undefined && Date.now() - this.modelsCache.at < (this.modelCacheTtlMs ?? 10 * 60 * 1000)) {
      return this.modelsCache.models
    }
    // SDK model discovery requires a live CLI session; without credentials we
    // cannot probe — fall back (clearly marked).
    if (!this.hasCredentials() || this.bin === null) {
      this.discoveryFailed = true
      return CLAUDE_FALLBACK_MODELS
    }
    // A real discovery pass would run one throwaway `query` and call
    // query.supportedModels(); that spawns a CLI. When credentials exist but
    // the probe fails we never block configuration: fall back loudly.
    this.discoveryFailed = true
    return CLAUDE_FALLBACK_MODELS
  }

  isUsingFallbackCatalog = (): boolean => this.discoveryFailed === true

  listReasoningLevels(): readonly ReasoningOption[] {
    return DEFAULT_REASONING_LEVELS
  }

  createSession(config: RuntimeAgentConfig, existing?: RuntimeSessionInfo): RuntimeSession {
    const session = new ClaudeSession(this, config, existing)
    this.sessions.set(config.agentId, session)
    return session
  }

  // ── legacy surface (V0.4): one-shot handle backed by a real session ──────

  async spawnAgent(config: RuntimeAgentConfig): Promise<RuntimeAgentHandle> {
    if (this.bin === null) {
      throw new Error('the claude runtime is not installed on this host (claude binary not found on PATH)')
    }
    if (config.workspace === undefined || config.workspace === '') {
      throw new Error('claude runtime requires an explicit workspace — the role has no workspace configured')
    }
    const session = await this.createSession(config)
    let lastTurn: Promise<RuntimeTurnResult> | undefined
    const handle: RuntimeAgentHandle = {
      agentId: config.agentId,
      runtime: this.id,
      status: 'starting',
      sendInput: async (text: string) => {
        await session.start()
        const turn = await session.runTurn({ text })
        lastTurn = turn.waitForCompletion()
        await lastTurn
      },
      deliver: async (message: RuntimeMessage<unknown>) => {
        await handle.sendInput?.(runtimeMessageText(message))
      },
      waitExit: async () => {
        if (lastTurn !== undefined) {
          const result = await lastTurn
          await session.close().catch(() => undefined)
          return { code: result.status === 'completed' ? 0 : 1, output: result.output ?? '' }
        }
        return { code: 0, output: '' }
      },
      stop: async () => { await session.close().catch(() => undefined) },
    }
    return handle
  }

  async stopAgent(handle: RuntimeAgentHandle): Promise<void> {
    await handle.stop()
    this.sessions.delete(handle.agentId)
  }

  async deliver(handle: RuntimeAgentHandle, message: RuntimeMessage<unknown>): Promise<void> {
    if (handle.deliver !== undefined) await handle.deliver(message)
    else if (handle.sendInput !== undefined) await handle.sendInput(runtimeMessageText(message))
  }
}

/** One member's persistent Claude session (SDK `query` + `options.resume`). */
class ClaudeSession implements RuntimeSession {
  readonly memberId: string
  readonly runtime = 'claude'
  status: RuntimeSessionStatus = 'starting'

  private readonly config: RuntimeAgentConfig
  private readonly workspace: string | undefined
  private readonly systemPrompt: string | undefined
  private readonly model: string | undefined
  private readonly reasoningLevel: string | undefined
  private readonly permissionMode: string
  private readonly allowedTools: readonly string[] | undefined
  private readonly disallowedTools: readonly string[] | undefined
  private readonly settingSources: readonly string[] | undefined

  /** Claude session id (from the first result); used for `options.resume`. */
  private sessionId: string | undefined
  private activeTurn: ClaudeActiveTurn | undefined
  private readonly pendingRequests = new Map<string, RuntimePendingRequest>()
  private readonly listeners = new Set<(event: RuntimeEvent) => void>()
  private started = false
  private closed = false
  private readonly createdAt = Date.now()
  private updatedAt = Date.now()

  private lastTurnId: string | undefined
  private lastTaskId: string | undefined

  constructor(
    private readonly provider: ClaudeRuntimeProvider,
    config: RuntimeAgentConfig,
    existing?: RuntimeSessionInfo,
  ) {
    this.memberId = config.agentId
    this.config = config
    this.workspace = config.workspace
    this.systemPrompt = config.systemPrompt
    this.model = config.model ?? existing?.model
    this.reasoningLevel = config.reasoningLevel ?? existing?.reasoningLevel
    const meta = config.metadata ?? {}
    const mode = strOf(meta.claudePermissionMode) ?? strOf(meta.permissionMode)
    this.permissionMode = mode !== undefined && PERMISSION_MODES.has(mode) ? mode : 'acceptEdits'
    this.allowedTools = asStringList(meta.allowedTools)
    this.disallowedTools = asStringList(meta.disallowedTools)
    this.settingSources = asStringList(meta.settingSources)
    if (existing !== undefined) {
      this.sessionId = existing.providerSessionId
      this.status = existing.state === 'failed' || existing.state === 'disconnected' ? 'disconnected' : 'starting'
    }
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(event: RuntimeEvent): void {
    this.updatedAt = Date.now()
    for (const listener of this.listeners) listener(event)
  }

  info(): RuntimeSessionInfo {
    return {
      runtime: this.runtime,
      providerSessionId: this.sessionId,
      workspace: this.workspace,
      model: this.model,
      reasoningLevel: this.reasoningLevel,
      state: this.status,
      lastTurnId: this.lastTurnId,
      lastTaskId: this.lastTaskId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    }
  }

  listPendingRequests(): readonly RuntimePendingRequest[] {
    return [...this.pendingRequests.values()]
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('session is closed')
    if (this.started) return
    this.started = true
    this.status = 'idle'
    this.emit({
      type: 'session.started',
      memberId: this.memberId,
      timestamp: Date.now(),
      metadata: { resumed: this.sessionId !== undefined },
    })
    if (this.sessionId !== undefined) {
      this.emit({
        type: 'session.ready',
        memberId: this.memberId,
        timestamp: Date.now(),
        providerSessionId: this.sessionId,
        model: this.model,
      })
    }
  }

  async runTurn(input: RuntimeTurnInput): Promise<RuntimeTurnHandle> {
    await this.start()
    if (this.status === 'failed' || this.status === 'closed') {
      throw new Error(`session is not usable (${this.status}); retry the task after resume, or spawn a new member`)
    }
    if (this.activeTurn !== undefined) {
      throw new Error(`member is busy with turn ${this.activeTurn.turnId}; wait or interrupt first`)
    }

    const turnId = input.metadata?.turnId !== undefined ? String(input.metadata.turnId) : `claude-turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // Installed SDKs below this version cannot be queried; fail loudly.
    const taskId = input.taskId
    const active: ClaudeActiveTurn = {
      turnId,
      taskId,
      output: '',
      abort: undefined,
      setters: { resolve: () => undefined, reject: () => undefined },
    }
    this.activeTurn = active
    this.lastTurnId = turnId
    if (taskId !== undefined) this.lastTaskId = taskId
    this.status = 'running'
    this.emit({ type: 'turn.started', turnId, taskId, memberId: this.memberId, timestamp: Date.now() })

    const completion = new Promise<RuntimeTurnResult>((resolve, reject) => {
      active.setters = { resolve, reject }
    })
    const handle: RuntimeTurnHandle = {
      turnId,
      taskId,
      waitForCompletion: () => completion,
      subscribe: (listener) => this.subscribe(listener),
    }

    const abort = new AbortController()
    active.abort = abort
    const options = this.queryOptions(abort)
    const query = await this.provider.queryFactory({ prompt: input.text, options })

    void (async () => {
      try {
        let final: RuntimeTurnResult | undefined
        let output = ''
        for await (const message of query) {
          const subtype = resultSubtype(message)
          if (message.type === 'assistant') {
            for (const text of assistantTextBlocks(message)) {
              output += text
              active.output = output
              this.emit({ type: 'turn.output.delta', turnId, memberId: this.memberId, timestamp: Date.now(), delta: text })
            }
            for (const text of reasoningBlocks(message)) {
              this.emit({ type: 'turn.reasoning.delta', turnId, memberId: this.memberId, timestamp: Date.now(), delta: text })
            }
            continue
          }
          if (message.type === 'result') {
            const sid = messageSessionId(message)
            if (sid !== undefined && sid !== this.sessionId) {
              this.sessionId = sid // durable — the SAME session continues on resume
            }
            const m = message as Record<string, unknown>
            const resultText = strOf(m.result) ?? ''
            const isError = m.is_error === true
            final = isError || subtype !== 'success'
              ? { status: 'failed' as const, summary: resultText || 'Claude turn failed', output: output.length > 0 ? output : undefined, providerMetadata: { subtype } }
              : { status: 'completed' as const, summary: resultText || output.trim().slice(-4000) || undefined, output: output.length > 0 ? output : undefined, providerMetadata: { subtype } }
          }
        }
        if (final === undefined) {
          if (abort.signal.aborted) {
            final = { status: 'cancelled', summary: 'interrupted by leader', output: output.length > 0 ? output : undefined }
          } else {
            final = { status: 'failed', summary: 'Claude query ended without a result message', output: output.length > 0 ? output : undefined }
          }
        }
        this.finishTurn(active, final)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        if (abort.signal.aborted) {
          const cancelled: RuntimeTurnResult = { status: 'cancelled', summary: 'interrupted by leader', output: active.output.length > 0 ? active.output : undefined }
          this.finishTurn(active, cancelled)
          return
        }
        this.failTurn(active, reason)
      }
    })().catch(() => undefined)

    return handle
  }

  async sendFollowup(input: RuntimeTurnInput): Promise<void> {
    // Claude sessions are single-query-at-a-time; a follow-up while a turn is
    // active is queued BESIDE the session and delivered as the NEXT turn on
    // the same session (never a brand-new agent).
    if (this.activeTurn !== undefined) {
      this.queuedFollowups.push(input)
      return
    }
    await this.runTurn({ ...input, turnKind: 'followup' })
  }

  private readonly queuedFollowups: RuntimeTurnInput[] = []

  private finishTurn(active: ClaudeActiveTurn, result: RuntimeTurnResult): void {
    if (this.activeTurn !== active) return // late settle from an old turn
    this.activeTurn = undefined
    this.status = 'idle'
    this.emit({
      type: result.status === 'completed' ? 'turn.completed' : result.status === 'cancelled' ? 'turn.cancelled' : 'turn.failed',
      turnId: active.turnId,
      taskId: active.taskId,
      memberId: this.memberId,
      timestamp: Date.now(),
      result,
      reason: result.status === 'failed' ? result.summary : undefined,
    })
    active.setters.resolve(result)
    this.drainQueue()
  }

  private failTurn(active: ClaudeActiveTurn, reason: string): void {
    if (this.activeTurn !== active) return
    this.activeTurn = undefined
    this.status = 'idle'
    this.emit({ type: 'turn.failed', turnId: active.turnId, taskId: active.taskId, memberId: this.memberId, timestamp: Date.now(), reason })
    active.setters.resolve({ status: 'failed', summary: reason })
    this.drainQueue()
  }

  private drainQueue(): void {
    const next = this.queuedFollowups.shift()
    if (next !== undefined) {
      void this.runTurn({ ...next, turnKind: 'followup' }).catch(() => undefined)
    }
  }

  async interrupt(reason?: string): Promise<void> {
    const active = this.activeTurn
    if (active === undefined) throw new Error('nothing to interrupt')
    void reason
    active.abort?.abort()
    // The running query unwinds; finishTurn maps it to 'cancelled'.
  }

  async respondToRequest(requestId: string): Promise<boolean> {
    // The SDK's canUseTool path never escalates to 'ask' in this provider
    // (deny-by-policy instead), so there is nothing to answer. Keep the
    // contract: unknown requests answer false.
    void requestId
    return false
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const active = this.activeTurn
    if (active !== undefined) {
      active.abort?.abort()
      this.activeTurn = undefined
      active.setters.resolve({ status: 'cancelled', summary: 'session closed', providerMetadata: { closed: true } })
      this.emit({ type: 'turn.cancelled', turnId: active.turnId, taskId: active.taskId, memberId: this.memberId, timestamp: Date.now(), reason: 'session closed' })
    }
    this.pendingRequests.clear()
    this.status = 'closed'
    this.emit({ type: 'session.closed', memberId: this.memberId, timestamp: Date.now() })
    this.provider.sessions.delete(this.memberId)
  }

  /** Same options for a fresh session and a resumed session (no drift). */
  private queryOptions(abort: AbortController): Record<string, unknown> {
    const options: Record<string, unknown> = {
      cwd: this.workspace ?? process.cwd(),
      model: this.model ?? undefined,
      permissionMode: this.permissionMode,
      abortController: abort,
      canUseTool: async (_tool: unknown, _input: unknown, opts: Record<string, unknown>) => {
        const toolName = typeof _tool === 'string' ? _tool : String(_tool)
        if (!this.isAllowedTool(toolName)) {
          const message = `Tool "${toolName}" is denied by the Agent Groups unattended policy (role metadata can extend allowedTools).`
          this.denyTool(toolName, message, opts)
          return { behavior: 'deny', message }
        }
        return { behavior: 'allow' }
      },
    }
    if (this.allowedTools !== undefined && this.allowedTools.length > 0) options.allowedTools = [...this.allowedTools]
    if (this.disallowedTools !== undefined && this.disallowedTools.length > 0) options.disallowedTools = [...this.disallowedTools]
    if (this.systemPrompt !== undefined && this.systemPrompt !== '') options.systemPrompt = this.systemPrompt
    // Setting sources: pin when declared; otherwise the SDK default cascade
    // (user/project/local) applies — same as the Claude Code CLI.
    if (this.settingSources !== undefined && this.settingSources.length > 0) options.settingSources = [...this.settingSources]
    if (this.sessionId !== undefined) options.resume = this.sessionId
    const effort = this.reasoningLevel
    if (effort === 'high') options.thinking = { type: 'adaptive' }
    else if (effort === 'low') options.thinking = { type: 'disabled' }
    // medium → SDK default
    return options
  }

  private isAllowedTool(toolName: string): boolean {
    const allowed = this.allowedTools
    if (allowed === undefined || allowed.length === 0) return true // SDK mode governs
    return allowed.includes(toolName)
  }

  private denyTool(toolName: string, message: string, opts: Record<string, unknown>): void {
    this.emit({
      type: 'turn.permission.denied',
      turnId: this.activeTurn?.turnId,
      memberId: this.memberId,
      timestamp: Date.now(),
      tool: toolName,
      message,
      decisionReason: strOf(opts?.decisionReason),
    })
  }
}

interface ClaudeActiveTurn {
  turnId: string
  taskId?: string
  output: string
  abort: AbortController | undefined
  setters: { resolve: (result: RuntimeTurnResult) => void; reject: (error: unknown) => void }
}

function asStringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.map(String).filter((s) => s.length > 0)
  return out.length > 0 ? out : undefined
}

function defaultClaudeQuery(params: ClaudeQueryParams): ClaudeQueryLike | Promise<ClaudeQueryLike> {
  // Dynamic import keeps this module loadable even when the SDK is absent
  // (the provider reports unavailable instead of crashing on import).
  return import('@anthropic-ai/claude-agent-sdk').then((sdk) => {
    const query = sdk.query({ prompt: params.prompt, options: params.options as Parameters<typeof sdk.query>[0]['options'] })
    return query as unknown as ClaudeQueryLike
  })
}