/**
 * Codex App Server provider tests (requirements §5, §6, §12, §19).
 *
 * The provider runs against the deterministic fake JSONL app-server — no
 * real codex process and no credentials. Covers: persistent thread reuse
 * across tasks, late-event correlation safety, follow-up steering (turn/steer),
 * interrupt, crash → turn failure + session disconnect, reconnect/resume on
 * the SAME thread, dynamic model discovery + marked fallback, approval and
 * input requests, legacy spawn shim.
 */
import { describe, expect, it, vi } from 'vitest'
import { CodexRuntimeProvider, CODEX_FALLBACK_MODELS } from '../src/runtime/codex.js'
import type { RuntimeEvent, RuntimeTurnResult } from '../src/runtime/base.js'
import { FakeCodexServer } from './fake-codex-server.js'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Script the fake server with the standard persistent-session flow. */
function installFlow(server: FakeCodexServer, options: { failModelList?: boolean } = {}): { wireIds: string[] } {
  const wireIds: string[] = []
  if (!options.failModelList) {
    server.setHandler('model/list', () => ({
      data: [
        { id: 'gpt-5.1-codex', model: 'gpt-5.1-codex', displayName: 'GPT-5.1-Codex', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
        { id: 'o4-mini', model: 'o4-mini', displayName: 'o4-mini', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
      ],
      nextCursor: null,
    }))
  } else {
    server.setHandler('model/list', () => { throw new Error('catalog unavailable') })
  }
  server.setHandler('thread/start', (params) => ({
    thread: { id: 'thr-1', sessionId: 'ses-1', preview: '', ephemeral: false, section: null, modelProvider: 'openai', cwd: params.cwd, status: { type: 'idle' }, name: null },
    model: params.model ?? 'gpt-5.1-codex',
  }))
  server.setHandler('thread/resume', (params) => ({
    thread: { id: params.threadId ?? 'thr-1', sessionId: 'ses-1', preview: '', ephemeral: false, section: null, modelProvider: 'openai', cwd: '/ws', status: { type: 'idle' }, name: null },
    model: 'gpt-5.1-codex',
  }))
  server.setHandler('turn/start', () => {
    const wireId = `wire-${wireIds.length + 1}`
    wireIds.push(wireId)
    return { turn: { id: wireId, status: 'inProgress', items: [], itemsView: { loadedItems: 0, totalItems: 0, fullyLoaded: true } } }
  })
  server.setHandler('turn/steer', () => ({}))
  server.setHandler('turn/interrupt', () => ({}))
  return { wireIds }
}

function makeProvider(server: FakeCodexServer, bin = 'fake-codex'): CodexRuntimeProvider {
  return new CodexRuntimeProvider({
    processHost: { label: 'fake-codex app-server (fake)', spawn: () => server.child },
    binPath: bin,
  })
}

function collectEvents(session: { subscribe(listener: (event: RuntimeEvent) => void): () => void }): RuntimeEvent[] {
  const events: RuntimeEvent[] = []
  session.subscribe((event) => events.push(event))
  return events
}

describe('codex runtime provider (app server)', () => {
  it('one member = one persistent thread across sequential task turns', async () => {
    const server = new FakeCodexServer('fake-codex')
    installFlow(server)
    const provider = makeProvider(server)
    const session = await provider.createSession({ groupId: 'g-1', agentId: 'm-1', role: 'implementation', workspace: '/ws', model: 'gpt-5.1-codex', reasoningLevel: 'high' })
    const events = collectEvents(session)

    // task A → turn 1
    const turn1 = await session.runTurn({ taskId: 'task-a', text: 'implement auth' })
    expect(events.some((e) => e.type === 'turn.started' && e.taskId === 'task-a')).toBe(true)
    server.child.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thr-1', turnId: 'wire-1', itemId: 'i1', delta: 'implemented' } })}\n`)
    server.finishTurn('wire-1', 'completed')
    const result1 = await turn1.waitForCompletion()
    expect(result1.status).toBe('completed')
    expect(result1.output).toContain('implemented')
    expect(result1.summary).toContain('agent summary text')
    expect(session.info().providerThreadId).toBe('thr-1')

    // task B → turn 2 on the SAME thread
    const turn2 = await session.runTurn({ taskId: 'task-b', text: 'now the reviewer pass' })
    server.finishTurn('wire-2', 'completed')
    const result2 = await turn2.waitForCompletion()
    expect(result2.status).toBe('completed')

    // same provider session/thread — no second thread/start
    const threadStarts = server.received.filter((r) => r.method === 'thread/start')
    const turnStarts = server.received.filter((r) => r.method === 'turn/start')
    expect(threadStarts).toHaveLength(1)
    expect(turnStarts).toHaveLength(2)
    expect(server.received.filter((r) => r.method === 'thread/resume')).toHaveLength(0)
    // thread/start carried the workspace + sandbox + role model config
    const threadParams = threadStarts[0]!.params as Record<string, unknown>
    expect(threadParams.cwd).toBe('/ws')
    expect(threadParams.sandbox).toBe('workspace-write')
    expect(threadParams.model).toBe('gpt-5.1-codex')
    // turn/start carried task + reasoning effort
    const turnParams = turnStarts[0]!.params as Record<string, unknown>
    expect(turnParams.threadId).toBe('thr-1')
    expect(turnParams.effort).toBe('high')
    await session.close(50).catch(() => undefined)
  })

  it('leader follow-up steers the RUNNING turn (same turn, same thread)', async () => {
    const server = new FakeCodexServer('fake-codex')
    installFlow(server)
    const provider = makeProvider(server)
    const session = await provider.createSession({ groupId: 'g-1', agentId: 'm-1', role: 'implementation', workspace: '/ws' })
    const turn = await session.runTurn({ taskId: 'task-a', text: 'build it' })
    await session.sendFollowup!({ text: 'the verifier found a race — fix only that' })
    await vi.waitFor(() => {
      const steer = server.received.find((r) => r.method === 'turn/steer')
      expect(steer).toBeDefined()
      expect((steer!.params as Record<string, unknown>).expectedTurnId).toBe('wire-1')
      expect((steer!.params as Record<string, unknown>).threadId).toBe('thr-1')
    })
    server.finishTurn('wire-1', 'completed')
    const result = await turn.waitForCompletion()
    expect(result.status).toBe('completed')
    // exactly one turn was started — the follow-up was NOT a new agent/turn
    expect(server.received.filter((r) => r.method === 'turn/start')).toHaveLength(1)
    await session.close(50).catch(() => undefined)
  })

  it('interrupt cancels the running turn and the session stays alive', async () => {
    const server = new FakeCodexServer('fake-codex')
    installFlow(server)
    const provider = makeProvider(server)
    const session = await provider.createSession({ groupId: 'g-1', agentId: 'm-1', role: 'implementation', workspace: '/ws' })
    const turn = await session.runTurn({ taskId: 'task-a', text: 'long task' })
    await session.interrupt('leader says stop')
    await vi.waitFor(() => {
      const interrupt = server.received.find((r) => r.method === 'turn/interrupt')
      expect(interrupt).toBeDefined()
      expect((interrupt!.params as Record<string, unknown>).turnId).toBe('wire-1')
    })
    server.finishTurn('wire-1', 'interrupted')
    const result = await turn.waitForCompletion()
    expect(result.status).toBe('cancelled')
    expect(session.status).toBe('idle')
    // the same session can take the next task
    const again = await session.runTurn({ taskId: 'task-b', text: 'retry' })
    server.finishTurn('wire-2', 'completed')
    expect((await again.waitForCompletion()).status).toBe('completed')
    await session.close(50).catch(() => undefined)
  })

  it('approval requests surface as events and can be answered by the host', async () => {
    const server = new FakeCodexServer('fake-codex')
    installFlow(server)
    const provider = makeProvider(server)
    const session = await provider.createSession({ groupId: 'g-1', agentId: 'm-1', role: 'implementation', workspace: '/ws' })
    const events = collectEvents(session)
    const turn = await session.runTurn({ taskId: 'task-a', text: 'do it' })
    server.requestFromServer('item/commandExecution/requestApproval', 61, { threadId: 'thr-1', turnId: 'wire-1', itemId: 'it-1', command: 'rm -rf /tmp/x', reason: 'cleanup' })
    await vi.waitFor(() => expect(events.some((e) => e.type === 'turn.approval.required')).toBe(true))
    const approval = events.find((e) => e.type === 'turn.approval.required')!
    if (approval.type !== 'turn.approval.required') throw new Error('unreachable')
    expect(approval.request.requestId).toBe('61')
    expect(approval.request.description).toContain('rm -rf /tmp/x')
    expect(session.listPendingRequests().map((r) => r.requestId)).toEqual(['61'])
    const answered = await session.respondToRequest!('61', 'decline')
    expect(answered).toBe(true)
    await vi.waitFor(() => {
      expect(server.received.some((r) => r.method === 'client-response' && r.id === 61 && (r.params as { decision: string }).decision === 'decline')).toBe(true)
    })
    expect(session.listPendingRequests()).toHaveLength(0)
    server.finishTurn('wire-1', 'completed')
    expect((await turn.waitForCompletion()).status).toBe('completed')
    await session.close(50).catch(() => undefined)
  })

  it('user-input requests produce waiting_input state and answer with question ids', async () => {
    const server = new FakeCodexServer('fake-codex')
    installFlow(server)
    const provider = makeProvider(server)
    const session = await provider.createSession({ groupId: 'g-1', agentId: 'm-1', role: 'implementation', workspace: '/ws' })
    const events = collectEvents(session)
    const turn = await session.runTurn({ taskId: 'task-a', text: 'do it' })
    server.requestFromServer('item/tool/requestUserInput', 62, {
      threadId: 'thr-1', turnId: 'wire-1', itemId: 'it-2',
      questions: [{ id: 'q1', header: 'dir', question: 'which directory?', isOther: false, isSecret: false, options: null }],
      isBlocking: true, autoResolutionMs: null,
    })
    await vi.waitFor(() => expect(events.some((e) => e.type === 'turn.input.required')).toBe(true))
    expect(session.status).toBe('waiting_input')
    const answered = await session.respondToRequest!('62', 'answer', 'src/')
    expect(answered).toBe(true)
    await vi.waitFor(() => {
      const response = server.received.find((r) => r.method === 'client-response' && r.id === 62)
      expect(response).toBeDefined()
      const answers = ((response!.params as { answers: Record<string, unknown> }).answers ?? {}) as Record<string, { answers: string[] }>
      expect(answers.q1?.answers).toEqual(['src/'])
    })
    expect(session.status).toBe('running')
    server.finishTurn('wire-1', 'completed')
    expect((await turn.waitForCompletion()).status).toBe('completed')
    await session.close(50).catch(() => undefined)
  })

  it('process crash fails the active turn; the SAME thread resumes afterwards', async () => {
    const server = new FakeCodexServer('fake-codex')
    installFlow(server)
    const provider = makeProvider(server)
    const session = await provider.createSession({ groupId: 'g-1', agentId: 'm-1', role: 'implementation', workspace: '/ws' })
    const events = collectEvents(session)
    const turn = await session.runTurn({ taskId: 'task-a', text: 'work' })
    server.exit(9)
    const result = await turn.waitForCompletion()
    expect(result.status).toBe('failed')
    expect(events.some((e) => e.type === 'session.disconnected')).toBe(true)
    expect(events.some((e) => e.type === 'turn.failed')).toBe(true)
    expect(session.status).toBe('disconnected')

    // "host restart": a fresh provider + fresh connection re-attach to the
    // same thread via thread/resume (no new thread).
    const server2 = new FakeCodexServer('fake-codex')
    installFlow(server2)
    const provider2 = makeProvider(server2)
    const resumed = await provider2.createSession(
      { groupId: 'g-1', agentId: 'm-1', role: 'implementation', workspace: '/ws' },
      session.info(),
    )
    const resumedEvents = collectEvents(resumed)
    await resumed.start()
    expect(resumed.info().providerThreadId).toBe('thr-1')
    expect(server2.received.some((r) => r.method === 'thread/resume')).toBe(true)
    expect(server2.received.some((r) => r.method === 'thread/start')).toBe(false)
    const turn2 = await resumed.runTurn({ taskId: 'task-b', text: 'continue after restart' })
    server2.finishTurn('wire-1', 'completed')
    expect((await turn2.waitForCompletion()).status).toBe('completed')
    expect(resumedEvents.some((e) => e.type === 'session.ready')).toBe(true)
    await resumed.close(50).catch(() => undefined)
  })

  it('a late event from an old turn never completes a newer turn', async () => {
    const server = new FakeCodexServer('fake-codex')
    installFlow(server)
    const provider = makeProvider(server)
    const session = await provider.createSession({ groupId: 'g-1', agentId: 'm-1', role: 'implementation', workspace: '/ws' })
    const events = collectEvents(session)
    const turn1 = await session.runTurn({ taskId: 'task-a', text: 'a' })
    server.finishTurn('wire-1', 'completed')
    await turn1.waitForCompletion()

    const turn2 = await session.runTurn({ taskId: 'task-b', text: 'b' })
    const completed = turn2.waitForCompletion()
    let settled = false
    void completed.then(() => { settled = true })

    // stale deltas AND a stale turn/completed for wire-1 arrive mid-turn-2
    server.child.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thr-1', turnId: 'wire-1', itemId: 'old', delta: 'GHOST' } })}\n`)
    server.finishTurn('wire-1', 'completed')
    await sleep(30)
    expect(settled).toBe(false) // turn 2 must still be running
    expect(events.some((e) => e.type === 'turn.output.delta' && e.delta === 'GHOST')).toBe(false)

    server.finishTurn('wire-2', 'completed')
    const result = await turn2.waitForCompletion()
    expect(result.status).toBe('completed')
    await session.close(50).catch(() => undefined)
  })

  it('SAME session survives a crash: the next task reconnects and resumes the thread', async () => {
    const server1 = new FakeCodexServer('fake-codex')
    installFlow(server1)
    const server2 = new FakeCodexServer('fake-codex')
    installFlow(server2)
    let current = server1
    const provider = new CodexRuntimeProvider({
      processHost: { label: 'fake-codex app-server (fake, rotating)', spawn: () => current.child },
      binPath: 'fake-codex',
    })
    const events: RuntimeEvent[] = []
    const session = await provider.createSession({ groupId: 'g-1', agentId: 'm-1', role: 'implementation', workspace: '/ws' })
    session.subscribe((event) => events.push(event))
    const turn1 = await session.runTurn({ taskId: 'task-1', text: 'first' })
    server1.finishTurn('wire-1', 'completed')
    await turn1.waitForCompletion()

    // the app-server dies; the member gets a NEW task on the SAME session
    current = server2
    server1.exit(3)
    await vi.waitFor(() => expect(events.some((e) => e.type === 'session.disconnected')).toBe(true))

    const turn2 = await session.runTurn({ taskId: 'task-2', text: 'after the crash' })
    // reconnected + resumed the SAME thread (no fresh thread/start)
    await vi.waitFor(() => {
      expect(server2.received.some((r) => r.method === 'thread/resume')).toBe(true)
    })
    expect(server2.received.some((r) => r.method === 'thread/start')).toBe(false)
    server2.finishTurn('wire-1', 'completed')
    const result = await turn2.waitForCompletion()
    expect(result.status).toBe('completed')
    expect(session.info().providerThreadId).toBe('thr-1')
    await session.close(50).catch(() => undefined)
  })

  it('discovers models dynamically and falls back with the marked catalog', async () => {
    const server = new FakeCodexServer('fake-codex')
    installFlow(server)
    const provider = makeProvider(server)
    const models = await provider.listModels()
    expect(provider.isUsingFallbackCatalog()).toBe(false)
    expect(models.map((m) => m.id)).toEqual(['gpt-5.1-codex', 'o4-mini'])
    expect(models[0]?.reasoningLevels).toEqual(['low', 'high'])

    // discovery failure → clearly-marked fallback, never a crash
    const server2 = new FakeCodexServer('fake-codex', { autoRespond: false })
    const provider2 = makeProvider(server2)
    server2.respondError(1, -32601, 'method not found')
    const fallback = await provider2.listModels()
    expect(fallback).toEqual(CODEX_FALLBACK_MODELS)
    expect(provider2.isUsingFallbackCatalog()).toBe(true)
  })

  it('legacy spawnAgent shim stays backward compatible (sendInput + waitExit)', async () => {
    const server = new FakeCodexServer('fake-codex')
    installFlow(server)
    const provider = makeProvider(server)
    const handle = await provider.spawnAgent({ groupId: 'g-1', agentId: 'm-1', role: 'implementation', workspace: '/ws' })
    const driving = handle.sendInput!('task one')
    await vi.waitFor(() => expect(server.received.some((r) => r.method === 'turn/start')).toBe(true))
    server.finishTurn('wire-1', 'completed')
    await driving
    const result = await handle.waitExit()
    expect(result.code).toBe(0)
    expect(server.received.some((r) => r.method === 'thread/start')).toBe(true)
  })
})