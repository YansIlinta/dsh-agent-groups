import { describe, expect, it } from 'vitest'
import { requireTemplate, templateMemberSlots } from '../src/template-registry.js'
import { templateTeamConfig } from '../src/runtime/team-config.js'
import { makeHost } from './helpers.js'

describe('Create Flow workspace', () => {
  it('keeps the legacy eager roster empty', () => {
    const template = requireTemplate('content-team')

    expect(template.name).toBe('Create Flow')
    expect(template.members).toEqual([])
    expect(templateMemberSlots(template)).toEqual([])
  })

  it('exposes dedicated production roles as a lazy role pool', () => {
    const config = templateTeamConfig('content-team')

    expect(config.leaderRole.name).toBe('Create Flow Lead')
    expect(config.memberRoles.map((role) => role.id)).toEqual([
      'topic-strategist',
      'researcher',
      'material-producer',
      'scriptwriter',
      'video-producer',
    ])
    expect(config.memberRoles.map((role) => role.defaultInstances)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(config.memberRoles.find((role) => role.id === 'researcher')?.maxInstances).toBe(3)
  })

  it('creates a Create Flow group with no specialist sessions until work needs them', async () => {
    const host = makeHost()
    await host.leaders.register('flow-lead')

    const group = await host.userCreateGroup({
      leaderSessionId: 'flow-lead',
      name: 'Lazy Flow',
      objective: 'Produce a short evidence-backed video.',
      templateId: 'content-team',
    })

    const members = host.groups.listMembers(group.groupId, () => undefined)
    expect(members.filter((member) => member.role === 'member')).toHaveLength(0)
    expect(host.teamConfig(group).memberRoles.map((role) => role.id)).toEqual([
      'topic-strategist',
      'researcher',
      'material-producer',
      'scriptwriter',
      'video-producer',
    ])
  })
})
