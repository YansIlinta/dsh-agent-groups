/**
 * Runtime provider layer (V0.4): one uniform abstraction for "how an agent of
 * this kind is created and operated". Team Roles reference providers by id;
 * GroupHost only ever talks to this interface. External Coding Agents
 * (Codex, Claude Code, …) plug in here — never into GroupHost or the tools.
 * @module @dsh-agent-groups/host
 */

import type { AgentRoleDefinition } from '../core-types.js'

/** One selectable model exposed by a runtime provider. */
export interface ModelDescriptor {
  readonly id: string
  readonly name?: string
  /** Reasoning levels this model accepts (ids of the provider's ReasoningOption). */
  readonly reasoningLevels?: readonly string[]
}

/** One selectable reasoning strength in the provider's own vocabulary. */
export interface ReasoningOption {
  readonly id: string
  readonly label: string
}

/** What a provider can do — the UI hides unsupported config surface. */
export interface RuntimeCapabilities {
  readonly models: boolean
  readonly reasoningLevels: boolean
  readonly interactiveSession: boolean
  readonly workspace: boolean
  readonly toolControl: boolean
  readonly streaming: boolean
}

/** Role config compiles into this before reaching the provider. */
export interface RuntimeAgentConfig {
  readonly groupId: string
  /** Unique member instance id (also the GroupMember.sessionId). */
  readonly agentId: string
  /** Team role id this instance was spawned under. */
  readonly role: string
  readonly profile?: string
  readonly model?: string
  /** Abstract reasoning level; the provider translates to its own vocabulary. */
  readonly reasoningLevel?: string
  readonly systemPrompt?: string
  /** Explicit working directory — external agents must run under this. */
  readonly workspace?: string
  /** DSH: the leader session id used as parent lineage. */
  readonly parentMemberId?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Runtime-side view of one spawned agent instance. */
export interface RuntimeAgentHandle {
  readonly agentId: string
  readonly runtime: string
  readonly status: 'starting' | 'running' | 'exited' | 'failed'
  readonly exitCode?: number
  /** Accumulated textual output for external process runtimes. */
  readonly output?: string
  /** Run-to-completion: resolves with the final output (external CLIs); DSH agents resolve immediately (they are async peers). */
  waitExit(): Promise<{ code: number; output: string }>
  /** Best-effort stop (kill process / dispose agent handle). */
  stop(): Promise<void>
  /** Direct textual input for interactive / CLI runtimes. */
  sendInput?(text: string): Promise<void>
}

/**
 * One runtime family (deepseek-harness, codex, claude-code, …).
 * Implementations must be stateless w.r.t. credentials: they read the host
 * environment (env vars, runtime login, existing CLI config) and never store
 * secrets in the durable store.
 */
export interface AgentRuntimeProvider {
  readonly id: string
  readonly name: string
  readonly description?: string
  /** Whether the runtime can be used right now (binaries + credentials). */
  isAvailable(): boolean | Promise<boolean>
  getCapabilities(): RuntimeCapabilities | Promise<RuntimeCapabilities>
  listModels(): readonly ModelDescriptor[] | Promise<readonly ModelDescriptor[]>
  /** Reasonable levels; a provider without listReasoningLevels still receives the abstract level string. */
  listReasoningLevels?(): readonly ReasoningOption[] | Promise<readonly ReasoningOption[]>
  /** Create one agent from the compiled role config. */
  spawnAgent(config: RuntimeAgentConfig): Promise<RuntimeAgentHandle>
  stopAgent(handle: RuntimeAgentHandle): Promise<void>
  /** Deliver a task brief / message to an existing instance. */
  sendInput?(agentId: string, text: string): Promise<void>
}

/** Default reasoning vocabulary shared by providers that map directly. */
export const DEFAULT_REASONING_LEVELS: readonly ReasoningOption[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
]

/** Provider-side validation of a compiled role config (before spawn). */
export function describeRole(role: AgentRoleDefinition): string {
  return `${role.name} (${role.runtime}${role.model !== undefined ? ` / ${role.model}` : ''}${role.reasoningLevel !== undefined ? ` / ${role.reasoningLevel}` : ''})`
}