/**
 * Known-leader registry (V0.2): durable list of sessions that acted as group
 * Leaders (populated on first leader tool use / init). The Agent Groups page uses it
 * for the "Create Group" leader picker — the web layer cannot see requester
 * sessions, so the picker must be explicit.
 * @module @dsh-agent-groups/host
 */

import type { KnownLeader } from './core-types.js'
import type { TableStore } from './store.js'

export class LeaderRegistry {
  private readonly store: TableStore<string, KnownLeader>

  constructor(store: TableStore<string, KnownLeader>) {
    this.store = store
  }

  /** Record that a session acted as a leader (idempotent, atomic bump). */
  async register(sessionId: string): Promise<void> {
    const now = Date.now()
    const existing = this.store.get(sessionId)
    if (existing !== undefined) {
      try {
        await this.store.update(sessionId, (current) => ({ ...current, lastSeenAt: now }))
        return
      } catch {
        // concurrent delete; fall through to put
      }
    }
    await this.store.put(sessionId, { sessionId, firstSeenAt: now, lastSeenAt: now })
  }

  get(sessionId: string): KnownLeader | undefined {
    return this.store.get(sessionId)
  }

  isKnown(sessionId: string): boolean {
    return this.store.get(sessionId) !== undefined
  }

  list(): KnownLeader[] {
    return [...this.store.entries()].map(([, leader]) => leader).sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  async remove(sessionId: string): Promise<boolean> {
    return this.store.delete(sessionId)
  }
}