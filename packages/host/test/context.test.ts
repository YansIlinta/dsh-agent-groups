/**
 * Phase 5 tests: Agent Context Cursor + Delta Context.
 */
import { describe, expect, it } from 'vitest'
import { AgentContextService } from '../src/runtime/context.js'
import { ExternalAgentBridge } from '../src/runtime/bridge.js'
import { makeHost } from './helpers.js'

describe('Phase 5: context cursor & delta context', () => {
  it('returns only changes since the cursor instead of full history', async () => {
    const host = makeHost()
    const group = await host.initGroup('lead-1', { name: 'G', objective: 'demo', acceptanceCriteria: ['x'] })
    await host.groups.addMember(group.groupId, {
      sessionId: 'ext-1',
      profileId: 'group-member',
      name: 'External',
      role: 'member',
      status: 'idle',
    })
    const service = new AgentContextService(host)

    const first = service.getDelta('ext-1')
    // First request includes the initial system channel message.
    expect(first.channelMessages.length).toBeGreaterThan(0)
    expect(first.activity.length).toBeGreaterThan(0)
    expect(first.cursor.contextVersion).toBe(1)

    await host.postChannel('ext-1', { text: 'hello after cursor' })

    const second = service.getDelta('ext-1', group.groupId, first.cursor)
    expect(second.channelMessages).toHaveLength(1)
    expect(second.channelMessages[0]?.text).toBe('hello after cursor')
    expect(second.cursor.contextVersion).toBe(2)

    const third = service.getDelta('ext-1', group.groupId, second.cursor)
    expect(third.channelMessages).toHaveLength(0)
  })

  it('bridge group_get_context supports delta when a cursor is supplied', async () => {
    const host = makeHost()
    const group = await host.initGroup('lead-1', { name: 'Bridge Delta', objective: 'demo', acceptanceCriteria: ['x'] })
    await host.groups.addMember(group.groupId, {
      sessionId: 'ext-2',
      profileId: 'group-member',
      name: 'External Two',
      role: 'member',
      status: 'idle',
    })
    const bridge = new ExternalAgentBridge(host)

    const first = await bridge.call('ext-2', 'group_get_context', { cursor: { contextVersion: 0 } }) as { cursor: { contextVersion: number } }
    expect(first.cursor.contextVersion).toBeGreaterThan(0)

    const second = await bridge.call('ext-2', 'group_get_context', { cursor: first.cursor })
    expect(second).toMatchObject({ groupId: group.groupId })
    expect(second).toHaveProperty('channelMessages')
  })
})
