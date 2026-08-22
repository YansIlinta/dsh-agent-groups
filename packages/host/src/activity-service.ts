/**
 * Activity timeline: durable append of every notable group event, plus the
 * push of matching deltas into the live-update hub. This is the single source
 * for the UI timeline and for leader "what happened" reads.
 * @module @dsh-agent-groups/host
 */

import { randomUUID } from 'node:crypto'
import type { ActivityEvent, ActivityType, GroupId } from './core-types.js'
import type { TableStore } from './store.js'
import { GroupNotifier } from './notifier.js'

export interface ActivityInput {
  readonly groupId: GroupId
  readonly type: ActivityType
  readonly actorId?: string
  readonly actorName?: string
  readonly refTaskId?: string
  readonly refMemberId?: string
  readonly payload?: Readonly<Record<string, unknown>>
}

export class ActivityService {
  private readonly store: TableStore<string, ActivityEvent>
  private readonly notifier: GroupNotifier

  constructor(store: TableStore<string, ActivityEvent>, notifier: GroupNotifier) {
    this.store = store
    this.notifier = notifier
  }

  async append(input: ActivityInput): Promise<ActivityEvent> {
    const event: ActivityEvent = {
      id: randomUUID(),
      groupId: input.groupId,
      timestamp: Date.now(),
      type: input.type,
      ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
      ...(input.actorName !== undefined ? { actorName: input.actorName } : {}),
      ...(input.refTaskId !== undefined ? { refTaskId: input.refTaskId } : {}),
      ...(input.refMemberId !== undefined ? { refMemberId: input.refMemberId } : {}),
      payload: input.payload ?? {},
    }
    await this.store.put(scopedKey(input.groupId, event.id), event)
    this.notifier.emit(input.groupId, 'activity', event)
    return event
  }

  list(groupId: GroupId, limit = 500): ActivityEvent[] {
    const rows: ActivityEvent[] = []
    for (const [key, event] of this.store.entries()) {
      if (key.startsWith(`${groupId}:`)) rows.push(event)
    }
    rows.sort((a, b) => a.timestamp - b.timestamp)
    return rows.slice(-limit)
  }
}

function scopedKey(scope: string, id: string): string {
  return `${scope}:${id}`
}

// Re-export for callers that only need the type.
export type { ActivityEvent }
