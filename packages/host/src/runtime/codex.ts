/**
 * Codex (OpenAI) runtime provider (V0.5): persistent Codex App Server.
 *
 * One long-running `codex app-server` process (shared by all Codex members),
 * communicated with over its supported bidirectional JSONL protocol (see
 * `codex-protocol.ts`). A Codex Agent Groups member maps to a durable Codex
 * **thread**, NOT to a `codex exec` child process:
 *
 * ```text
 * codex app-server ── initialize ── thread/start ── turn/start(task A)
 *                        ── turn/completed ── turn/start(task B) ── ...
 * ```
 *
 * The same thread is reused across tasks and Leader follow-ups (follow-ups
 * steer the active turn via `turn/steer`), so the coding agent keeps its
 * working context. Model availability is discovered dynamically through
 * `model/list` — the provider is the authority for available models and
 * reasoning controls; a static list exists ONLY as a clearly-marked fallback
 * when the app-server genuinely cannot be reached.
 *
 * Availability is credential-driven: the provider never stores or asks for
 * secrets — it uses the host's existing login (~/.codex/auth.json) or
 * OPENAI_API_KEY / CODEX_API_KEY environment variables.
 *
 * @module @dsh-agent-groups/host
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CodexAppServerConnection,
  CodexBinaryProcessHost,
  CodexProtocolError,
  type CodexInboundMessage,
  type CodexProcessHost,
  type RequestId,
} from './codex-protocol.js'
import {
  DEFAULT_REASONING_LEVELS,
  type AgentRuntimeProvider,
  type ModelDescriptor,
  type ReasoningOption,
  type RuntimeAgentConfig,
  type RuntimeAgentHandle,
  type RuntimeCapabilities,
  type RuntimeSession,
  type RuntimeSessionInfo,
  type RuntimeSessionStatus,
  type RuntimeTurnHandle,
  type RuntimeTurnInput,
  type RuntimeTurnResult,
  type SteerOutcome,
} from './base.js'
import type { RuntimeEvent, RuntimePendingRequest } from './events.js'
import { runtimeMessageText, type RuntimeMessage } from './message.js'

/**
 * Minimal PATH lookup (no extra deps). Handles Windows PATH separators (';')
 * and executable extensions so a win32 install (npm shims / WinGet exe) is
 * found just like a POSIX one.
 */
function which(bin: string): string | null {
  const path = (process.env.PATH ?? '').split(process.platform === 'win32' ? /[;:]/ : ':')
  const candidates = process.platform === 'win32' ? [`${bin}.exe`, `${bin}.cmd`, bin] : [bin]
  for (const dir of path) {
    if (dir === '') continue
    for (const candidate of candidates) {
      const full = join(dir, candidate)
      try {
        if (existsSync(full)) return full
      } catch { /* keep scanning */ }
    }
  }
  return null
}

const CAPABILITIES: RuntimeCapabilities = {
  models: true,
  reasoningLevels: true,
  interactiveSession: true,
  workspace: true,
  toolControl: true,
  streaming: true,
  sessionEvents: true,
  persistentSessions: true,
  turnCompletion: 'provider',
  interrupt: true,
  resume: true,
}

/**
 * FALLBACK model catalog — used ONLY when `model/list` discovery is genuinely
 * unavailable (binary missing / app-server refuses to answer). Clearly marked
 * as fallback: a newly released Codex model never requires editing Agent
 * Groups source code to become selectable through the normal discovery path.
 */
export const CODEX_FALLBACK_MODELS: readonly ModelDescriptor[] = [
  { id: 'gpt-5.1-codex', name: 'GPT-5.1-Codex (fallback)', reasoningLevels: ['low', 'medium', 'high', 'ultra'] },
  { id: 'gpt-5-codex', name: 'GPT-5-Codex (fallback)', reasoningLevels: ['low', 'medium', 'high', 'ultra'] },
  { id: 'o4-mini', name: 'o4-mini (fallback)', reasoningLevels: ['low', 'medium', 'high'] },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function strOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Approval policy per role metadata (never stored).
 * - `decline` (default): every unanswered approval request is auto-declined
 *   after the request deadline so nothing hangs invisibly; there is no
 *   blanket auto-approve anywhere.
 * - `hold`: hold for the human/Leader; the request still gets a deadline
 *   after which the SAFE `cancel` action is executed (explicit event).
 */
function approvalPolicyFor(config: RuntimeAgentConfig): { mode: 'decline' | 'hold'; timeoutAction: 'decline' | 'cancel' } {
  const raw = config.metadata?.['approvalPolicy']
  if (raw === 'hold') return { mode: 'hold', timeoutAction: 'cancel' }
  return { mode: 'decline', timeoutAction: 'decline' }
}

function approvalDescription(method: string, params: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof params.reason === 'string' && params.reason !== '') parts.push(params.reason)
  if (typeof params.command === 'string' && params.command !== '') parts.push(`\`${params.command}\``)
  if (Array.isArray(params.commandActions)) {
    const summary = (params.commandActions as unknown[]).slice(0, 4)
      .map((a) => (isRecord(a) ? [strOf(a.kind), strOf(a.path), strOf(a.command)].filter(Boolean).join(' ') : String(a)))
      .join('; ')
    if (summary.length > 0) parts.push(summary)
  }
  return parts.length > 0 ? parts.join(' — ') : method
}

/** Role metadata → thread/start + turn/start overrides (whitelisted keys). */
function roleThreadOverrides(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const approval = metadata['approvalPolicy']
  if (approval === 'never' || approval === 'on-request' || approval === 'untrusted' || (typeof approval === 'object' && approval !== null)) {
    out.approvalPolicy = approval
  }
  const sandbox = metadata['sandbox']
  if (sandbox === 'read-only' || sandbox === 'workspace-write' || sandbox === 'danger-full-access') {
    out.sandbox = sandbox
  }
  return out
}

/** Strip anything that could look like a credential from request params. */
function redact(params: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (/token|secret|key|auth|password|credential/i.test(key)) continue
    copy[key] = value
  }
  return copy
}

export interface CodexRuntimeOptions {
  readonly binPath?: string
  /** Inject a process host (tests use a fake JSONL server child). */
  readonly processHost?: CodexProcessHost
  readonly requestTimeoutMs?: number
  /** Model catalog cache TTL (dynamic discovery; default 10 minutes). */
  readonly modelCacheTtlMs?: number
  /**
   * V0.6: pending-request deadline. Requests unanswered by the Leader/User
   * within this window execute their safe default (`decline` for the default
   * policy, `cancel` for hold mode) and emit `request.timeout` — no provider
   * request may hang invisibly forever. Default 5 minutes.
   */
  readonly requestDeadlineMs?: number
}

/**
 * V0.6: typed steer failure. `turn/steer` on the active Codex turn failed and
 * the Leader instruction was NOT injected into the running turn. GroupHost
 * handles this by queueing the guidance as the NEXT turn on the same session
 * (it is never silently dropped) and recording `runtime_steer_failed`.
 */
export class CodexSteerError extends CodexProtocolError {
  constructor(message: string) {
    super('TURN_STEER_FAILED', message)
    this.name = 'CodexSteerError'
  }
}

export class CodexRuntimeProvider implements AgentRuntimeProvider {
  readonly id = 'codex'
  readonly name = 'Codex (OpenAI)'
  readonly description = 'OpenAI Codex App Server — persistent coding-agent sessions (one Codex thread per member).'

  private readonly bin: string | null
  private readonly processHost: CodexProcessHost | undefined
  // Non-private: CodexSession (same module) must reach these.
  readonly requestTimeoutMs: number
  readonly modelCacheTtlMs: number
  /** V0.6: deadline for unanswered provider requests (default 5 minutes). */
  readonly requestDeadlineMs: number

  /** Shared long-running `codex app-server` connection (process pool). */
  connection: CodexAppServerConnection | undefined
  readonly sessions = new Map<string, CodexSession>()

  private modelsCache: { at: number; models: readonly ModelDescriptor[] } | undefined
  private discoveryFailed: boolean | undefined

  constructor(options: CodexRuntimeOptions | string = {}) {
    if (typeof options === 'string') {
      this.bin = options
      this.processHost = undefined
      this.requestTimeoutMs = 60_000
      this.modelCacheTtlMs = 10 * 60 * 1000
      this.requestDeadlineMs = 5 * 60 * 1000
    } else {
      this.bin = options.binPath ?? which('codex')
      this.processHost = options.processHost
      this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000
      this.modelCacheTtlMs = options.modelCacheTtlMs ?? 10 * 60 * 1000
      this.requestDeadlineMs = options.requestDeadlineMs ?? 5 * 60 * 1000
    }
  }

  /** Credential probe — existence only, never reads values. */
  private hasCredentials(): boolean {
    if (process.env.OPENAI_API_KEY !== undefined || process.env.CODEX_API_KEY !== undefined) return true
    try {
      return existsSync(join(homedir(), '.codex', 'auth.json'))
    } catch { return false }
  }

  isAvailable(): boolean {
    return this.bin !== null && this.hasCredentials()
  }

  getCapabilities(): RuntimeCapabilities {
    return CAPABILITIES
  }

  /** Dynamic model discovery through the app-server catalog. */
  async listModels(): Promise<readonly ModelDescriptor[]> {
    if (this.modelsCache !== undefined && Date.now() - this.modelsCache.at < this.modelCacheTtlMs) {
      return this.modelsCache.models
    }
    if (this.bin === null) {
      this.discoveryFailed = true
      return CODEX_FALLBACK_MODELS
    }
    try {
      const connection = await this.ensureConnection()
      const result = await connection.request<Record<string, unknown>>('model/list', { includeHidden: false }, 30_000)
      const data = result?.data
      if (!Array.isArray(data)) throw new CodexProtocolError('MALFORMED_RESPONSE', 'model/list returned no data array')
      const models: ModelDescriptor[] = data
        .filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof strOf(entry.id) === 'string')
        .map((entry) => ({
          id: String(entry.id),
          name: strOf(entry.displayName) ?? strOf(entry.model) ?? String(entry.id),
          reasoningLevels: Array.isArray(entry.supportedReasoningEfforts)
            ? (entry.supportedReasoningEfforts as unknown[])
                .filter((eff): eff is Record<string, unknown> => isRecord(eff))
                .map((eff) => strOf(eff.reasoningEffort))
                .filter((eff): eff is string => eff !== undefined)
            : undefined,
        }))
      if (models.length === 0) throw new CodexProtocolError('MALFORMED_RESPONSE', 'model/list returned an empty catalog')
      this.discoveryFailed = false
      this.modelsCache = { at: Date.now(), models }
      return models
    } catch {
      // Discovery failure must NOT kill the configuration UI — fall back with
      // the clearly-marked static catalog (documented fallback).
      this.discoveryFailed = true
      return CODEX_FALLBACK_MODELS
    }
  }

  /** True when the catalog is the marked fallback (UI badge). */
  isUsingFallbackCatalog = (): boolean => this.discoveryFailed === true

  listReasoningLevels(): readonly ReasoningOption[] {
    return DEFAULT_REASONING_LEVELS
  }

  /** Shared app-server connection; spawns exactly one process per host. */
  async ensureConnection(): Promise<CodexAppServerConnection> {
    if (this.connection !== undefined) return this.connection
    if (this.bin === null) throw new CodexProtocolError('SPAWN_FAILED', 'codex binary not found on PATH')
    const connection = new CodexAppServerConnection(
      this.processHost ?? new CodexBinaryProcessHost(this.bin),
      { requestTimeoutMs: this.requestTimeoutMs ?? 60_000 },
    )
    await connection.connect()
    this.connection = connection
    connection.onExit(() => {
      // propagate the disconnect to every session; a later start() reconnects.
      this.connection = undefined
      for (const session of this.sessions.values()) session.onTransportExit()
    })
    return connection
  }

  // ── V0.5: sessions ─────────────────────────────────────────────────────────

  createSession(config: RuntimeAgentConfig, existing?: RuntimeSessionInfo): RuntimeSession {
    const session = new CodexSession(this, config, existing)
    this.sessions.set(config.agentId, session)
    return session
  }

  // ── legacy surface (V0.4): one-shot handles backed by a real session ──────

  async spawnAgent(config: RuntimeAgentConfig): Promise<RuntimeAgentHandle> {
    if (this.bin === null) {
      throw new Error('the codex runtime is not installed on this host (codex binary not found on PATH)')
    }
    if (config.workspace === undefined || config.workspace === '') {
      throw new Error('codex runtime requires an explicit workspace — the role has no workspace configured')
    }
    const session = await this.createSession(config)
    let output = ''
    session.subscribe((event) => {
      if (event.type === 'turn.output.delta') output += event.delta
    })
    let lastTurn: Promise<RuntimeTurnResult> | undefined
    const handle: RuntimeAgentHandle = {
      agentId: config.agentId,
      runtime: this.id,
      status: 'starting',
      sendInput: async (text: string) => {
        await session.start()
        const turn = await session.startTaskTurn({ text })
        lastTurn = turn.waitForCompletion()
        await lastTurn
      },
      deliver: async (message: RuntimeMessage<unknown>) => {
        await handle.sendInput?.(runtimeMessageText(message))
      },
      waitExit: async () => {
        // Legacy contract: resolve when the LAST sent turn completed.
        if (lastTurn === undefined) return { code: 0, output: '' }
        const result = await lastTurn
        await session.close(300).catch(() => undefined)
        return { code: result.status === 'completed' ? 0 : 1, output: result.output ?? output ?? '' }
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

/**
 * One member's persistent Codex thread on the shared app-server connection.
 * The same thread is reused across tasks and Leader follow-ups; turn events
 * are correlated by (threadId, turnId) so a late event from an old turn can
 * never complete a newer turn.
 */
class CodexSession implements RuntimeSession {
  readonly memberId: string
  readonly runtime = 'codex'
  status: RuntimeSessionStatus = 'starting'

  private readonly workspace: string | undefined
  private readonly systemPrompt: string | undefined
  private model: string | undefined
  private readonly reasoningLevel: string | undefined

  /** Codex thread id — the durable provider conversation identity. */
  private threadId: string | undefined
  /** Codex thread.sessionId (session-tree identity). */
  private sessionTreeId: string | undefined

  private activeTurn: ActiveTurn | undefined
  private attachedConnection: CodexAppServerConnection | undefined
  private readonly pendingRequests = new Map<string, RuntimePendingRequest>()
  /** Original (possibly numeric) provider request ids, keyed by string view. */
  private readonly pendingWireIds = new Map<string, RequestId>()
  private startPromise: Promise<void> | undefined
  private readonly listeners = new Set<(event: RuntimeEvent) => void>()
  private started = false
  private closed = false
  private readonly createdAt = Date.now()
  private updatedAt = Date.now()
  private readonly resumed: boolean

  private lastTurnId: string | undefined
  private lastTaskId: string | undefined

  constructor(
    private readonly provider: CodexRuntimeProvider,
    private readonly config: RuntimeAgentConfig,
    existing?: RuntimeSessionInfo,
  ) {
    this.memberId = config.agentId
    this.workspace = config.workspace
    this.systemPrompt = config.systemPrompt
    this.model = config.model ?? existing?.model
    this.reasoningLevel = config.reasoningLevel ?? existing?.reasoningLevel
    if (existing !== undefined) {
      this.threadId = existing.providerThreadId
      this.sessionTreeId = existing.providerSessionId
      this.lastTurnId = existing.lastTurnId
      this.lastTaskId = existing.lastTaskId
      this.status = existing.state === 'failed' || existing.state === 'disconnected' ? 'disconnected' : 'starting'
      this.resumed = this.threadId !== undefined
    } else {
      this.resumed = false
    }
  }

  get providerThreadId(): string | undefined { return this.threadId }

  get providerSessionId(): string | undefined { return this.sessionTreeId }

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
      providerSessionId: this.sessionTreeId,
      providerThreadId: this.threadId,
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
    if (this.startPromise === undefined) {
      this.startPromise = this.startInternal()
    }
    return this.startPromise
  }

  private async startInternal(): Promise<void> {
    const justResumed = this.resumed
    this.started = true
    this.emit({ type: 'session.started', memberId: this.memberId, timestamp: Date.now(), metadata: { resumed: justResumed } })

    let connection: CodexAppServerConnection
    try {
      connection = await this.provider.ensureConnection()
    } catch (error) {
      this.failSession(error)
      throw error instanceof CodexProtocolError ? error : new CodexProtocolError('SPAWN_FAILED', `cannot start the Codex app server: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.attachTo(connection)

    try {
      if (justResumed && this.threadId !== undefined) {
        // Re-attach to the SAME thread (host restart / transport reconnect).
        const result = await connection.request<Record<string, unknown>>('thread/resume', { threadId: this.threadId }, 60_000)
        const thread = isRecord(result?.thread) ? result.thread : undefined
        if (isRecord(thread)) {
          this.threadId = strOf(thread.id) ?? this.threadId
          this.sessionTreeId = strOf(thread.sessionId) ?? this.sessionTreeId
        }
        this.status = 'idle'
        this.emit({
          type: 'session.ready',
          memberId: this.memberId,
          timestamp: Date.now(),
          providerSessionId: this.sessionTreeId,
          providerThreadId: this.threadId,
          model: this.model,
        })
        return
      }

      // Fresh thread.
      const params: Record<string, unknown> = {
        cwd: this.workspace ?? undefined,
        sandbox: 'workspace-write',
        baseInstructions: this.systemPrompt !== undefined && this.systemPrompt !== '' ? this.systemPrompt : undefined,
        model: this.model ?? undefined,
        ...(this.config.metadata !== undefined ? roleThreadOverrides(this.config.metadata) : {}),
      }
      const result = await connection.request<Record<string, unknown>>('thread/start', params, 60_000)
      const thread = isRecord(result?.thread) ? result.thread : undefined
      if (!isRecord(thread) || typeof strOf(thread.id) !== 'string') {
        throw new CodexProtocolError('MALFORMED_RESPONSE', 'thread/start returned no thread id')
      }
      this.threadId = String(thread.id)
      this.sessionTreeId = strOf(thread.sessionId) ?? this.sessionTreeId
      this.model = strOf(result.model) ?? this.model
      this.status = 'idle'
      this.emit({
        type: 'session.ready',
        memberId: this.memberId,
        timestamp: Date.now(),
        providerSessionId: this.sessionTreeId,
        providerThreadId: this.threadId,
        model: this.model,
      })
    } catch (error) {
      this.failSession(error)
      throw error
    }
  }

  /** Transport exit → the active turn fails; the session stays resumable. */
  onTransportExit(): void {
    this.attachedConnection = undefined
    const turnId = this.activeTurn?.turnId
    const taskId = this.activeTurn?.taskId
    this.failActiveTurn('failed', 'Codex app server exited; the session reconnects on the next turn')
    this.status = 'disconnected'
    this.emit({
      type: 'session.disconnected',
      memberId: this.memberId,
      timestamp: Date.now(),
      reason: 'Codex app server exited unexpectedly',
      turnId,
      unrecoverable: false,
    })
    this.clearAllPendingRequests('app server exited')
  }

  private failSession(error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error)
    const active = this.activeTurn
    if (active !== undefined) {
      this.failActiveTurn('failed', reason)
    }
    this.status = 'failed'
    this.emit({ type: 'session.failed', memberId: this.memberId, timestamp: Date.now(), reason, turnId: active?.turnId })
  }

  /** Settle the active turn as failed (crash/exception path). */
  private failActiveTurn(_status: 'failed', reason: string): void {
    const active = this.activeTurn
    if (active === undefined) return
    this.activeTurn = undefined
    this.status = 'idle'
    this.emit({ type: 'turn.failed', turnId: active.turnId, taskId: active.taskId, memberId: this.memberId, timestamp: Date.now(), reason })
    active.setters.resolve({ status: 'failed', summary: reason, output: active.output.length > 0 ? active.output : undefined })
  }

  async startTaskTurn(input: RuntimeTurnInput): Promise<RuntimeTurnHandle> {
    await this.start()
    if (this.status === 'failed' || this.status === 'closed') {
      throw new Error(`session is not usable (${this.status}); retry the task after resume, or spawn a new member`)
    }
    if (this.activeTurn !== undefined) {
      throw new Error(`member is busy with turn ${this.activeTurn.turnId}; send a follow-up or interrupt first`)
    }
    if (this.threadId === undefined) throw new Error('session has no thread id yet')
    // Reconnect automatically when the app-server crashed meanwhile.
    const connection = await this.ensureLiveConnection()

    const turnId = randomUUID()
    const taskId = input.taskId
    const active: ActiveTurn = {
      turnId,
      taskId,
      kind: input.turnKind ?? (taskId !== undefined ? 'task' : 'followup'),
      output: '',
      setters: { resolve: () => undefined, reject: () => undefined },
    }
    this.activeTurn = active
    this.lastTurnId = turnId
    if (taskId !== undefined) this.lastTaskId = taskId
    // V0.6: the per-turn changed-file collection belongs to THIS turn only —
    // cleared at turn start, read at completion, never cleared before read.
    this.changedFiles.clear()
    this.status = 'working'
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

    try {
      const result = await connection.request<Record<string, unknown>>('turn/start', {
        threadId: this.threadId,
        clientUserMessageId: turnId,
        input: [{ type: 'text', text: input.text, text_elements: [] }],
        cwd: this.workspace ?? undefined,
        model: this.model ?? undefined,
        effort: this.reasoningLevel ?? undefined,
      }, this.provider.requestTimeoutMs ?? 60_000)
      const turn = isRecord(result?.turn) ? result.turn : undefined
      // The provider MAY return its own turn id; ours stays the correlation key.
      active.wireTurnId = isRecord(turn) && typeof strOf(turn.id) === 'string' && String(turn.id) !== turnId
        ? String(turn.id)
        : turnId
    } catch (error) {
      this.activeTurn = undefined
      this.status = 'idle'
      const reason = error instanceof Error ? error.message : String(error)
      this.emit({ type: 'turn.failed', turnId, taskId, memberId: this.memberId, timestamp: Date.now(), reason })
      active.setters.reject(error)
      throw error
    }
    return handle
  }

  /**
   * V0.6: steering for the ACTIVE turn (`turn/steer`, same thread + expected
   * turn). A failed steer THROWS a typed {@link CodexSteerError} — the host
   * records it as a queued next-turn follow-up, so Leader input is never
   * silently dropped. Idle sessions start a fresh follow-up turn instead.
   */
  async steerActiveTurn(input: RuntimeTurnInput): Promise<SteerOutcome> {
    await this.start()
    if (this.threadId === undefined) throw new Error('session has no thread id')
    const connection = await this.ensureLiveConnection()

    const active = this.activeTurn
    if (active !== undefined && active.wireTurnId !== undefined) {
      try {
        await connection.request('turn/steer', {
          threadId: this.threadId,
          expectedTurnId: active.wireTurnId,
          clientUserMessageId: `steer-${Date.now()}`,
          input: [{ type: 'text', text: input.text, text_elements: [] }],
        }, this.provider.requestTimeoutMs ?? 60_000)
        this.emit({ type: 'turn.steered', turnId: active.turnId, taskId: active.taskId, memberId: this.memberId, timestamp: Date.now() })
        return { steered: true }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        this.emit({ type: 'provider.error', memberId: this.memberId, timestamp: Date.now(), code: 'TURN_STEER_FAILED', message: reason })
        // The running turn stays live; the Leader input becomes the NEXT turn
        // on the SAME session (never dropped). The typed failure lets the host
        // record `runtime_steer_failed` instead of believing delivery happened.
        this.emit({
          type: 'turn.queued',
          memberId: this.memberId,
          timestamp: Date.now(),
          kind: 'followup',
          text: input.text,
          taskId: input.taskId,
          behindTurnId: active.turnId,
        })
        throw new CodexSteerError(reason)
      }
    }
    if (active !== undefined) {
      // Active but the provider never returned a wire turn id — cannot steer;
      // queue as the next turn on the same session (typed failure, never drop).
      this.emit({
        type: 'turn.queued',
        memberId: this.memberId,
        timestamp: Date.now(),
        kind: 'followup',
        text: input.text,
        taskId: input.taskId,
        behindTurnId: active.turnId,
      })
      throw new CodexSteerError(`active turn ${active.turnId} has no provider turn id to steer`)
    }
    await this.startTaskTurn({ ...input, turnKind: 'followup' })
    return { steered: true }
  }

  /**
   * V0.6: queue a NEW TASK as a future turn. The provider records the intent
   * (normalized `turn.queued` event); the HOST's authoritative queue holds it
   * and starts it after the active turn reaches a terminal state. The active
   * turn's task binding is NEVER modified.
   */
  async queueTaskTurn(input: RuntimeTurnInput): Promise<void> {
    await this.start()
    this.emit({
      type: 'turn.queued',
      memberId: this.memberId,
      timestamp: Date.now(),
      kind: 'task',
      text: input.text,
      taskId: input.taskId,
      behindTurnId: this.activeTurn?.turnId,
    })
  }

  /** V0.6: queue next-turn guidance on the same session (never a new agent). */
  async queueFollowup(input: RuntimeTurnInput): Promise<void> {
    await this.start()
    this.emit({
      type: 'turn.queued',
      memberId: this.memberId,
      timestamp: Date.now(),
      kind: 'followup',
      text: input.text,
      taskId: input.taskId,
      behindTurnId: this.activeTurn?.turnId,
    })
  }

  async interrupt(reason?: string): Promise<void> {
    const active = this.activeTurn
    if (active === undefined || active.wireTurnId === undefined || this.threadId === undefined) {
      throw new Error('nothing to interrupt')
    }
    const connection = await this.ensureLiveConnection()
    void reason
    await connection.request('turn/interrupt', { threadId: this.threadId, turnId: active.wireTurnId }, 15_000)
    // The server answers with turn/completed(status="interrupted") → the turn
    // handle resolves with status 'cancelled'.
  }

  async respondToRequest(requestId: string, action: string, payload?: unknown): Promise<boolean> {
    const request = this.pendingRequests.get(requestId)
    if (request === undefined) return false
    let response: unknown
    if (request.requestKind === 'input') {
      const answers = typeof payload === 'string' ? [payload] : Array.isArray(payload) ? payload.map(String) : [String(payload ?? '')]
      const questions = isRecord(request.params) ? request.params.questions : undefined
      const map: Record<string, unknown> = {}
      if (Array.isArray(questions)) {
        for (const q of questions as unknown[]) {
          if (isRecord(q) && typeof strOf(q.id) === 'string') map[String(q.id)] = { answers }
        }
      }
      response = { answers: map }
    } else {
      response = { decision: action }
    }
    const connection = this.provider.connection
    if (connection === undefined) return false
    const wireId = this.pendingWireIds.get(requestId) ?? requestId
    const ok = connection.respondToServerRequest(wireId, response)
    if (ok) {
      this.clearPendingRequest(requestId)
      if (this.status === 'waiting_input' || this.status === 'needs_approval') this.status = 'working'
    }
    return ok
  }

  async close(graceMs = 1_500): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const request of this.pendingRequests.keys()) {
      void this.respondToRequest(request, 'cancel')
    }
    this.pendingRequests.clear()
    this.pendingWireIds.clear()
    const active = this.activeTurn
    if (active !== undefined) {
      this.activeTurn = undefined
      active.setters.resolve({ status: 'cancelled', summary: 'session closed', providerMetadata: { closed: true } })
      this.emit({ type: 'turn.cancelled', turnId: active.turnId, taskId: active.taskId, memberId: this.memberId, timestamp: Date.now(), reason: 'session closed' })
    }
    this.status = 'closed'
    this.emit({ type: 'session.closed', memberId: this.memberId, timestamp: Date.now() })
    this.provider.sessions.delete(this.memberId)
    // When the last session closes, shut the shared app-server down.
    if (this.provider.sessions.size === 0) {
      const connection = this.provider.connection
      this.provider.connection = undefined
      await connection?.close(graceMs).catch(() => undefined)
      this.provider['modelsCache'] = undefined
    }
  }

  // ── transport message handling (correlated by thread + current turn) ──────

  private onTransportMessage(message: CodexInboundMessage): void {
    if (message.kind === 'notification') {
      this.onNotification(message.method, isRecord(message.params) ? message.params : {})
      return
    }
    if (message.kind === 'server_request') {
      this.onServerRequest(message.id, message.method, isRecord(message.params) ? message.params : {})
    }
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    const threadId = strOf(params.threadId)
    if (threadId !== undefined && this.threadId !== undefined && threadId !== this.threadId) {
      return // another session's thread
    }
    switch (method) {
      case 'item/agentMessage/delta': {
        const turnId = strOf(params.turnId)
        const delta = strOf(params.delta)
        if (turnId === undefined || delta === undefined || !this.belongsToActiveTurn(turnId)) return
        this.activeTurn!.output += delta
        this.emit({ type: 'turn.output.delta', turnId, memberId: this.memberId, timestamp: Date.now(), delta })
        return
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const turnId = strOf(params.turnId)
        const delta = strOf(params.delta) ?? strOf(params.summaryDelta) ?? ''
        if (turnId === undefined || !this.belongsToActiveTurn(turnId)) return
        this.emit({ type: 'turn.reasoning.delta', turnId, memberId: this.memberId, timestamp: Date.now(), delta })
        return
      }
      case 'item/started': {
        const turnId = strOf(params.turnId)
        if (turnId === undefined || !this.belongsToActiveTurn(turnId)) return
        const item = isRecord(params.item) ? params.item : undefined
        const kind = strOf(item?.type)
        const tool = kind === 'commandExecution' || kind === 'mcpToolCall' || kind === 'dynamicToolCall' || kind === 'webSearch'
          ? String(item?.command ?? item?.tool ?? kind)
          : undefined
        if (tool !== undefined) {
          this.emit({ type: 'turn.tool.started', turnId, memberId: this.memberId, timestamp: Date.now(), tool })
        }
        return
      }
      case 'item/completed': {
        const turnId = strOf(params.turnId)
        if (turnId === undefined || !this.belongsToActiveTurn(turnId)) return
        const item = isRecord(params.item) ? params.item : undefined
        const kind = strOf(item?.type)
        if (kind === 'fileChange') this.collectFileChanges(item)
        if (kind === 'commandExecution' || kind === 'mcpToolCall' || kind === 'dynamicToolCall') {
          this.emit({
            type: 'turn.tool.completed',
            turnId,
            memberId: this.memberId,
            timestamp: Date.now(),
            tool: String(item?.command ?? item?.tool ?? kind),
            status: strOf(item?.status),
          })
        }
        return
      }
      case 'turn/started': {
        const turn = isRecord(params.turn) ? params.turn : undefined
        const turnId = strOf(turn?.id)
        if (turnId !== undefined && this.activeTurn !== undefined) this.activeTurn.wireTurnId = turnId
        return
      }
      case 'turn/completed': {
        const turn = isRecord(params.turn) ? params.turn : undefined
        this.finalizeTurn(turn)
        return
      }
      // benign / noise notifications
      case 'thread/status/changed':
      case 'thread/tokenUsage/updated':
      case 'thread/closed':
      case 'warning':
      case 'configWarning':
      case 'deprecationNotice':
      case 'guardianWarning':
      case 'turn/diff/updated':
      case 'turn/plan/updated':
      case 'item/plan/delta':
        return
      default:
        return
    }
  }

  /** Subscribe transport traffic EXACTLY once per connection generation. */
  private attachTo(connection: CodexAppServerConnection): void {
    if (this.attachedConnection === connection) return
    this.attachedConnection = connection
    connection.onMessage((message) => this.onTransportMessage(message))
  }

  /**
   * Ensure a LIVE transport for this session: reconnect the shared app-server
   * after a crash and re-attach THIS thread via thread/resume, so a task that
   * arrives after `session.disconnected` keeps the SAME provider conversation.
   */
  private async ensureLiveConnection(): Promise<CodexAppServerConnection> {
    let connection = this.provider.connection
    if (connection === undefined) {
      // Transient transport state: the SAME durable thread is being re-attached.
      if (this.status === 'disconnected' || this.status === 'reconnecting') {
        this.status = 'reconnecting'
        this.emit({ type: 'session.reconnecting', memberId: this.memberId, timestamp: Date.now(), reason: 're-attaching the same Codex thread' })
      }
      connection = await this.provider.ensureConnection()
      this.attachTo(connection)
      if (this.threadId !== undefined) {
        await connection.request('thread/resume', { threadId: this.threadId }, 60_000)
        this.status = 'idle'
        this.emit({
          type: 'session.ready',
          memberId: this.memberId,
          timestamp: Date.now(),
          providerSessionId: this.sessionTreeId,
          providerThreadId: this.threadId,
          model: this.model,
        })
      }
    }
    return connection
  }

  /** Only the CURRENT turn may consume thread events (late-event safety). */
  private belongsToActiveTurn(turnId: string): boolean {
    const active = this.activeTurn
    if (active === undefined) return false
    return turnId === active.turnId || turnId === active.wireTurnId
  }

  private readonly changedFiles = new Map<string, { path: string }>()

  private collectFileChanges(item: Record<string, unknown> | undefined): void {
    const changes = item?.changes
    if (!Array.isArray(changes)) return
    for (const change of changes) {
      if (isRecord(change) && typeof strOf(change.path) === 'string') {
        this.changedFiles.set(String(change.path), { path: String(change.path) })
      }
    }
  }

  private finalizeTurn(turn: Record<string, unknown> | undefined): void {
    const active = this.activeTurn
    if (active === undefined) return
    const wireId = strOf(turn?.id)
    // A turn/completed for an OLD turn must never settle a newer turn.
    if (wireId !== undefined && active.wireTurnId !== undefined && wireId !== active.wireTurnId && wireId !== active.turnId) return
    const status = strOf(turn?.status)

    if (status === 'failed') {
      const error = isRecord(turn?.error) ? turn.error : undefined
      const reason = strOf(error?.message) ?? 'turn failed (no error details)'
      this.activeTurn = undefined
      this.status = 'idle'
      this.emit({ type: 'turn.failed', turnId: active.turnId, taskId: active.taskId, memberId: this.memberId, timestamp: Date.now(), reason })
      active.setters.resolve({ status: 'failed', summary: reason, output: active.output.length > 0 ? active.output : undefined, providerMetadata: { wireTurnId: active.wireTurnId, codexStatus: status } })
      return
    }
    if (status === 'interrupted') {
      this.activeTurn = undefined
      this.status = 'idle'
      this.emit({ type: 'turn.cancelled', turnId: active.turnId, taskId: active.taskId, memberId: this.memberId, timestamp: Date.now(), reason: 'interrupted' })
      active.setters.resolve({ status: 'cancelled', summary: active.output.trim().slice(-2000) || 'turn interrupted', output: active.output.length > 0 ? active.output : undefined })
      return
    }
    if (status !== 'completed') return // in-progress or unknown: not terminal

    // V0.6 regression fix: the per-turn changed-file collection is read HERE
    // (it was cleared before being read, so completed turns always reported an
    // empty list). It is reset at the NEXT turn start.
    const files = [...this.changedFiles.values()].map((f) => f.path)
    const summary = (this.summaryOf(turn) ?? active.output.trim().slice(-4000)) || undefined
    const result: RuntimeTurnResult = {
      status: 'completed',
      summary,
      output: active.output.length > 0 ? active.output : undefined,
      changedFiles: files.length > 0 ? files : undefined,
      risks: [],
      unresolved: [],
      providerMetadata: { wireTurnId: active.wireTurnId, codexStatus: status },
    }
    this.activeTurn = undefined
    this.status = 'idle'
    this.emit({ type: 'turn.completed', turnId: active.turnId, taskId: active.taskId, memberId: this.memberId, timestamp: Date.now(), result })
    active.setters.resolve(result)
  }

  private summaryOf(turn: Record<string, unknown> | undefined): string | undefined {
    if (turn === undefined) return undefined
    const items = turn.items
    if (!Array.isArray(items)) return undefined
    const agentMessages = (items as unknown[]).filter((item): item is Record<string, unknown> => isRecord(item) && item.type === 'agentMessage')
    const last = agentMessages[agentMessages.length - 1]
    if (last !== undefined && typeof strOf(last.text) === 'string') return String(last.text)
    return undefined
  }

  private onServerRequest(id: RequestId, method: string, params: Record<string, unknown>): void {
    const timestamp = Date.now()
    const turnId = strOf(params.turnId) ?? this.activeTurn?.turnId
    const taskId = this.activeTurn?.taskId

    if (method === 'item/tool/requestUserInput') {
      const request: RuntimePendingRequest = {
        requestId: String(id),
        requestKind: 'input',
        memberId: this.memberId,
        turnId,
        taskId,
        description: this.inputRequestDescription(params),
        params: redact(params),
        timestamp,
        allowedActions: ['answer'],
        // V0.6: user-input requests also expire — unanswered input is
        // cancelled safely so nothing parks forever.
        deadline: timestamp + this.provider.requestDeadlineMs,
        timeoutAction: 'cancel',
      }
      this.pendingRequests.set(request.requestId, request)
      this.pendingWireIds.set(request.requestId, id)
      this.status = 'waiting_input'
      this.scheduleRequestDeadline(request)
      this.emit({ type: 'turn.input.required', turnId, memberId: this.memberId, timestamp, request })
      return
    }

    const approvalMethods = new Set([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'item/tool/call',
      'mcpServer/elicitation/request',
    ])
    if (approvalMethods.has(method)) {
      const policy = approvalPolicyFor(this.config)
      const request: RuntimePendingRequest = {
        requestId: String(id),
        requestKind: 'approval',
        memberId: this.memberId,
        turnId,
        taskId,
        description: approvalDescription(method, params),
        params: redact(params),
        timestamp,
        defaultAction: policy.mode === 'decline' ? 'decline' : undefined,
        allowedActions: ['accept', 'acceptForSession', 'decline', 'cancel'],
        // V0.6: a real deadline — unanswered requests execute their safe
        // default instead of parking forever (see scheduleRequestDeadline).
        deadline: timestamp + this.provider.requestDeadlineMs,
        timeoutAction: policy.timeoutAction,
      }
      this.pendingRequests.set(request.requestId, request)
      this.pendingWireIds.set(request.requestId, id)
      this.status = 'needs_approval'
      this.scheduleRequestDeadline(request)
      this.emit({ type: 'turn.approval.required', turnId, memberId: this.memberId, timestamp, request })
    }
  }

  // ── V0.6: pending-request lifecycle (nothing hangs invisibly forever) ─────

  private readonly requestTimers = new Map<string, NodeJS.Timeout>()

  /**
   * Every pending request gets a deadline. When it passes unanswered, the
   * provider EXECUTES the safe policy action (`decline` for the default
   * policy, `cancel` for hold mode — never an approval) and emits an explicit
   * `request.timeout` event so the Host can persist and surface it.
   */
  private scheduleRequestDeadline(request: RuntimePendingRequest): void {
    if (request.deadline === undefined) return
    const remaining = Math.max(request.deadline - Date.now(), 0)
    const timer = setTimeout(() => {
      this.requestTimers.delete(request.requestId)
      if (!this.pendingRequests.has(request.requestId)) return // answered already
      const action = request.timeoutAction ?? request.defaultAction ?? 'cancel'
      const connection = this.provider.connection
      let delivered = false
      if (connection !== undefined) {
        const wireId = this.pendingWireIds.get(request.requestId) ?? request.requestId
        delivered = connection.respondToServerRequest(wireId, { decision: action })
      }
      this.clearPendingRequest(request.requestId)
      if (this.status === 'waiting_input' || this.status === 'needs_approval') this.status = 'working'
      this.emit({
        type: 'request.timeout',
        memberId: this.memberId,
        timestamp: Date.now(),
        requestId: request.requestId,
        requestKind: request.requestKind,
        turnId: request.turnId,
        taskId: request.taskId,
        action,
        delivered,
      })
    }, remaining)
    // Unref so pending approvals never keep the host process alive.
    timer.unref()
    this.requestTimers.set(request.requestId, timer)
  }

  private clearPendingRequest(requestId: string): void {
    this.pendingRequests.delete(requestId)
    this.pendingWireIds.delete(requestId)
    const timer = this.requestTimers.get(requestId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.requestTimers.delete(requestId)
    }
  }

  private clearAllPendingRequests(reason: string): void {
    void reason
    for (const requestId of [...this.pendingRequests.keys()]) {
      this.clearPendingRequest(requestId)
    }
  }

  private inputRequestDescription(params: Record<string, unknown>): string {
    const questions = params.questions
    if (Array.isArray(questions)) {
      const first = questions[0]
      if (isRecord(first)) return `Codex asks: ${strOf(first.question) ?? strOf(first.header) ?? 'please provide input'}`
    }
    return 'Codex requests user input'
  }
}

interface ActiveTurn {
  turnId: string
  wireTurnId?: string
  taskId?: string
  kind: 'task' | 'followup'
  output: string
  setters: { resolve: (result: RuntimeTurnResult) => void; reject: (error: unknown) => void }
}