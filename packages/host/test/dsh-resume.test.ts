/**
 * DSH member resume configuration regression (requirement §9).
 *
 * Proven at three layers:
 *  1. adapter: resumeAgent re-applies the member's OWN provider/model and
 *     re-installs the reasoning setup — never the global default model;
 *  2. provider: DeepSeekHarnessRuntimeProvider.createSession passes the
 *     original config through ensureAgent on resume;
 *  3. product: spawn role with model A + high reasoning → "restart" → the
 *     resumed member still dispatches with model A + high.
 */
import { describe, expect, it } from 'vitest'
import { DshAgentRuntimeAdapter, type AgentRuntimeAdapter, type MemberCreateSpec } from '../src/dsh-adapter.js'
import { DeepSeekHarnessRuntimeProvider } from '../src/runtime/deepseek-harness.js'
import { GroupHost } from '../src/group-host.js'
import { createNoopAdapter } from '../src/dsh-adapter.js'
import { RuntimeRegistry } from '../src/runtime/registry.js'
import { makeStores, makeHarness, type Stores } from './helpers.js'
import type { AgentHandle, AgentRegistry } from '@deepseek-ai/dsh-agent'

// ── fakes for the real adapter ──────────────────────────────────────────────

interface CreateCall {
  sessionId: unknown
  agentOptions: { provider?: string; model?: string }
  setup?: (agentCtx: unknown) => Promise<unknown>
}

interface ResumeCall {
  resumeSessionId: unknown
  agentOptions: { provider?: string; model?: string }
  setup?: (agentCtx: unknown) => Promise<unknown>
  resumeFails?: boolean
}

class FakeAgentRegistry {
  created: CreateCall[] = []
  resumed: ResumeCall[] = []
  live = new Map<string, { status: 'idle' | 'running'; followup(): void; inject(): void; cancel(): void }>()
  /** DSH sessions are durable: resume only works for previously-created ids. */
  readonly persisted = new Set<string>()
  resumeThrows = false

  async create(options: CreateCall): Promise<AgentHandle> {
    this.created.push(options)
    this.persisted.add(String(options.sessionId))
    const agent = { status: 'idle' as const, followup: () => undefined, inject: () => undefined, cancel: () => undefined }
    this.live.set(String(options.sessionId), agent)
    return { agent: agent as never, dispose: async () => { this.live.delete(String(options.sessionId)) } }
  }

  async resume(options: ResumeCall): Promise<AgentHandle> {
    this.resumed.push(options)
    if (this.resumeThrows || !this.persisted.has(String(options.resumeSessionId))) {
      throw new Error('no persisted session')
    }
    const agent = { status: 'idle' as const, followup: () => undefined, inject: () => undefined, cancel: () => undefined }
    this.live.set(String(options.resumeSessionId), agent)
    return { agent: agent as never, dispose: async () => { this.live.delete(String(options.resumeSessionId)) } }
  }

  get(sessionId: unknown): { status: 'idle' | 'running'; followup(): void; inject(): void; cancel(): void } | undefined {
    return this.live.get(String(sessionId))
  }
}

class FakePresets {
  async mount(): Promise<void> {}
}

const GLOBAL_DEFAULT = { provider: 'provider-z', model: 'model-z' }

function makeAdapter(agents: FakeAgentRegistry): DshAgentRuntimeAdapter {
  return new DshAgentRuntimeAdapter({
    agents: agents as unknown as AgentRegistry,
    agentPresets: new FakePresets() as never,
    agentDefaultModel: { currentSelection: () => GLOBAL_DEFAULT },
  })
}

describe('V0.5: DSH member resume configuration drift (regression)', () => {
  it('adapter: resumeAgent re-applies the member config, not the global default', async () => {
    const agents = new FakeAgentRegistry()
    const adapter = makeAdapter(agents)

    await adapter.createMemberAgent({ sessionId: 'm-1', parentId: 'p', provider: 'provider-a', model: 'model-a', reasoningLevel: 'high' })
    expect(agents.created[0]!.agentOptions).toEqual({ provider: 'provider-a', model: 'model-a' })
    expect(agents.created[0]!.setup).toBeDefined() // installs model selection + reasoning

    // simulate host restart: same durable session, brand-new adapter world
    const agents2 = new FakeAgentRegistry()
    agents2.persisted.add('m-1')
    const adapter2 = makeAdapter(agents2)
    const resumed = await adapter2.resumeAgent('m-1', { provider: 'provider-a', model: 'model-a', reasoningLevel: 'high' })
    expect(resumed).toBeDefined()
    expect(agents2.resumed[0]!.agentOptions).toEqual({ provider: 'provider-a', model: 'model-a' }) // NOT model-z
    expect(agents2.resumed[0]!.setup).toBeDefined() // reasoning selection re-installed

    // sanity: an unconfigured resume uses the global default — the product
    // path never does this for role-configured members (see below)
    const agents3 = new FakeAgentRegistry()
    agents3.persisted.add('m-2')
    const adapter3 = makeAdapter(agents3)
    await adapter3.resumeAgent('m-2')
    expect(agents3.resumed[0]!.agentOptions).toEqual({ provider: 'provider-z', model: 'model-z' })
  })

  it('provider: createSession carries the original provider/model/reasoning into ensureAgent', async () => {
    const agents = new FakeAgentRegistry()
    const adapter = makeAdapter(agents)
    const provider = new DeepSeekHarnessRuntimeProvider(adapter as unknown as AgentRuntimeAdapter, { currentSelection: () => GLOBAL_DEFAULT })
    const session = await provider.createSession({ groupId: 'g', agentId: 'm-1', role: 'implementation', model: 'model-a', reasoningLevel: 'high', parentMemberId: 'lead', metadata: { provider: 'provider-a' } })
    await session.start()
    expect(agents.created[0]!.agentOptions).toEqual({ provider: 'provider-a', model: 'model-a' })

    // restart: state is recreated FROM the durable metadata
    const agents2 = new FakeAgentRegistry()
    agents2.persisted.add('m-1')
    const adapter2 = makeAdapter(agents2)
    const provider2 = new DeepSeekHarnessRuntimeProvider(adapter2 as unknown as AgentRuntimeAdapter, { currentSelection: () => GLOBAL_DEFAULT })
    const resumed = await provider2.createSession(
      { groupId: 'g', agentId: 'm-1', role: 'implementation', model: 'model-a', reasoningLevel: 'high', parentMemberId: 'lead', metadata: { provider: 'provider-a' } },
      session.info(),
    )
    await resumed.start()
    expect(agents2.resumed[0]!.agentOptions).toEqual({ provider: 'provider-a', model: 'model-a' })
  })

  it('product: spawn role with model A + high → restart → resume keeps model A + high', async () => {
    const stores = makeStores()
    const agents = new FakeAgentRegistry()
    const adapter = makeAdapter(agents)
    const provider = new DeepSeekHarnessRuntimeProvider(adapter as unknown as AgentRuntimeAdapter, { currentSelection: () => GLOBAL_DEFAULT })
    const registry = new RuntimeRegistry()
    registry.register(provider)

    const h = makeHarness(stores)
    const host1 = new GroupHost({
      groups: h.groups, tasks: h.tasks, channel: h.channel, privateMessages: h.privateMessages,
      activity: h.activity, profiles: h.profiles, notifier: h.notifier,
      adapter: adapter as unknown as AgentRuntimeAdapter, leaders: h.leaders, runtimes: registry,
    })
    const group = await host1.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    await host1.updateTeamConfig(group.groupId, {
      leaderRole: { id: 'leader', name: 'Leader', runtime: 'deepseek-harness' },
      memberRoles: [{ id: 'implementation', name: 'Implementation', runtime: 'deepseek-harness', model: 'model-a', reasoningLevel: 'high', maxInstances: 1, metadata: { provider: 'provider-a' } }],
    }, 'User')
    const member = await host1.spawnByRole('lead-1', { role: 'implementation' })
    expect(member.model).toBe('model-a')
    expect(member.reasoningLevel).toBe('high')
    // durable metadata recorded at spawn (the resume contract, no secrets)
    expect(member.runtimeSession).toBeDefined()

    // "host restart": fresh host + fresh adapter + fresh provider world
    const agents2 = new FakeAgentRegistry()
    agents2.persisted.add(member.sessionId)
    const adapter2 = makeAdapter(agents2)
    const provider2 = new DeepSeekHarnessRuntimeProvider(adapter2 as unknown as AgentRuntimeAdapter, { currentSelection: () => GLOBAL_DEFAULT })
    const registry2 = new RuntimeRegistry()
    registry2.register(provider2)
    const h2 = makeHarness(stores)
    const host2 = new GroupHost({
      groups: h2.groups, tasks: h2.tasks, channel: h2.channel, privateMessages: h2.privateMessages,
      activity: h2.activity, profiles: h2.profiles, notifier: h2.notifier,
      adapter: adapter2 as unknown as AgentRuntimeAdapter, leaders: h2.leaders, runtimes: registry2,
    })
    await host2.resumeAllMemberRuntimes()

    // dispatch one task — the resume spec must be model-a + high
    const task = await host2.createTask('lead-1', { subject: 'x', description: 'x', kind: 'implementation', acceptanceCriteria: ['x'] })
    await host2.assignTask('lead-1', { taskId: task.taskId, ownerId: member.sessionId })
    // adapter2.resumeAgent must have been called with the MEMBER's config
    expect(agents2.resumed).toHaveLength(1)
    expect(agents2.resumed[0]!.agentOptions).toEqual({ provider: 'provider-a', model: 'model-a' })
    expect(agents2.resumed[0]!.setup).toBeDefined()
    // and the member record still says A + high
    const memberAfter = host2.groups.listMembers(group.groupId, () => undefined).find((m) => m.sessionId === member.sessionId)!
    expect(memberAfter.model).toBe('model-a')
    expect(memberAfter.reasoningLevel).toBe('high')
    expect(memberAfter.runtimeSession?.provider).toBe('provider-a')
  })

  it('legacy profile spawning still works with the global default selection', async () => {
    const agents = new FakeAgentRegistry()
    const adapter = makeAdapter(agents)
    await adapter.createMemberAgent({ sessionId: 'm-9', parentId: 'p' })
    expect(agents.created[0]!.agentOptions).toEqual({ provider: 'provider-z', model: 'model-z' })
  })
})