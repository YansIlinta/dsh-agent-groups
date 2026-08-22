/**
 * V0.4 tests: role definitions, team configuration, role-based spawns and the
 * runtime registry.
 */
import { describe, expect, it } from 'vitest'
import type { AgentRoleDefinition, TeamConfig } from '../src/core-types.js'
import { RuntimeRegistry } from '../src/runtime/registry.js'
import { teamConfigFor, templateTeamConfig, ROLE_TEMPLATES, LEADER_ROLE } from '../src/runtime/team-config.js'
import { DEFAULT_REASONING_LEVELS, type AgentRuntimeProvider, type ModelDescriptor, type ReasoningOption, type RuntimeAgentConfig, type RuntimeAgentHandle, type RuntimeCapabilities } from '../src/runtime/base.js'
import { GroupHost } from '../src/group-host.js'
import { createNoopAdapter } from '../src/dsh-adapter.js'
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

function makeRoleHost() {
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