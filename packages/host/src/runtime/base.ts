/**
 * Runtime provider layer (V0.4 + V0.5): one uniform abstraction for "how an
 * agent of this kind is created and operated". Team Roles reference providers
 * by id; GroupHost only ever talks to this interface.
 *
 * V0.5 adds the session + turn contract. The fundamental shape is:
 *
 * ```text
 * Group Member
 *   └── RuntimeSession        (one persistent provider conversation)
 *         ├── Turn 1 ← task A ─ Result
 *         ├── Turn 2 ← leader follow-up ─ Result
 *         └── Turn 3 ← task B ─ Result
 * ```
 *
 * Process lifetime, session lifetime, turn lifetime and task lifetime are
 * SEPARATE concepts. A process exiting must never automatically mean "the
 * member successfully completed its task" — unexpected exits produce
 * `session.disconnected` / `turn.failed` events instead.
 *
 * Providers implement BOTH the legacy one-shot surface
 * ({@link AgentRuntimeProvider}, kept for backward-compatible callers and
 * old stored groups) and the V0.5 session surface
 * ({@link SessionRuntimeProvider}). GroupHost uses sessions for external
 * coding-agent runtimes.
 *
 * @module @dsh-agent-groups/host
 */

import type { AgentRoleDefinition } from '../core-types.js'
import type { RuntimeMessage } from './message.js'
import type { RuntimeEventListener, RuntimePendingRequest, RuntimeTurnEvent } from './events.js'

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
  /** V0.5: provider emits normalized events (session./turn.*). */
  readonly sessionEvents?: boolean
  /** V0.5: provider can keep one conversation across multiple turns. */
  readonly persistentSessions?: boolean
  /**
   * V0.5: how a turn's completion is decided:
   *  - `provider`  — the provider reports a normalized turn result (Codex/Claude).
   *  - `claimed`   — completion arrives as the member's own completion claim
   *                  (DSH members call group_complete_task).
   */
  readonly turnCompletion?: 'provider' | 'claimed'
  /** V0.5: provider can interrupt a running turn. */
  readonly interrupt?: boolean
  /** V0.5: provider can resume a stored provider session/thread. */
  readonly resume?: boolean
  /**
   * V0.5: whether the provider can enumerate its model catalog dynamically.
   * Providers that only mirror the harness' current selection (DSH) report
   * false so role model overrides are not falsely rejected.
   */
  readonly dynamicModels?: boolean
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

// ── V0.5: sessions & turns ──────────────────────────────────────────────────

/** Durable runtime-session state machine. */
export type RuntimeSessionStatus =
  | 'starting'
  | 'idle'
  | 'running'
  | 'waiting_input'
  | 'interrupted'
  | 'disconnected'
  | 'failed'
  | 'closed'

/** Input for one turn (one provider conversation step). */
export interface RuntimeTurnInput {
  /** Associated GroupTask when this turn IS a task execution. */
  readonly taskId?: string
  /** Human text / full brief for the turn. */
  readonly text: string
  /** `task` = a task execution turn; `followup` = conversational follow-up. */
  readonly turnKind?: 'task' | 'followup'
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Normalized outcome of one completed/failed/cancelled turn. */
export interface RuntimeTurnResult {
  readonly status: 'completed' | 'failed' | 'cancelled' | 'input_required'
  readonly summary?: string
  readonly output?: string
  readonly artifacts?: string[]
  readonly changedFiles?: string[]
  readonly tests?: unknown
  readonly risks?: string[]
  readonly unresolved?: string[]
  readonly providerMetadata?: Readonly<Record<string, unknown>>
}

/** A handle to one running turn; the caller waits or unsubscribes. */
export interface RuntimeTurnHandle {
  readonly turnId: string
  readonly taskId?: string
  /** Resolves when the turn settles (completed/failed/cancelled/input_required). */
  waitForCompletion(): Promise<RuntimeTurnResult>
  /** Stream normalized turn events (deltas, tool progress, approvals). */
  subscribe(listener: RuntimeEventListener): () => void
}

/** Plain, serializable session metadata (the durable `runtimeSession` record). */
export interface RuntimeSessionInfo {
  readonly runtime: string
  /** Provider identity (DSH model provider) when the runtime distinguishes it. */
  readonly provider?: string
  readonly providerSessionId?: string
  readonly providerThreadId?: string
  readonly workspace?: string
  readonly model?: string
  readonly reasoningLevel?: string
  readonly state: RuntimeSessionStatus
  readonly lastTurnId?: string
  readonly lastTaskId?: string
  readonly createdAt?: number
  readonly updatedAt?: number
}

/**
 * One persistent provider conversation for one Group Member. Created by the
 * provider, kept alive across tasks, resumed after host restarts where the
 * provider supports it.
 */
export interface RuntimeSession {
  /** Durable member id (GroupMember.sessionId). */
  readonly memberId: string
  readonly runtime: string
  readonly providerSessionId?: string
  readonly providerThreadId?: string
  readonly status: RuntimeSessionStatus

  /** Start (or reconnect) the provider conversation. */
  start(): Promise<void>
  /** Start a new turn on this session. */
  runTurn(input: RuntimeTurnInput): Promise<RuntimeTurnHandle>
  /**
   * Conversational follow-up: continue the CURRENT running turn where the
   * provider supports steering (Codex `turn/steer`), or queue as the next
   * turn. Implementations decide; the caller never creates a new agent for a
   * follow-up.
   */
  sendFollowup?(input: RuntimeTurnInput): Promise<void>
  /** Interrupt the running turn. */
  interrupt(reason?: string): Promise<void>
  /** Answer a pending provider request (approval / input / permission). */
  respondToRequest?(requestId: string, action: string, payload?: unknown): Promise<boolean>
  /** Gracefully close the provider conversation (keep it resumable). */
  close(graceMs?: number): Promise<void>
  /** Serializable view for the durable member record. */
  info(): RuntimeSessionInfo
  /** Normalized event stream (session.* + turn.*). */
  subscribe(listener: RuntimeEventListener): () => void
  /** Replay the currently-pending requests (after resume; re-answerable). */
  listPendingRequests(): readonly RuntimePendingRequest[]
}

// ── legacy surface (V0.4, kept for compatibility) ──────────────────────────

/** Runtime-side view of one spawned agent instance (legacy process-oriented). */
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
  /** Structured runtime message delivery (Phase 1). */
  deliver?(message: RuntimeMessage<unknown>): Promise<void>
}

/**
 * One runtime family (deepseek-harness, codex, claude, …).
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
  /** Create one agent from the compiled role config (legacy one-shot). */
  spawnAgent(config: RuntimeAgentConfig): Promise<RuntimeAgentHandle>
  stopAgent(handle: RuntimeAgentHandle): Promise<void>
  /** Deliver a task brief / message to an existing instance. */
  sendInput?(agentId: string, text: string): Promise<void>
  /** Structured runtime message delivery (Phase 1). */
  deliver?(handle: RuntimeAgentHandle, message: RuntimeMessage<unknown>): Promise<void>
}

/** V0.5: a provider that maintains persistent sessions with turns. */
export interface SessionRuntimeProvider extends AgentRuntimeProvider {
  /**
   * Create (or resume) a persistent session for one member.
   * `existing` carries the durable provider session/thread ids so a host
   * restart can re-attach to the SAME provider conversation.
   */
  createSession(config: RuntimeAgentConfig, existing?: RuntimeSessionInfo): Promise<RuntimeSession>
}

/** Type guard: does this provider speak sessions/turns? */
export function isSessionProvider(provider: AgentRuntimeProvider): provider is SessionRuntimeProvider {
  return typeof (provider as SessionRuntimeProvider).createSession === 'function'
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

export type { RuntimeEvent, RuntimeTurnEvent, RuntimePendingRequest } from './events.js'