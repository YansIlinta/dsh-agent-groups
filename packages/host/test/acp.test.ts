import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ACPAgentRuntimeProvider } from '../src/runtime/acp.js'
import type { RuntimeEvent } from '../src/runtime/events.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))
const providers: ACPAgentRuntimeProvider[] = []

function provider(statePath: string): ACPAgentRuntimeProvider {
  const instance = new ACPAgentRuntimeProvider({
    id: 'fake-acp',
    name: 'Fake ACP',
    command: process.execPath,
    args: [fixture, statePath],
    source: 'custom',
    models: [{ id: 'fake-pro', name: 'Fake Pro', reasoningLevels: ['high'] }],
  }, { requestDeadlineMs: 1_000 })
  providers.push(instance)
  return instance
}

afterEach(async () => {
  await Promise.all(providers.splice(0).map((item) => item.dispose()))
})

describe('ACPAgentRuntimeProvider', () => {
  it('keeps one ACP session across sequential turns and negotiates capabilities', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-acp-'))
    const statePath = join(dir, 'state.json')
    const runtime = provider(statePath)
    await expect(runtime.getReadiness()).resolves.toMatchObject({ launchable: true, initialized: false, executor: 'local' })
    await expect(runtime.validate()).resolves.toMatchObject({ launchable: true, initialized: true, executor: 'local' })
    const session = runtime.createSession({
      groupId: 'g1', agentId: 'm1', role: 'implementation', workspace: dir, model: 'fake-pro', reasoningLevel: 'high',
    })
    const events: RuntimeEvent[] = []
    session.subscribe((event) => events.push(event))
    await session.start()
    const sessionId = session.providerSessionId
    const first = await (await session.startTaskTurn({ taskId: 't1', text: 'first' })).waitForCompletion()
    const second = await (await session.startTaskTurn({ taskId: 't2', text: 'second' })).waitForCompletion()
    expect(session.providerSessionId).toBe(sessionId)
    expect(first.output).toContain('reply:first:count=1')
    expect(second.output).toContain('reply:second:count=2')
    expect(session.info().providerCapabilities).toMatchObject({ resumeSession: true, steering: true, images: true })
    await expect(runtime.getReadiness()).resolves.toMatchObject({ launchable: true, initialized: true })
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(2)
  })

  it('resumes the same durable session after the ACP process restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-acp-resume-'))
    const statePath = join(dir, 'state.json')
    const firstProvider = provider(statePath)
    const first = firstProvider.createSession({ groupId: 'g1', agentId: 'm1', role: 'implementation', workspace: dir })
    await first.start()
    await (await first.startTaskTurn({ text: 'before-restart' })).waitForCompletion()
    const durable = first.info()
    await firstProvider.dispose()

    const resumed = provider(statePath).createSession({ groupId: 'g1', agentId: 'm1', role: 'implementation', workspace: dir }, durable)
    await resumed.start()
    const result = await (await resumed.startTaskTurn({ text: 'after-restart' })).waitForCompletion()
    expect(resumed.providerSessionId).toBe(durable.providerSessionId)
    expect(result.output).toContain('count=2')
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    expect(Object.keys(state.sessions)).toEqual([durable.providerSessionId])
  })

  it('surfaces permission requests and resolves them explicitly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-acp-permission-'))
    const session = provider(join(dir, 'state.json')).createSession({ groupId: 'g1', agentId: 'm1', role: 'implementation', workspace: dir })
    await session.start()
    const handle = await session.startTaskTurn({ taskId: 't1', text: 'needs permission' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const [request] = session.listPendingRequests()
    expect(request).toMatchObject({ requestKind: 'permission', taskId: 't1' })
    expect(await session.respondToRequest(request!.requestId, 'allow-once')).toBe(true)
    const result = await handle.waitForCompletion()
    expect(result.output).toContain('permission:allow-once')
  })

  it('feature-detects steering and treats cancellation as cancellation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-acp-steer-'))
    const session = provider(join(dir, 'state.json')).createSession({ groupId: 'g1', agentId: 'm1', role: 'implementation', workspace: dir })
    await session.start()
    const handle = await session.startTaskTurn({ taskId: 't1', text: 'wait-for-cancel' })
    await expect(session.steerActiveTurn!({ text: 'change direction' })).resolves.toEqual({ steered: true })
    await session.interrupt('test')
    await expect(handle.waitForCompletion()).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('isolates parallel member sessions on one ACP process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-acp-parallel-'))
    const runtime = provider(join(dir, 'state.json'))
    const left = runtime.createSession({ groupId: 'g1', agentId: 'left', role: 'implementation', workspace: dir })
    const right = runtime.createSession({ groupId: 'g1', agentId: 'right', role: 'review', workspace: dir })
    await Promise.all([left.start(), right.start()])
    const [leftResult, rightResult] = await Promise.all([
      left.startTaskTurn({ text: 'left-work' }).then((handle) => handle.waitForCompletion()),
      right.startTaskTurn({ text: 'right-work' }).then((handle) => handle.waitForCompletion()),
    ])
    expect(left.providerSessionId).not.toBe(right.providerSessionId)
    expect(leftResult.output).toContain('reply:left-work')
    expect(rightResult.output).toContain('reply:right-work')
  })

  it('fails loudly when a durable ACP session cannot resume', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-acp-resume-fail-'))
    const session = provider(join(dir, 'state.json')).createSession(
      { groupId: 'g1', agentId: 'm1', role: 'implementation', workspace: dir },
      { runtime: 'fake-acp', providerSessionId: 'missing-session', state: 'idle' },
    )
    await expect(session.start()).rejects.toThrow('resume failed')
    expect(session.status).toBe('failed')
  })

  it('maps malformed output plus process crash to disconnection and a failed turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-acp-crash-'))
    const session = provider(join(dir, 'state.json')).createSession({ groupId: 'g1', agentId: 'm1', role: 'implementation', workspace: dir })
    const events: RuntimeEvent[] = []
    session.subscribe((event) => events.push(event))
    await session.start()
    const result = await (await session.startTaskTurn({ taskId: 't-crash', text: 'crash-process' })).waitForCompletion()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(result.status).toBe('failed')
    expect(events.some((event) => event.type === 'session.disconnected')).toBe(true)
    expect(events.some((event) => event.type === 'turn.completed')).toBe(false)
  })
})
