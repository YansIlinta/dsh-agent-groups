/**
 * Codex Bridge Protocol (Phase 3).
 *
 * A small, explicit text protocol for the Codex CLI runtime. The Codex model
 * is instructed to emit one JSON action per line prefixed with a marker; the
 * provider parses stdout and forwards each action to the ExternalAgentBridge.
 * This is the "active member" path. stdout tail parsing remains only as a
 * crash/fallback completion mechanism.
 *
 * @module @dsh-agent-groups/host
 */

import type { ExternalAgentBridge, ExternalBridgeMethod, ExternalBridgeParams } from './bridge.js'

export const BRIDGE_MARKER = '[AGENT_GROUPS_BRIDGE]'

export interface CodexBridgeAction {
  readonly method: ExternalBridgeMethod
  readonly params?: ExternalBridgeParams
}

/** Parse one stdout line. Returns undefined when the line is not a bridge call. */
export function parseBridgeAction(line: string): CodexBridgeAction | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith(BRIDGE_MARKER)) return undefined
  const json = trimmed.slice(BRIDGE_MARKER.length).trim()
  if (json.length === 0) return undefined
  try {
    const parsed = JSON.parse(json) as Partial<CodexBridgeAction>
    if (typeof parsed.method !== 'string') return undefined
    return {
      method: parsed.method as ExternalBridgeMethod,
      params: parsed.params ?? {},
    }
  } catch {
    return undefined
  }
}

export function codexBridgeInstructions(): string {
  return [
    'You are connected to Agent Groups through the External Agent Bridge.',
    'You can actively query tasks, post to the channel, report to the Leader, and complete your task.',
    'Emit exactly one JSON action per line, prefixed with the marker below:',
    '',
    `${BRIDGE_MARKER} {"method":"group_get_context","params":{}}`,
    `${BRIDGE_MARKER} {"method":"group_list_tasks","params":{}}`,
    `${BRIDGE_MARKER} {"method":"group_get_task","params":{"taskId":"<taskId>"}}`,
    `${BRIDGE_MARKER} {"method":"group_post","params":{"text":"message"}}`,
    `${BRIDGE_MARKER} {"method":"group_report_to_leader","params":{"text":"report"}}`,
    `${BRIDGE_MARKER} {"method":"group_read_channel","params":{"limit":20}}`,
    `${BRIDGE_MARKER} {"method":"group_complete_task","params":{"taskId":"<taskId>","summary":"...","artifacts":["..."],"completionClaim":true}}`,
    '',
    'Do not invent tool names. Use only the methods above.',
    'When you finish the assigned task, emit group_complete_task with a structured result.',
  ].join('\n')
}

/** Execute a parsed bridge action and swallow/log errors so a bad action cannot kill the Codex process. */
export async function executeBridgeAction(
  bridge: ExternalAgentBridge,
  agentId: string,
  action: CodexBridgeAction,
  onError?: (error: unknown) => void,
): Promise<void> {
  try {
    await bridge.call(agentId, action.method, action.params ?? {})
  } catch (error) {
    if (onError !== undefined) onError(error)
  }
}
