/**
 * Runtime Recovery (Phase 8).
 *
 * Reliability helpers layered on top of GroupHost. They do not replace the
 * existing runtime-exit callbacks; they handle durable-state cleanup for
 * cases such as a DSH restart, a hung provisioning runtime, or a stale member
 * that never transitioned to running.
 *
 * @module @dsh-agent-groups/host
 */

import type { GroupHost } from '../group-host.js'

export interface RecoveryOptions {
  /** Members stuck in provisioning longer than this are marked failed. */
  readonly staleAfterMs?: number
  /** Inject a clock for tests. */
  readonly now?: number
}

export class RuntimeRecovery {
  constructor(private readonly host: GroupHost) {}

  /**
   * Mark long-stuck provisioning members as failed and emit runtime_failed
   * activity. Returns the member ids that were recovered.
   */
  async recoverStaleProvisioning(options: RecoveryOptions = {}): Promise<string[]> {
    const now = options.now ?? Date.now()
    const staleAfterMs = options.staleAfterMs ?? 10 * 60 * 1000
    const recovered: string[] = []

    for (const group of this.host.groups.listGroups()) {
      const groupId = group.groupId
      const members = this.host.groups.listMembers(groupId, () => undefined)
      for (const member of members) {
        if (member.status !== 'provisioning') continue
        if (now - member.joinedAt < staleAfterMs) continue
        await this.host.groups.patchMember(groupId, member.sessionId, {
          status: 'failed',
          error: `recovered: provisioning timed out after ${staleAfterMs}ms`,
        })
        await this.host.activity.append({
          groupId,
          type: 'member_runtime_failed',
          actorName: member.name,
          refMemberId: member.sessionId,
          payload: { reason: 'stale-provisioning', runtime: member.runtime },
        })
        recovered.push(member.sessionId)
      }
    }
    return recovered
  }
}
