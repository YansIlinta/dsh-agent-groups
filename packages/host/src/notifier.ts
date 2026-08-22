/**
 * Live-update hub: services emit typed deltas after every durable commit; web
 * clients and (optionally) leader notifications subscribe. Durable truth lives
 * in the store; the hub only fans out change notifications.
 * @module @dsh-agent-groups/host
 */

import type { GroupId, GroupUpdate } from './core-types.js'

export interface GroupUpdateListener {
  (update: GroupUpdate): void
}

export class GroupNotifier {
  private readonly listeners = new Set<GroupUpdateListener>()
  private seq = 0

  /** Broadcast one update to every subscriber. */
  emit(groupId: GroupId, kind: GroupUpdate['kind'], event: GroupUpdate['event']): void {
    this.seq += 1
    const update: GroupUpdate = { seq: this.seq, groupId, kind, event }
    for (const listener of [...this.listeners]) {
      try {
        listener(update)
      } catch {
        // A subscriber failure must not break the commit path.
      }
    }
  }

  /** Subscribe; returns the unsubscribe closure. */
  subscribe(listener: GroupUpdateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get currentSeq(): number {
    return this.seq
  }
}
