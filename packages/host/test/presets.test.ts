/**
 * Phase 6 tests: Runtime / Role / Team preset architecture.
 */
import { describe, expect, it } from 'vitest'
import {
  RUNTIME_PRESETS,
  ROLE_PRESETS,
  TEAM_PRESETS,
  getRolePreset,
  getRuntimePreset,
  getTeamPreset,
  resolveRolePreset,
  resolveTeamPreset,
} from '../src/runtime/presets.js'

describe('Phase 6: preset architecture', () => {
  it('has three layers: runtime, role, team presets', () => {
    expect(RUNTIME_PRESETS.length).toBeGreaterThan(0)
    expect(ROLE_PRESETS.length).toBeGreaterThan(0)
    expect(TEAM_PRESETS.length).toBeGreaterThan(0)
    expect(getRuntimePreset('codex-high')?.runtime).toBe('codex')
    expect(getRolePreset('implementation')?.name).toBe('Implementation Agent')
    expect(getTeamPreset('software-team')?.memberRoles).toContainEqual({ role: 'implementation', count: 2 })
  })

  it('role preset resolves runtime/model/reasoning from runtime preset', () => {
    const implementation = resolveRolePreset('implementation')
    expect(implementation.runtime).toBe('codex')
    expect(implementation.model).toBe('gpt-5.2')
    expect(implementation.reasoningLevel).toBe('high')
    expect(implementation.systemPrompt).toContain('implementation member')
  })

  it('team preset resolves to a TeamConfig with concrete roles', () => {
    const team = resolveTeamPreset('software-team')
    expect(team.leaderRole.id).toBe('leader')
    expect(team.memberRoles.length).toBe(6) // planner + researcher + architect + 2 implementation + reviewer
    expect(team.memberRoles.filter((r) => r.id.startsWith('implementation')).length).toBe(2)
    expect(team.memberRoles.every((r) => r.runtime.length > 0)).toBe(true)
  })
})
