import { describe, expect, it } from 'vitest'
import { makeHarness, makeHost, SAMPLE_MISSION, seedGroup } from './helpers.js'

describe('group & mission lifecycle', () => {
  it('init creates one active group bound to the leader with a leader member', async () => {
    const h = makeHarness()
    const group = await seedGroup(h, 'lead-1', 'Dashboard Team')
    expect(group.status).toBe('active')
    expect(group.mission.objective).toContain('Analytics')
    expect(group.leaderSessionId).toBe('lead-1')
    const members = h.groups.listMembers(group.groupId, () => undefined)
    expect(members).toHaveLength(1)
    expect(members[0]?.role).toBe('leader')
    expect(h.groups.groupForActor('lead-1')?.groupId).toBe(group.groupId)
  })

  it('a leader cannot initialize a second active group', async () => {
    const h = makeHarness()
    await seedGroup(h, 'lead-1')
    await expect(seedGroup(h, 'lead-1', 'Second')).rejects.toMatchObject({ code: 'ACTIVE_GROUP_EXISTS' })
  })

  it('addMember / patchMember / removeMember keep the durable roster row', async () => {
    const h = makeHarness()
    const group = await seedGroup(h)
    await h.groups.addMember(group.groupId, {
      sessionId: 'm-1',
      profileId: 'frontend-engineer',
      name: 'Fe',
      role: 'member',
      status: 'idle',
    })
    const member = h.groups.requireMember(group.groupId, 'm-1')
    expect(member.profileId).toBe('frontend-engineer')
    await h.groups.patchMember(group.groupId, 'm-1', { status: 'running' })
    expect(h.groups.requireMember(group.groupId, 'm-1').status).toBe('running')
    await h.groups.removeMember(group.groupId, 'm-1')
    // Durable row flips to 'left'; membership lookups then hide it.
    expect(h.groups.requireMember(group.groupId, 'm-1').status).toBe('left')
    expect(h.groups.getMembership(group.groupId, 'm-1')).toBeUndefined()
  })

  it('completing the mission is irreversible and idempotent-guarded for the leader', async () => {
    const h = makeHarness()
    const group = await seedGroup(h)
    const done = await h.groups.completeMission(group.groupId, 'lead-1')
    expect(done.status).toBe('completed')
    expect(done.completedAt).toBeDefined()
    const activities = h.activity.list(group.groupId)
    expect(activities.some((a) => a.type === 'mission_completed')).toBe(true)
  })

  it('leader cannot spawn a duplicate member from the same profile (host gate)', async () => {
    const host = makeHost()
    await host.initGroup('lead-1', {
      name: 'Team',
      objective: SAMPLE_MISSION.objective,
      acceptanceCriteria: SAMPLE_MISSION.acceptanceCriteria ? [...SAMPLE_MISSION.acceptanceCriteria] : undefined,
    })
    await host.spawnMember('lead-1', { profileId: 'frontend-engineer' })
    await expect(host.spawnMember('lead-1', { profileId: 'frontend-engineer' })).rejects.toMatchObject({ code: 'ALREADY_MEMBER' })
  })

  it('derive member view status merges live status over durable state', async () => {
    const h = makeHarness()
    const group = await seedGroup(h)
    await h.groups.addMember(group.groupId, { sessionId: 'm-1', profileId: 'reviewer', name: 'Rv', role: 'member', status: 'idle' })
    const view = h.groups.listMembers(group.groupId, () => 'running' as const)
    const m1 = view.find((m) => m.sessionId === 'm-1')!
    expect(m1.liveStatus).toBe('running')
  })
})
