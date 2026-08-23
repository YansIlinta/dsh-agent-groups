import { describe, expect, it } from 'vitest'
import { GroupError } from '../src/group-service.js'
import { makeHarness, makeStores, seedGroup } from './helpers.js'

const RESULT = {
  summary: 'done',
  artifacts: ['a.ts', 'b.ts'],
  completionClaim: true,
  tests: [{ command: 'npm test', passed: true }],
}

describe('task lifecycle', () => {
  it('creates a task with revision 1 and strips empty optional fields', async () => {
    const h = makeHarness()
    const group = await seedGroup(h)
    const task = await h.tasks.createTask(group.groupId, {
      subject: 'Implement API',
      createdBy: 'lead',
      description: 'Add the /analytics endpoint',
      kind: 'implementation',
      acceptanceCriteria: ['tests pass'],
    })
    expect(task.revision).toBe(1)
    expect(task.attempt).toBe(1)
    expect(task.status).toBe('pending')
    expect(task.blockedBy).toEqual([])
    expect(task.writeScopes).toBeUndefined()
  })

  it('derives blocked status from incomplete dependencies', async () => {
    const h = makeHarness()
    const group = await seedGroup(h)
    const parent = await h.tasks.createTask(group.groupId, { createdBy: 'lead', subject: 'analyze', description: '…', kind: 'research', acceptanceCriteria: ['x'] })
    const child = await h.tasks.createTask(group.groupId, {
      subject: 'design',
      createdBy: 'lead',
      description: '…',
      kind: 'planning',
      acceptanceCriteria: ['x'],
      blockedBy: [parent.taskId],
    })
    expect(h.tasks.listTasks(group.groupId).find((t) => t.taskId === child.taskId)?.status).toBe('blocked')
    await h.tasks.claim(group.groupId, parent.taskId, 'm1')
    await h.tasks.complete(group.groupId, parent.taskId, 'm1', RESULT)
    await h.tasks.verify(group.groupId, parent.taskId, 'lead', true)
    expect(h.tasks.listTasks(group.groupId).find((t) => t.taskId === child.taskId)?.status).toBe('pending')
  })

  it('assign, claim, complete, verify pass; claiming another owner rejects', async () => {
    const h = makeHarness()
    const group = await seedGroup(h)
    const task = await h.tasks.createTask(group.groupId, { createdBy: 'lead', subject: 'build', description: '…', kind: 'implementation', acceptanceCriteria: ['ok'] })
    const assigned = await h.tasks.assign(group.groupId, task.taskId, 'm1', 'lead')
    expect(assigned.ownerId).toBe('m1')
    const claimed = await h.tasks.claim(group.groupId, task.taskId, 'm1')
    expect(claimed.status).toBe('in_progress')
    await expect(h.tasks.claim(group.groupId, task.taskId, 'm2')).rejects.toMatchObject({ code: 'CONFLICT' })
    const done = await h.tasks.complete(group.groupId, task.taskId, 'm1', RESULT)
    expect(done.status).toBe('review')
    expect(done.result?.completionClaim).toBe(true)
    const verified = await h.tasks.verify(group.groupId, task.taskId, 'lead', true)
    expect(verified.status).toBe('completed')
    await expect(h.tasks.verify(group.groupId, task.taskId, 'lead', true)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(h.tasks.requireTask(group.groupId, task.taskId).revision).toBe(5)
  })

  it('reject sets failed; reopen bumps attempt and resets to pending', async () => {
    const h = makeHarness()
    const group = await seedGroup(h)
    const task = await h.tasks.createTask(group.groupId, { createdBy: 'lead', subject: 'flake', description: '…', kind: 'implementation', acceptanceCriteria: ['ok'] })
    await h.tasks.assign(group.groupId, task.taskId, 'm1', 'lead')
    await h.tasks.claim(group.groupId, task.taskId, 'm1')
    await h.tasks.complete(group.groupId, task.taskId, 'm1', RESULT)
    await h.tasks.verify(group.groupId, task.taskId, 'lead', false, 'broken')
    const failed = h.tasks.requireTask(group.groupId, task.taskId)
    expect(failed.status).toBe('failed')
    expect(failed.verification?.passed).toBe(false)
    const reopened = await h.tasks.reopen(group.groupId, task.taskId, 'lead', 'retry once')
    expect(reopened.status).toBe('pending')
    expect(reopened.attempt).toBe(2)
  })

  it('persists independently identified attempts and settles each turn once', async () => {
    const h = makeHarness()
    const group = await seedGroup(h)
    const task = await h.tasks.createTask(group.groupId, { createdBy: 'lead', subject: 'attempts', description: '…', kind: 'implementation', acceptanceCriteria: ['ok'] })

    const first = await h.tasks.startAttempt(group.groupId, task.taskId, {
      memberId: 'm1',
      turnId: 'turn-1',
      runtime: 'codex',
      providerSessionId: 'session-1',
    })
    const duplicate = await h.tasks.startAttempt(group.groupId, task.taskId, {
      memberId: 'm1',
      turnId: 'turn-1',
      runtime: 'codex',
      providerSessionId: 'session-1',
    })
    expect(duplicate.attemptId).toBe(first.attemptId)
    expect(first).toMatchObject({ sequence: 1, status: 'running', turnId: 'turn-1' })

    const settled = await h.tasks.settleAttempt(group.groupId, task.taskId, 'turn-1', 'completed', 'implemented')
    expect(settled).toMatchObject({ attemptId: first.attemptId, status: 'completed', summary: 'implemented' })
    const lateFailure = await h.tasks.settleAttempt(group.groupId, task.taskId, 'turn-1', 'failed', 'late provider exit')
    expect(lateFailure).toMatchObject({ status: 'completed', summary: 'implemented' })
    expect(h.tasks.requireTask(group.groupId, task.taskId).attempts).toHaveLength(1)
  })

  it('records a new attempt sequence after a task is reopened', async () => {
    const h = makeHarness()
    const group = await seedGroup(h)
    const task = await h.tasks.createTask(group.groupId, { createdBy: 'lead', subject: 'retry', description: '…', kind: 'implementation', acceptanceCriteria: ['ok'] })
    await h.tasks.startAttempt(group.groupId, task.taskId, { memberId: 'm1', turnId: 'turn-1' })
    await h.tasks.settleAttempt(group.groupId, task.taskId, 'turn-1', 'failed', 'crashed')
    await h.tasks.assign(group.groupId, task.taskId, 'm1', 'lead')
    await h.tasks.claim(group.groupId, task.taskId, 'm1')
    await h.tasks.markFailed(group.groupId, task.taskId, 'm1', 'crashed')
    await h.tasks.reopen(group.groupId, task.taskId, 'lead', 'retry')
    const second = await h.tasks.startAttempt(group.groupId, task.taskId, { memberId: 'm1', turnId: 'turn-2' })

    expect(second.sequence).toBe(2)
    expect(h.tasks.requireTask(group.groupId, task.taskId).attempts?.map((attempt) => attempt.status)).toEqual(['failed', 'running'])
  })

  it('CAS rejects stale revisions with CONFLICT and keeps a single winner', async () => {
    const h = makeHarness()
    const group = await seedGroup(h)
    const task = await h.tasks.createTask(group.groupId, { createdBy: 'lead', subject: 'race', description: '…', kind: 'implementation', acceptanceCriteria: ['ok'] })
    await h.tasks.assign(group.groupId, task.taskId, 'm1', 'lead', task.revision)
    await expect(h.tasks.assign(group.groupId, task.taskId, 'm2', 'lead', task.revision)).rejects.toBeInstanceOf(GroupError)
    expect(h.tasks.requireTask(group.groupId, task.taskId).ownerId).toBe('m1')
  })

  it('groups, members and tasks survive a service reload over shared stores', async () => {
    const stores = makeStores()
    const h = makeHarness(stores)
    const group = await seedGroup(h)
    await h.tasks.createTask(group.groupId, { createdBy: 'lead', subject: 'persist', description: '…', kind: 'review', acceptanceCriteria: ['ok'] })
    const reloaded = makeHarness(stores)
    expect(reloaded.groups.requireGroup(group.groupId).status).toBe('active')
    expect(reloaded.tasks.listTasks(group.groupId)[0]?.subject).toBe('persist')
    expect(reloaded.groups.listMembers(group.groupId, () => undefined).map((m) => m.role)).toContain('leader')
  })
})
