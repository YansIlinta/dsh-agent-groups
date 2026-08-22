/**
 * Phase 2 tests: External Agent Bridge.
 *
 * The bridge must delegate to GroupHost and must not reimplement task/channel
 * logic. Security comes from GroupHost's membership checks.
 */
import { describe, expect, it } from 'vitest'
import { ExternalAgentBridge } from '../src/runtime/bridge.js'
import { makeHost } from './helpers.js'

describe('Phase 2: External Agent Bridge', () => {
  it('lets a group member read context, tasks, channel, workspace and private messages', async () => {
    const host = makeHost()
    const group = await host.initGroup('lead-1', { name: 'Bridge Group', objective: 'demo', acceptanceCriteria: ['done'] })
    await host.groups.addMember(group.groupId, {
      sessionId: 'ext-1',
      profileId: 'group-member',
      name: 'External One',
      role: 'member',
      status: 'idle',
    })
    const bridge = new ExternalAgentBridge(host)

    const context = await bridge.getContext('ext-1')
    expect(context.groupId).toBe(group.groupId)
    expect(context.member.name).toBe('External One')
    expect(context.groupName).toBe('Bridge Group')
    expect(context.roster.some((m) => m.sessionId === 'ext-1')).toBe(true)
    expect(context.recentChannel.length).toBeGreaterThan(0)
    expect(context.recentChannel[0]?.text).toContain('Bridge Group')
    expect(context.workspace.artifacts).toEqual([])

    expect(bridge.listTasks('ext-1')).toEqual([])
    expect(bridge.getWorkspace('ext-1')).toMatchObject({ artifacts: [] })
  })

  it('routes through the generic call method', async () => {
    const host = makeHost()
    const group = await host.initGroup('lead-1', { name: 'G', objective: 'demo', acceptanceCriteria: ['x'] })
    await host.groups.addMember(group.groupId, {
      sessionId: 'ext-2',
      profileId: 'group-member',
      name: 'External Two',
      role: 'member',
      status: 'idle',
    })
    const bridge = new ExternalAgentBridge(host)

    const post = await bridge.call('ext-2', 'group_post', { text: 'hello from external' })
    expect(post).toMatchObject({ text: 'hello from external' })

    const report = await bridge.call('ext-2', 'group_report_to_leader', { text: 'private report' })
    expect(report).toMatchObject({ direction: 'member-to-leader' })

    const messages = await bridge.call('ext-2', 'group_get_messages', {})
    expect(messages).toHaveLength(1)
  })

  it('enforces membership: non-members cannot use the bridge', async () => {
    const host = makeHost()
    await host.initGroup('lead-1', { name: 'G', objective: 'demo', acceptanceCriteria: ['x'] })
    const bridge = new ExternalAgentBridge(host)

    await expect(bridge.getContext('ghost')).rejects.toThrow(/not a member/i)
    await expect(bridge.call('ghost', 'group_list_tasks', {})).rejects.toThrow(/not a member/i)
  })

  it('external member can claim and complete an assigned task through the bridge', async () => {
    const host = makeHost()
    const group = await host.initGroup('lead-1', { name: 'G', objective: 'demo', acceptanceCriteria: ['x'] })
    await host.groups.addMember(group.groupId, {
      sessionId: 'ext-3',
      profileId: 'group-member',
      name: 'External Three',
      role: 'member',
      status: 'idle',
    })
    const task = await host.createTask('lead-1', {
      subject: 'Implement bridge',
      description: 'Make external agents first-class.',
      kind: 'implementation',
      acceptanceCriteria: ['bridge works'],
      priority: 'high',
      writeScopes: ['src/runtime'],
    })
    await host.assignTask('lead-1', { taskId: task.taskId, ownerId: 'ext-3' })

    const bridge = new ExternalAgentBridge(host)
    const claimed = await bridge.claimTask('ext-3', task.taskId)
    expect(claimed.status).toBe('in_progress')

    const completed = await bridge.completeTask('ext-3', {
      taskId: task.taskId,
      summary: 'Done',
      artifacts: ['src/runtime/bridge.ts'],
      changedFiles: ['src/runtime/bridge.ts'],
      tests: [{ command: 'npm test', passed: true }],
      risks: [],
      unresolved: [],
      completionClaim: true,
    })
    expect(completed.status).toBe('review')
    expect(completed.result?.summary).toBe('Done')
  })
})
