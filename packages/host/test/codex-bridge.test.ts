/**
 * Phase 3 tests: Codex Bridge Protocol parser and action execution.
 */
import { describe, expect, it } from 'vitest'
import {
  BRIDGE_MARKER,
  codexBridgeInstructions,
  executeBridgeAction,
  parseBridgeAction,
} from '../src/runtime/codex-bridge.js'
import type { ExternalAgentBridge } from '../src/runtime/bridge.js'

describe('Phase 3: Codex Bridge Protocol', () => {
  it('parses a bridge action from a marked stdout line', () => {
    const line = `${BRIDGE_MARKER} {"method":"group_post","params":{"text":"hello"}}`
    const action = parseBridgeAction(line)
    expect(action).toEqual({ method: 'group_post', params: { text: 'hello' } })
  })

  it('ignores non-bridge or malformed lines', () => {
    expect(parseBridgeAction('just normal output')).toBeUndefined()
    expect(parseBridgeAction(`${BRIDGE_MARKER} not-json`)).toBeUndefined()
    expect(parseBridgeAction(`${BRIDGE_MARKER} {"params":{}}`)).toBeUndefined()
  })

  it('includes the bridge method vocabulary in the instructions', () => {
    const instructions = codexBridgeInstructions()
    expect(instructions).toContain('group_get_context')
    expect(instructions).toContain('group_complete_task')
    expect(instructions).toContain('group_report_to_leader')
  })

  it('executes an action through the bridge and swallows errors', async () => {
    const calls: unknown[] = []
    const bridge = {
      call: async (agentId: string, method: string, params: unknown) => {
        calls.push([agentId, method, params])
        return { ok: true }
      },
    } as unknown as ExternalAgentBridge

    await executeBridgeAction(bridge, 'ext-1', { method: 'group_post', params: { text: 'hi' } })
    expect(calls).toHaveLength(1)

    const failing = {
      call: async () => { throw new Error('bridge rejected') },
    } as unknown as ExternalAgentBridge
    await expect(executeBridgeAction(failing, 'ext-1', { method: 'group_list_tasks' })).resolves.toBeUndefined()
  })
})
