/**
 * Normalized runtime event vocabulary (V0.5).
 *
 * Every runtime provider (Codex App Server, Claude Agent SDK, DeepSeek
 * Harness, …) speaks provider-native protocols; this module is the ONE
 * normalized vocabulary GroupHost understands. Providers are NOT required to
 * emit every event — capabilities describe what each provider can actually
 * do, and the vocabulary is open so future providers can add finer-grained
 * events without breaking existing consumers.
 *
 * All events are plain JSON data (lossless); streaming deltas are ephemeral
 * by design — the durable Activity Timeline stores milestones, never token
 * deltas.
 *
 * @module @dsh-agent-groups/host
 */

import type { RuntimeTurnResult } from './base.js'

/** Provider/process-level session lifecycle events. */
export type RuntimeSessionEvent =
  | { readonly type: 'session.started'; readonly memberId: string; readonly timestamp: number; readonly metadata?: Readonly<Record<string, unknown>> }
  | {
      readonly type: 'session.ready'
      readonly memberId: string
      readonly timestamp: number
      /** Provider-side session identifier (Codex thread id, Claude session id, DSH session id). */
      readonly providerSessionId?: string
      readonly providerThreadId?: string
      readonly model?: string
    }
  | {
      readonly type: 'session.disconnected'
      readonly memberId: string
      readonly timestamp: number
      readonly reason?: string
      /** The active turn (if any) was killed by the disconnect. */
      readonly turnId?: string
      /** Set when the provider will NOT be able to resume the session. */
      readonly unrecoverable?: boolean
    }
  | { readonly type: 'session.failed'; readonly memberId: string; readonly timestamp: number; readonly reason?: string; readonly turnId?: string }
  | { readonly type: 'session.closed'; readonly memberId: string; readonly timestamp: number; readonly reason?: string }

/** A request the runtime wants answered (approval / user input / permission). */
export interface RuntimePendingRequest {
  /** Provider-side request id used to answer the request. */
  readonly requestId: string
  readonly requestKind: 'approval' | 'input' | 'permission'
  readonly memberId: string
  readonly turnId?: string
  readonly taskId?: string
  /** Human-readable description surfaced in the Team UI. */
  readonly description: string
  /** Provider-specific payload; must never contain credentials. */
  readonly params?: Readonly<Record<string, unknown>>
  readonly timestamp: number
  /** Default answer the provider applies when nobody answers (provider semantics). */
  readonly defaultAction?: string
  /** Allowed answer actions, when the provider declares them. */
  readonly allowedActions?: readonly string[]
}

/** Turn-scoped lifecycle events. */
export type RuntimeTurnEvent =
  | { readonly type: 'turn.started'; readonly turnId: string; readonly taskId?: string; readonly memberId: string; readonly timestamp: number }
  | {
      readonly type: 'turn.output.delta'
      readonly turnId: string
      readonly memberId: string
      readonly timestamp: number
      /** Delta text of this chunk (ephemeral — streamed, never persisted as history). */
      readonly delta: string
    }
  | {
      readonly type: 'turn.reasoning.delta'
      readonly turnId: string
      readonly memberId: string
      readonly timestamp: number
      readonly delta: string
    }
  | {
      readonly type: 'turn.tool.started'
      readonly turnId: string
      readonly memberId: string
      readonly timestamp: number
      readonly tool: string
      readonly title?: string
    }
  | {
      readonly type: 'turn.tool.completed'
      readonly turnId: string
      readonly memberId: string
      readonly timestamp: number
      readonly tool: string
      readonly status?: string
    }
  | {
      readonly type: 'turn.approval.required'
      readonly turnId?: string
      readonly memberId: string
      readonly timestamp: number
      readonly request: RuntimePendingRequest
    }
  | {
      readonly type: 'turn.permission.denied'
      readonly turnId?: string
      readonly memberId: string
      readonly timestamp: number
      readonly tool: string
      readonly message: string
      readonly decisionReason?: string
    }
  | {
      readonly type: 'turn.input.required'
      readonly turnId?: string
      readonly memberId: string
      readonly timestamp: number
      readonly request: RuntimePendingRequest
    }
  | { readonly type: 'turn.completed'; readonly turnId: string; readonly taskId?: string; readonly memberId: string; readonly timestamp: number; readonly result: RuntimeTurnResult }
  | { readonly type: 'turn.failed'; readonly turnId: string; readonly taskId?: string; readonly memberId: string; readonly timestamp: number; readonly reason?: string }
  | { readonly type: 'turn.cancelled'; readonly turnId: string; readonly taskId?: string; readonly memberId: string; readonly timestamp: number; readonly reason?: string }

/** Any normalized runtime event. */
export type RuntimeEvent =
  | RuntimeSessionEvent
  | RuntimeTurnEvent
  | {
      readonly type: 'provider.error'
      readonly memberId: string
      readonly timestamp: number
      readonly code?: string
      readonly message: string
    }

/** Narrow listener shape used by GroupHost (and tests). */
export type RuntimeEventListener = (event: RuntimeEvent) => void

/** Cardinality hint for the durable Activity Timeline mapping. */
export const RUNTIME_ACTIVITY_TYPES = [
  'runtime_session_started',
  'runtime_session_resumed',
  'runtime_session_ready',
  'runtime_session_disconnected',
  'runtime_session_failed',
  'runtime_session_closed',
  'runtime_turn_started',
  'runtime_turn_completed',
  'runtime_turn_failed',
  'runtime_turn_cancelled',
  'runtime_approval_required',
  'runtime_input_required',
  'runtime_approval_answered',
  'runtime_request_answered',
] as const

export type RuntimeActivityType = (typeof RUNTIME_ACTIVITY_TYPES)[number]