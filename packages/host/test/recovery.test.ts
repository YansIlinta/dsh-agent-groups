/**
 * Phase 8 tests: runtime recovery + reliability guards.
 */
import { describe, expect, it } from 'vitest'
import { RuntimeRecovery } from '../src/runtime/recovery.js'
import { scopedKey } from '../src/store.js'
import { makeHost, makeStores } from './helpers.js'

describe('Phase 8: runtime recovery', () => {
  it('marks stale provisioning members as failed and records activity', async () => {
    const stores = makeStores()
    const host = makeHost(stores)
    const group = await host.initGroup('lead-1', { name: 'G', objective: 'demo', acceptanceCriteria: ['x'] })
    const member = await host.groups.addMember(group.groupId, {
      sessionId: 'ext-stale',
      profileId: 'group-member',
      name: 'Stale',
      role: 'member',
      status: 'provisioning',
    })
    // Simulate a very old member.
    await stores.members.update(scopedKey(group.groupId, member.sessionId), (current) => ({
      ...current,
      joinedAt: 1,
    }))

    const recovery = new RuntimeRecovery(host)
    const recovered = await recovery.recoverStaleProvisioning({ staleAfterMs: 10, now: 100 })

    expect(recovered).toEqual([member.sessionId])
    const after = host.groups.listMembers(group.groupId, () => undefined).find((m) => m.sessionId === member.sessionId)!
    expect(after.status).toBe('failed')
    expect(host.activity.list(group.groupId).some((a) => a.type === 'member_runtime_failed')).toBe(true)
  })

  it('duplicate completion is rejected by the task service', async () => {
    const host = makeHost()
    const group = await host.initGroup('lead-1', { name: 'G', objective: 'demo', acceptanceCriteria: ['x'] })
    await host.groups.addMember(group.groupId, {
      sessionId: 'ext-1',
      profileId: 'group-member',
      name: 'External',
      role: 'member',
      status: 'idle',
    })
    const task = await host.createTask('lead-1', {
      subject: 'T', description: 'D', kind: 'implementation',
      acceptanceCriteria: ['ok'], priority: 'normal', writeScopes: ['src'],
    })
    await host.assignTask('lead-1', { taskId: task.taskId, ownerId: 'ext-1' })
    await host.claimTask('ext-1', { taskId: task.taskId })

    await host.completeTask('ext-1', {
      taskId: task.taskId, summary: 'done', artifacts: [], completionClaim: true,
    })

    await expect(host.completeTask('ext-1', {
      taskId: task.taskId, summary: 'again', artifacts: [], completionClaim: true,
    })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
