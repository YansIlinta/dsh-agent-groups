/**
 * Team configuration derivation (V0.4): built-in role definitions + the
 * migration path for pre-V0.4 groups (no stored team config → derive a
 * sensible default without touching the durable record). Team Templates are
 * now just role sets — no runtime coupling.
 * @module @dsh-agent-groups/host
 */

import type { AgentRoleDefinition, TeamConfig } from '../core-types.js'

const RUNTIME = 'deepseek-harness'
const MEMBER_PROFILE = 'group-member'

function role(def: Omit<AgentRoleDefinition, 'runtime' | 'profile'> & { profile?: string }): AgentRoleDefinition {
  return { runtime: RUNTIME, profile: def.profile ?? MEMBER_PROFILE, ...def }
}

export const LEADER_ROLE: AgentRoleDefinition = role({
  id: 'leader',
  name: 'Leader',
  description: 'The group orchestrator: decomposes the mission, spawns roles on demand, assigns and verifies tasks.',
  profile: 'group-leader',
  reasoningLevel: 'high',
  maxInstances: 1,
})

export const GENERALIST_ROLE: AgentRoleDefinition = role({
  id: 'generalist',
  name: 'Generalist',
  description: 'General-purpose member for flexible missions.',
  reasoningLevel: 'medium',
  maxInstances: 8,
  defaultInstances: 1,
})

/** Generic built-in role templates (§22), shared by the original team types. */
export const ROLE_TEMPLATES: readonly AgentRoleDefinition[] = [
  role({
    id: 'planner',
    name: 'Planner',
    description: 'Architecture, decomposition, risks and implementation strategy. Does not implement unless explicitly instructed.',
    reasoningLevel: 'high',
    maxInstances: 1,
    systemPrompt: 'You are the planning member of the team. Focus on architecture, decomposition, risks and implementation strategy. Do not implement unless explicitly instructed.',
  }),
  role({
    id: 'researcher',
    name: 'Researcher',
    description: 'Discovery: gathers facts, reads code/docs, reports findings.',
    reasoningLevel: 'medium',
    maxInstances: 3,
    systemPrompt: 'You are the research member of the team. Focus on gathering facts, reading code and documentation, and reporting findings. Do not edit files unless the task explicitly says so.',
  }),
  role({
    id: 'architect',
    name: 'Architect',
    description: 'Designs the shape of the solution (schemas, interfaces, module boundaries).',
    reasoningLevel: 'high',
    maxInstances: 1,
    systemPrompt: 'You are the architecture member of the team. Focus on schemas, interfaces and module boundaries. Do not implement unless explicitly instructed.',
  }),
  role({
    id: 'implementation',
    name: 'Implementation Agent',
    description: 'Edits code, runs tools, delivers the assigned task.',
    reasoningLevel: 'high',
    maxInstances: 4,
    systemPrompt: 'You are an implementation member. Focus on editing code, running tools and delivering the assigned task.',
  }),
  role({
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Inspects implementation, identifies problems, verifies acceptance criteria.',
    reasoningLevel: 'high',
    maxInstances: 2,
    systemPrompt: 'Focus on inspecting implementation and identifying problems.',
  }),
]

/** Create Flow-specific roles stay scoped to the video-production specialization. */
const CREATE_FLOW_ROLE_TEMPLATES: readonly AgentRoleDefinition[] = [
  role({
    id: 'topic-strategist',
    name: 'Topic Strategist',
    description: 'Finds and evaluates content angles, audience fit, novelty, stakes and production potential.',
    reasoningLevel: 'high',
    maxInstances: 2,
    systemPrompt: 'Focus on discovering and evaluating content topics. Produce concrete candidate angles, audience rationale, novelty, stakes, evidence needs and a recommended direction.',
  }),
  role({
    id: 'material-producer',
    name: 'Material Producer',
    description: 'Collects, organizes and creates production materials in the workspace, preserving source provenance and usable file paths.',
    reasoningLevel: 'medium',
    maxInstances: 2,
  }),
  role({
    id: 'scriptwriter',
    name: 'Scriptwriter',
    description: 'Turns an approved topic and research pack into a structured, production-ready script.',
    reasoningLevel: 'high',
    maxInstances: 2,
    systemPrompt: 'Write production-ready scripts from the approved topic and research evidence. Preserve factual traceability, structure the narrative clearly, and flag unsupported claims instead of inventing them.',
  }),
  role({
    id: 'video-producer',
    name: 'Video Producer',
    description: 'Owns deterministic media assembly: prepares local inputs, invokes Create Flow ASR/TTS/render tools through the Leader, and verifies produced media files.',
    reasoningLevel: 'medium',
    maxInstances: 2,
  }),
]

/** Team templates → role sets (§23); runtime stays decoupled. */
export function templateTeamConfig(templateId: string | undefined): TeamConfig {
  const byId = (id: string): AgentRoleDefinition => {
    const found = [...ROLE_TEMPLATES, ...CREATE_FLOW_ROLE_TEMPLATES].find((t) => t.id === id)
    if (found !== undefined) return found
    return { ...GENERALIST_ROLE, id, name: id }
  }
  switch (templateId) {
    case 'software-team':
      return {
        leaderRole: LEADER_ROLE,
        memberRoles: ['planner', 'researcher', 'architect', 'implementation', 'reviewer'].map(byId),
      }
    case 'research-team':
      return {
        leaderRole: LEADER_ROLE,
        memberRoles: [
          { ...byId('researcher'), id: 'researcher', name: 'Researcher', maxInstances: 3, defaultInstances: 1 },
          { ...byId('architect'), id: 'analyst', name: 'Analyst', description: 'Synthesizes research into analysis.' },
          { ...byId('reviewer'), id: 'writer', name: 'Writer', description: 'Turns findings into clear writing.', reasoningLevel: 'medium' },
        ],
      }
    case 'content-team':
      return {
        leaderRole: {
          ...LEADER_ROLE,
          name: 'Create Flow Lead',
          description: 'Owns production reasoning and dynamically materializes specialist roles as the video workfront expands.',
        },
        // Create Flow deliberately has no eager defaultInstances. The role set
        // describes available specialist capabilities; the Leader materializes
        // only the instances needed for the current ready workfront.
        memberRoles: [
          { ...byId('topic-strategist') },
          { ...byId('researcher'), maxInstances: 3, description: 'Searches sources and builds evidence-backed research packs; independent questions can fan out across multiple instances.' },
          { ...byId('material-producer') },
          { ...byId('scriptwriter') },
          { ...byId('video-producer') },
        ],
      }
    case 'general-team':
      return { leaderRole: LEADER_ROLE, memberRoles: [{ ...GENERALIST_ROLE, maxInstances: 4, defaultInstances: 1 }] }
    default:
      return { leaderRole: LEADER_ROLE, memberRoles: [GENERALIST_ROLE] }
  }
}

/** V0.4 migration: pre-role groups keep loading and get a sane role set. */
export function teamConfigFor(templateId: string | undefined, stored: TeamConfig | undefined): TeamConfig {
  if (stored !== undefined) return stored
  return templateTeamConfig(templateId)
}
