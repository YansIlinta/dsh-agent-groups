/**
 * Agent Profile registry: consumable role descriptions the Leader inspects
 * before delegating. Ships five sample profiles; additional profiles persist
 * in the durable store. The Leader never depends on a fixed role name — it
 * reads name/description/capabilities and assigns by fit (第 2 节).
 * @module @dsh-agent-groups/host
 */

import type { AgentProfile, AgentProfileId } from './core-types.js'
import type { TableStore } from './store.js'
import { GroupError } from './group-service.js'

/** Shipped sample profiles (the Leader may also read user-defined ones). */
export const BUILTIN_PROFILES: readonly AgentProfile[] = [
  {
    id: 'product-planner',
    name: 'Product Planner',
    presetId: undefined,
    description: 'Understands goals, turns rough requests into requirements, workstreams, acceptance criteria, and risk analysis. Best for early planning and replanning.',
    capabilities: ['planning', 'requirements', 'analysis', 'decomposition', 'risk'],
    responsibilities: ['Clarify the mission', 'Decompose into workstreams', 'Define acceptance criteria'],
    preferredTaskTypes: ['planning', 'research'],
    tags: ['planning', 'analysis'],
  },
  {
    id: 'frontend-engineer',
    name: 'Frontend Engineer',
    presetId: undefined,
    description: 'Focuses on React / TypeScript / CSS / UI implementation. Ships components and pages that build and lint cleanly.',
    capabilities: ['frontend', 'react', 'typescript', 'css', 'ui-implementation'],
    responsibilities: ['Implement UI from the product plan', 'Fix frontend issues', 'Keep build and lint green'],
    preferredTaskTypes: ['implementation'],
    defaultWriteScopes: ['src/', 'public/'],
    tags: ['frontend'],
  },
  {
    id: 'implementation-engineer',
    name: 'Implementation Engineer',
    presetId: undefined,
    description: 'General implementation work: backend logic, scripts, data wiring, small full-stack changes.',
    capabilities: ['backend', 'typescript', 'node', 'python', 'fullstack'],
    responsibilities: ['Implement backend and glue code', 'Write and run tests', 'Report unresolved risks'],
    preferredTaskTypes: ['implementation', 'research'],
    tags: ['backend', 'generalist'],
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    presetId: undefined,
    description: 'Reads an implementation critically against acceptance criteria, checks for design, correctness, and regression risks.',
    capabilities: ['code-review', 'analysis', 'quality', 'testing'],
    responsibilities: ['Review task outputs', 'Report concrete issues', 'Suggest fixes'],
    preferredTaskTypes: ['review', 'verification'],
    tags: ['review'],
  },
  {
    id: 'acceptance-agent',
    name: 'Acceptance Agent',
    presetId: undefined,
    description: 'Independent acceptance/verification: runs tests and acceptance checks and reports pass/fail evidence.',
    capabilities: ['verification', 'testing', 'acceptance', 'qa'],
    responsibilities: ['Execute acceptance checks', 'Run tests', 'Report evidence'],
    preferredTaskTypes: ['verification'],
    tags: ['verification', 'qa'],
  },
]

export class ProfileRegistry {
  private readonly store: TableStore<string, AgentProfile>

  constructor(store: TableStore<string, AgentProfile>) {
    this.store = store
  }

  list(): AgentProfile[] {
    const rows: AgentProfile[] = [...BUILTIN_PROFILES]
    for (const [key, profile] of this.store.entries()) {
      if (!BUILTIN_PROFILES.some((builtin) => builtin.id === profile.id)) rows.push(profile)
    }
    return rows
  }

  get(id: AgentProfileId): AgentProfile | undefined {
    const builtin = BUILTIN_PROFILES.find((profile) => profile.id === id)
    if (builtin !== undefined) return builtin
    return this.store.get(id)
  }

  require(id: AgentProfileId): AgentProfile {
    const profile = this.get(id)
    if (profile === undefined) throw new GroupError('NOT_FOUND', `agent profile not found: ${id}`)
    return profile
  }

  async register(profile: AgentProfile): Promise<void> {
    if (BUILTIN_PROFILES.some((builtin) => builtin.id === profile.id)) {
      throw new Error(`cannot overwrite built-in profile: ${profile.id}`)
    }
    await this.store.put(profile.id, profile)
  }

  async remove(id: AgentProfileId): Promise<boolean> {
    if (BUILTIN_PROFILES.some((builtin) => builtin.id === id)) return false
    return this.store.delete(id)
  }
}
