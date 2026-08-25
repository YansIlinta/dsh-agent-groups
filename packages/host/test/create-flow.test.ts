import { describe, expect, it } from 'vitest'
import { requireTemplate, templateMemberSlots } from '../src/template-registry.js'
import { templateTeamConfig } from '../src/runtime/team-config.js'

describe('Create Flow workspace', () => {
  it('turns the content template into the end-to-end production team', () => {
    const template = requireTemplate('content-team')

    expect(template.name).toBe('Create Flow')
    expect(templateMemberSlots(template).map((slot) => slot.role)).toEqual([
      'Topic Strategist',
      'Researcher',
      'Material Producer',
      'Scriptwriter',
      'Video Producer',
    ])
  })

  it('materializes dedicated production runtime roles', () => {
    const config = templateTeamConfig('content-team')

    expect(config.leaderRole.name).toBe('Create Flow Lead')
    expect(config.memberRoles.map((role) => role.id)).toEqual([
      'topic-strategist',
      'researcher',
      'material-producer',
      'scriptwriter',
      'video-producer',
    ])
    expect(config.memberRoles.map((role) => role.defaultInstances)).toEqual([1, 1, 1, 1, 1])
  })
})
