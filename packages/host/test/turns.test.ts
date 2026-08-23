/**
 * V0.5 GroupHost integration tests: persistent sessions, turn-based task
 * completion, follow-ups, interrupts, crashes, late-event safety, removals,
 * host-restart resume and loud resume failures (requirements §4, §11, §12,
 * §13, §18, §21, §24).
 *
 * Uses an in-memory SESSION provider (one persistent thread per member) so
 * everything is deterministic — process lifetime, session lifetime, turn
 * lifetime and task lifetime are exercised as SEPARATE concepts.
 */
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { GroupHost } from '../src/group-host.js'
import { GroupError } from '../src/group-service.js'
import { makeStores, makeHarness, type Stores } from './helpers.js'
import { createNoopAdapter } from '../src/dsh-adapter.js'
import { RuntimeRegistry } from '../src/runtime/registry.js'
import {
  DEFAULT_REASONING_LEVELS,
  isSessionProvider,
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
} from '../src/runtime/base.js'
import type { RuntimeEvent, RuntimePendingRequest } from '../src/runtime/events.js'
import { runtimeMessageText, type RuntimeMessage } from '../src/runtime/message.js'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ── deterministic in-memory session provider ────────────────────────────────

class FakeThreadSession implements RuntimeSession {
  readonly memberId: string
  readonly runtime = 'fake-thread'
  status: RuntimeSessionStatus = 'starting'
  private readonly listeners = new Set<(event: RuntimeEvent) => void>()
  private active: { turnId: string; taskId?: string; settle: (result: RuntimeTurnResult) => void; text: string } | undefined
  private readonly pendingRequests = new Map<string, RuntimePendingRequest>()
  private started = false
  private closed = false
  readonly providerSessionId: string | undefined
  readonly providerThreadId: string | undefined

  constructor(
    private readonly config: RuntimeAgentConfig,
    readonly provider: FakeThreadProvider,
    existing?: RuntimeSessionInfo,
  ) {
    this.memberId = config.agentId
    if (existing !== undefined) {
      this.providerThreadId = existing.providerThreadId
      this.providerSessionId = existing.providerSessionId
      this.status = 'disconnected'
      this.provider.resumedThreads.push({ memberId: config.agentId, threadId: existing.providerThreadId })
    } else {
      this.providerThreadId = `thr-${config.agentId}`
      this.providerSessionId = `ses-${config.agentId}`
    }
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  info(): RuntimeSessionInfo {
    return {
      runtime: this.runtime,
      providerSessionId: this.providerSessionId,
      providerThreadId: this.providerThreadId,
      model: this.config.model,
      reasoningLevel: this.config.reasoningLevel,
      state: this.status,
      createdAt: 0,
      updatedAt: 0,
    }
  }

  listPendingRequests(): readonly RuntimePendingRequest[] {
    return [...this.pendingRequests.values()]
  }

  async start(): Promise<void> {
    if (this.closed) return
    if (!this.started) {
      this.started = true
      this.emit({ type: 'session.started', memberId: this.memberId, timestamp: Date.now() })
    }
    this.status = 'idle'
    this.emit({ type: 'session.ready', memberId: this.memberId, timestamp: Date.now(), providerSessionId: this.providerSessionId, providerThreadId: this.providerThreadId })
  }

  async startTaskTurn(input: RuntimeTurnInput): Promise<RuntimeTurnHandle> {
    await this.start()
    if (this.active !== undefined) throw new Error('busy')
    const turnId = `turn-${++this.provider.turnCounter}`
    let settle!: (result: RuntimeTurnResult) => void
    const completion = new Promise<RuntimeTurnResult>((resolve) => { settle = resolve })
    this.active = { turnId, taskId: input.taskId, settle, text: input.text }
    this.status = 'working'
    this.provider.startedTurns.push({ memberId: this.memberId, turnId, taskId: input.taskId, threadId: this.providerThreadId, text: input.text })
    this.emit({ type: 'turn.started', turnId, taskId: input.taskId, memberId: this.memberId, timestamp: Date.now() })
    return {
      turnId,
      taskId: input.taskId,
      waitForCompletion: () => completion,
      subscribe: (listener) => this.subscribe(listener),
    }
  }

  /**
   * V0.6: steering semantics on the fake — records the steer, or (with
   * `provider.steerThrows`) fails with a typed error after emitting
   * `turn.queued`; or (with `provider.queueSteers`) reports `{queued}` like a
   * provider that cannot steer a live query.
   */
  async steerActiveTurn(input: RuntimeTurnInput): Promise<{ steered: true } | { queued: true }> {
    const active = this.active
    if (this.provider.steerThrows && active !== undefined) {
      this.provider.steers.push({ memberId: this.memberId, turnId: active.turnId, text: input.text })
      this.emit({
        type: 'turn.queued',
        memberId: this.memberId,
        timestamp: Date.now(),
        kind: 'followup',
        text: input.text,
        taskId: input.taskId,
        behindTurnId: active.turnId,
      })
      throw new Error('TURN_STEER_FAILED: fake steer rejected')
    }
    if (active !== undefined) {
      if (this.provider.queueSteers) {
        this.emit({
          type: 'turn.queued',
          memberId: this.memberId,
          timestamp: Date.now(),
          kind: 'followup',
          text: input.text,
          taskId: input.taskId,
          behindTurnId: active.turnId,
        })
        return { queued: true }
      }
      this.provider.steers.push({ memberId: this.memberId, turnId: active.turnId, text: input.text })
      this.emit({ type: 'turn.steered', turnId: active.turnId, taskId: active.taskId, memberId: this.memberId, timestamp: Date.now() })
      return { steered: true }
    }
    await this.startTaskTurn({ ...input, turnKind: 'followup' })
    return { steered: true }
  }

  /** V0.6: queue a NEW TASK as a future turn (host-driven drain). */
  async queueTaskTurn(input: RuntimeTurnInput): Promise<void> {
    this.emit({
      type: 'turn.queued',
      memberId: this.memberId,
      timestamp: Date.now(),
      kind: 'task',
      text: input.text,
      taskId: input.taskId,
      behindTurnId: this.active?.turnId,
    })
  }

  /** V0.6: queue next-turn guidance on the same session. */
  async queueFollowup(input: RuntimeTurnInput): Promise<void> {
    this.emit({
      type: 'turn.queued',
      memberId: this.memberId,
      timestamp: Date.now(),
      kind: 'followup',
      text: input.text,
      taskId: input.taskId,
      behindTurnId: this.active?.turnId,
    })
  }

  async interrupt(reason?: string): Promise<void> {
    const active = this.active
    if (active === undefined) throw new Error('nothing to interrupt')
    this.active = undefined
    this.status = 'idle'
    this.emit({ type: 'turn.cancelled', turnId: active.turnId, taskId: active.taskId, memberId: this.memberId, timestamp: Date.now(), reason })
    active.settle({ status: 'cancelled', summary: reason ?? 'interrupted' })
  }

  async respondToRequest(requestId: string, action: string, payload?: unknown): Promise<boolean> {
    const request = this.pendingRequests.get(requestId)
    if (request === undefined) return false
    this.provider.answers.push({ memberId: this.memberId, requestId, action, payload })
    this.pendingRequests.delete(requestId)
    this.status = 'working'
    return true
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const active = this.active
    if (active !== undefined) {
      this.active = undefined
      active.settle({ status: 'cancelled', summary: 'session closed' })
      this.emit({ type: 'turn.cancelled', turnId: active.turnId, taskId: active.taskId, memberId: this.memberId, timestamp: Date.now(), reason: 'session closed' })
    }
    this.status = 'closed'
    this.emit({ type: 'session.closed', memberId: this.memberId, timestamp: Date.now() })
  }

  // test hooks
  crash(): void {
    const active = this.active
    this.active = undefined
    this.status = 'disconnected'
    if (active !== undefined) {
      this.emit({ type: 'turn.failed', turnId: active.turnId, taskId: active.taskId, memberId: this.memberId, timestamp: Date.now(), reason: 'app server exited' })
      active.settle({ status: 'failed', summary: 'app server exited' })
    }
    this.emit({ type: 'session.disconnected', memberId: this.memberId, timestamp: Date.now(), reason: 'app server exited' })
  }

  completeActiveTurn(summary: string): void {
    const active = this.active
    if (active === undefined) throw new Error('no active turn')
    this.active = undefined
    this.status = 'idle'
    const result: RuntimeTurnResult = { status: 'completed', summary, output: summary, changedFiles: ['src/auth.ts'] }
    this.emit({ type: 'turn.completed', turnId: active.turnId, taskId: active.taskId, memberId: this.memberId, timestamp: Date.now(), result })
    active.settle(result)
  }

  failActiveTurn(reason: string): void {
    const active = this.active
    if (active === undefined) throw new Error('no active turn')
    this.active = undefined
    this.status = 'idle'
    this.emit({ type: 'turn.failed', turnId: active.turnId, taskId: active.taskId, memberId: this.memberId, timestamp: Date.now(), reason })
    active.settle({ status: 'failed', summary: reason })
  }

  /** Emit a STALE completion for an OLD turn id (late-event simulation). */
  emitLateCompletion(turnId: string, taskId: string | undefined, summary: string): void {
    this.emit({ type: 'turn.completed', turnId, taskId, memberId: this.memberId, timestamp: Date.now(), result: { status: 'completed', summary } })
  }

  requestApproval(requestId: string, description: string, options: { deadline?: number } = {}): void {
    const request: RuntimePendingRequest = {
      requestId, requestKind: 'approval', memberId: this.memberId,
      turnId: this.active?.turnId, taskId: this.active?.taskId,
      description, params: {}, timestamp: Date.now(), defaultAction: 'decline', allowedActions: ['accept', 'decline'],
      deadline: options.deadline, timeoutAction: 'decline',
    }
    this.pendingRequests.set(requestId, request)
    this.emit({ type: 'turn.approval.required', turnId: request.turnId, memberId: this.memberId, timestamp: Date.now(), request })
  }

  requestInput(requestId: string, description: string): void {
    const request: RuntimePendingRequest = {
      requestId, requestKind: 'input', memberId: this.memberId,
      turnId: this.active?.turnId, taskId: this.active?.taskId,
      description, params: {}, timestamp: Date.now(), allowedActions: ['answer'],
    }
    this.pendingRequests.set(requestId, request)
    this.status = 'waiting_input'
    this.emit({ type: 'turn.input.required', turnId: request.turnId, memberId: this.memberId, timestamp: Date.now(), request })
  }

  /** V0.6: emit a request timeout (as the provider does after its deadline). */
  emitRequestTimeout(requestId: string, action: string, delivered = true): void {
    const request = this.pendingRequests.get(requestId)
    this.pendingRequests.delete(requestId)
    this.status = 'working'
    this.emit({
      type: 'request.timeout',
      memberId: this.memberId,
      timestamp: Date.now(),
      requestId,
      requestKind: request?.requestKind ?? 'approval',
      turnId: request?.turnId,
      taskId: request?.taskId,
      action,
      delivered,
    })
  }

  /** V0.6: a provider-initiated turn (the Host did not start it). */
  startUnmanagedTurn(taskId: string | undefined, text: string): void {
    if (this.active !== undefined) throw new Error('busy')
    const turnId = `turn-${++this.provider.turnCounter}`
    let settle!: (result: RuntimeTurnResult) => void
    const completion = new Promise<RuntimeTurnResult>((resolve) => { settle = resolve })
    this.active = { turnId, taskId, settle, text }
    this.status = 'working'
    this.provider.startedTurns.push({ memberId: this.memberId, turnId, taskId, threadId: this.providerThreadId, text })
    this.emit({ type: 'turn.started', turnId, taskId, memberId: this.memberId, timestamp: Date.now() })
    void completion
  }
}

class FakeThreadProvider implements AgentRuntimeProvider {
  readonly id = 'fake-thread'
  readonly name = 'Fake Thread Runtime'
  readonly sessions = new Map<string, FakeThreadSession>()
  readonly startedTurns: Array<{ memberId: string; turnId: string; taskId?: string; threadId?: string; text: string }> = []
  /** V0.6: accepted steers into the ACTIVE turn. */
  readonly steers: Array<{ memberId: string; turnId: string; text: string }> = []
  readonly answers: Array<{ memberId: string; requestId: string; action: string; payload?: unknown }> = []
  readonly resumedThreads: Array<{ memberId: string; threadId?: string }> = []
  turnCounter = 0
  resumeThrows = false
  /** V0.6: steerActiveTurn throws after recording a queued follow-up. */
  steerThrows = false
  /** V0.6: steerActiveTurn reports {queued} (provider cannot steer live). */
  queueSteers = false
  available = true

  isAvailable(): boolean { return this.available }
  getCapabilities(): RuntimeCapabilities {
    return { models: true, reasoningLevels: true, interactiveSession: true, workspace: true, toolControl: false, streaming: true, sessionEvents: true, persistentSessions: true, turnCompletion: 'provider', interrupt: true, resume: true }
  }
  listModels(): readonly ModelDescriptor[] { return [{ id: 'model-a' }, { id: 'model-b' }] }
  listReasoningLevels(): readonly ReasoningOption[] { return [...DEFAULT_REASONING_LEVELS] }

  createSession(config: RuntimeAgentConfig, existing?: RuntimeSessionInfo): RuntimeSession {
    if (existing !== undefined && this.resumeThrows) {
      throw new Error('provider session cannot be resumed (expired thread)')
    }
    const session = new FakeThreadSession(config, this, existing)
    this.sessions.set(config.agentId, session)
    return session
  }

  sessionOf(memberId: string): FakeThreadSession | undefined { return this.sessions.get(memberId) }

  async spawnAgent(config: RuntimeAgentConfig): Promise<RuntimeAgentHandle> {
    throw new Error('not used — session provider')
  }
  async stopAgent(handle: RuntimeAgentHandle): Promise<void> { await handle.stop() }
  async deliver(handle: RuntimeAgentHandle, message: RuntimeMessage<unknown>): Promise<void> {
    await handle.sendInput?.(runtimeMessageText(message))
  }
}

const TEAM = {
  leaderRole: { id: 'leader', name: 'Leader', runtime: 'fake-thread' },
  memberRoles: [
    { id: 'implementation', name: 'Implementation Agent', runtime: 'fake-thread', profile: 'group-member', model: 'model-a', reasoningLevel: 'high', maxInstances: 2 },
    { id: 'reviewer', name: 'Reviewer', runtime: 'fake-thread', model: 'model-b', reasoningLevel: 'medium', maxInstances: 1 },
  ],
}

function makeTurnHost(stores: Stores, provider: FakeThreadProvider): GroupHost {
  const h = makeHarness(stores)
  const registry = new RuntimeRegistry()
  registry.register(provider)
  return new GroupHost({
    groups: h.groups,
    tasks: h.tasks,
    channel: h.channel,
    privateMessages: h.privateMessages,
    activity: h.activity,
    profiles: h.profiles,
    notifier: h.notifier,
    adapter: createNoopAdapter(),
    leaders: h.leaders,
    runtimes: registry,
  })
}

async function seedTeam(host: GroupHost): Promise<{ groupId: string; memberId: string }> {
  const group = await host.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
  await host.updateTeamConfig(group.groupId, TEAM as never, 'User')
  const member = await host.spawnByRole('lead-1', { role: 'implementation' })
  return { groupId: group.groupId, memberId: member.sessionId }
}

async function assign(host: GroupHost, groupId: string, memberId: string, subject: string): Promise<{ taskId: string }> {
  const task = await host.createTask('lead-1', { subject, description: '…', kind: 'implementation', acceptanceCriteria: ['works'] })
  await host.assignTask('lead-1', { taskId: task.taskId, ownerId: memberId })
  return { taskId: task.taskId }
}

describe('V0.5: persistent sessions & turn-based task completion', () => {
  it('materializes and persists a ready provider session before first dispatch', async () => {
    const stores = makeStores()
    const provider = new FakeThreadProvider()
    const host = makeTurnHost(stores, provider)
    const { groupId, memberId } = await seedTeam(host)
    const member = host.groups.requireMember(groupId, memberId)

    expect(provider.sessionOf(memberId)?.status).toBe('idle')
    expect(member.runtimeSession).toMatchObject({
      providerSessionId: `ses-${memberId}`,
      state: 'idle',
    })
    expect(provider.startedTurns).toHaveLength(0)
  })

  it('Task A → turn 1 → claim → idle; Task B on the SAME session/thread', async () => {
    const stores = makeStores()
    const provider = new FakeThreadProvider()
    const host = makeTurnHost(stores, provider)
    const { groupId, memberId } = await seedTeam(host)

    const taskA = await assign(host, groupId, memberId, 'implement auth')
    await sleep(5)
    expect(provider.startedTurns[0]?.taskId).toBe(taskA.taskId)
    expect(host.tasks.requireTask(groupId, taskA.taskId).dispatch?.state).toBe('delivered')
    provider.sessionOf(memberId)!.completeActiveTurn('auth implemented')
    await sleep(10)
    const doneA = host.tasks.listTasks(groupId).find((t) => t.taskId === taskA.taskId)!
    // a completed TURN submits a completion CLAIM — verification is separate
    expect(doneA.status).toBe('review')
    expect(doneA.result?.completionClaim).toBe(true)
    expect(doneA.result?.summary).toBe('auth implemented')
    expect(doneA.result?.changedFiles).toEqual(['src/auth.ts'])
    await host.verifyTask('lead-1', { taskId: taskA.taskId, passed: true })
    expect(host.tasks.listTasks(groupId).find((t) => t.taskId === taskA.taskId)!.status).toBe('completed')
    // member idle, session alive
    expect(host['memberRuntimes'].get(memberId)!.state).toBe('idle')

    const taskB = await assign(host, groupId, memberId, 'add refresh tokens')
    await sleep(5)
    expect(provider.startedTurns[1]?.taskId).toBe(taskB.taskId)
    // SAME provider session/thread — no new session object
    expect(provider.startedTurns[1]?.threadId).toBe(provider.startedTurns[0]?.threadId)
    expect(provider.sessions.size).toBe(1)
    provider.sessionOf(memberId)!.completeActiveTurn('refresh tokens added')
    await sleep(10)
    expect(host.tasks.listTasks(groupId).find((t) => t.taskId === taskB.taskId)!.status).toBe('review')
    // activity timeline recorded turn milestones
    const types = host.activity.list(groupId).map((a) => a.type)
    expect(types.filter((t) => t === 'runtime_turn_started').length).toBe(2)
    expect(types.filter((t) => t === 'runtime_turn_completed').length).toBe(2)
  })

  it('Leader follow-up steers the SAME running turn (never a new agent)', async () => {
    const stores = makeStores()
    const provider = new FakeThreadProvider()
    const host = makeTurnHost(stores, provider)
    const { groupId, memberId } = await seedTeam(host)
    const { taskId } = await assign(host, groupId, memberId, 'build it')
    await sleep(5)
    // leader private message while the turn is RUNNING → steering, same turn
    await host.messageMember('lead-1', { memberSessionId: memberId, text: 'the verifier found a race in refreshToken() — fix only that' })
    await sleep(5)
    expect(provider.steers).toHaveLength(1)
    expect(provider.steers[0]!.turnId).toBe(provider.startedTurns[0]!.turnId)
    expect(provider.steers[0]!.text).toContain('race in refreshToken')
    expect(host.activity.list(groupId).some((a) => a.type === 'runtime_turn_steered')).toBe(true)
    // no brand-new agent/session was created
    expect(provider.sessions.size).toBe(1)
    provider.sessionOf(memberId)!.completeActiveTurn('race fixed')
    await sleep(10)
    const task = host.tasks.listTasks(groupId).find((t) => t.taskId === taskId)!
    expect(task.result?.summary).toBe('race fixed')
    expect(task.status).toBe('review')
  })

  it('interrupt cancels the running turn; the same member continues afterwards', async () => {
    const stores = makeStores()
    const provider = new FakeThreadProvider()
    const host = makeTurnHost(stores, provider)
    const { groupId, memberId } = await seedTeam(host)
    const taskA = await assign(host, groupId, memberId, 'long task')
    await sleep(5)
    await host.interruptMember('lead-1', { memberSessionId: memberId, reason: 'stop now' })
    await sleep(10)
    // task stays open (interrupted ≠ failed, ≠ completed)
    const task = host.tasks.listTasks(groupId).find((t) => t.taskId === taskA.taskId)!
    expect(['in_progress', 'pending', 'blocked']).toContain(task.status)
    expect(task.result).toBeUndefined()
    expect(host.activity.list(groupId).some((a) => a.type === 'runtime_turn_cancelled')).toBe(true)
    // same member + SAME session keeps working
    const taskB = await assign(host, groupId, memberId, 'next task')
    await sleep(5)
    provider.sessionOf(memberId)!.completeActiveTurn('done')
    await sleep(10)
    expect(host.tasks.listTasks(groupId).find((t) => t.taskId === taskB.taskId)!.status).toBe('review')
  })

  it('a failed turn FAILS the task loudly; the session survives for a retry', async () => {
    const stores = makeStores()
    const provider = new FakeThreadProvider()
    const host = makeTurnHost(stores, provider)
    const { groupId, memberId } = await seedTeam(host)
    const taskA = await assign(host, groupId, memberId, 'do it')
    await sleep(5)
    provider.sessionOf(memberId)!.failActiveTurn('compile error')
    await sleep(10)
    const task = host.tasks.listTasks(groupId).find((t) => t.taskId === taskA.taskId)!
    expect(task.status).toBe('failed')
    expect(host.activity.list(groupId).some((a) => a.type === 'runtime_turn_failed')).toBe(true)
    // session still alive → leader retries on the SAME member
    const taskB = await assign(host, groupId, memberId, 'retry: compile error')
    await sleep(5)
    provider.sessionOf(memberId)!.completeActiveTurn('fixed')
    await sleep(10)
    expect(host.tasks.listTasks(groupId).find((t) => t.taskId === taskB.taskId)!.status).toBe('review')
  })

  it('session crash → turn failed + member DISCONNECTED (not a lifecycle failure)', async () => {
    const stores = makeStores()
    const provider = new FakeThreadProvider()
    const host = makeTurnHost(stores, provider)
    const { groupId, memberId } = await seedTeam(host)
    const taskA = await assign(host, groupId, memberId, 'work')
    await sleep(5)
    provider.sessionOf(memberId)!.crash()
    await sleep(10)
    const task = host.tasks.listTasks(groupId).find((t) => t.taskId === taskA.taskId)!
    expect(task.result).toBeUndefined()
    expect(task.status).toBe('failed')
    // V0.6: a transport crash is NOT a member lifecycle failure — the member
    // keeps its durable identity; the runtime is marked disconnected and the
    // SAME provider conversation is re-attached on the next dispatch.
    const member = host.groups.listMembers(groupId, () => undefined).find((m) => m.sessionId === memberId)!
    expect(member.status).not.toBe('failed')
    expect(host.snapshot(groupId, { dshVersion: 'test', checks: [], fatal: [] }).members.find((m) => m.sessionId === memberId)!.runtimeState).toBe('disconnected')
    expect(host.activity.list(groupId).some((a) => a.type === 'runtime_session_disconnected')).toBe(true)
    expect(host.activity.list(groupId).some((a) => a.type === 'runtime_turn_failed')).toBe(true)
    // the same member + SAME thread resumes on the next dispatch (no fresh thread)
    const taskB = await assign(host, groupId, memberId, 'retry after crash')
    await sleep(5)
    expect(provider.startedTurns[1]?.threadId).toBe(provider.startedTurns[0]?.threadId)
    provider.sessionOf(memberId)!.completeActiveTurn('retry done')
    await sleep(10)
    expect(host.tasks.listTasks(groupId).find((t) => t.taskId === taskB.taskId)!.status).toBe('review')
  })

  it('a late event from old turn A never completes turn B', async () => {
    const stores = makeStores()
    const provider = new FakeThreadProvider()
    const host = makeTurnHost(stores, provider)
    const { groupId, memberId } = await seedTeam(host)
    const taskA = await assign(host, groupId, memberId, 'task a')
    await sleep(5)
    const turnA = provider.startedTurns[0]!.turnId
    provider.sessionOf(memberId)!.completeActiveTurn('a done')
    await sleep(10)

    const taskB = await assign(host, groupId, memberId, 'task b')
    await sleep(5)
    // stale events from turn A arrive while turn B is running
    provider.sessionOf(memberId)!.emitLateCompletion(turnA, taskA.taskId, 'a done AGAIN (stale)')
    await sleep(10)
    const taskBAfter = host.tasks.listTasks(groupId).find((t) => t.taskId === taskB.taskId)!
    expect(taskBAfter.result).toBeUndefined()
    const taskAAfter = host.tasks.listTasks(groupId).find((t) => t.taskId === taskA.taskId)!
    expect(taskAAfter.result?.summary).toBe('a done') // untouched by the stale claim
    provider.sessionOf(memberId)!.completeActiveTurn('b done')
    await sleep(10)
    expect(host.tasks.listTasks(groupId).find((t) => t.taskId === taskB.taskId)!.status).toBe('review')
  })

  it('member removal during a running turn: session closes, late events are ignored', async () => {
    const stores = makeStores()
    const provider = new FakeThreadProvider()
    const host = makeTurnHost(stores, provider)
    const { groupId, memberId } = await seedTeam(host)
    const taskA = await assign(host, groupId, memberId, 'work')
    await sleep(5)
    await host.userRemoveMember(groupId, memberId)
    // host registration is gone and the provider session is closed
    expect(host['memberRuntimes'].has(memberId)).toBe(false)
    expect(provider.sessions.get(memberId)?.status).toBe('closed')
    // late completion for the terminated turn cannot resurrect a claim
    try {
      provider.sessionOf(memberId)?.completeActiveTurn('too late')
    } catch { /* session closed — no active turn */ }
    await sleep(10)
    const task = host.tasks.listTasks(groupId).find((t) => t.taskId === taskA.taskId)!
    expect(task.result).toBeUndefined()
    expect(task.status).not.toBe('completed')
  })

  it('host restart: resumeAllMemberRuntimes re-attaches the SAME provider thread', async () => {
    const stores = makeStores()
    const provider1 = new FakeThreadProvider()
    const host1 = makeTurnHost(stores, provider1)
    const { groupId, memberId } = await seedTeam(host1)
    const taskA = await assign(host1, groupId, memberId, 'first')
    await sleep(5)
    provider1.sessionOf(memberId)!.completeActiveTurn('first done')
    await sleep(10)
    const threadBefore = provider1.startedTurns[0]!.threadId
    expect(threadBefore).toBe(`thr-${memberId}`)

    // "restart": a NEW host + NEW provider over the SAME durable stores
    const provider2 = new FakeThreadProvider()
    const host2 = makeTurnHost(stores, provider2)
    await host2.resumeAllMemberRuntimes()
    const taskB = await assign(host2, groupId, memberId, 'second')
    await sleep(5)
    // resumed thread, no fresh thread
    expect(provider2.resumedThreads).toHaveLength(1)
    expect(provider2.resumedThreads[0]!.threadId).toBe(threadBefore)
    expect(provider2.startedTurns[0]?.threadId).toBe(threadBefore)
    expect(provider2.startedTurns[0]?.taskId).toBe(taskB.taskId)
    provider2.sessionOf(memberId)!.completeActiveTurn('second done')
    await sleep(10)
    expect(host2.tasks.listTasks(groupId).find((t) => t.taskId === taskB.taskId)!.status).toBe('review')
    // the durable member record carries the session metadata (no secrets)
    const member = host2.groups.listMembers(groupId, () => undefined).find((m) => m.sessionId === memberId)!
    expect(member.runtimeSession?.providerThreadId).toBe(threadBefore)
  })

  it('host restart marks an unobservable running attempt lost without replaying it', async () => {
    const stores = makeStores()
    const provider1 = new FakeThreadProvider()
    const host1 = makeTurnHost(stores, provider1)
    const { groupId, memberId } = await seedTeam(host1)
    const task = await assign(host1, groupId, memberId, 'interrupted by host restart')
    await sleep(10)
    expect(host1.tasks.requireTask(groupId, task.taskId).attempts?.[0]?.status).toBe('running')

    const provider2 = new FakeThreadProvider()
    const host2 = makeTurnHost(stores, provider2)
    await host2.resumeAllMemberRuntimes()

    const reconciled = host2.tasks.requireTask(groupId, task.taskId)
    expect(reconciled.status).toBe('failed')
    expect(reconciled.attempts?.[0]).toMatchObject({ status: 'lost', failure: expect.stringContaining('no live provider turn') })
    expect(provider2.startedTurns).toHaveLength(0)
    expect(host2.groups.requireMember(groupId, memberId).currentTaskId).toBeUndefined()
    expect(host2.activity.list(groupId).some((event) => event.type === 'task_attempt_lost')).toBe(true)
  })

  it('reconciliation safely delivers a pending dispatch intent exactly once', async () => {
    const stores = makeStores()
    const provider1 = new FakeThreadProvider()
    const host1 = makeTurnHost(stores, provider1)
    const { groupId, memberId } = await seedTeam(host1)
    const task = await host1.createTask('lead-1', { subject: 'durable outbox', description: '…', kind: 'implementation', acceptanceCriteria: ['works'] })
    await host1.tasks.assign(groupId, task.taskId, memberId, 'lead-1', undefined, true)
    expect(host1.tasks.requireTask(groupId, task.taskId).dispatch?.state).toBe('pending')

    const provider2 = new FakeThreadProvider()
    const host2 = makeTurnHost(stores, provider2)
    await host2.resumeAllMemberRuntimes()
    await sleep(10)
    expect(provider2.startedTurns).toHaveLength(1)
    expect(provider2.startedTurns[0]?.taskId).toBe(task.taskId)
    expect(host2.tasks.requireTask(groupId, task.taskId).dispatch?.state).toBe('delivered')
    await host2.resumeAllMemberRuntimes()
    expect(provider2.startedTurns).toHaveLength(1)
  })

  it('reconciliation makes an orphaned in-flight dispatch ambiguous without replay', async () => {
    const stores = makeStores()
    const provider1 = new FakeThreadProvider()
    const host1 = makeTurnHost(stores, provider1)
    const { groupId, memberId } = await seedTeam(host1)
    const task = await host1.createTask('lead-1', { subject: 'ambiguous outbox', description: '…', kind: 'implementation', acceptanceCriteria: ['works'] })
    await host1.tasks.assign(groupId, task.taskId, memberId, 'lead-1', undefined, true)
    await host1.tasks.beginDispatch(groupId, task.taskId, memberId)

    const provider2 = new FakeThreadProvider()
    const host2 = makeTurnHost(stores, provider2)
    await host2.resumeAllMemberRuntimes()
    const reconciled = host2.tasks.requireTask(groupId, task.taskId)
    expect(reconciled.dispatch).toMatchObject({ state: 'ambiguous', failure: expect.stringContaining('refusing automatic replay') })
    expect(reconciled.status).toBe('failed')
    expect(provider2.startedTurns).toHaveLength(0)
  })

  it('resume failure fails LOUDLY — no silent second conversation', async () => {
    const stores = makeStores()
    const provider1 = new FakeThreadProvider()
    const host1 = makeTurnHost(stores, provider1)
    const { groupId, memberId } = await seedTeam(host1)

    const provider2 = new FakeThreadProvider()
    provider2.resumeThrows = true
    const host2 = makeTurnHost(stores, provider2)
    await host2.resumeAllMemberRuntimes() // resume attempts recorded, failures surfaced on dispatch
    await host2.createTask('lead-1', { subject: 'x', description: 'x', kind: 'implementation', acceptanceCriteria: ['x'] })
    const task = host2.tasks.listTasks(groupId).find((t) => t.subject === 'x')!
    await expect(host2.assignTask('lead-1', { taskId: task.taskId, ownerId: memberId }))
      .rejects.toMatchObject({ code: 'SESSION_RESUME_FAILED' })
    // no NEW provider conversation was silently created
    expect(provider2.sessions.size).toBe(0)
  })

  it('approval + input-required requests surface in the snapshot and can be answered', async () => {
    const stores = makeStores()
    const provider = new FakeThreadProvider()
    const host = makeTurnHost(stores, provider)
    const { groupId, memberId } = await seedTeam(host)
    const { taskId } = await assign(host, groupId, memberId, 'work')
    await sleep(5)
    const session = provider.sessionOf(memberId)!
    session.requestApproval('req-1', 'run: rm -rf /tmp/x')
    await sleep(5)
    const snap = host.snapshot(groupId, { dshVersion: 'test', checks: [], fatal: [] })
    const runtimeState = snap.members.find((m) => m.sessionId === memberId)!.runtimeState
    expect(runtimeState).toBe('needs_approval')
    expect(snap.runtimeRequests.map((r) => r.requestId)).toEqual(['req-1'])
    expect(host.activity.list(groupId).some((a) => a.type === 'runtime_approval_required')).toBe(true)

    const answered = await host.respondRuntimeRequest(groupId, memberId, 'req-1', 'decline')
    expect(answered).toBe(true)
    expect(provider.answers[0]).toMatchObject({ memberId, requestId: 'req-1', action: 'decline' })
    expect(host.activity.list(groupId).some((a) => a.type === 'runtime_approval_answered')).toBe(true)
    expect(host.snapshot(groupId, { dshVersion: 'test', checks: [], fatal: [] }).runtimeRequests).toHaveLength(0)

    // input-required
    session.requestInput('req-2', 'which directory?')
    await sleep(5)
    expect(host.snapshot(groupId, { dshVersion: 'test', checks: [], fatal: [] }).members.find((m) => m.sessionId === memberId)!.runtimeState).toBe('waiting_input')
    expect(await host.respondRuntimeRequest(groupId, memberId, 'req-2', 'answer', 'src/')).toBe(true)
    expect(provider.answers[1]).toMatchObject({ requestId: 'req-2', payload: 'src/' })

    session.completeActiveTurn('done')
    await sleep(10)
    expect(host.tasks.listTasks(groupId).find((t) => t.taskId === taskId)!.status).toBe('review')
  })

  it('V0.6: Task B assigned while Task A runs is a QUEUED future turn — the active turn is NEVER retargeted', async () => {
    const stores = makeStores()
    const provider = new FakeThreadProvider()
    const host = makeTurnHost(stores, provider)
    const { groupId, memberId } = await seedTeam(host)
    const taskA = await assign(host, groupId, memberId, 'task a')
    await sleep(5)
    // task B lands while turn A is still running → QUEUED, not merged into A
    const taskB = await assign(host, groupId, memberId, 'task b')
    await sleep(5)
    expect(provider.startedTurns).toHaveLength(1) // B did NOT start a turn
    expect(provider.steers).toHaveLength(0) // B is a task, not a correction
    // the Host's authoritative queue sees the future turn
    const snap = host.snapshot(groupId, { dshVersion: 'test', checks: [], fatal: [] })
    const memberView = snap.members.find((m) => m.sessionId === memberId)!
    expect(memberView.runtimeQueuedTurns).toHaveLength(1)
    expect(memberView.runtimeQueuedTurns![0]!.kind).toBe('task')
    expect(memberView.runtimeQueuedTurns![0]!.taskId).toBe(taskB.taskId)
    expect(host.activity.list(groupId).some((a) => a.type === 'runtime_turn_queued')).toBe(true)

    // turn A completes → task A settles with A's claim, THEN B starts on the
    // SAME session and settles only B.
    provider.sessionOf(memberId)!.completeActiveTurn('a done')
    await sleep(15)
    const taskAAfter = host.tasks.listTasks(groupId).find((t) => t.taskId === taskA.taskId)!
    expect(taskAAfter.result?.summary).toBe('a done')
    expect(taskAAfter.status).toBe('review')
    // B's turn started AFTER A reached terminal state, same thread
    expect(provider.startedTurns).toHaveLength(2)
    expect(provider.startedTurns[1]!.taskId).toBe(taskB.taskId)
    expect(provider.startedTurns[1]!.threadId).toBe(provider.startedTurns[0]!.threadId)
    expect(provider.sessions.size).toBe(1)
    // the queue is drained now
    expect(host.snapshot(groupId, { dshVersion: 'test', checks: [], fatal: [] }).members.find((m) => m.sessionId === memberId)!.runtimeQueuedTurns).toBeUndefined()
    provider.sessionOf(memberId)!.completeActiveTurn('b done')
    await sleep(10)
    const taskBAfter = host.tasks.listTasks(groupId).find((t) => t.taskId === taskB.taskId)!
    expect(taskBAfter.status).toBe('review')
    expect(taskBAfter.result?.summary).toBe('b done')
    // task A was never completed by turn B
    expect(host.tasks.listTasks(groupId).find((t) => t.taskId === taskA.taskId)!.result?.summary).toBe('a done')
  })

  it('V0.6: a provider that cannot steer live queues the correction and runs it as the NEXT turn on the same session', async () => {
    const stores = makeStores()
    const provider = new FakeThreadProvider()
    provider.queueSteers = true // Claude-like limitation
    const host = makeTurnHost(stores, provider)
    const { groupId, memberId } = await seedTeam(host)
    const { taskId } = await assign(host, groupId, memberId, 'build it')
    await sleep(5)
    await host.messageMember('lead-1', { memberSessionId: memberId, text: 'queued correction: use the v2 API' })
    await sleep(5)
    expect(provider.steers).toHaveLength(0)
    // the correction is visible as QUEUED (never pretended to be steered)
    const snap = host.snapshot(groupId, { dshVersion: 'test', checks: [], fatal: [] })
    const queued = snap.members.find((m) => m.sessionId === memberId)!.runtimeQueuedTurns!
    expect(queued).toHaveLength(1)
    expect(queued[0]!.kind).toBe('followup')
    expect(queued[0]!.text).toContain('v2 API')
    // after the task turn completes, the correction runs as the next turn
    provider.sessionOf(memberId)!.completeActiveTurn('done')
    await sleep(15)
    expect(provider.startedTurns).toHaveLength(2)
    expect(provider.startedTurns[1]!.text).toContain('v2 API')
    expect(provider.startedTurns[1]!.taskId).toBeUndefined() // correction, no task binding
    provider.sessionOf(memberId)!.completeActiveTurn('corrected')
    await sleep(10)
    expect(host.tasks.listTasks(groupId).find((t) => t.taskId === taskId)!.result?.summary).toBe('done')
  })

  it('V0.6: a failed steer can NEVER silently lose the correction (typed failure + reliable queueing)', async () => {
    const stores = makeStores()
    const provider = new FakeThreadProvider()
    provider.steerThrows = true // Codex turn/steer failure
    const host = makeTurnHost(stores, provider)
    const { groupId, memberId } = await seedTeam(host)
    const { taskId } = await assign(host, groupId, memberId, 'build it')
    await sleep(5)
    // the Leader's delivery must NOT pretend the steer was injected
    await host.messageMember('lead-1', { memberSessionId: memberId, text: 'must not be lost: fix the race' })
    await sleep(5)
    expect(host.activity.list(groupId).some((a) => a.type === 'runtime_steer_failed')).toBe(true)
    // the correction was queued, not dropped
    const queued = host.snapshot(groupId, { dshVersion: 'test', checks: [], fatal: [] }).members.find((m) => m.sessionId === memberId)!.runtimeQueuedTurns!
    expect(queued).toHaveLength(1)
    expect(queued[0]!.kind).toBe('followup')
    expect(queued[0]!.text).toContain('fix the race')
    // it executes as the NEXT turn on the SAME session
    provider.sessionOf(memberId)!.completeActiveTurn('done')
    await sleep(15)
    expect(provider.startedTurns[1]!.text).toContain('fix the race')
    provider.sessionOf(memberId)!.completeActiveTurn('race fixed')
    await sleep(10)
    expect(host.tasks.listTasks(groupId).find((t) => t.taskId === taskId)!.status).toBe('review')
  })

  it('V0.6: interrupt returns the task to a defined retryable state and drains the queue', async () => {
    const stores = makeStores()
    const provider = new FakeThreadProvider()
    const host = makeTurnHost(stores, provider)
    const { groupId, memberId } = await seedTeam(host)
    const taskA = await assign(host, groupId, memberId, 'long task')
    await sleep(5)
    const taskB = await assign(host, groupId, memberId, 'queued behind A')
    await sleep(5)
    await host.interruptMember('lead-1', { memberSessionId: memberId, reason: 'stop now' })
    await sleep(15)
    // cancellation policy: the interrupted task is retryable (pending), NOT
    // success and NOT failure; the member stops carrying A and then carries
    // queued task B once deterministic draining starts it
    const taskAAfter = host.tasks.listTasks(groupId).find((t) => t.taskId === taskA.taskId)!
    expect(taskAAfter.status).toBe('pending')
    expect(taskAAfter.result).toBeUndefined()
    const memberAfter = host.groups.listMembers(groupId, () => undefined).find((m) => m.sessionId === memberId)!
    expect(memberAfter.currentTaskId).toBe(taskB.taskId)
    expect(host.activity.list(groupId).some((a) => a.type === 'runtime_turn_cancelled')).toBe(true)
    expect(host.activity.list(groupId).some((a) => a.type === 'task_reopened')).toBe(true)
    // the queued task B starts after the interrupt (deterministic continuation)
    expect(provider.startedTurns).toHaveLength(2)
    expect(provider.startedTurns[1]!.taskId).toBe(taskB.taskId)
    provider.sessionOf(memberId)!.completeActiveTurn('b after interrupt')
    await sleep(10)
    expect(host.tasks.listTasks(groupId).find((t) => t.taskId === taskB.taskId)!.status).toBe('review')
  })

  it('V0.6: an approval request timeout produces an explicit event and a safe action', async () => {
    const stores = makeStores()
    const provider = new FakeThreadProvider()
    const host = makeTurnHost(stores, provider)
    const { groupId, memberId } = await seedTeam(host)
    const { taskId } = await assign(host, groupId, memberId, 'work')
    await sleep(5)
    const session = provider.sessionOf(memberId)!
    session.requestApproval('req-1', 'run: rm -rf /tmp/x', { deadline: Date.now() + 10 })
    await sleep(5)
    expect(host.snapshot(groupId, { dshVersion: 'test', checks: [], fatal: [] }).runtimeRequests).toHaveLength(1)
    // the provider executes its safe default and emits the timeout
    session.emitRequestTimeout('req-1', 'decline')
    await sleep(5)
    expect(host.snapshot(groupId, { dshVersion: 'test', checks: [], fatal: [] }).runtimeRequests).toHaveLength(0)
    expect(host.activity.list(groupId).some((a) => a.type === 'runtime_request_timed_out')).toBe(true)
    expect(host.activity.list(groupId).find((a) => a.type === 'runtime_request_timed_out')!.payload).toMatchObject({ requestId: 'req-1', action: 'decline' })
    // the member resumes working afterwards
    session.completeActiveTurn('done')
    await sleep(10)
    expect(host.tasks.listTasks(groupId).find((t) => t.taskId === taskId)!.status).toBe('review')
  })

  it('V0.6: a provider-initiated turn is adopted into the Host active-turn state', async () => {
    const stores = makeStores()
    const provider = new FakeThreadProvider()
    const host = makeTurnHost(stores, provider)
    const { groupId, memberId } = await seedTeam(host)
    // the provider starts a turn the Host did not start (e.g. a drained queue)
    provider.sessionOf(memberId)!.startUnmanagedTurn('task-x', 'provider-driven work')
    await sleep(5)
    const snap = host.snapshot(groupId, { dshVersion: 'test', checks: [], fatal: [] })
    const view = snap.members.find((m) => m.sessionId === memberId)!
    expect(view.runtimeState).toBe('working')
    expect(view.currentTurnId).toBeDefined()
    // the Host treats it as the active turn and blocks a new concurrent turn
    await host.createTask('lead-1', { subject: 'y', description: 'y', kind: 'implementation', acceptanceCriteria: ['y'] })
    const taskY = host.tasks.listTasks(groupId).find((t) => t.subject === 'y')!
    await host.assignTask('lead-1', { taskId: taskY.taskId, ownerId: memberId })
    await sleep(5)
    expect(provider.startedTurns).toHaveLength(1) // no concurrent turn
    expect(host.snapshot(groupId, { dshVersion: 'test', checks: [], fatal: [] }).members.find((m) => m.sessionId === memberId)!.runtimeQueuedTurns).toHaveLength(1)
    provider.sessionOf(memberId)!.completeActiveTurn('provider work done')
    await sleep(15)
    // the queued task then runs and completes normally
    expect(provider.startedTurns[1]!.taskId).toBe(taskY.taskId)
    provider.sessionOf(memberId)!.completeActiveTurn('y done')
    await sleep(10)
    expect(host.tasks.listTasks(groupId).find((t) => t.taskId === taskY.taskId)!.status).toBe('review')
  })
})

describe('V0.5: runtime registry helpers', () => {
  it('isSessionProvider distinguishes session providers', () => {
    const provider = new FakeThreadProvider()
    expect(isSessionProvider(provider)).toBe(true)
    const legacy = {
      id: 'x', name: 'x',
      isAvailable: () => true,
      getCapabilities: () => ({ models: false, reasoningLevels: false, interactiveSession: false, workspace: false, toolControl: false, streaming: false }),
      listModels: () => [],
      spawnAgent: async () => { throw new Error('nope') },
      stopAgent: async () => undefined,
    }
    expect(isSessionProvider(legacy as unknown as AgentRuntimeProvider)).toBe(false)
  })

  it('GroupError vocabulary includes the V0.5 loud codes', () => {
    for (const code of ['SESSION_START_FAILED', 'SESSION_RESUME_FAILED', 'TURN_START_FAILED', 'TURN_TIMEOUT', 'RUNTIME_DISCONNECTED']) {
      const error = new GroupError(code as never, 'x')
      expect(error.code).toBe(code)
    }
  })
})
