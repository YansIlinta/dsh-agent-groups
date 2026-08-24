/**
 * V0.4 tests: role definitions, team configuration, role-based spawns and the
 * runtime registry.
 */
import { describe, expect, it } from 'vitest'
import type { AgentRoleDefinition, TeamConfig } from '../src/core-types.js'
import { RuntimeRegistry } from '../src/runtime/registry.js'
import { teamConfigFor, templateTeamConfig, ROLE_TEMPLATES, LEADER_ROLE } from '../src/runtime/team-config.js'
import { DEFAULT_REASONING_LEVELS, type AgentRuntimeProvider, type ModelDescriptor, type ReasoningOption, type RuntimeAgentConfig, type RuntimeAgentHandle, type RuntimeCapabilities } from '../src/runtime/base.js'
import { GroupHost, type HostDiscoverySource } from '../src/group-host.js'
import { createNoopAdapter } from '../src/dsh-adapter.js'
import { parseRecord } from '../src/persistence.js'
import { makeStores, makeHarness } from './helpers.js'

/** Deterministic fake provider recording every spawn config. */
class FakeProvider implements AgentRuntimeProvider {
  readonly id: string
  readonly name: string
  available = true
  models: ModelDescriptor[] = [{ id: 'model-a' }, { id: 'model-b' }]
  levels: ReasoningOption[] = [...DEFAULT_REASONING_LEVELS]
  spawns: Array<{ config: RuntimeAgentConfig; resolve: (result: { code: number; output: string }) => void; output: string }> = []

  constructor(id = 'fake-runtime', name = 'Fake Runtime') {
    this.id = id
    this.name = name
  }

  isAvailable(): boolean { return this.available }

  getCapabilities(): RuntimeCapabilities {
    return { models: true, reasoningLevels: true, interactiveSession: false, workspace: true, toolControl: false, streaming: false }
  }

  listModels(): readonly ModelDescriptor[] { return this.models }
  listReasoningLevels(): readonly ReasoningOption[] { return this.levels }

  async spawnAgent(config: RuntimeAgentConfig): Promise<RuntimeAgentHandle> {
    let release!: (result: { code: number; output: string }) => void
    const exit = new Promise<{ code: number; output: string }>((resolve) => { release = resolve })
    const record = { config, resolve: release, output: '' }
    this.spawns.push(record)
    return {
      agentId: config.agentId,
      runtime: this.id,
      status: 'starting',
      waitExit: () => exit,
      sendInput: async (text: string) => { record.output = text },
      stop: async () => { record.resolve({ code: 130, output: record.output }) },
    }
  }

  async stopAgent(handle: RuntimeAgentHandle): Promise<void> { await handle.stop() }

  finish(agentId: string, code = 0, output = 'done'): void {
    const record = this.spawns.find((s) => s.config.agentId === agentId)
    record?.resolve({ code, output })
  }
}

const TEN_MEMBER_TEAM: TeamConfig = {
  leaderRole: LEADER_ROLE,
  memberRoles: [
    { id: 'planner', name: 'Planner', runtime: 'fake-runtime', profile: 'group-member', model: 'model-a', reasoningLevel: 'high', maxInstances: 1 },
    { id: 'implementation', name: 'Implementation Agent', runtime: 'fake-runtime', model: 'model-b', reasoningLevel: 'medium', maxInstances: 2 },
  ],
}

function makeRoleHost(opts: { discovery?: HostDiscoverySource } = {}) {
  const stores = makeStores()
  const h = makeHarness(stores)
  const registry = new RuntimeRegistry()
  const provider = new FakeProvider()
  registry.register(provider)
  const groupHost = new GroupHost({
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
    discovery: opts.discovery,
  })
  return { groupHost, provider, registry }
}

describe('V0.4: role definitions & team configuration', () => {
  it('built-in role templates exist and carry runtime/model/reasoning defaults', () => {
    const ids = ROLE_TEMPLATES.map((r) => r.id)
    expect(ids).toEqual(['planner', 'researcher', 'architect', 'implementation', 'reviewer'])
    const implementation = ROLE_TEMPLATES.find((r) => r.id === 'implementation')!
    expect(implementation.runtime).toBe('deepseek-harness')
    expect(implementation.maxInstances).toBe(4)
    expect(implementation.reasoningLevel).toBe('high')
    expect(implementation.systemPrompt).toContain('implementation member')
  })

  it('team templates derive role sets without runtime coupling', () => {
    const config = templateTeamConfig('software-team')
    expect(config.memberRoles.map((r) => r.id)).toEqual(['planner', 'researcher', 'architect', 'implementation', 'reviewer'])
    expect(templateTeamConfig('general-team').memberRoles[0]?.id).toBe('generalist')
    expect(templateTeamConfig(undefined).memberRoles[0]?.id).toBe('generalist')
  })

  it('old groups (no stored config) migrate to derived defaults', () => {
    const derived = teamConfigFor('software-team', undefined)
    expect(derived.memberRoles.length).toBe(5)
    const custom = teamConfigFor('software-team', TEN_MEMBER_TEAM)
    expect(custom.memberRoles[0]?.model).toBe('model-a')
  })

  it('team-config persists (roundtrip) and records activity', async () => {
    const { groupHost } = makeRoleHost()
    const group = await groupHost.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    const updated = await groupHost.updateTeamConfig(group.groupId, TEN_MEMBER_TEAM, 'User')
    expect(updated.teamConfig?.memberRoles).toHaveLength(2)
    expect(groupHost.teamConfig(updated)).toEqual(TEN_MEMBER_TEAM)
    expect(groupHost.activity.list(group.groupId).some((a) => a.type === 'team_config_updated')).toBe(true)
  })

  it('team config validation rejects duplicates, empty ids, bad reasoning', async () => {
    const { groupHost } = makeRoleHost()
    const group = await groupHost.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    await expect(groupHost.updateTeamConfig(group.groupId, {
      leaderRole: LEADER_ROLE,
      memberRoles: [
        { id: 'dup', name: 'A', runtime: 'dsh' },
        { id: 'dup', name: 'B', runtime: 'dsh' },
      ],
    }, 'User')).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(groupHost.updateTeamConfig(group.groupId, {
      leaderRole: LEADER_ROLE,
      memberRoles: [{ id: 'x', name: 'X', runtime: 'dsh', reasoningLevel: 'ultra' }],
    }, 'User')).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('V0.4: role-based spawn', () => {
  it('spawns through the configured runtime with model/reasoning/profile/workspace', async () => {
    const { groupHost, provider } = makeRoleHost()
    const group = await groupHost.groups.initGroup('lead-1', 'Lead', 'T', { objective: 'demo', acceptanceCriteria: ['x'] }, { cwd: '/ws' })
    await groupHost.updateTeamConfig(group.groupId, TEN_MEMBER_TEAM, 'User')
    const member = await groupHost.spawnByRole('lead-1', { role: 'planner' })
    expect(member.roleId).toBe('planner')
    expect(member.runtime).toBe('fake-runtime')
    expect(member.model).toBe('model-a')
    expect(member.reasoningLevel).toBe('high')
    expect(provider.spawns).toHaveLength(1)
    const spawn = provider.spawns[0]!
    expect(spawn.config.role).toBe('planner')
    expect(spawn.config.model).toBe('model-a')
    expect(spawn.config.reasoningLevel).toBe('high')
    expect(spawn.config.profile).toBe('group-member')
    expect(spawn.config.workspace).toBe('/ws')
    expect(spawn.config.parentMemberId).toBe('lead-1')
    // runtime activity recorded, no credentials in payload
    const activity = groupHost.activity.list(group.groupId)
    expect(activity.some((a) => a.type === 'member_spawn_requested')).toBe(true)
    expect(activity.some((a) => a.type === 'member_runtime_started')).toBe(true)
    for (const event of activity) {
      expect(JSON.stringify(event.payload)).not.toMatch(/key|token|secret/i)
    }
  })

  it('unknown role fails with ROLE_NOT_FOUND', async () => {
    const { groupHost } = makeRoleHost()
    const group = await groupHost.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    await groupHost.updateTeamConfig(group.groupId, TEN_MEMBER_TEAM, 'User')
    await expect(groupHost.spawnByRole('lead-1', { role: 'ghost' })).rejects.toMatchObject({ code: 'ROLE_NOT_FOUND' })
  })

  it('maxInstances blocks extra instances with ROLE_INSTANCE_LIMIT', async () => {
    const { groupHost } = makeRoleHost()
    const group = await groupHost.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    await groupHost.updateTeamConfig(group.groupId, TEN_MEMBER_TEAM, 'User')
    await groupHost.spawnByRole('lead-1', { role: 'planner' })
    await groupHost.spawnByRole('lead-1', { role: 'implementation' })
    await groupHost.spawnByRole('lead-1', { role: 'implementation' })
    // implementation allows 2 — the third is refused
    await expect(groupHost.spawnByRole('lead-1', { role: 'implementation' }))
      .rejects.toMatchObject({ code: 'ROLE_INSTANCE_LIMIT' })
    // removed members free a slot
    const first = groupHost.groups.listMembers(group.groupId, () => undefined).find((m) => m.roleId === 'implementation')!
    await groupHost.userRemoveMember(group.groupId, first.sessionId)
    const retry = await groupHost.spawnByRole('lead-1', { role: 'implementation' })
    expect(retry.roleId).toBe('implementation')
  })

  it('unavailable runtime fails clearly (RUNTIME_UNAVAILABLE), never silently falls back', async () => {
    const { groupHost, provider } = makeRoleHost()
    const group = await groupHost.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    await groupHost.updateTeamConfig(group.groupId, TEN_MEMBER_TEAM, 'User')
    provider.available = false
    await expect(groupHost.spawnByRole('lead-1', { role: 'planner' }))
      .rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    const notRegistered = await groupHost.updateTeamConfig(group.groupId, {
      leaderRole: LEADER_ROLE,
      memberRoles: [{ id: 'x', name: 'X', runtime: 'claude-code' }],
    }, 'User')
    void notRegistered
    await expect(groupHost.spawnByRole('lead-1', { role: 'x' }))
      .rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  })

  it('invalid model fails with MODEL_UNAVAILABLE when the runtime exposes a catalog', async () => {
    const { groupHost, provider } = makeRoleHost()
    const group = await groupHost.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    await groupHost.updateTeamConfig(group.groupId, TEN_MEMBER_TEAM, 'User')
    provider.models = [{ id: 'model-a' }]
    const badConfig = {
      leaderRole: LEADER_ROLE,
      memberRoles: [{ id: 'planner', name: 'Planner', runtime: 'fake-runtime', model: 'model-zzz', reasoningLevel: 'high', maxInstances: 1 }],
    }
    await groupHost.updateTeamConfig(group.groupId, badConfig, 'User')
    await expect(groupHost.spawnByRole('lead-1', { role: 'planner' }))
      .rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
  })

  it('invalid reasoning level fails with REASONING_UNAVAILABLE', async () => {
    const { groupHost, provider } = makeRoleHost()
    const group = await groupHost.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    await groupHost.updateTeamConfig(group.groupId, {
      leaderRole: LEADER_ROLE,
      memberRoles: [{ id: 'p', name: 'P', runtime: 'fake-runtime', reasoningLevel: 'high' }],
    }, 'User')
    // the runtime only ships low/medium — high is refused at spawn time
    provider.levels = [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }]
    await expect(groupHost.spawnByRole('lead-1', { role: 'p' }))
      .rejects.toMatchObject({ code: 'REASONING_UNAVAILABLE' })
  })

  it('legacy profile spawn stays compatible (no role involved)', async () => {
    const { groupHost } = makeRoleHost()
    const group = await groupHost.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    const member = await groupHost.spawnMember('lead-1', { profileId: 'frontend-engineer' })
    expect(member.profileId).toBe('frontend-engineer')
    expect(member.roleId).toBeUndefined()
  })

  it('V0.5: a process exit NEVER completes a task — only a completed TURN does', async () => {
    const { groupHost, provider } = makeRoleHost()
    const group = await groupHost.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    await groupHost.updateTeamConfig(group.groupId, TEN_MEMBER_TEAM, 'User')
    const member = await groupHost.spawnByRole('lead-1', { role: 'implementation' })
    const task = await groupHost.createTask('lead-1', { subject: 'build it', description: '…', kind: 'implementation', acceptanceCriteria: ['works'] })
    await groupHost.assignTask('lead-1', { taskId: task.taskId, ownerId: member.sessionId })
    const assigned = groupHost.tasks.listTasks(group.groupId).find((t) => t.taskId === task.taskId)!
    expect(assigned.ownerId).toBe(member.sessionId)
    // The legacy process exits successfully — this must NOT become a result.
    provider.finish(member.sessionId, 0, 'implemented everything')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const after = groupHost.tasks.listTasks(group.groupId).find((t) => t.taskId === task.taskId)!
    expect(after.result).toBeUndefined()
    expect(['pending', 'in_progress']).toContain(after.status)
    // ... and the member is marked failed (a runtime without a completed turn).
    const memberAfter = groupHost.groups.listMembers(group.groupId, () => undefined).find((m) => m.sessionId === member.sessionId)!
    expect(memberAfter.status).toBe('failed')
    expect(groupHost.activity.list(group.groupId).some((a) => a.type === 'member_runtime_stopped')).toBe(true)
  })

  it('external failure marks the member failed and records runtime_failed', async () => {
    const { groupHost, provider } = makeRoleHost()
    const group = await groupHost.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    await groupHost.updateTeamConfig(group.groupId, TEN_MEMBER_TEAM, 'User')
    const member = await groupHost.spawnByRole('lead-1', { role: 'implementation' })
    provider.finish(member.sessionId, 1, 'boom')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const after = groupHost.groups.listMembers(group.groupId, () => undefined).find((m) => m.sessionId === member.sessionId)!
    expect(after.status).toBe('failed')
    expect(groupHost.activity.list(group.groupId).some((a) => a.type === 'member_runtime_failed')).toBe(true)
  })

  it('teamStatus reports roles with instance counts for the Leader', async () => {
    const { groupHost, groupHost: host } = makeRoleHost()
    void host
    const group = await groupHost.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    await groupHost.updateTeamConfig(group.groupId, TEN_MEMBER_TEAM, 'User')
    await groupHost.spawnByRole('lead-1', { role: 'planner' })
    const status = groupHost.teamStatus('lead-1') as { roles: Array<{ id: string; running: number; maxInstances: number | null }> }
    expect(status.roles.find((r) => r.id === 'planner')?.running).toBe(1)
    expect(status.roles.find((r) => r.id === 'planner')?.maxInstances).toBe(1)
    void group
  })
})

describe('V0.4: runtime registry', () => {
  it('register/get/list and duplicate registration guard', () => {
    const registry = new RuntimeRegistry()
    const provider = new FakeProvider('probe')
    registry.register(provider)
    expect(registry.get('probe')).toBe(provider)
    expect(registry.list().map((p) => p.id)).toEqual(['probe'])
    expect(() => registry.register(provider)).toThrow(/already registered/)
  })
})

describe('V0.4.1: optional role provider/reasoningEffort (backward compatible)', () => {
  it('role definitions accept optional provider/reasoningEffort and persist (roundtrip)', async () => {
    const { groupHost } = makeRoleHost()
    const group = await groupHost.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    const config: TeamConfig = {
      leaderRole: LEADER_ROLE,
      memberRoles: [{
        id: 'impl', name: 'Impl', runtime: 'fake-runtime',
        provider: 'deepseek-official', model: 'deepseek-v4-flash',
        reasoningLevel: 'high', reasoningEffort: 'max', maxInstances: 1,
      }],
    }
    const updated = await groupHost.updateTeamConfig(group.groupId, config, 'User')
    expect(groupHost.teamConfig(updated).memberRoles[0]?.provider).toBe('deepseek-official')
    expect(groupHost.teamConfig(updated).memberRoles[0]?.reasoningEffort).toBe('max')
    // the DURABLE record validates at the read boundary WITH the new fields.
    const parsed = parseRecord<any>('groups', updated)
    expect(parsed.teamConfig.memberRoles[0].provider).toBe('deepseek-official')
    expect(parsed.teamConfig.memberRoles[0].reasoningEffort).toBe('max')
  })

  it('legacy records without the new fields still load (no migration break)', async () => {
    const { groupHost } = makeRoleHost()
    const group = await groupHost.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    // a pre-V0.4.1 team config: roles without provider / reasoningEffort
    const legacy = await groupHost.updateTeamConfig(group.groupId, {
      leaderRole: LEADER_ROLE,
      memberRoles: [{ id: 'p', name: 'P', runtime: 'fake-runtime', model: 'model-a', reasoningLevel: 'high', maxInstances: 1 }],
    }, 'User')
    const parsedGroup = parseRecord<any>('groups', legacy)
    expect(parsedGroup.teamConfig.memberRoles[0].reasoningLevel).toBe('high')
    expect(parsedGroup.teamConfig.memberRoles[0].provider).toBeUndefined()
    expect(parsedGroup.teamConfig.memberRoles[0].reasoningEffort).toBeUndefined()

    // a legacy member + runtimeSession (no provider/reasoningEffort)
    const legacyMember = { sessionId: 'm-1', groupId: group.groupId, profileId: 'group-member', name: 'M', status: 'idle', role: 'member', joinedAt: 1, runtime: 'deepseek-harness', model: 'm-a', reasoningLevel: 'high' }
    const parsedMember = parseRecord<any>('members', legacyMember)
    expect(parsedMember.reasoningLevel).toBe('high')
    expect(parsedMember.provider).toBeUndefined()
    expect(parsedMember.reasoningEffort).toBeUndefined()
    const parsedWithSession = parseRecord<any>('members', {
      ...legacyMember,
      runtimeSession: { runtime: 'deepseek-harness', provider: 'deepseek-official', model: 'm-a', reasoningLevel: 'high', state: 'idle' },
    })
    expect(parsedWithSession.runtimeSession.provider).toBe('deepseek-official')
    // a NEW member record carrying the V0.4.1 fields round-trips too
    const parsedNew = parseRecord<any>('members', { ...legacyMember, provider: 'deepseek-official', reasoningEffort: 'max' })
    expect(parsedNew.provider).toBe('deepseek-official')
    expect(parsedNew.reasoningEffort).toBe('max')
  })

  it('updateTeamConfig rejects secret-named fields anywhere in a role payload', async () => {
    const { groupHost } = makeRoleHost()
    const group = await groupHost.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    const role = (id: string, extra: Record<string, unknown>): AgentRoleDefinition =>
      ({ id, name: id, runtime: 'deepseek-harness', ...extra }) as unknown as AgentRoleDefinition
    const cases: Array<[string, TeamConfig]> = [
      ['apiKey at top level', { leaderRole: LEADER_ROLE, memberRoles: [role('a', { apiKey: 'sk-x' })] }],
      ['api_key separator variant', { leaderRole: LEADER_ROLE, memberRoles: [role('b', { api_key: 'x' })] }],
      ['secret nested in metadata', { leaderRole: LEADER_ROLE, memberRoles: [role('c', { metadata: { secret: 'x' } })] }],
      ['credentialRef in metadata', { leaderRole: LEADER_ROLE, memberRoles: [role('d', { metadata: { credentialRef: 'DEEPSEEK_API_KEY' } })] }],
      ['credentials on leaderRole', { leaderRole: role('leader', { credentials: ['a'] }), memberRoles: [] }],
    ]
    for (const [label, bad] of cases) {
      await expect(groupHost.updateTeamConfig(group.groupId, bad, 'User'), label)
        .rejects.toMatchObject({ code: 'CONFLICT' })
    }
  })

  it('rejects empty/whitespace provider or reasoningEffort', async () => {
    const { groupHost } = makeRoleHost()
    const group = await groupHost.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    await expect(groupHost.updateTeamConfig(group.groupId, {
      leaderRole: LEADER_ROLE,
      memberRoles: [{ id: 'a', name: 'A', runtime: 'fake-runtime', provider: ' ' }],
    }, 'User')).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(groupHost.updateTeamConfig(group.groupId, {
      leaderRole: LEADER_ROLE,
      memberRoles: [{ id: 'b', name: 'B', runtime: 'fake-runtime', reasoningEffort: '' }],
    }, 'User')).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('without discovery wired, provider/reasoningEffort are shape-validated only (runtime gates later)', async () => {
    const { groupHost } = makeRoleHost()
    const group = await groupHost.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    const updated = await groupHost.updateTeamConfig(group.groupId, {
      leaderRole: LEADER_ROLE,
      memberRoles: [{ id: 'a', name: 'A', runtime: 'deepseek-harness', provider: 'mystery-provider', reasoningEffort: 'mystery-effort' }],
    }, 'User')
    expect(updated.teamConfig?.memberRoles[0]?.provider).toBe('mystery-provider')
    expect(updated.teamConfig?.memberRoles[0]?.reasoningEffort).toBe('mystery-effort')
  })

  it('gates provider/effort against harness discovery when wired (DSH runtime only)', async () => {
    const discovery: HostDiscoverySource = {
      listProviderIds: async () => ['deepseek-official', 'opencode-go'],
      listReasoningEfforts: async (provider) => (provider === 'deepseek-official' ? ['high', 'max'] : undefined),
      listProviders: () => [
        { id: 'deepseek-official', name: 'DeepSeek' },
        { id: 'opencode-go', name: 'OpenCode Go' },
      ],
      listModels: async () => [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
      resolveReasoning: async (provider) => (provider === 'deepseek-official'
        ? { efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' }
        : undefined),
      listConfigurableProviders: () => [],
      credentialStatus: async (provider) => ({ provider }),
    }
    const { groupHost } = makeRoleHost({ discovery })
    const group = await groupHost.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    // DSH runtime + unknown provider → PROVIDER_UNAVAILABLE
    await expect(groupHost.updateTeamConfig(group.groupId, {
      leaderRole: LEADER_ROLE,
      memberRoles: [{ id: 'a', name: 'A', runtime: 'deepseek-harness', provider: 'not-a-provider' }],
    }, 'User')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
    // DSH runtime + known provider + unsupported effort → REASONING_UNAVAILABLE
    await expect(groupHost.updateTeamConfig(group.groupId, {
      leaderRole: LEADER_ROLE,
      memberRoles: [{ id: 'b', name: 'B', runtime: 'deepseek-harness', provider: 'deepseek-official', reasoningEffort: 'medium' }],
    }, 'User')).rejects.toMatchObject({ code: 'REASONING_UNAVAILABLE' })
    // DSH runtime + known provider + known effort passes
    const ok = await groupHost.updateTeamConfig(group.groupId, {
      leaderRole: LEADER_ROLE,
      memberRoles: [{ id: 'c', name: 'C', runtime: 'deepseek-harness', provider: 'deepseek-official', reasoningEffort: 'max' }],
    }, 'User')
    expect(ok.teamConfig?.memberRoles[0]?.reasoningEffort).toBe('max')
    // non-DSH runtime keeps current behavior: provider/effort NOT gated
    const legacy = await groupHost.updateTeamConfig(group.groupId, {
      leaderRole: LEADER_ROLE,
      memberRoles: [{ id: 'd', name: 'D', runtime: 'claude', provider: 'anything', reasoningEffort: 'whatever' }],
    }, 'User')
    expect(legacy.teamConfig?.memberRoles[0]?.provider).toBe('anything')
    expect(legacy.teamConfig?.memberRoles[0]?.reasoningEffort).toBe('whatever')
  })

  it('rejects an abstract reasoningLevel not offered by the route (DeepSeek medium incident, Q3 warning)', async () => {
    const discovery: HostDiscoverySource = {
      listProviderIds: async () => ['deepseek-official', 'opencode-go'],
      listReasoningEfforts: async (provider) => (provider === 'deepseek-official' ? ['high', 'max'] : undefined),
      listProviders: () => [
        { id: 'deepseek-official', name: 'DeepSeek' },
        { id: 'opencode-go', name: 'OpenCode Go' },
      ],
      listModels: async () => [],
      resolveReasoning: async () => undefined,
      listConfigurableProviders: () => [],
      credentialStatus: async (provider) => ({ provider }),
    }
    const { groupHost } = makeRoleHost({ discovery })
    const group = await groupHost.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    // legacy level 'medium' only (no reasoningEffort) on a resolvable route:
    // the request path would reject it (UNSUPPORTED_REASONING_EFFORT) — the
    // save must fail loudly instead, listing the offered effort ids.
    const rejection = groupHost.updateTeamConfig(group.groupId, {
      leaderRole: LEADER_ROLE,
      memberRoles: [{ id: 'a', name: 'A', runtime: 'deepseek-harness', provider: 'deepseek-official', reasoningLevel: 'medium' }],
    }, 'User')
    await expect(rejection).rejects.toMatchObject({ code: 'REASONING_UNAVAILABLE' })
    await expect(rejection).rejects.toThrow(/offered: high, max/)
    // 'high' IS an offered effort id → the legacy level passes as-is
    const ok = await groupHost.updateTeamConfig(group.groupId, {
      leaderRole: LEADER_ROLE,
      memberRoles: [{ id: 'b', name: 'B', runtime: 'deepseek-harness', provider: 'deepseek-official', reasoningLevel: 'high' }],
    }, 'User')
    expect(ok.teamConfig?.memberRoles[0]?.reasoningLevel).toBe('high')
    // route with unresolvable efforts → accept, the runtime gates at request time
    const unresolvable = await groupHost.updateTeamConfig(group.groupId, {
      leaderRole: LEADER_ROLE,
      memberRoles: [{ id: 'c', name: 'C', runtime: 'deepseek-harness', provider: 'opencode-go', reasoningLevel: 'low' }],
    }, 'User')
    expect(unresolvable.teamConfig?.memberRoles[0]?.reasoningLevel).toBe('low')
    // a pinned reasoningEffort takes precedence: the legacy level is ignored
    const explicit = await groupHost.updateTeamConfig(group.groupId, {
      leaderRole: LEADER_ROLE,
      memberRoles: [{ id: 'd', name: 'D', runtime: 'deepseek-harness', provider: 'deepseek-official', reasoningLevel: 'medium', reasoningEffort: 'max' }],
    }, 'User')
    expect(explicit.teamConfig?.memberRoles[0]?.reasoningEffort).toBe('max')
  })

  it('role provider/reasoningEffort flow into the spawn config and the member record', async () => {
    const { groupHost, provider } = makeRoleHost()
    const group = await groupHost.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    await groupHost.updateTeamConfig(group.groupId, {
      leaderRole: LEADER_ROLE,
      memberRoles: [{ id: 'impl', name: 'Impl', runtime: 'fake-runtime', provider: 'deepseek-official', model: 'model-a', reasoningLevel: 'medium', reasoningEffort: 'max', maxInstances: 1 }],
    }, 'User')
    const member = await groupHost.spawnByRole('lead-1', { role: 'impl' })
    expect(provider.spawns).toHaveLength(1)
    const spawn = provider.spawns[0]!
    expect(spawn.config.provider).toBe('deepseek-official')
    expect(spawn.config.reasoningEffort).toBe('max')
    expect(spawn.config.reasoningLevel).toBe('medium') // legacy field still carried
    expect(member.provider).toBe('deepseek-official')
    expect(member.reasoningEffort).toBe('max')
    expect(member.model).toBe('model-a')
    // effective provider/effort in the activity payload, never secrets
    const spawnEvent = groupHost.activity.list(group.groupId).find((a) => a.type === 'member_spawn_requested')
    expect(spawnEvent?.payload).toMatchObject({ role: 'impl', provider: 'deepseek-official', reasoningEffort: 'max' })
    for (const event of groupHost.activity.list(group.groupId)) {
      expect(JSON.stringify(event.payload)).not.toMatch(/key|token|secret/i)
    }
  })
})
