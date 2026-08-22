import { describe, expect, it } from 'vitest'
import { detectWriteOverlaps, scopesOverlap } from '../src/conflicts.js'
import type { GroupTask } from '../src/core-types.js'

function task(id: string, scopes: string[], status: GroupTask['status']): GroupTask {
  return {
    groupId: 'g',
    taskId: id,
    kind: 'implementation',
    subject: id,
    description: '',
    status,
    priority: 'normal',
    createdBy: 'lead',
    acceptanceCriteria: [],
    blockedBy: [],
    attempt: 1,
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    ...(scopes.length > 0 ? { writeScopes: scopes } : {}),
  }
}

describe('write-scope overlap warnings (§13/§14)', () => {
  it('treats nested prefixes as overlapping', () => {
    expect(scopesOverlap('apps/web/src', 'apps/web/src/dashboard')).toBe(true)
    expect(scopesOverlap('apps/web/src/dashboard', 'apps/web/src')).toBe(true)
  })

  it('treats identical scopes (modulo trailing slash) as overlapping', () => {
    expect(scopesOverlap('src', 'src/')).toBe(true)
    expect(scopesOverlap('src', 'src')).toBe(true)
  })

  it('treats disjoint scopes as safe', () => {
    expect(scopesOverlap('apps/web/src', 'apps/server/src')).toBe(false)
    expect(scopesOverlap('a/b', 'c/d')).toBe(false)
  })

  it('only reports pairs among non-terminal tasks', () => {
    const tasks = [
      task('t1', ['src/a'], 'in_progress'),
      task('t2', ['src/a/b'], 'pending'),
      task('t3', ['src/a'], 'completed'), // terminal — must not conflict with t1
      task('t4', ['elsewhere'], 'in_progress'),
    ]
    const conflicts = detectWriteOverlaps(tasks)
    expect(conflicts.map((c) => [c.taskAId, c.taskBId])).toEqual([['t1', 't2']])
  })
})
