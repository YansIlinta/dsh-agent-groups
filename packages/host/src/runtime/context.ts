/**
 * Agent Context Cursor + Delta Context (Phase 5).
 *
 * Each agent maintains a lightweight cursor describing how much of the group
 * it has already seen. Instead of sending the full group history on every
 * turn, the host returns:
 *
 *   Base Context
 *   + Current Task
 *   + Relevant Messages
 *   + Changes Since Cursor
 *
 * This service is intentionally backed by GroupHost's existing stores; it does
 * not create a second copy of tasks/channel/activity state.
 *
 * @module @dsh-agent-groups/host
 */

import type { GroupHost } from '../group-host.js'
import type { ActivityEvent, ChannelMessage, GroupTask, PrivateMessage } from '../core-types.js'

/** Per-agent incremental context cursor. */
export interface AgentContextCursor {
  readonly lastChannelMessageId?: string
  readonly lastPrivateMessageId?: string
  readonly lastActivityId?: string
  readonly currentTaskRevision?: number
  /** Monotonic context version; incremented each time the cursor advances. */
  readonly contextVersion: number
}

/** The compact delta response returned to an agent. */
export interface AgentContextDelta {
  readonly groupId: string
  readonly cursor: AgentContextCursor
  readonly base: {
    readonly groupName: string
    readonly memberName: string
    readonly role: 'leader' | 'member'
    readonly currentTaskId?: string
    readonly rosterCount: number
  }
  readonly currentTask?: GroupTask
  readonly taskChanges: readonly GroupTask[]
  readonly channelMessages: readonly ChannelMessage[]
  readonly privateMessages: readonly PrivateMessage[]
  readonly activity: readonly ActivityEvent[]
}

export function createEmptyCursor(): AgentContextCursor {
  return { contextVersion: 0 }
}

function afterId<T extends { readonly id: string }>(rows: readonly T[], lastId: string | undefined): T[] {
  if (lastId === undefined) return [...rows]
  const index = rows.findIndex((row) => row.id === lastId)
  if (index < 0) return [...rows]
  return rows.slice(index + 1)
}

export class AgentContextService {
  private readonly cursors = new Map<string, AgentContextCursor>()

  constructor(private readonly host: GroupHost) {}

  getCursor(agentId: string): AgentContextCursor {
    return this.cursors.get(agentId) ?? createEmptyCursor()
  }

  setCursor(agentId: string, cursor: AgentContextCursor): void {
    this.cursors.set(agentId, cursor)
  }

  private resolveGroup(agentId: string, groupId?: string): string {
    if (groupId !== undefined) {
      this.host.roster(agentId, groupId)
      return groupId
    }
    const membership = this.host.groups.getMembershipForAgent(agentId)
    if (membership === undefined) {
      throw new Error(`agent ${agentId} is not a member of any group`)
    }
    return membership.groupId
  }

  /** Build and persist a context delta for the given agent. */
  getDelta(agentId: string, groupId?: string, providedCursor?: AgentContextCursor): AgentContextDelta {
    const group = this.resolveGroup(agentId, groupId)
    const member = this.host.groups.requireMember(group, agentId)
    const record = this.host.groups.requireGroup(group)
    const start = providedCursor ?? this.getCursor(agentId)

    const allTasks = this.host.taskBoard(agentId, group)
    const allChannel = this.host.channel.list(group)
    const visiblePrivate = this.host.privateMessagesView(agentId, group)
    const allActivity = this.host.activity.list(group)

    const currentTask = member.currentTaskId === undefined
      ? undefined
      : allTasks.find((task) => task.taskId === member.currentTaskId)

    const channelMessages = afterId(allChannel, start.lastChannelMessageId)
    const privateMessages = afterId(visiblePrivate, start.lastPrivateMessageId)
    const activity = afterId(allActivity, start.lastActivityId)
    const taskChanges = allTasks.filter((task) => task.revision > (start.currentTaskRevision ?? 0))

    const nextCursor: AgentContextCursor = {
      lastChannelMessageId: allChannel.length > 0 ? allChannel[allChannel.length - 1]?.id : start.lastChannelMessageId,
      lastPrivateMessageId: visiblePrivate.length > 0 ? visiblePrivate[visiblePrivate.length - 1]?.id : start.lastPrivateMessageId,
      lastActivityId: allActivity.length > 0 ? allActivity[allActivity.length - 1]?.id : start.lastActivityId,
      currentTaskRevision: currentTask?.revision ?? start.currentTaskRevision,
      contextVersion: start.contextVersion + 1,
    }
    this.setCursor(agentId, nextCursor)

    return {
      groupId: group,
      cursor: nextCursor,
      base: {
        groupName: record.name,
        memberName: member.name,
        role: member.role,
        currentTaskId: member.currentTaskId,
        rosterCount: this.host.roster(agentId, group).length,
      },
      currentTask,
      taskChanges,
      channelMessages,
      privateMessages,
      activity,
    }
  }

  /** Reset an agent's cursor (e.g. after task reassignment or member re-entry). */
  reset(agentId: string): void {
    this.cursors.delete(agentId)
  }
}
