/**
 * Team Templates (第 3/4 节): preset team compositions the user can start a
 * group from, then adjust before/after creation. Built-in for V0.2; the
 * selected template id is persisted on the group record (`templateId`).
 * @module @dsh-agent-groups/host
 */

import type { TeamTemplate } from './core-types.js'
import { GroupError } from './group-service.js'

export const TEAM_TEMPLATES: readonly TeamTemplate[] = [
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
    name: 'Content Team',
    description: 'Research → writing → editorial pass for documentation and copy.',
    leaderProfile: 'product-planner',
    icon: '✍️',
    members: [
      { role: 'Researcher', profile: 'implementation-engineer', count: 1 },
      { role: 'Writer', profile: 'reviewer', count: 1 },
      { role: 'Editor', profile: 'reviewer', count: 1 },
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

/** Flatten a template into ordered member slots (leader excluded). */
export function templateMemberSlots(template: TeamTemplate): ReadonlyArray<{ role: string; profile: string }> {
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