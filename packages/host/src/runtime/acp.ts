/**
 * Generic Agent Client Protocol runtime.
 *
 * Provider processes, ACP connections, ACP sessions and prompt turns have
 * independent lifetimes. One provider instance owns one shared ACP process;
 * every Agent Groups member owns an ACP session on that connection.
 */
import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import * as acp from '@agentclientprotocol/sdk'
import {
  DEFAULT_REASONING_LEVELS,
  type AgentRuntimeProvider,
  type ModelDescriptor,
  type ReasoningOption,
  type RuntimeAgentConfig,
  type RuntimeAgentHandle,
  type RuntimeCapabilities,
  type RuntimeReadiness,
  type RuntimeSession,
  type RuntimeSessionInfo,
  type RuntimeSessionStatus,
  type RuntimeTurnHandle,
  type RuntimeTurnInput,
  type RuntimeTurnResult,
  type SteerOutcome,
} from './base.js'
import type { RuntimeEvent, RuntimeEventListener, RuntimePendingRequest } from './events.js'
import { runtimeMessageText, type RuntimeMessage } from './message.js'
import { LocalRuntimeExecutor, type RuntimeExecutor } from './executor.js'

export interface ACPAgentDefinition {
  readonly id: string
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  /** Applied only to the child process; never copied into durable state. */
  readonly env?: Readonly<Record<string, string>>
  readonly source?: 'builtin' | 'registry' | 'custom'
  readonly description?: string
  readonly models?: readonly ModelDescriptor[]
}

export interface ACPAgentRuntimeOptions {
  readonly spawnProcess?: (definition: ACPAgentDefinition) => ChildProcessWithoutNullStreams
  readonly executor?: RuntimeExecutor
  readonly requestDeadlineMs?: number
}

export interface ACPNormalizedCapabilities {
  readonly protocolVersion: number
  readonly loadSession: boolean
  readonly resumeSession: boolean
  readonly listSessions: boolean
  readonly closeSession: boolean
  readonly deleteSession: boolean
  readonly additionalDirectories: boolean
  readonly images: boolean
  readonly audio: boolean
  readonly embeddedContext: boolean
  readonly mcpHttp: boolean
  readonly mcpSse: boolean
  readonly mcpAcp: boolean
  readonly steering: boolean
  readonly goal: boolean
  readonly configOptions: boolean
  readonly authenticationMethods: readonly {
    readonly id: string
    readonly name: string
    readonly type: 'agent' | 'terminal'
  }[]
  readonly logout: boolean
  readonly agentName?: string
  readonly agentVersion?: string
}

type InitResponse = acp.InitializeResponse
type SessionSetupResponse = acp.NewSessionResponse | acp.LoadSessionResponse | acp.ResumeSessionResponse

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function safeMetadata(value: unknown): Record<string, unknown> | undefined {
  const source = record(value)
  if (source === undefined) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    if (/token|secret|password|credential|authorization|api.?key/i.test(key)) continue
    out[key] = item
  }
  return out
}

function normalizeCapabilities(response: InitResponse): ACPNormalizedCapabilities {
  const caps = response.agentCapabilities
  const session = caps?.sessionCapabilities
  const prompt = caps?.promptCapabilities
  const mcp = caps?.mcpCapabilities
  const meta = record(response._meta)
  return {
    protocolVersion: response.protocolVersion,
    loadSession: caps?.loadSession === true,
    resumeSession: session?.resume != null,
    listSessions: session?.list != null,
    closeSession: session?.close != null,
    deleteSession: session?.delete != null,
    additionalDirectories: session?.additionalDirectories != null,
    images: prompt?.image === true,
    audio: prompt?.audio === true,
    embeddedContext: prompt?.embeddedContext === true,
    mcpHttp: mcp?.http === true,
    mcpSse: mcp?.sse === true,
    mcpAcp: mcp?.acp === true,
    steering: record(meta?.steering)?.supported === true,
    goal: meta?.goal !== undefined,
    configOptions: true,
    authenticationMethods: (response.authMethods ?? []).map((method) => ({
      id: method.id,
      name: method.name,
      type: 'type' in method && method.type === 'terminal' ? 'terminal' : 'agent',
    })),
    logout: caps?.auth?.logout != null,
    agentName: response.agentInfo?.name,
    agentVersion: response.agentInfo?.version,
  }
}

class ACPConnectionManager {
  private child: ChildProcessWithoutNullStreams | undefined
  private connection: acp.ClientSideConnection | undefined
  private starting: Promise<acp.ClientSideConnection> | undefined
  private init: InitResponse | undefined
  private stderrTail = ''
  private readonly sessions = new Map<string, ACPRuntimeSession>()

  constructor(
    readonly definition: ACPAgentDefinition,
    private readonly options: ACPAgentRuntimeOptions,
  ) {}

  get capabilities(): ACPNormalizedCapabilities | undefined {
    return this.init === undefined ? undefined : normalizeCapabilities(this.init)
  }

  async ensure(): Promise<acp.ClientSideConnection> {
    if (this.connection !== undefined) return this.connection
    if (this.starting !== undefined) return this.starting
    this.starting = this.connect()
    try {
      return await this.starting
    } finally {
      this.starting = undefined
    }
  }

  private async connect(): Promise<acp.ClientSideConnection> {
    const child = this.options.spawnProcess?.(this.definition)
      ?? (this.options.executor ?? new LocalRuntimeExecutor()).spawn(this.definition)
    this.child = child
    this.stderrTail = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000)
    })
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    )
    const connection = new acp.ClientSideConnection(() => ({
      requestPermission: (params) => this.routePermission(params),
      sessionUpdate: (params) => this.routeUpdate(params),
      createElicitation: (params) => this.routeElicitation(params),
    }), stream)
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = undefined
      this.connection = undefined
      this.init = undefined
      const suffix = this.stderrTail.trim().slice(-500)
      const reason = `${this.definition.name} ACP process exited (${signal ?? code ?? 'unknown'})${suffix === '' ? '' : `: ${suffix}`}`
      for (const session of new Set(this.sessions.values())) session.transportLost(reason)
      this.sessions.clear()
    })
    try {
      this.init = await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: 'dsh-agent-groups', title: 'DSH Agent Groups', version: '0.1.0' },
        clientCapabilities: {
          session: { configOptions: { boolean: {} } },
          elicitation: { form: {} },
        },
      })
    } catch (error) {
      child.kill()
      throw new Error(`ACP initialize failed for ${this.definition.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.connection = connection
    return connection
  }

  register(sessionId: string, session: ACPRuntimeSession): void {
    this.sessions.set(sessionId, session)
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  private routeUpdate(params: acp.SessionNotification): void {
    this.sessions.get(params.sessionId)?.receiveUpdate(params)
  }

  private routePermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const session = this.sessions.get(params.sessionId)
    if (session === undefined) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    return session.requestPermission(params)
  }

  private routeElicitation(params: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse> {
    const sessionId = 'sessionId' in params && typeof params.sessionId === 'string' ? params.sessionId : undefined
    const session = sessionId === undefined ? undefined : this.sessions.get(sessionId)
    if (session === undefined) return Promise.resolve({ action: 'cancel' })
    return session.requestInput(params)
  }

  async dispose(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.connection = undefined
    this.init = undefined
    this.sessions.clear()
    if (child !== undefined && child.exitCode === null) child.kill()
  }
}

interface ActiveTurn {
  readonly turnId: string
  readonly taskId?: string
  readonly input: RuntimeTurnInput
  readonly listeners: Set<RuntimeEventListener>
  readonly completion: Promise<RuntimeTurnResult>
  readonly resolve: (result: RuntimeTurnResult) => void
  output: string
  settled: boolean
}

interface PendingResolution {
  readonly request: RuntimePendingRequest
  readonly timer: NodeJS.Timeout
  resolve(action: string, payload?: unknown): void
}

export class ACPRuntimeSession implements RuntimeSession {
  readonly runtime: string
  private state: RuntimeSessionStatus = 'starting'
  private sessionId: string | undefined
  private active: ActiveTurn | undefined
  private readonly listeners = new Set<RuntimeEventListener>()
  private readonly pending = new Map<string, PendingResolution>()
  private negotiated: ACPNormalizedCapabilities | undefined
  private setupResponse: SessionSetupResponse | undefined
  private createdAt = Date.now()
  private updatedAt = Date.now()
  private lastTurnId: string | undefined
  private lastTaskId: string | undefined

  constructor(
    readonly memberId: string,
    private readonly config: RuntimeAgentConfig,
    private readonly manager: ACPConnectionManager,
    private readonly existing?: RuntimeSessionInfo,
    private readonly requestDeadlineMs = 300_000,
  ) {
    this.runtime = manager.definition.id
    this.sessionId = existing?.providerSessionId
    this.createdAt = existing?.createdAt ?? this.createdAt
  }

  get providerSessionId(): string | undefined { return this.sessionId }
  get providerThreadId(): string | undefined { return undefined }
  get status(): RuntimeSessionStatus { return this.state }

  async start(): Promise<void> {
    if (this.state === 'idle' || this.state === 'working' || this.state === 'waiting_input' || this.state === 'needs_approval') return
    this.state = this.existing === undefined ? 'starting' : 'reconnecting'
    this.emit({ type: this.existing === undefined ? 'session.started' : 'session.reconnecting', memberId: this.memberId, timestamp: Date.now() })
    try {
      const connection = await this.manager.ensure()
      this.negotiated = this.manager.capabilities
      const cwd = this.config.workspace ?? process.cwd()
      const mcpServers: acp.McpServer[] = []
      if (this.sessionId !== undefined) {
        if (this.negotiated?.resumeSession === true) {
          this.setupResponse = await connection.resumeSession({ sessionId: this.sessionId, cwd, mcpServers })
        } else if (this.negotiated?.loadSession === true) {
          this.setupResponse = await connection.loadSession({ sessionId: this.sessionId, cwd, mcpServers })
        } else {
          throw new Error(`${this.manager.definition.name} does not advertise session resume/load; refusing a contextless replacement session`)
        }
      } else {
        const created = await connection.newSession({ cwd, mcpServers })
        this.setupResponse = created
        this.sessionId = created.sessionId
      }
      this.manager.register(this.sessionId, this)
      await this.applyConfiguredOptions(connection)
      this.state = 'idle'
      this.updatedAt = Date.now()
      this.emit({
        type: 'session.ready',
        memberId: this.memberId,
        timestamp: this.updatedAt,
        providerSessionId: this.sessionId,
        model: this.config.model,
      })
    } catch (error) {
      this.state = 'failed'
      this.emit({ type: 'session.failed', memberId: this.memberId, timestamp: Date.now(), reason: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  private async applyConfiguredOptions(connection: acp.ClientSideConnection): Promise<void> {
    if (this.sessionId === undefined || this.setupResponse?.configOptions == null) return
    for (const option of this.setupResponse.configOptions) {
      const desired = option.category === 'model'
        ? this.config.model
        : option.category === 'thought_level'
          ? this.config.reasoningLevel
          : undefined
      if (desired === undefined || option.type !== 'select' || desired === option.currentValue) continue
      const values = option.options.flatMap((entry) => 'options' in entry ? entry.options : [entry])
      if (!values.some((entry) => entry.value === desired)) continue
      await connection.setSessionConfigOption({ sessionId: this.sessionId, configId: option.id, value: desired })
    }
  }

  async startTaskTurn(input: RuntimeTurnInput): Promise<RuntimeTurnHandle> {
    if (this.state !== 'idle' || this.active !== undefined) throw new Error(`ACP session ${this.memberId} is busy (${this.state})`)
    const connection = await this.manager.ensure()
    if (this.sessionId === undefined) throw new Error(`ACP session ${this.memberId} has not started`)
    let resolve!: (result: RuntimeTurnResult) => void
    const completion = new Promise<RuntimeTurnResult>((done) => { resolve = done })
    const turn: ActiveTurn = {
      turnId: randomUUID(),
      taskId: input.taskId,
      input,
      listeners: new Set(),
      completion,
      resolve,
      output: '',
      settled: false,
    }
    this.active = turn
    this.state = 'working'
    this.lastTurnId = turn.turnId
    this.lastTaskId = turn.taskId
    this.updatedAt = Date.now()
    this.emit({ type: 'turn.started', turnId: turn.turnId, taskId: turn.taskId, memberId: this.memberId, timestamp: this.updatedAt })
    void connection.prompt({ sessionId: this.sessionId, prompt: [{ type: 'text', text: input.text }] })
      .then((response) => {
        if (response.stopReason === 'end_turn') {
          this.finish(turn, { status: 'completed', summary: turn.output.trim().slice(-2000) || 'ACP turn completed', output: turn.output || undefined, providerMetadata: { stopReason: response.stopReason, usage: response.usage } })
        } else if (response.stopReason === 'cancelled') {
          this.finish(turn, { status: 'cancelled', summary: 'ACP turn cancelled', output: turn.output || undefined, providerMetadata: { stopReason: response.stopReason } })
        } else {
          this.finish(turn, { status: 'failed', summary: `ACP turn stopped: ${response.stopReason}`, output: turn.output || undefined, providerMetadata: { stopReason: response.stopReason } })
        }
      })
      .catch((error) => this.fail(turn, error instanceof Error ? error.message : String(error)))
    return {
      turnId: turn.turnId,
      taskId: turn.taskId,
      waitForCompletion: () => completion,
      subscribe: (listener) => {
        turn.listeners.add(listener)
        return () => turn.listeners.delete(listener)
      },
    }
  }

  async steerActiveTurn(input: RuntimeTurnInput): Promise<SteerOutcome> {
    const active = this.active
    if (active === undefined || this.sessionId === undefined) throw new Error('ACP steering requires an active turn')
    if (this.negotiated?.steering !== true) {
      this.emit({ type: 'turn.queued', memberId: this.memberId, timestamp: Date.now(), kind: 'followup', text: input.text, taskId: input.taskId, behindTurnId: active.turnId })
      return { queued: true }
    }
    const connection = await this.manager.ensure()
    const result = await connection.request<{ outcome?: string }, { sessionId: string; prompt: acp.ContentBlock[] }>(
      '_session/steering',
      { sessionId: this.sessionId, prompt: [{ type: 'text', text: input.text }] },
    )
    if (result.outcome === 'injected' || result.outcome === 'startedNewTurn') {
      this.emit({ type: 'turn.steered', turnId: active.turnId, taskId: active.taskId, memberId: this.memberId, timestamp: Date.now() })
      return { steered: true }
    }
    throw new Error(`ACP steering failed (${result.outcome ?? 'unknown outcome'})`)
  }

  async queueTaskTurn(input: RuntimeTurnInput): Promise<void> {
    this.emit({ type: 'turn.queued', memberId: this.memberId, timestamp: Date.now(), kind: 'task', text: input.text, taskId: input.taskId, behindTurnId: this.active?.turnId })
  }

  async queueFollowup(input: RuntimeTurnInput): Promise<void> {
    this.emit({ type: 'turn.queued', memberId: this.memberId, timestamp: Date.now(), kind: 'followup', text: input.text, taskId: input.taskId, behindTurnId: this.active?.turnId })
  }

  async interrupt(reason?: string): Promise<void> {
    if (this.active === undefined || this.sessionId === undefined) return
    const connection = await this.manager.ensure()
    await connection.cancel({ sessionId: this.sessionId })
    if (reason !== undefined) this.updatedAt = Date.now()
  }

  async respondToRequest(requestId: string, action: string, payload?: unknown): Promise<boolean> {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return false
    this.pending.delete(requestId)
    clearTimeout(pending.timer)
    pending.resolve(action, payload)
    this.state = this.active === undefined ? 'idle' : 'working'
    return true
  }

  async close(): Promise<void> {
    if (this.active !== undefined) await this.interrupt('session close')
    if (this.sessionId !== undefined) {
      const connection = await this.manager.ensure()
      if (this.negotiated?.closeSession === true) await connection.closeSession({ sessionId: this.sessionId })
      this.manager.unregister(this.sessionId)
    }
    this.state = 'closed'
    this.emit({ type: 'session.closed', memberId: this.memberId, timestamp: Date.now() })
  }

  info(): RuntimeSessionInfo {
    return {
      runtime: this.runtime,
      provider: 'acp',
      providerSessionId: this.sessionId,
      workspace: this.config.workspace,
      model: this.config.model,
      reasoningLevel: this.config.reasoningLevel,
      providerCapabilities: this.negotiated === undefined ? undefined : { ...this.negotiated },
      state: this.state,
      lastTurnId: this.lastTurnId,
      lastTaskId: this.lastTaskId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    }
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  listPendingRequests(): readonly RuntimePendingRequest[] {
    return [...this.pending.values()].map((entry) => entry.request)
  }

  receiveUpdate(params: acp.SessionNotification): void {
    const active = this.active
    if (active === undefined || params.sessionId !== this.sessionId) return
    const update = params.update
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      active.output += update.content.text
      this.emit({ type: 'turn.output.delta', turnId: active.turnId, memberId: this.memberId, timestamp: Date.now(), delta: update.content.text })
    } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
      this.emit({ type: 'turn.reasoning.delta', turnId: active.turnId, memberId: this.memberId, timestamp: Date.now(), delta: update.content.text })
    } else if (update.sessionUpdate === 'tool_call') {
      this.emit({ type: 'turn.tool.started', turnId: active.turnId, memberId: this.memberId, timestamp: Date.now(), tool: update.toolCallId, title: update.title })
    } else if (update.sessionUpdate === 'tool_call_update' && update.status !== undefined) {
      this.emit({ type: 'turn.tool.completed', turnId: active.turnId, memberId: this.memberId, timestamp: Date.now(), tool: update.toolCallId, status: update.status ?? undefined })
    }
  }

  requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const requestId = randomUUID()
    const active = this.active
    const options = params.options.map((option) => option.optionId)
    const request: RuntimePendingRequest = {
      requestId,
      requestKind: 'permission',
      memberId: this.memberId,
      turnId: active?.turnId,
      taskId: active?.taskId,
      description: params.toolCall.title ?? 'ACP tool permission',
      params: safeMetadata({ toolCallId: params.toolCall.toolCallId, kind: params.toolCall.kind, options: params.options }),
      timestamp: Date.now(),
      allowedActions: [...options, 'cancel'],
      defaultAction: 'cancel',
      deadline: Date.now() + this.requestDeadlineMs,
      timeoutAction: 'cancel',
    }
    this.state = 'needs_approval'
    this.emit({ type: 'turn.approval.required', turnId: active?.turnId, memberId: this.memberId, timestamp: request.timestamp, request })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve({ outcome: { outcome: 'cancelled' } })
        this.emit({ type: 'request.timeout', memberId: this.memberId, timestamp: Date.now(), requestId, requestKind: 'permission', turnId: active?.turnId, taskId: active?.taskId, action: 'cancel', delivered: true })
      }, this.requestDeadlineMs)
      timer.unref?.()
      this.pending.set(requestId, {
        request,
        timer,
        resolve: (action) => resolve(options.includes(action) ? { outcome: { outcome: 'selected', optionId: action } } : { outcome: { outcome: 'cancelled' } }),
      })
    })
  }

  requestInput(params: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse> {
    const requestId = randomUUID()
    const active = this.active
    const request: RuntimePendingRequest = {
      requestId,
      requestKind: 'input',
      memberId: this.memberId,
      turnId: active?.turnId,
      taskId: active?.taskId,
      description: typeof params.message === 'string' ? params.message : 'Agent requires user input',
      params: safeMetadata(params),
      timestamp: Date.now(),
      allowedActions: ['accept', 'decline', 'cancel'],
      defaultAction: 'cancel',
      deadline: Date.now() + this.requestDeadlineMs,
      timeoutAction: 'cancel',
    }
    this.state = 'waiting_input'
    this.emit({ type: 'turn.input.required', turnId: active?.turnId, memberId: this.memberId, timestamp: request.timestamp, request })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve({ action: 'cancel' })
        this.emit({ type: 'request.timeout', memberId: this.memberId, timestamp: Date.now(), requestId, requestKind: 'input', turnId: active?.turnId, taskId: active?.taskId, action: 'cancel', delivered: true })
      }, this.requestDeadlineMs)
      timer.unref?.()
      this.pending.set(requestId, {
        request,
        timer,
        resolve: (action, payload) => {
          if (action === 'accept') resolve({ action: 'accept', content: record(payload) as Record<string, acp.ElicitationContentValue> | undefined })
          else resolve({ action: action === 'decline' ? 'decline' : 'cancel' })
        },
      })
    })
  }

  transportLost(reason: string): void {
    const active = this.active
    this.state = 'disconnected'
    this.emit({ type: 'session.disconnected', memberId: this.memberId, timestamp: Date.now(), reason, turnId: active?.turnId })
    if (active !== undefined) this.fail(active, reason)
  }

  private finish(turn: ActiveTurn, result: RuntimeTurnResult): void {
    if (turn.settled || this.active !== turn) return
    turn.settled = true
    this.active = undefined
    this.state = result.status === 'cancelled' ? 'interrupted' : result.status === 'failed' ? 'failed' : 'idle'
    this.updatedAt = Date.now()
    const event: RuntimeEvent = result.status === 'completed'
      ? { type: 'turn.completed', turnId: turn.turnId, taskId: turn.taskId, memberId: this.memberId, timestamp: this.updatedAt, result }
      : result.status === 'cancelled'
        ? { type: 'turn.cancelled', turnId: turn.turnId, taskId: turn.taskId, memberId: this.memberId, timestamp: this.updatedAt, reason: result.summary }
        : { type: 'turn.failed', turnId: turn.turnId, taskId: turn.taskId, memberId: this.memberId, timestamp: this.updatedAt, reason: result.summary }
    this.emit(event)
    for (const listener of turn.listeners) listener(event)
    turn.resolve(result)
  }

  private fail(turn: ActiveTurn, reason: string): void {
    this.finish(turn, { status: 'failed', summary: reason, output: turn.output || undefined })
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event)
    for (const listener of this.active?.listeners ?? []) listener(event)
  }
}

export class ACPAgentRuntimeProvider implements AgentRuntimeProvider {
  readonly id: string
  readonly name: string
  readonly description: string
  private readonly manager: ACPConnectionManager
  private readonly executor: RuntimeExecutor

  constructor(readonly definition: ACPAgentDefinition, private readonly options: ACPAgentRuntimeOptions = {}) {
    this.id = definition.id
    this.name = definition.name
    this.description = definition.description ?? `${definition.name} through the Agent Client Protocol.`
    this.executor = options.executor ?? new LocalRuntimeExecutor()
    this.manager = new ACPConnectionManager(definition, options)
  }

  isAvailable(): boolean | Promise<boolean> { return this.executor.isAvailable(this.definition) }

  async getReadiness(): Promise<RuntimeReadiness> {
    return {
      launchable: await this.isAvailable(),
      initialized: this.manager.capabilities !== undefined,
      executor: this.executor.id,
    }
  }

  async validate(): Promise<RuntimeReadiness> {
    if (!await this.isAvailable()) return { launchable: false, initialized: false, executor: this.executor.id, error: `${this.definition.command} is not installed` }
    try {
      await this.manager.ensure()
      return { launchable: true, initialized: true, executor: this.executor.id }
    } catch (error) {
      return { launchable: true, initialized: false, executor: this.executor.id, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    const negotiated = this.manager.capabilities
    return {
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
      resume: negotiated?.resumeSession === true || negotiated?.loadSession === true,
      dynamicModels: true,
    }
  }

  listModels(): readonly ModelDescriptor[] { return this.definition.models ?? [] }
  listReasoningLevels(): readonly ReasoningOption[] { return DEFAULT_REASONING_LEVELS }

  createSession(config: RuntimeAgentConfig, existing?: RuntimeSessionInfo): ACPRuntimeSession {
    return new ACPRuntimeSession(config.agentId, config, this.manager, existing, this.options.requestDeadlineMs)
  }

  async spawnAgent(config: RuntimeAgentConfig): Promise<RuntimeAgentHandle> {
    const session = this.createSession(config)
    await session.start()
    let last: Promise<RuntimeTurnResult> | undefined
    return {
      agentId: config.agentId,
      runtime: this.id,
      status: 'running',
      waitExit: async () => {
        const result = await last
        return { code: result === undefined || result.status === 'completed' ? 0 : 1, output: result?.output ?? result?.summary ?? '' }
      },
      stop: () => session.close(),
      sendInput: async (text) => { last = (await session.startTaskTurn({ text })).waitForCompletion() },
      deliver: async (message) => { last = (await session.startTaskTurn({ text: runtimeMessageText(message), turnKind: 'followup' })).waitForCompletion() },
    }
  }

  async stopAgent(handle: RuntimeAgentHandle): Promise<void> { await handle.stop() }
  async sendInput(_agentId: string, _text: string): Promise<void> { throw new Error('use the ACP session handle to send input') }
  async deliver(handle: RuntimeAgentHandle, message: RuntimeMessage<unknown>): Promise<void> { await handle.deliver?.(message) }
  async dispose(): Promise<void> { await this.manager.dispose() }
}

export const BUILTIN_ACP_AGENTS: readonly ACPAgentDefinition[] = [
  {
    id: 'codex',
    name: 'Codex (ACP)',
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp'],
    source: 'builtin',
    description: 'OpenAI Codex through the official ACP adapter.',
  },
  {
    id: 'claude',
    name: 'Claude (ACP)',
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
    source: 'builtin',
    description: 'Claude Agent SDK through the official ACP adapter.',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI (ACP)',
    command: 'gemini',
    args: ['--acp'],
    source: 'builtin',
    description: 'Gemini CLI native ACP mode.',
  },
]

/**
 * Load optional custom ACP commands from host configuration. Environment
 * values are consumed only at process launch and are never returned from this
 * function's public/runtime views or copied into durable member records.
 */
export function loadCustomACPAgentDefinitions(json = process.env.AGENT_GROUPS_ACP_AGENTS_JSON): ACPAgentDefinition[] {
  if (json === undefined || json.trim() === '') return []
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed)) throw new Error('AGENT_GROUPS_ACP_AGENTS_JSON must be a JSON array')
  const definitions: ACPAgentDefinition[] = []
  for (const value of parsed) {
    const item = record(value)
    if (item === undefined || typeof item.id !== 'string' || item.id.trim() === '' || typeof item.name !== 'string' || typeof item.command !== 'string') {
      throw new Error('every custom ACP agent requires non-empty id, name, and command strings')
    }
    if (!Array.isArray(item.args) || !item.args.every((arg) => typeof arg === 'string')) {
      throw new Error(`custom ACP agent ${item.id} requires a string[] args field`)
    }
    const env = item.env === undefined ? undefined : record(item.env)
    if (env !== undefined && !Object.values(env).every((entry) => typeof entry === 'string')) {
      throw new Error(`custom ACP agent ${item.id} env values must all be strings`)
    }
    definitions.push({
      id: item.id,
      name: item.name,
      command: item.command,
      args: item.args,
      env: env as Record<string, string> | undefined,
      source: 'custom',
      description: typeof item.description === 'string' ? item.description : undefined,
    })
  }
  return definitions
}
