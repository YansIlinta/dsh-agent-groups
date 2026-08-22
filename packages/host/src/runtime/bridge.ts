/**
 * External Agent Bridge (Phase 2).
 *
 * This is Agent Groups' own runtime communication layer for external coding
 * agents (Codex, Claude Code, future runtimes). External agents never touch
 * GroupHost internal objects directly; they call this bridge with their
 * agentId/groupId, and every call is delegated to the existing GroupHost
 * methods where durable membership/role/task ownership is enforced.
 *
 * The bridge intentionally contains no task/channel implementation: GroupHost
 * remains the single source of truth.
 *
 * @module @dsh-agent-groups/host
 */

import type { GroupHost } from '../group-host.js'
import type { ChannelMessage, GroupMember, GroupTask, PrivateMessage, TaskPriority, WorkspaceArtifact } from '../core-types.js'
import { AgentContextService, type AgentContextCursor, type AgentContextDelta } from './context.js'

export type ExternalBridgeMethod =
  | 'group_get_context'
  | 'group_get_task'
  | 'group_list_tasks'
  | 'group_claim_task'
  | 'group_post'
  | 'group_report_to_leader'
  | 'group_read_channel'
  | 'group_complete_task'
  | 'group_get_workspace'
  | 'group_get_messages'

export interface ExternalBridgeParams {
  readonly taskId?: string
  readonly text?: string
  readonly replyToMessageId?: string
  readonly limit?: number
  readonly summary?: string
  readonly artifacts?: string[]
  readonly changedFiles?: string[]
  readonly tests?: Array<{ command: string; passed: boolean; output?: string }>
  readonly risks?: string[]
  readonly unresolved?: string[]
  readonly completionClaim?: boolean
  readonly groupId?: string
  readonly cursor?: AgentContextCursor
}

/** Compact context returned to an external agent on demand. */
export interface ExternalAgentContext {
  readonly groupId: string
  readonly member: GroupMember
  readonly groupName: string
  readonly roster: ReadonlyArray<GroupMember & { readonly liveStatus: string }>
  readonly currentTask?: GroupTask
  readonly recentChannel: readonly ChannelMessage[]
  readonly recentPrivate: readonly PrivateMessage[]
  readonly recentActivity: ReadonlyArray<{ readonly id: string; readonly type: string; readonly timestamp: number; readonly refTaskId?: string }>
  readonly workspace: { readonly notes?: string; readonly notesUpdatedAt?: number; readonly artifacts: readonly WorkspaceArtifact[] }
}

export class ExternalAgentBridge {
  private readonly context: AgentContextService

  constructor(private readonly host: GroupHost) {
    this.context = new AgentContextService(host)
  }

  /** Resolve the effective group for an external member. */
  private resolveGroup(agentId: string, groupId?: string): string {
    if (groupId !== undefined) {
      // This also throws if the agent is not a member of the group.
      this.host.roster(agentId, groupId)
      return groupId
    }
    const membership = this.host.groups.getMembershipForAgent(agentId)
    if (membership === undefined) {
      throw new Error(`external agent ${agentId} is not a member of any group`)
    }
    return membership.groupId
  }

  /** Generic JSON-call entrypoint for CLI/runtime bridge transports. */
  async call(agentId: string, method: ExternalBridgeMethod, params: ExternalBridgeParams = {}): Promise<unknown> {
    switch (method) {
      case 'group_get_context':
        return params.cursor === undefined
          ? this.getContext(agentId, params.groupId)
          : this.getContextDelta(agentId, params.cursor, params.groupId)
      case 'group_get_task':
        return this.getTask(agentId, this.requireString(params.taskId, 'taskId'), params.groupId)
      case 'group_list_tasks':
        return this.listTasks(agentId, params.groupId)
      case 'group_claim_task':
        return this.claimTask(agentId, this.requireString(params.taskId, 'taskId'), params.groupId)
      case 'group_post':
        return this.post(agentId, this.requireString(params.text, 'text'), params.groupId, params.replyToMessageId)
      case 'group_report_to_leader':
        return this.reportToLeader(agentId, this.requireString(params.text, 'text'), params.groupId)
      case 'group_read_channel':
        return this.readChannel(agentId, params.groupId, params.limit ?? 100)
      case 'group_complete_task':
        return this.completeTask(agentId, {
          taskId: this.requireString(params.taskId, 'taskId'),
          summary: this.requireString(params.summary, 'summary'),
          artifacts: params.artifacts ?? [],
          changedFiles: params.changedFiles,
          tests: params.tests,
          risks: params.risks,
          unresolved: params.unresolved,
          completionClaim: params.completionClaim ?? true,
        }, params.groupId)
      case 'group_get_workspace':
        return this.getWorkspace(agentId, params.groupId)
      case 'group_get_messages':
        return this.getMessages(agentId, params.groupId)
      default:
        throw new Error(`unknown external bridge method: ${String(method)}`)
    }
  }

  async getContext(agentId: string, groupId?: string): Promise<ExternalAgentContext> {
    const group = this.resolveGroup(agentId, groupId)
    const member = this.host.groups.requireMember(group, agentId)
    const record = this.host.groups.requireGroup(group)
    const roster = this.host.roster(agentId, group)
    const tasks = this.host.taskBoard(agentId, group)
    const currentTask = member.currentTaskId === undefined
      ? undefined
      : tasks.find((task) => task.taskId === member.currentTaskId)

    return {
      groupId: group,
      member,
      groupName: record.name,
      roster,
      currentTask,
      recentChannel: this.host.channelFeed(agentId, group, 50),
      recentPrivate: this.host.privateMessagesView(agentId, group).slice(-20),
      recentActivity: this.host.activityFeed(agentId, group, 50).map((event) => ({
        id: event.id,
        type: event.type,
        timestamp: event.timestamp,
        refTaskId: event.refTaskId,
      })),
      workspace: this.getWorkspace(agentId, group),
    }
  }

  getContextDelta(agentId: string, cursor?: AgentContextCursor, groupId?: string): AgentContextDelta {
    // The context service resolves membership before reading anything. When no
    // cursor is supplied it uses the bridge's per-agent stored cursor.
    return this.context.getDelta(agentId, groupId, cursor)
  }

  getTask(agentId: string, taskId: string, groupId?: string): GroupTask {
    const group = this.resolveGroup(agentId, groupId)
    return this.host.taskDetail(agentId, taskId, group)
  }

  listTasks(agentId: string, groupId?: string): GroupTask[] {
    const group = this.resolveGroup(agentId, groupId)
    return this.host.taskBoard(agentId, group)
  }

  async claimTask(agentId: string, taskId: string, groupId?: string): Promise<GroupTask> {
    const group = this.resolveGroup(agentId, groupId)
    return this.host.claimTask(agentId, { taskId }, group)
  }

  async post(agentId: string, text: string, groupId?: string, replyToMessageId?: string): Promise<ChannelMessage> {
    const group = this.resolveGroup(agentId, groupId)
    return this.host.postChannel(agentId, { text, replyToMessageId }, group)
  }

  async reportToLeader(agentId: string, text: string, groupId?: string): Promise<PrivateMessage> {
    const group = this.resolveGroup(agentId, groupId)
    return this.host.reportToLeader(agentId, { text }, group)
  }

  readChannel(agentId: string, groupId?: string, limit = 100): ChannelMessage[] {
    const group = this.resolveGroup(agentId, groupId)
    return this.host.channelFeed(agentId, group, limit)
  }

  async completeTask(
    agentId: string,
    input: {
      taskId: string
      summary: string
      artifacts: string[]
      changedFiles?: string[]
      tests?: Array<{ command: string; passed: boolean; output?: string }>
      risks?: string[]
      unresolved?: string[]
      completionClaim: boolean
    },
    groupId?: string,
  ): Promise<GroupTask> {
    const group = this.resolveGroup(agentId, groupId)
    return this.host.completeTask(agentId, input, group)
  }

  getWorkspace(agentId: string, groupId?: string): { notes?: string; notesUpdatedAt?: number; artifacts: WorkspaceArtifact[] } {
    const group = this.resolveGroup(agentId, groupId)
    return this.host.workspaceView(group)
  }

  getMessages(agentId: string, groupId?: string): PrivateMessage[] {
    const group = this.resolveGroup(agentId, groupId)
    return this.host.privateMessagesView(agentId, group)
  }

  private requireString(value: string | undefined, name: string): string {
    if (value === undefined || value.length === 0) {
      throw new Error(`${name} is required`)
    }
    return value
  }
}

/** Convenience type for bridge call payloads (exported for CLI adapters). */
export interface ExternalBridgeCall {
  readonly method: ExternalBridgeMethod
  readonly params?: ExternalBridgeParams
}
