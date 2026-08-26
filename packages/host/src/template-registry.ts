/**
 * Team Templates (第 3/4 节): preset team compositions the user can start a
 * group from, then adjust before/after creation. Built-in for V0.2; the
 * selected template id is persisted on the group record (`templateId`).
 * @module @dsh-agent-groups/host
 */

import type { TeamTemplate } from './core-types.js'
import { GroupError } from './group-service.js'

/**
 * Built-in templates may declare a role roster without eagerly materializing
 * every role as a running Member. This stays local to the built-in registry so
 * the durable TeamTemplate transport shape remains backwards compatible.
 */
interface BuiltinTeamTemplate extends TeamTemplate {
  readonly eagerMembers?: boolean
}

export const TEAM_TEMPLATES: readonly BuiltinTeamTemplate[] = [
  {
    id: 'software-team',
    name: 'Software Team',
    description: 'Full-stack build out: research, architecture, backend + frontend implementation, and review.',
    leaderProfile: 'product-planner',
    icon: '🖥️',
    members: [
      { role: 'Researcher', profile: 'implementation-engineer', count: 1 },
      { role: 'Architect', profile: 'implementation-engineer', count: 1 },
      { role: 'Backend Engineer', profile: 'implementation-engineer', count: 1 },
      { role: 'Frontend Engineer', profile: 'frontend-engineer', count: 1 },
      { role: 'Reviewer', profile: 'reviewer', count: 1 },
    ],
  },
  {
    id: 'research-team',
    name: 'Research Team',
    description: 'Discovery and analysis: parallel researchers feeding an analyst and a writer.',
    leaderProfile: 'product-planner',
    icon: '🔬',
    members: [
      { role: 'Researcher', profile: 'implementation-engineer', count: 2 },
      { role: 'Analyst', profile: 'acceptance-agent', count: 1 },
      { role: 'Writer', profile: 'reviewer', count: 1 },
    ],
  },
  {
    id: 'content-team',
    name: 'Create Flow',
    description: 'Agent-native video production: persistent roles are spawned on demand while research/material work can fan out in parallel.',
    leaderProfile: 'product-planner',
    icon: '🎬',
    // The roster remains visible as template capability metadata, but Create
    // Flow uses the V0.4 role-based path to materialize specialists lazily.
    eagerMembers: false,
    members: [
      { role: 'Topic Strategist', profile: 'implementation-engineer', count: 1 },
      { role: 'Researcher', profile: 'implementation-engineer', count: 1 },
      { role: 'Material Producer', profile: 'implementation-engineer', count: 1 },
      { role: 'Scriptwriter', profile: 'reviewer', count: 1 },
      { role: 'Video Producer', profile: 'implementation-engineer', count: 1 },
    ],
  },
  {
    id: 'general-team',
    name: 'General Team',
    description: 'One leader plus generalist implementers for small, flexible missions.',
    leaderProfile: 'product-planner',
    icon: '🧩',
    members: [{ role: 'Generalist', profile: 'implementation-engineer', count: 2 }],
  },
]

/**
 * Flatten member slots that should be materialized eagerly at group creation.
 * A lazy template still declares its role roster in `members`; its running
 * instances are created later through the role-based spawn path.
 */
export function templateMemberSlots(template: TeamTemplate): ReadonlyArray<{ role: string; profile: string }> {
  if ((template as BuiltinTeamTemplate).eagerMembers === false) return []
  const slots: Array<{ role: string; profile: string }> = []
  for (const member of template.members) {
    const count = member.count ?? 1
    for (let i = 0; i < count; i++) {
      slots.push({ role: member.role, profile: member.profile })
    }
  }
  return slots
}

export function listTemplates(): readonly TeamTemplate[] {
  return TEAM_TEMPLATES
}

export function getTemplate(id: string | undefined): TeamTemplate | undefined {
  if (id === undefined) return undefined
  return TEAM_TEMPLATES.find((template) => template.id === id)
}

export function requireTemplate(id: string): TeamTemplate {
  const template = getTemplate(id)
  if (template === undefined) throw new GroupError('NOT_FOUND', `no team template "${id}"`)
  return template
}
