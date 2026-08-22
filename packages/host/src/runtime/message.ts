/**
 * Runtime Message Abstraction (Phase 1).
 *
 * This is the structured protocol used between GroupHost / Agent Groups Bridge
 * and every runtime provider. It is deliberately not a wall of free text:
 * callers can route by `type`, attach task/thread/priority metadata, and keep
 * the payload as JSON. Runtimes that only accept text use
 * `runtimeMessageText()` / `deliverRuntimeMessage()` as a compatibility shim.
 *
 * @module @dsh-agent-groups/host
 */

export type RuntimeMessageType =
  | 'task_assignment'
  | 'task_update'
  | 'task_result'
  | 'question'
  | 'answer'
  | 'leader_instruction'
  | 'private_report'
  | 'channel_message'
  | 'system_event'
  | 'context_update'

export type RuntimePriority = 'low' | 'normal' | 'high' | 'critical' | 'urgent'

/** Structured message envelope shared by all runtime providers. */
export interface RuntimeMessage<T = unknown> {
  readonly type: RuntimeMessageType
  readonly groupId: string
  readonly senderId: string
  readonly recipientId?: string
  readonly taskId?: string
  readonly threadId?: string
  readonly priority?: RuntimePriority
  readonly timestamp: number
  readonly payload: T
}

/** Minimal structural sink used by `deliverRuntimeMessage`. */
export interface RuntimeMessageSink {
  readonly deliver?: (message: RuntimeMessage<unknown>) => Promise<void> | void
  readonly sendInput?: (text: string) => Promise<void> | void
}

export interface CreateRuntimeMessageInput<T = unknown> {
  readonly type: RuntimeMessageType
  readonly groupId: string
  readonly senderId: string
  readonly recipientId?: string
  readonly taskId?: string
  readonly threadId?: string
  readonly priority?: RuntimePriority
  readonly timestamp?: number
  readonly payload: T
}

/** Create a timestamped, validated (at type level) runtime message. */
export function createRuntimeMessage<T>(input: CreateRuntimeMessageInput<T>): RuntimeMessage<T> {
  return {
    type: input.type,
    groupId: input.groupId,
    senderId: input.senderId,
    recipientId: input.recipientId,
    taskId: input.taskId,
    threadId: input.threadId,
    priority: input.priority,
    timestamp: input.timestamp ?? Date.now(),
    payload: input.payload,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Extract a human-readable text from a structured message's payload. */
export function runtimeMessageText(message: RuntimeMessage<unknown>): string {
  const header = [`[Agent Groups · ${message.type}]`]
  if (message.taskId !== undefined) header.push(`Task: ${message.taskId}`)
  if (message.threadId !== undefined) header.push(`Thread: ${message.threadId}`)
  if (message.priority !== undefined) header.push(`Priority: ${message.priority}`)

  const body = messagePayloadText(message.payload)
  return `${header.join(' · ')}\n${body}`.trim()
}

function messagePayloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (!isRecord(payload)) return JSON.stringify(payload)

  if (typeof payload.text === 'string' && payload.text.length > 0) return payload.text
  if (typeof payload.taskBrief === 'string' && payload.taskBrief.length > 0) return payload.taskBrief

  const lines: string[] = []
  if (typeof payload.subject === 'string') lines.push(`Subject: ${payload.subject}`)
  if (typeof payload.summary === 'string') lines.push(`Summary: ${payload.summary}`)
  if (typeof payload.description === 'string' && payload.description.length > 0) lines.push(`Description: ${payload.description}`)
  if (typeof payload.kind === 'string') lines.push(`Kind: ${payload.kind}`)
  if (Array.isArray(payload.acceptanceCriteria)) {
    const criteria = payload.acceptanceCriteria as unknown[]
    if (criteria.length > 0) {
      lines.push('Acceptance criteria:')
      for (const item of criteria) lines.push(`  - ${String(item)}`)
    }
  }
  if (Array.isArray(payload.writeScopes)) {
    const scopes = payload.writeScopes as unknown[]
    if (scopes.length > 0) lines.push(`Write scopes: ${scopes.join(', ')}`)
  }
  if (Array.isArray(payload.blockedBy)) {
    const blockedBy = payload.blockedBy as unknown[]
    if (blockedBy.length > 0) lines.push(`Blocked by: ${blockedBy.join(', ')}`)
  }
  if (Array.isArray(payload.filesTouched)) {
    const files = payload.filesTouched as unknown[]
    if (files.length > 0) lines.push(`Files touched: ${files.join(', ')}`)
  }
  if (Array.isArray(payload.blockers)) {
    const blockers = payload.blockers as unknown[]
    if (blockers.length > 0) lines.push(`Blockers: ${blockers.join(', ')}`)
  }
  if (typeof payload.nextStep === 'string') lines.push(`Next step: ${payload.nextStep}`)

  const directText = lines.join('\n').trim()
  if (directText.length > 0) return directText
  return JSON.stringify(payload)
}

/**
 * Deliver a structured message to a runtime handle with backwards
 * compatibility: prefer the structured `deliver` sink, otherwise fall back to
 * the existing text-only `sendInput`.
 */
export async function deliverRuntimeMessage(
  sink: RuntimeMessageSink | undefined,
  message: RuntimeMessage<unknown>,
): Promise<boolean> {
  if (sink === undefined) return false
  if (sink.deliver !== undefined) {
    await sink.deliver(message)
    return true
  }
  if (sink.sendInput !== undefined) {
    await sink.sendInput(runtimeMessageText(message))
    return true
  }
  return false
}
