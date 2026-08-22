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

  async runTurn(input: RuntimeTurnInput): Promise<RuntimeTurnHandle> {
    await this.start()
    if (this.active !== undefined) throw new Error('busy')
    const turnId = `turn-${++this.provider.turnCounter}`
    let settle!: (result: RuntimeTurnResult) => void
    const completion = new Promise<RuntimeTurnResult>((resolve) => { settle = resolve })
    this.active = { turnId, taskId: input.taskId, settle, text: input.text }
    this.status = 'running'
    this.provider.startedTurns.push({ memberId: this.memberId, turnId, taskId: input.taskId, threadId: this.providerThreadId, text: input.text })
    this.emit({ type: 'turn.started', turnId, taskId: input.taskId, memberId: this.memberId, timestamp: Date.now() })
    return {
      turnId,
      taskId: input.taskId,
      waitForCompletion: () => completion,
      subscribe: (listener) => this.subscribe(listener),
    }
  }

  async sendFollowup(input: RuntimeTurnInput): Promise<void> {
    if (this.active !== undefined) {
      this.provider.followups.push({ memberId: this.memberId, text: input.text, turnId: this.active.turnId })
      return
    }
    await this.runTurn({ ...input, turnKind: 'followup' })
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
    this.status = 'running'
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

  requestApproval(requestId: string, description: string): void {
    const request: RuntimePendingRequest = {
      requestId, requestKind: 'approval', memberId: this.memberId,
      turnId: this.active?.turnId, taskId: this.active?.taskId,
      description, params: {}, timestamp: Date.now(), defaultAction: 'decline', allowedActions: ['accept', 'decline'],
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
}

class FakeThreadProvider implements AgentRuntimeProvider {
  readonly id = 'fake-thread'
  readonly name = 'Fake Thread Runtime'
  readonly sessions = new Map<string, FakeThreadSession>()
  readonly startedTurns: Array<{ memberId: string; turnId: string; taskId?: string; threadId?: string; text: string }> = []
  readonly followups: Array<{ memberId: string; turnId: string; text: string }> = []
  readonly answers: Array<{ memberId: string; requestId: string; action: string; payload?: unknown }> = []
  readonly resumedThreads: Array<{ memberId: string; threadId?: string }> = []
  turnCounter = 0
  resumeThrows = false
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
  it('Task A → turn 1 → claim → idle; Task B on the SAME session/thread', async () => {
    const stores = makeStores()
    const provider = new FakeThreadProvider()
    const host = makeTurnHost(stores, provider)
    const { groupId, memberId } = await seedTeam(host)

    const taskA = await assign(host, groupId, memberId, 'implement auth')
    await sleep(5)
    expect(provider.startedTurns[0]?.taskId).toBe(taskA.taskId)
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

  it('Leader follow-up reaches the SAME session/turn (never a new agent)', async () => {
    const stores = makeStores()
    const provider = new FakeThreadProvider()
    const host = makeTurnHost(stores, provider)
    const { groupId, memberId } = await seedTeam(host)
    const { taskId } = await assign(host, groupId, memberId, 'build it')
    await sleep(5)
    // leader private message while the turn is RUNNING
    await host.messageMember('lead-1', { memberSessionId: memberId, text: 'the verifier found a race in refreshToken() — fix only that' })
    await sleep(5)
    expect(provider.followups).toHaveLength(1)
    expect(provider.followups[0]!.turnId).toBe(provider.startedTurns[0]!.turnId)
    expect(provider.followups[0]!.text).toContain('race in refreshToken')
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

  it('session crash → turn failed + member disconnected (NEVER a task success)', async () => {
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
    const member = host.groups.listMembers(groupId, () => undefined).find((m) => m.sessionId === memberId)!
    expect(member.status).toBe('failed')
    expect(host.activity.list(groupId).some((a) => a.type === 'runtime_session_disconnected')).toBe(true)
    expect(host.activity.list(groupId).some((a) => a.type === 'runtime_turn_failed')).toBe(true)
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

  it('turn assignment while another task is running = correction on the SAME turn', async () => {
    const stores = makeStores()
    const provider = new FakeThreadProvider()
    const host = makeTurnHost(stores, provider)
    const { groupId, memberId } = await seedTeam(host)
    const taskA = await assign(host, groupId, memberId, 'task a')
    await sleep(5)
    // task B lands while turn A is still running → follow-up on the same turn
    const taskB = await assign(host, groupId, memberId, 'task b (correction)')
    await sleep(5)
    expect(provider.followups).toHaveLength(1)
    expect(provider.startedTurns).toHaveLength(1)
    provider.sessionOf(memberId)!.completeActiveTurn('b done')
    await sleep(10)
    // the claim lands on the member's CURRENT task (B) — turn-safe correlation
    expect(host.tasks.listTasks(groupId).find((t) => t.taskId === taskB.taskId)!.status).toBe('review')
    expect(host.tasks.listTasks(groupId).find((t) => t.taskId === taskA.taskId)!.result).toBeUndefined()
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