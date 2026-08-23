/**
 * Preset Architecture (Phase 6).
 *
 * Three layers of long-lived configuration:
 *
 *   Runtime Preset  → runtime + model + reasoning defaults
 *   Role Preset     → reusable role behavior / system prompt / instance limits
 *   Team Preset     → composition of Role Presets for a whole team
 *
 * Runtime identifiers are never written into Team Presets; a Team Preset only
 * references Role Presets, and a Role Preset can reference an optional Runtime
 * Preset default. This keeps runtime/model choices reusable and replaceable.
 *
 * @module @dsh-agent-groups/host
 */

import type { AgentRoleDefinition, TeamConfig } from '../core-types.js'

export interface RuntimePreset {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly runtime: string
  readonly model?: string
  readonly reasoningLevel?: string
  readonly settings?: Readonly<Record<string, unknown>>
}

export interface RolePreset {
  readonly id: string
  readonly name: string
  readonly description?: string
  /** Optional default Runtime Preset id; TeamConfig can override it. */
  readonly runtimePreset?: string
  readonly model?: string
  readonly reasoningLevel?: string
  readonly systemPrompt?: string
  readonly maxInstances?: number
  readonly defaultInstances?: number
  readonly profile?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface TeamPresetRoleRef {
  readonly role: string
  readonly count?: number
}

export interface TeamPreset {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly leaderRole: string
  readonly memberRoles: readonly TeamPresetRoleRef[]
}

export const RUNTIME_PRESETS: readonly RuntimePreset[] = [
  {
    id: 'dsh-balanced',
    name: 'DSH Balanced',
    description: 'Native DeepSeek Harness with default reasoning.',
    runtime: 'deepseek-harness',
    reasoningLevel: 'medium',
  },
  {
    id: 'codex-high',
    name: 'Codex High Reasoning',
    description: 'OpenAI Codex with a high reasoning model.',
    runtime: 'codex',
    model: 'gpt-5.2',
    reasoningLevel: 'high',
  },
  {
    id: 'claude-balanced',
    name: 'Claude Balanced',
    description: 'Claude through the official ACP adapter.',
    runtime: 'claude',
    model: 'claude-sonnet-4-5',
    reasoningLevel: 'medium',
  },
  {
    id: 'gemini-balanced',
    name: 'Gemini ACP',
    description: 'Gemini CLI native ACP mode.',
    runtime: 'gemini',
    reasoningLevel: 'medium',
  },
]

export const ROLE_PRESETS: readonly RolePreset[] = [
  {
    id: 'planner',
    name: 'Planner',
    description: 'Architecture, decomposition, risks and implementation strategy.',
    runtimePreset: 'dsh-balanced',
    reasoningLevel: 'high',
    maxInstances: 1,
    systemPrompt: 'You are the planning member of the team. Focus on architecture, decomposition, risks and implementation strategy. Do not implement unless explicitly instructed.',
  },
  {
    id: 'researcher',
    name: 'Researcher',
    description: 'Discovery: gathers facts, reads code/docs, reports findings.',
    runtimePreset: 'dsh-balanced',
    reasoningLevel: 'medium',
    maxInstances: 3,
    systemPrompt: 'You are the research member of the team. Focus on gathering facts, reading code and documentation, and reporting findings. Do not edit files unless the task explicitly says so.',
  },
  {
    id: 'architect',
    name: 'Architect',
    description: 'Designs the shape of the solution (schemas, interfaces, module boundaries).',
    runtimePreset: 'dsh-balanced',
    reasoningLevel: 'high',
    maxInstances: 1,
    systemPrompt: 'You are the architecture member of the team. Focus on schemas, interfaces and module boundaries. Do not implement unless explicitly instructed.',
  },
  {
    id: 'implementation',
    name: 'Implementation Agent',
    description: 'Edits code, runs tools, delivers the assigned task.',
    runtimePreset: 'codex-high',
    reasoningLevel: 'high',
    maxInstances: 4,
    systemPrompt: 'You are an implementation member. Focus on editing code, running tools and delivering the assigned task.',
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Inspects implementation, identifies problems, verifies acceptance criteria.',
    runtimePreset: 'dsh-balanced',
    reasoningLevel: 'high',
    maxInstances: 2,
    systemPrompt: 'Focus on inspecting implementation and identifying problems.',
  },
  {
    id: 'generalist',
    name: 'Generalist',
    description: 'General-purpose member for flexible missions.',
    runtimePreset: 'dsh-balanced',
    reasoningLevel: 'medium',
    maxInstances: 8,
    systemPrompt: 'You are a general-purpose member. Adapt to the task and coordinate with the Leader.',
  },
]

export const TEAM_PRESETS: readonly TeamPreset[] = [
  {
    id: 'software-team',
    name: 'Software Engineering Team',
    description: 'Planner, researcher, architect, implementation, reviewer.',
    leaderRole: 'leader',
    memberRoles: [
      { role: 'planner' },
      { role: 'researcher' },
      { role: 'architect' },
      { role: 'implementation', count: 2 },
      { role: 'reviewer' },
    ],
  },
  {
    id: 'research-team',
    name: 'Research Team',
    description: 'Researcher, analyst/writer, editor.',
    leaderRole: 'leader',
    memberRoles: [
      { role: 'researcher', count: 2 },
      { role: 'architect', count: 1 },
      { role: 'reviewer', count: 1 },
    ],
  },
  {
    id: 'general-team',
    name: 'General Team',
    description: 'Flexible generalist team.',
    leaderRole: 'leader',
    memberRoles: [{ role: 'generalist', count: 2 }],
  },
]

/** Lookup helpers. */
export function getRuntimePreset(id: string): RuntimePreset | undefined {
  return RUNTIME_PRESETS.find((preset) => preset.id === id)
}

export function getRolePreset(id: string): RolePreset | undefined {
  return ROLE_PRESETS.find((preset) => preset.id === id)
}

export function getTeamPreset(id: string): TeamPreset | undefined {
  return TEAM_PRESETS.find((preset) => preset.id === id)
}

/** Resolve a Role Preset into a concrete AgentRoleDefinition. */
export function resolveRolePreset(rolePresetId: string, runtimePresetId?: string): AgentRoleDefinition {
  const role = getRolePreset(rolePresetId)
  if (role === undefined) {
    throw new Error(`role preset not found: ${rolePresetId}`)
  }
  const runtimeId = runtimePresetId ?? role.runtimePreset
  const runtime = runtimeId === undefined ? undefined : getRuntimePreset(runtimeId)
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    runtime: runtime?.runtime ?? 'deepseek-harness',
    profile: role.profile,
    model: runtime?.model ?? role.model,
    reasoningLevel: runtime?.reasoningLevel ?? role.reasoningLevel,
    systemPrompt: role.systemPrompt,
    maxInstances: role.maxInstances,
    defaultInstances: role.defaultInstances,
    metadata: {
      ...(runtime?.settings ?? {}),
      ...(role.metadata ?? {}),
      runtimePreset: runtimeId,
      rolePreset: role.id,
    },
  }
}

const LEADER_ROLE_PRESET: AgentRoleDefinition = {
  id: 'leader',
  name: 'Leader',
  description: 'The group orchestrator.',
  runtime: 'deepseek-harness',
  profile: 'group-leader',
  reasoningLevel: 'high',
  maxInstances: 1,
}

/** Resolve a Team Preset into a full TeamConfig using built-in Role/Runtime presets. */
export function resolveTeamPreset(teamPresetId: string): TeamConfig {
  const team = getTeamPreset(teamPresetId)
  if (team === undefined) {
    throw new Error(`team preset not found: ${teamPresetId}`)
  }
  const memberRoles: AgentRoleDefinition[] = []
  for (const ref of team.memberRoles) {
    const resolved = resolveRolePreset(ref.role)
    const count = ref.count ?? 1
    for (let i = 0; i < count; i += 1) {
      memberRoles.push({ ...resolved, id: count > 1 ? `${resolved.id}-${i + 1}` : resolved.id, name: count > 1 ? `${resolved.name} ${i + 1}` : resolved.name })
    }
  }
  return { leaderRole: LEADER_ROLE_PRESET, memberRoles }
}
