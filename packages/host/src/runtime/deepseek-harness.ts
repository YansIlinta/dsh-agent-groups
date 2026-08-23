/**
 * DeepSeek Harness runtime provider (V0.4 + V0.5): the tenant of the existing
 * DSH agent factory. All DSH member creation funnels through this provider
 * (the leader tools no longer scatter spawn logic around GroupHost). The
 * provider is a thin tenant over `AgentRuntimeAdapter` — same engine,
 * role-configured model / reasoning added on top.
 *
 * V0.5: DSH members are DURABLE DSH sessions, so the session/turn contract
 * maps naturally — a member IS a session; a task assignment IS a turn. Turn
 * completion comes from the member's own completion claim
 * (`turnCompletion: 'claimed'`), and `ensureAgent` re-applies the member's
 * ORIGINAL provider/model/reasoning configuration on every resume (host
 * restart included) so a role-configured member never drifts to the global
 * default model.
 *
 * @module @dsh-agent-groups/host
 */

import { textContent } from '../group-host.js'
import { groupMessageSource } from '../message-source.js'
import type { AgentRuntimeAdapter, MemberCreateSpec } from '../dsh-adapter.js'
import { DEFAULT_REASONING_LEVELS, type AgentRuntimeProvider, type ModelDescriptor, type RuntimeAgentConfig, type RuntimeAgentHandle, type RuntimeCapabilities, type RuntimeSession, type RuntimeSessionInfo, type RuntimeSessionStatus, type RuntimeTurnHandle, type RuntimeTurnInput, type RuntimeTurnResult, type SteerOutcome } from './base.js'
import { runtimeMessageText, type RuntimeMessage } from './message.js'
import type { RuntimeEvent, RuntimePendingRequest } from './events.js'

export interface DshDefaultModelSource {
  currentSelection(): { provider?: string; model?: string }
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
  turnCompletion: 'claimed',
  interrupt: true,
  resume: true,
  dynamicModels: false,
}

export class DeepSeekHarnessRuntimeProvider implements AgentRuntimeProvider {
  readonly id = 'deepseek-harness'
  readonly name = 'DeepSeek Harness'
  readonly description = 'Native DSH agents (group-member preset): durable sessions, group tools, channel + leader reports.'

  constructor(
    private readonly adapter: AgentRuntimeAdapter,
    private readonly defaultModel: DshDefaultModelSource,
  ) {}

  isAvailable(): boolean {
    // The noop adapter only exists for tests/headless; production mounts the
    // real DSH adapter, so a healthy runtime is available.
    return this.adapter.kind === 'dsh'
  }

  getCapabilities(): RuntimeCapabilities {
    return CAPABILITIES
  }

  listModels(): readonly ModelDescriptor[] {
    const selection = this.defaultModel.currentSelection()
    if (selection.model === undefined) return []
    return [{ id: selection.model, name: `${selection.provider ?? 'default'} / ${selection.model}` }]
  }

  listReasoningLevels(): readonly import('./base.js').ReasoningOption[] {
    return DEFAULT_REASONING_LEVELS
  }

  /** V0.5: a member IS a persistent DSH session. */
  createSession(config: RuntimeAgentConfig, existing?: RuntimeSessionInfo): RuntimeSession {
    const spec: MemberCreateSpec = {
      sessionId: config.agentId,
      parentId: config.parentMemberId ?? '',
      cwd: config.workspace,
      // The member's ORIGINAL provider wins over the current global default —
      // this is the durable configuration used on every resume.
      provider: existing?.provider ?? (typeof config.metadata?.provider === 'string' ? config.metadata.provider : undefined),
      model: existing?.model ?? config.model,
      reasoningLevel: existing?.reasoningLevel ?? config.reasoningLevel,
    }
    return new DshMemberSession(this.adapter, config, spec, existing)
  }

  async spawnAgent(config: RuntimeAgentConfig): Promise<RuntimeAgentHandle> {
    const selection = this.defaultModel.currentSelection()
    await this.adapter.createMemberAgent({
      sessionId: config.agentId,
      parentId: config.parentMemberId ?? '',
      cwd: config.workspace,
      provider: typeof config.metadata?.provider === 'string' ? config.metadata.provider : selection.provider,
      model: config.model ?? selection.model,
      reasoningLevel: config.reasoningLevel,
    })
    return {
      agentId: config.agentId,
      runtime: this.id,
      status: 'running' as const,
      async waitExit() {
        // DSH agents are async peers of the Leader — no process exit to await.
        return { code: 0, output: '' }
      },
      stop: async () => { await this.adapter.disposeMember(config.agentId) },
      sendInput: async (text: string) => {
        await this.adapter.deliver(config.agentId, textContent(text), groupMessageSource(config.groupId, { label: 'role runtime input' }))
      },
      deliver: async (message) => {
        await this.adapter.deliver(config.agentId, textContent(runtimeMessageText(message)), groupMessageSource(config.groupId, { label: 'role runtime message' }))
      },
    }
  }

  async stopAgent(handle: RuntimeAgentHandle): Promise<void> {
    await handle.stop()
  }

  async deliver(handle: RuntimeAgentHandle, message: RuntimeMessage<unknown>): Promise<void> {
    if (handle.deliver !== undefined) {
      await handle.deliver(message)
    } else if (handle.sendInput !== undefined) {
      await handle.sendInput(runtimeMessageText(message))
    }
  }
}

/** One DSH member session: durable DSH agent, turns = delivered messages. */
class DshMemberSession implements RuntimeSession {
  readonly memberId: string
  readonly runtime = 'deepseek-harness'
  status: RuntimeSessionStatus = 'starting'

  private readonly listeners = new Set<(event: RuntimeEvent) => void>()
  private started = false
  private closed = false
  private readonly createdAt = Date.now()
  private updatedAt = Date.now()
  private lastTurnId: string | undefined
  private lastTaskId: string | undefined
  private readonly resumed: boolean

  constructor(
    private readonly adapter: AgentRuntimeAdapter,
    private readonly config: RuntimeAgentConfig,
    private readonly spec: MemberCreateSpec,
    existing?: RuntimeSessionInfo,
  ) {
    this.memberId = config.agentId
    this.resumed = existing?.providerSessionId !== undefined
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
      provider: this.spec.provider,
      providerSessionId: this.memberId,
      workspace: this.spec.cwd,
      model: this.spec.model,
      reasoningLevel: this.spec.reasoningLevel,
      state: this.status,
      lastTurnId: this.lastTurnId,
      lastTaskId: this.lastTaskId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    }
  }

  listPendingRequests(): readonly RuntimePendingRequest[] {
    return [] // DSH approval flows run inside the member session itself
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('session is closed')
    if (this.started) return
    this.started = true
    this.emit({ type: 'session.started', memberId: this.memberId, timestamp: Date.now(), metadata: { resumed: this.resumed } })
    // ensureAgent: live → resume (with the ORIGINAL config) → create. The
    // same durable DSH session id is always used.
    const live = await this.adapter.ensureAgent(this.memberId, this.spec)
    if (live === undefined) {
      this.status = 'failed'
      this.emit({ type: 'session.failed', memberId: this.memberId, timestamp: Date.now(), reason: 'DSH agent could not be created or resumed' })
      throw new Error('DSH agent could not be created or resumed')
    }
    this.status = 'idle'
    this.emit({
      type: 'session.ready',
      memberId: this.memberId,
      timestamp: Date.now(),
      providerSessionId: this.memberId,
      model: this.spec.model,
    })
  }

  async startTaskTurn(input: RuntimeTurnInput): Promise<RuntimeTurnHandle> {
    await this.start()
    if (this.closed) throw new Error('session is closed')
    const turnId = input.metadata?.turnId !== undefined ? String(input.metadata.turnId) : `dsh-turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.lastTurnId = turnId
    if (input.taskId !== undefined) this.lastTaskId = input.taskId
    this.status = 'working'
    this.emit({ type: 'turn.started', turnId, taskId: input.taskId, memberId: this.memberId, timestamp: Date.now() })

    const text = typeof input.text === 'string' ? input.text : String(input.text)
    await this.adapter.deliver(this.memberId, textContent(text), groupMessageSource(this.config.groupId, { label: input.turnKind ?? 'role runtime input' }))

    // DSH completion arrives as the member's own claim (turnCompletion:
    // 'claimed'); GroupHost finalizes the turn. The handle still resolves
    // when the session is closed or interrupted.
    let settle!: (result: RuntimeTurnResult) => void
    const completion = new Promise<RuntimeTurnResult>((resolve) => { settle = resolve })
    const handle: RuntimeTurnHandle = {
      turnId,
      taskId: input.taskId,
      waitForCompletion: () => completion,
      subscribe: (listener) => this.subscribe(listener),
    }
    this.turnSettles.set(turnId, settle)
    return handle
  }

  private readonly turnSettles = new Map<string, (result: RuntimeTurnResult) => void>()

  /**
   * V0.6: native DSH steering — `agent.steer()` submits next-step guidance
   * into the member's CURRENT work (wakes if idle). When the agent is not
   * live the guidance is represented as a queued next turn instead.
   */
  async steerActiveTurn(input: RuntimeTurnInput): Promise<SteerOutcome> {
    const text = typeof input.text === 'string' ? input.text : String(input.text)
    const steered = this.adapter.steer(this.memberId, textContent(text), groupMessageSource(this.config.groupId, { label: 'leader steering' }))
    if (steered) {
      const turnId = this.lastTurnId ?? ''
      this.emit({ type: 'turn.steered', turnId, taskId: this.lastTaskId, memberId: this.memberId, timestamp: Date.now() })
      return { steered: true }
    }
    // No live agent to steer — queue as the next turn on the same session.
    this.emit({
      type: 'turn.queued',
      memberId: this.memberId,
      timestamp: Date.now(),
      kind: 'followup',
      text,
      taskId: input.taskId,
      behindTurnId: this.lastTurnId,
    })
    return { queued: true }
  }

  /** V0.6: queue a NEW TASK as a future turn (delivered after the current
   * task reaches a terminal state — the member's claim, or an interrupt). */
  async queueTaskTurn(input: RuntimeTurnInput): Promise<void> {
    const text = typeof input.text === 'string' ? input.text : String(input.text)
    this.emit({
      type: 'turn.queued',
      memberId: this.memberId,
      timestamp: Date.now(),
      kind: 'task',
      text,
      taskId: input.taskId,
      behindTurnId: this.lastTurnId,
    })
  }

  /** V0.6: queue next-turn guidance on the same DSH session. */
  async queueFollowup(input: RuntimeTurnInput): Promise<void> {
    const text = typeof input.text === 'string' ? input.text : String(input.text)
    this.emit({
      type: 'turn.queued',
      memberId: this.memberId,
      timestamp: Date.now(),
      kind: 'followup',
      text,
      taskId: input.taskId,
      behindTurnId: this.lastTurnId,
    })
  }

  async interrupt(reason?: string): Promise<void> {
    this.adapter.interrupt(this.memberId, reason ?? 'interrupted by leader')
    for (const turnId of this.turnSettles.keys()) {
      this.turnSettles.get(turnId)?.({ status: 'cancelled', summary: reason ?? 'interrupted by leader' })
      this.turnSettles.delete(turnId)
    }
    this.emit({ type: 'turn.cancelled', turnId: this.lastTurnId ?? '', taskId: this.lastTaskId, memberId: this.memberId, timestamp: Date.now(), reason })
    this.status = 'idle'
  }

  async respondToRequest(): Promise<boolean> {
    return false // no provider-level pending requests for DSH sessions
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const settle of this.turnSettles.values()) settle({ status: 'cancelled', summary: 'session closed' })
    this.turnSettles.clear()
    this.status = 'closed'
    this.emit({ type: 'session.closed', memberId: this.memberId, timestamp: Date.now() })
  }
}