/**
 * Write-scope overlap detection. The MVP keeps the shared-checkout model; the
 * Leader avoids overlapping scopes when parallelizing and the UI surfaces the
 * remaining conflicts loudly (第 13 节).
 * @module @dsh-agent-groups/host
 */

import type { GroupTask } from './core-types.js'

/** True when one scope is a path prefix of the other (or equal). */
export function scopesOverlap(a: string, b: string): boolean {
  const normA = a.replace(/\/+$/, '')
  const normB = b.replace(/\/+$/, '')
  if (normA === normB) return true
  return normA.startsWith(`${normB}/`) || normB.startsWith(`${normA}/`)
}

export function writeScopesOf(task: GroupTask): readonly string[] {
  return task.writeScopes ?? []
}

export interface WriteConflict {
  readonly taskAId: string
  readonly taskBId: string
  readonly overlappingScopes: string[]
}

/** Non-terminal tasks whose write scopes overlap. */
export function detectWriteOverlaps(tasks: readonly GroupTask[]): WriteConflict[] {
  const active = tasks.filter((task) => task.status !== 'completed' && task.status !== 'failed')
  const conflicts: WriteConflict[] = []
  for (let i = 0; i < active.length; i += 1) {
    const a = active[i]
    if (!a) continue
    for (let j = i + 1; j < active.length; j += 1) {
      const b = active[j]
      if (!b) continue
      const overlapping = writeScopesOf(a).filter((sa) => writeScopesOf(b).some((sb) => scopesOverlap(sa, sb)))
      if (overlapping.length > 0) {
        conflicts.push({ taskAId: a.taskId, taskBId: b.taskId, overlappingScopes: overlapping })
      }
    }
  }
  return conflicts
}
