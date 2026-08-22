/**
 * GroupHost: the product service tools and the web API call into. Every
 * operation resolves the actor's DURABLE role before doing anything, then
 * delegates to the owning sub-service, persists through the domain store, and
 * pushes the change to the notifier. This is the enforcement point — a system
 * prompt is never the boundary (第 8/22 节).
 * @module @dsh-agent-groups/host
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, normalize } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  ActivityEvent,
  AgentMemberStatus,
  AgentProfile,
  AgentTaskResult,
  ChannelMessage,
  CompatibilityReport,
  GroupId,
  GroupListItem,
  GroupMember,
  GroupRecord,
  GroupSnapshot,
  GroupTask,
  KnownLeader,
  Mission,
  PrivateMessage,
  TaskKind,
  TaskStatus,
  TeamTemplate,
  Workstream,
  WorkspaceArtifact,
} from './core-types.js'
import { GroupService, GroupError, type MissionInput, type MemberView } from './group-service.js'
import { TaskService, type TaskInput, type TaskUpdatePatch } from './task-service.js'
import { ChannelService, PrivateMessageService } from './channel-service.js'
import { ActivityService } from './activity-service.js'
import { ProfileRegistry } from './profile-registry.js'
import { type AgentRuntimeAdapter } from './dsh-adapter.js'
import { GroupNotifier } from './notifier.js'
import { groupMessageSource } from './message-source.js'
import { LeaderRegistry } from './leader-registry.js'
import { listTemplates, requireTemplate, templateMemberSlots } from './template-registry.js'

export function textContent(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

export interface LeaderActor {
  readonly group: GroupRecord
  readonly leader: GroupMember
}

/**
 * The complete host surface. Constructed in the plugin's `apply` with the
 * domain-backed stores and the DSH adapter; each method is role-guarded.
 */
export class GroupHost {
  readonly groups: GroupService
  readonly tasks: TaskService
  readonly channel: ChannelService
  readonly privateMessages: PrivateMessageService
  readonly activity: ActivityService
  readonly profiles: ProfileRegistry
  readonly notifier: GroupNotifier
  readonly leaders: LeaderRegistry
  private readonly adapter: AgentRuntimeAdapter

  constructor(options: {
    groups: GroupService
    tasks: TaskService
    channel: ChannelService
    privateMessages: PrivateMessageService
    activity: ActivityService
    profiles: ProfileRegistry
    notifier: GroupNotifier
    adapter: AgentRuntimeAdapter
    leaders: LeaderRegistry
  }) {
    this.groups = options.groups
    this.tasks = options.tasks
    this.channel = options.channel
    this.privateMessages = options.privateMessages
    this.activity = options.activity
    this.profiles = options.profiles
    this.notifier = options.notifier
    this.adapter = options.adapter
    this.leaders = options.leaders
  }

  // ── actor resolution ──────────────────────────────────────────────────────

  private leaderActor(actor: string, groupId?: GroupId): LeaderActor {
    void this.leaders.register(actor)
    const group = this.groups.resolveActorGroup(actor, 'leader', groupId)
    return { group, leader: this.groups.assertLeader(group.groupId, actor) }
  }

  private memberContext(actor: string, groupId?: GroupId): { group: GroupRecord; member: GroupMember } {
    const group = this.groups.resolveActorGroup(actor, 'member', groupId)
    return { group, member: this.groups.assertMember(group.groupId, actor) }
  }

  // ── Leader operations ─────────────────────────────────────────────────────

  async initGroup(
    actor: string,
    input: { name: string; objective: string; constraints?: string[]; deliverables?: string[]; acceptanceCriteria?: string[]; risks?: string[] },
  ): Promise<GroupRecord> {
    void this.leaders.register(actor)
    const cwd = this.adapter.liveAgent(actor)?.agent.session.header.cwd
    const group = await this.groups.initGroup(actor, this.actorDisplayName(actor), input.name, input, { cwd })
    await this.channel.post(group.groupId, {
      senderId: 'system',
      senderName: 'System',
      kind: 'system',
      text: `Group "${group.name}" created with mission: ${input.objective}`,
    })
    return this.groups.requireGroup(group.groupId)
  }

  async spawnMember(actor: string, input: { profileId: string; name?: string; displayRole?: string }): Promise<GroupMember> {
    const { group } = this.leaderActor(actor)
    this.groups.assertDispatchable(group)
    return this.spawnMemberInto(group.groupId, input)
  }

  /**
   * Shared member materialization (leader-tool path AND user console path).
   * Guards: profile exists, optional profile-repeat policy for template slots,
   * roster cap, dispatchable. `profileRepeat` allows template count>1 slots of
   * one profile (the leader tool keeps the one-member-per-profile rule).
   */
  private async spawnMemberInto(
    groupId: string,
    input: { profileId: string; name?: string; displayRole?: string },
    opts?: { profileRepeat?: boolean },
  ): Promise<GroupMember> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    this.groups.assertDispatchable(group)
    const profile = this.profiles.require(input.profileId)
    if ((opts?.profileRepeat ?? false) !== true) {
      const existing = this.groups
        .listMembers(group.groupId, () => undefined)
        .find((member) => member.profileId === input.profileId && member.role === 'member' && member.status !== 'left')
      if (existing !== undefined) {
        throw new GroupError('ALREADY_MEMBER', `a member from profile "${input.profileId}" already exists (${existing.name})`)
      }
    }
    const memberCount = this.groups.listMembers(group.groupId, () => undefined).filter((m) => m.status !== 'left').length
    if (group.maxMembers !== undefined && memberCount >= group.maxMembers) {
      throw new GroupError('CONFLICT', `roster cap reached (maxMembers=${group.maxMembers}); raise the cap in group settings to add more`)
    }
    const memberSessionId = randomUUID()
    await this.adapter.createMemberAgent({
      sessionId: memberSessionId,
      parentId: group.leaderSessionId,
      cwd: group.cwd,
      provider: profile.provider,
      model: profile.model,
    })
    const member = await this.groups.addMember(group.groupId, {
      sessionId: memberSessionId,
      profileId: profile.id,
      name: input.name ?? profile.name,
      role: 'member',
      status: 'idle',
      ...(input.displayRole !== undefined ? { displayRole: input.displayRole } : {}),
    })
    await this.adapter.deliver(memberSessionId, textContent(this.spawnNotice(group)), groupMessageSource(group.groupId, { label: 'group membership notice' }))
    await this.channel.post(group.groupId, {
      senderId: 'system',
      senderName: 'System',
      kind: 'system',
      text: `${member.name} joined the group (profile: ${profile.name}).`,
    })
    return member
  }

  private spawnNotice(group: GroupRecord): string {
    return [
      '[Agent Groups · Welcome]',
      `You have joined the group "${group.name}" as a member.`,
      `Mission: ${group.mission.objective}`,
      `Your leader session is ${group.leaderSessionId}.`,
      'You can list the task board (group_list_tasks), claim a task (group_claim_task),',
      'post to the channel (group_post), and report privately to the leader (group_report_to_leader).',
      'You cannot direct-message another teammate; channel posts and leader reports are your group communication.',
    ].join('\n')
  }

  async addWorkstream(actor: string, input: { title: string; description?: string }): Promise<Workstream> {
    const { group } = this.leaderActor(actor)
    return this.groups.addWorkstream(group.groupId, input.title, input.description)
  }

  async replan(actor: string, input: { reason: string; mission?: Partial<Mission>; newWorkstreams?: Array<{ title: string; description?: string }> }): Promise<GroupRecord> {
    const { group } = this.leaderActor(actor)
    if (input.mission !== undefined) await this.groups.updateMission(group.groupId, input.mission)
    for (const ws of input.newWorkstreams ?? []) await this.groups.addWorkstream(group.groupId, ws.title, ws.description)
    await this.activity.append({
      groupId: group.groupId,
      type: 'leader_replanned',
      actorId: actor,
      refMemberId: group.leaderSessionId,
      payload: { reason: input.reason },
    })
    this.notifier.emit(group.groupId, 'group', undefined)
    return this.groups.requireGroup(group.groupId)
  }

  async createTask(actor: string, input: Omit<TaskInput, 'createdBy'>): Promise<GroupTask> {
    const { group } = this.leaderActor(actor)
    this.groups.assertDispatchable(group)
    return this.tasks.createTask(group.groupId, { ...input, createdBy: actor })
  }

  async createVerifierTask(actor: string, input: { overTaskId: string; subject: string; description: string; assignedBy?: string }): Promise<GroupTask> {
    const { group } = this.leaderActor(actor)
    this.groups.assertDispatchable(group)
    return this.tasks.createVerifierTask(group.groupId, input.overTaskId, {
      subject: input.subject,
      description: input.description,
      kind: 'verification',
      acceptanceCriteria: ['Pass/fail evidence reported'],
      expectedArtifacts: ['verdict + evidence'],
      priority: 'high',
      createdBy: actor,
      assignedBy: input.assignedBy,
    })
  }

  async assignTask(actor: string, input: { taskId: string; ownerId: string; expectedRevision?: number; deliver?: boolean }): Promise<GroupTask> {
    const { group } = this.leaderActor(actor)
    this.groups.assertDispatchable(group)
    this.groups.requireMember(group.groupId, input.ownerId)
    const task = await this.tasks.assign(group.groupId, input.taskId, input.ownerId, actor, input.expectedRevision)
    if (input.deliver !== false) {
      await this.adapter.deliver(
        input.ownerId,
        textContent(this.taskBrief(group, task)),
        groupMessageSource(group.groupId, { direction: 'leader-to-member', label: 'task assignment' }),
      )
    }
    return task
  }

  async verifyTask(actor: string, input: { taskId: string; passed: boolean; notes?: string }): Promise<GroupTask> {
    const { group } = this.leaderActor(actor)
    return this.tasks.verify(group.groupId, input.taskId, actor, input.passed, input.notes)
  }

  async reopenTask(actor: string, input: { taskId: string; reason?: string }): Promise<GroupTask> {
    const { group } = this.leaderActor(actor)
    this.groups.assertDispatchable(group)
    return this.tasks.reopen(group.groupId, input.taskId, actor, input.reason)
  }

  async retryTask(actor: string, input: { taskId: string; subject?: string }): Promise<GroupTask> {
    const { group } = this.leaderActor(actor)
    this.groups.assertDispatchable(group)
    const original = this.tasks.requireTask(group.groupId, input.taskId)
    return this.tasks.createTask(group.groupId, {
      subject: input.subject ?? `Retry: ${original.subject}`,
      description: original.description,
      kind: original.kind,
      acceptanceCriteria: original.acceptanceCriteria,
      expectedArtifacts: original.expectedArtifacts,
      priority: original.priority,
      writeScopes: original.writeScopes,
      blockedBy: original.blockedBy,
      createdBy: actor,
      retryOf: original.taskId,
    })
  }

  async markTaskFailed(actor: string, input: { taskId: string; reason: string }): Promise<GroupTask> {
    const { group } = this.leaderActor(actor)
    return this.tasks.markFailed(group.groupId, input.taskId, actor, input.reason)
  }

  async messageMember(actor: string, input: { memberSessionId: string; text: string }): Promise<PrivateMessage> {
    const { group } = this.leaderActor(actor)
    const member = this.groups.requireMember(group.groupId, input.memberSessionId)
    const message = await this.privateMessages.send(group.groupId, {
      senderId: actor,
      senderName: this.actorDisplayName(actor),
      recipientId: member.sessionId,
      direction: 'leader-to-member',
      text: input.text,
    })
    await this.adapter.deliver(
      member.sessionId,
      textContent(`[Private message from Leader]\n${input.text}`),
      groupMessageSource(group.groupId, { direction: 'leader-to-member', label: 'private message from Leader' }),
    )
    return message
  }

  async broadcast(actor: string, input: { text: string; kind?: 'message' | 'status' | 'task'; replyToMessageId?: string }): Promise<ChannelMessage> {
    const { group } = this.leaderActor(actor)
    return this.channel.post(group.groupId, { senderId: actor, senderName: this.actorDisplayName(actor), kind: input.kind, text: input.text, replyToMessageId: input.replyToMessageId })
  }

  async interruptMember(actor: string, input: { memberSessionId: string; reason: string }): Promise<boolean> {
    const { group } = this.leaderActor(actor)
    this.groups.requireMember(group.groupId, input.memberSessionId)
    const ok = this.adapter.interrupt(input.memberSessionId, input.reason)
    await this.groups.patchMember(group.groupId, input.memberSessionId, { error: `interrupted: ${input.reason}` })
    await this.activity.append({
      groupId: group.groupId,
      type: 'member_interrupted',
      actorId: actor,
      refMemberId: input.memberSessionId,
      payload: { reason: input.reason },
    })
    return ok
  }

  async completeMission(actor: string, groupId?: GroupId): Promise<GroupRecord> {
    const { group } = this.leaderActor(actor, groupId)
    const reopened = (await this.tasks.listTasks(group.groupId)).filter(
      (task) => task.status !== 'completed' && task.status !== 'failed',
    )
    const completed = await this.groups.completeMission(group.groupId, actor)
    await this.channel.post(group.groupId, {
      senderId: actor,
      senderName: this.actorDisplayName(actor),
      kind: 'status',
      text: reopened.length > 0
        ? `Leader completed the mission with ${reopened.length} open task(s).`
        : 'Leader completed the mission. All tasks closed.',
    })
    return completed
  }

  // ── Member operations ─────────────────────────────────────────────────────

  async claimTask(actor: string, input: { taskId: string; expectedRevision?: number }): Promise<GroupTask> {
    const { group } = this.memberContext(actor)
    this.groups.assertDispatchable(group)
    return this.tasks.claim(group.groupId, input.taskId, actor, input.expectedRevision)
  }

  async completeTask(actor: string, input: { taskId: string; summary: string; artifacts: string[]; changedFiles?: string[]; tests?: AgentTaskResult['tests']; risks?: string[]; unresolved?: string[]; completionClaim: boolean }): Promise<GroupTask> {
    const { group } = this.memberContext(actor)
    const task = await this.tasks.complete(group.groupId, input.taskId, actor, {
      summary: input.summary,
      artifacts: input.artifacts,
      changedFiles: input.changedFiles,
      tests: input.tests,
      risks: input.risks,
      unresolved: input.unresolved,
      completionClaim: input.completionClaim,
    })
    await this.groups.patchMember(group.groupId, actor, { lastActiveAt: Date.now() })
    const leader = this.groups.getMembership(group.groupId, group.leaderSessionId)
    if (leader !== undefined) {
      await this.adapter.deliver(
        group.leaderSessionId,
        textContent(this.completionNotice(actor, task)),
        groupMessageSource(group.groupId, { direction: 'member-to-leader', label: 'task completion notice' }),
      )
    }
    return task
  }

  private completionNotice(actor: string, task: GroupTask): string {
    return [
      `[Task completion · ${task.subject}]`,
      `Member ${actor} submitted a completion claim for task ${task.taskId}.`,
      `Summary: ${task.result?.summary ?? '(none)'}`,
      `Artifacts: ${(task.result?.artifacts ?? []).join(', ') || '(none)'}`,
      `Review it with leader_verify_task(taskId="${task.taskId}", passed=<bool>).`,
    ].join('\n')
  }

  async postChannel(actor: string, input: { text: string; replyToMessageId?: string }): Promise<ChannelMessage> {
    const { group } = this.memberContext(actor)
    return this.channel.post(group.groupId, { senderId: actor, senderName: this.actorDisplayName(actor), text: input.text, replyToMessageId: input.replyToMessageId })
  }

  async reportToLeader(actor: string, input: { text: string }): Promise<PrivateMessage> {
    const { group } = this.memberContext(actor)
    const message = await this.privateMessages.send(group.groupId, {
      senderId: actor,
      senderName: this.actorDisplayName(actor),
      recipientId: group.leaderSessionId,
      direction: 'member-to-leader',
      text: input.text,
    })
    await this.adapter.deliver(
      group.leaderSessionId,
      textContent(`[Private report from member ${this.actorDisplayName(actor)}]\n${input.text}`),
      groupMessageSource(group.groupId, { direction: 'member-to-leader', label: 'private report from member' }),
    )
    return message
  }

  async actorStatus(actor: string, groupId?: GroupId): Promise<{ groupId: string; role: 'leader' | 'member'; status: AgentMemberStatus }> {
    const { group, member } = this.memberContext(actor, groupId)
    const live = this.adapter.liveAgent(actor)
    return { groupId: group.groupId, role: member.role, status: member.role === 'member' ? resolveLiveStatus(member.status, live?.status) : member.status }
  }

  // ── reads (both roles + web) ──────────────────────────────────────────────

  roster(actor: string, groupId?: GroupId): MemberView[] {
    const { group } = this.actorContext(actor, groupId)
    return this.groups.listMembers(group.groupId, (sessionId) => this.adapter.liveAgent(sessionId)?.status)
  }

  taskBoard(actor: string, groupId?: GroupId): GroupTask[] {
    const { group } = this.actorContext(actor, groupId)
    return this.tasks.listTasks(group.groupId)
  }

  taskDetail(actor: string, taskId: string, groupId?: GroupId): GroupTask {
    const { group } = this.actorContext(actor, groupId)
    return this.tasks.requireTask(group.groupId, taskId)
  }

  channelFeed(actor: string, groupId?: GroupId, limit = 200): ChannelMessage[] {
    const { group } = this.actorContext(actor, groupId)
    return this.channel.list(group.groupId, limit)
  }

  privateMessagesView(actor: string, groupId?: GroupId): PrivateMessage[] {
    const { group } = this.actorContext(actor, groupId)
    const membership = this.groups.getMembership(group.groupId, actor)
    if (membership?.role === 'leader') return this.privateMessages.listForGroup(group.groupId, actor)
    return this.privateMessages.listForPrincipal(group.groupId, actor)
  }

  profilesView(): AgentProfile[] {
    return this.profiles.list()
  }

  activityFeed(actor: string, groupId?: GroupId, limit = 500): ActivityEvent[] {
    const { group } = this.actorContext(actor, groupId)
    return this.activity.list(group.groupId, limit)
  }

  private actorContext(actor: string, groupId?: GroupId): { group: GroupRecord } {
    if (groupId !== undefined) {
      const group = this.groups.requireGroup(groupId)
      if (!this.groups.isLeader(groupId, actor) && !this.groups.isMember(groupId, actor)) {
        throw new GroupError('NO_GROUP', `actor ${actor} is not part of group ${groupId}`)
      }
      return { group }
    }
    const group = this.groups.groupForActor(actor)
    if (group === undefined) throw new GroupError('NO_GROUP', 'actor is not in a group')
    return { group }
  }

  // ── web / user ────────────────────────────────────────────────────────────

  /** Compact overview used by leader_status / leader_wait. */
  statusOverview(actor: string): unknown {
    try {
      const { group } = this.leaderActor(actor)
      const roster = this.groups.listMembers(group.groupId, (sessionId) => this.adapter.liveAgent(sessionId)?.status)
      const tasks = this.tasks.listTasks(group.groupId)
      const channel = this.channel.list(group.groupId, 40)
      return {
        group: { id: group.groupId, name: group.name, status: group.status, mission: group.mission.objective, workstreams: group.workstreams },
        members: roster.map((member) => ({
          sessionId: member.sessionId,
          name: member.name,
          profileId: member.profileId,
          status: member.liveStatus,
          currentTask: member.currentTaskId ?? null,
        })),
        tasks: tasks.map((task) => ({
          taskId: task.taskId,
          subject: task.subject,
          status: task.status,
          owner: task.ownerId ?? null,
          kind: task.kind,
          blockedBy: task.blockedBy,
          writeScopes: task.writeScopes,
        })),
        recentActivity: channel.slice(-10),
      }
    } catch (error) {
      if (error instanceof GroupError && error.code === 'NO_GROUP') {
        return { note: 'No group is bound to this session yet. Call leader_init_group first.' }
      }
      throw error
    }
  }

  listGroupsForWeb(includeArchived = false): GroupListItem[] {
    return this.groups
      .listGroups()
      .filter((group) => includeArchived || group.archivedAt === undefined)
      .map((group) => {
        const members = this.groups.listMembers(group.groupId, () => undefined)
        return {
          groupId: group.groupId,
          name: group.name,
          status: group.status,
          leaderSessionId: group.leaderSessionId,
          missionObjective: group.mission.objective,
          memberCount: members.filter((member) => member.status !== 'left').length,
          taskCount: this.tasks.listTasks(group.groupId).length,
          createdAt: group.createdAt,
          updatedAt: group.updatedAt,
          pausedAt: group.pausedAt,
          archivedAt: group.archivedAt,
        }
      })
      .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
  }

  async userMessageToLeader(groupId: GroupId, text: string): Promise<boolean> {
    const group = this.groups.requireGroup(groupId)
    if (group.status === 'completed' || group.archivedAt !== undefined) return false
    await this.privateMessages.send(group.groupId, {
      senderId: 'user',
      senderName: 'User',
      recipientId: group.leaderSessionId,
      direction: 'user-to-leader',
      text,
    })
    return this.adapter.deliver(group.leaderSessionId, textContent(text), { kind: 'user' })
  }

  /** V0.2: Leader replies to the user inside the Agent Groups page Leader Chat. */
  async leaderReplyToUser(actor: string, input: { text: string }): Promise<PrivateMessage> {
    const { group } = this.leaderActor(actor)
    return this.privateMessages.send(group.groupId, {
      senderId: actor,
      senderName: this.actorDisplayName(actor),
      recipientId: 'user',
      direction: 'leader-to-user',
      text: input.text,
    })
  }

  /** V0.2: Leader edits the shared Mission Notes. */
  async leaderUpdateNotes(actor: string, input: { notes: string }): Promise<GroupRecord> {
    const { group } = this.leaderActor(actor)
    return this.groups.updateNotes(group.groupId, input.notes, this.actorDisplayName(actor))
  }

  /** V0.2: Leader pauses/resumes its own group (dispatch gate only). */
  async leaderSetPaused(actor: string, paused: boolean): Promise<GroupRecord> {
    const { group } = this.leaderActor(actor)
    const record = await this.groups.setPaused(group.groupId, paused, this.actorDisplayName(actor))
    return record
  }

  /** V0.2: user → team broadcast, posted on the Group Channel. */
  async userBroadcast(groupId: GroupId, text: string): Promise<ChannelMessage> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    return this.channel.post(group.groupId, { senderId: 'user', senderName: 'User', text })
  }

  // ── V0.2: user console (create / manage team) ─────────────────────────────

  /**
   * Create a group from the Agent Groups page: binds a KNOWN leader session (one that
   * already acted as a Leader) so the role model is never bypassed; the bound
   * session must own no group yet. Optional team template materializes the
   * member slots immediately (custom member lists allowed instead).
   */
  async userCreateGroup(input: {
    leaderSessionId: string
    name: string
    objective: string
    constraints?: string[]
    deliverables?: string[]
    acceptanceCriteria?: string[]
    risks?: string[]
    templateId?: string
    maxMembers?: number
    members?: Array<{ role?: string; profile: string; name?: string }>
  }): Promise<GroupRecord> {
    const { leaderSessionId } = input
    if (!this.leaders.isKnown(leaderSessionId)) {
      throw new GroupError('NOT_LEADER', `session ${leaderSessionId} has not acted as a Leader yet — start a session with the Team Lead preset and chat with it first`)
    }
    if (this.groups.groupForActor(leaderSessionId) !== undefined) {
      throw new GroupError('ACTIVE_GROUP_EXISTS', `session ${leaderSessionId} already belongs to a group`)
    }
    const cwd = this.adapter.liveAgent(leaderSessionId)?.agent.session.header.cwd
    const group = await this.groups.initGroup(leaderSessionId, 'Leader', input.name, input, {
      templateId: input.templateId,
      maxMembers: input.maxMembers,
      cwd,
    })
    await this.channel.post(group.groupId, {
      senderId: 'system',
      senderName: 'System',
      kind: 'system',
      text: `Group "${group.name}" created via the Agent Groups page with mission: ${input.objective}`,
    })
    let slots: Array<{ role?: string; profile: string; name?: string }> = input.members ?? []
    if (input.templateId !== undefined && slots.length === 0) {
      const template = requireTemplate(input.templateId)
      slots = templateMemberSlots(template).map((slot) => ({ ...slot }))
    }
    const profileCounts = new Map<string, number>()
    for (const slot of slots) {
      const repeat = profileCounts.get(slot.profile) ?? 0
      profileCounts.set(slot.profile, repeat + 1)
      const name = slot.name ?? (repeat === 0 ? slot.role : `${slot.role} ${repeat + 1}`)
      try {
        await this.spawnMemberInto(group.groupId, { profileId: slot.profile, name, displayRole: slot.role }, { profileRepeat: true })
      } catch (error) {
        if (error instanceof GroupError && (error.code === 'ALREADY_MEMBER' || error.code === 'PAUSED' || error.code === 'CONFLICT')) {
          await this.channel.post(group.groupId, {
            senderId: 'system',
            senderName: 'System',
            kind: 'system',
            text: `Skipped member slot ${slot.profile}: ${error.message}`,
          })
          continue
        }
        throw error
      }
    }
    return this.groups.requireGroup(group.groupId)
  }

  /** V0.2: Agent Groups page "Add Member" — same gates as the leader spawn path. */
  async userSpawnMember(groupId: GroupId, input: { profileId: string; name?: string; displayRole?: string }): Promise<GroupMember> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    this.groups.assertDispatchable(group)
    return this.spawnMemberInto(group.groupId, input)
  }

  /** V0.2: remove/archive a member; history and messages stay (第 9 节). */
  async userRemoveMember(groupId: GroupId, memberSessionId: string): Promise<void> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    const member = this.groups.requireMember(group.groupId, memberSessionId)
    if (member.role === 'leader') throw new GroupError('CONFLICT', 'the Leader cannot be removed')
    await this.adapter.disposeMember(memberSessionId)
    await this.groups.removeMember(group.groupId, memberSessionId)
    await this.activity.append({
      groupId,
      type: 'member_removed',
      actorName: 'User',
      refMemberId: memberSessionId,
      payload: { name: member.name, profileId: member.profileId },
    })
    await this.channel.post(group.groupId, {
      senderId: 'system',
      senderName: 'System',
      kind: 'system',
      text: `${member.name} was removed from the team.`,
    })
  }

  /** V0.2: rename the display name / display role of a member. */
  async userPatchMember(
    groupId: GroupId,
    memberSessionId: string,
    patch: { name?: string; displayRole?: string },
  ): Promise<GroupMember | undefined> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    return this.groups.patchMember(group.groupId, memberSessionId, patch)
  }

  async userPauseGroup(groupId: GroupId, paused: boolean): Promise<GroupRecord> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    return this.groups.setPaused(group.groupId, paused, 'User')
  }

  async userArchiveGroup(groupId: GroupId, archived: boolean): Promise<GroupRecord> {
    const group = this.groups.requireGroup(groupId)
    if (group.status === 'completed' && !archived) {
      // restoring a completed group is allowed (settings), keep status
    }
    return this.groups.archiveGroup(group.groupId, archived, 'User')
  }

  async userDuplicateGroup(groupId: GroupId, name?: string): Promise<GroupRecord> {
    const group = this.groups.requireGroup(groupId)
    if (group.status !== 'completed' && group.archivedAt === undefined) {
      throw new GroupError('CONFLICT', 'duplicate only after the mission is completed or archived — one active group per Leader')
    }
    const copy = await this.groups.duplicateGroup(group.groupId, name)
    const roster = this.groups.listMembers(group.groupId, () => undefined).filter((m) => m.role === 'member' && m.status !== 'left')
    for (const member of roster) {
      try {
        await this.spawnMemberInto(copy.groupId, {
          profileId: member.profileId,
          name: member.name,
          displayRole: member.displayRole,
        })
      } catch {
        // a full roster copy is best-effort; per-profile duplicates are skipped
      }
    }
    await this.channel.post(copy.groupId, {
      senderId: 'system',
      senderName: 'System',
      kind: 'system',
      text: `Group duplicated from "${group.name}" via the Agent Groups page.`,
    })
    return copy
  }

  async userUpdateNotes(groupId: GroupId, notes: string): Promise<GroupRecord> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    return this.groups.updateNotes(group.groupId, notes, 'User')
  }

  async userUpdateSettings(groupId: GroupId, patch: { name?: string; maxMembers?: number }): Promise<GroupRecord> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    return this.groups.updateGroupSettings(group.groupId, patch, 'User')
  }

  /** V0.2: Agent Groups page task editing (leader/user console; 第 12 节). */
  async userEditTask(groupId: GroupId, taskId: string, patch: TaskUpdatePatch): Promise<GroupTask> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    return this.tasks.updateTask(group.groupId, taskId, 'user', patch)
  }

  /** V0.2: Agent Groups page hold/release (kanban Ready ↔ Blocked, 第 13 节). */
  async userHoldTask(groupId: GroupId, taskId: string, held: boolean): Promise<GroupTask> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    return this.tasks.setHeld(group.groupId, taskId, 'user', held)
  }

  /** V0.2: Agent Groups page pin/unpin (第 22 节). */
  async userPinMessage(groupId: GroupId, messageId: string, pinned: boolean): Promise<ChannelMessage> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    return this.channel.setPinned(group.groupId, messageId, 'user', pinned)
  }

  // ── V0.2: workspace (第 24–26 节) ─────────────────────────────────────────

  /** Derived workspace view: notes + artifacts from structured task results. */
  workspaceView(groupId: GroupId): { notes?: string; notesUpdatedAt?: number; artifacts: WorkspaceArtifact[] } {
    const group = this.groups.requireGroup(groupId)
    const artifacts: WorkspaceArtifact[] = []
    for (const task of this.tasks.listTasks(group.groupId)) {
      const result = task.result
      if (result === undefined) continue
      for (const path of result.artifacts ?? []) {
        artifacts.push({ path, source: 'artifact', taskId: task.taskId, taskSubject: task.subject, createdBy: result.submittedAt ? task.ownerId ?? group.leaderSessionId : group.leaderSessionId, createdAt: result.submittedAt })
      }
      for (const path of result.changedFiles ?? []) {
        artifacts.push({ path, source: 'changed', taskId: task.taskId, taskSubject: task.subject, createdBy: task.ownerId ?? group.leaderSessionId, createdAt: result.submittedAt })
      }
    }
    // de-duplicate by path+task (a changed file listed as artifact twice)
    const seen = new Set<string>()
    const unique = artifacts.filter((artifact) => {
      const key = `${artifact.taskId}:${artifact.path}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return { notes: group.notes, notesUpdatedAt: group.notesUpdatedAt, artifacts: unique }
  }

  /** V0.2: read a text preview of one artifact (contained under group cwd). */
  artifactPreview(groupId: GroupId, path: string): { ok: true; text: string } | { ok: false; error: string } {
    const group = this.groups.requireGroup(groupId)
    const cwd = group.cwd
    if (cwd === undefined) return { ok: false, error: 'group has no workspace root (leader session offline); cannot preview files' }
    const target = normalize(join(cwd, path))
    if (target !== cwd && !target.startsWith(`${normalize(cwd)}/`)) {
      return { ok: false, error: 'path escapes the group workspace' }
    }
    try {
      const buffer = readFileSync(target)
      const max = 16 * 1024
      const text = buffer.toString('utf8').slice(0, max)
      return { ok: true, text }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** V0.2: leader picker for Create Group UI. */
  listLeadersForWeb(): Array<KnownLeader & { hasActiveGroup: boolean; boundGroupId?: string }> {
    return this.leaders.list().map((leader) => {
      const group = this.groups.groupForActor(leader.sessionId)
      return {
        ...leader,
        hasActiveGroup: group !== undefined,
        boundGroupId: group?.groupId,
      }
    })
  }

  /** V0.2: templates exposed to the Agent Groups page (第 3/4 节). */
  templates(): readonly TeamTemplate[] {
    return listTemplates()
  }

  /** V0.2: agent profiles + deployment agent presets (第 7 节). */
  profilesViewWithPresets(): { profiles: AgentProfile[]; presets: Array<{ id: string; name?: string; description?: string }> } {
    return { profiles: this.profiles.list(), presets: readDeploymentPresets() }
  }

  snapshot(groupId: GroupId, compatibility: CompatibilityReport): GroupSnapshot {
    const group = this.groups.requireGroup(groupId)
    const members = this.groups.listMembers(groupId, (sessionId) => this.adapter.liveAgent(sessionId)?.status)
    const leaderLive = this.adapter.liveAgent(group.leaderSessionId) !== undefined
    return {
      group,
      members,
      tasks: this.tasks.listTasks(groupId),
      channel: this.channel.list(groupId),
      privateMessages: this.privateMessages.listForGroup(groupId, group.leaderSessionId),
      activity: this.activity.list(groupId),
      profiles: this.profiles.list(),
      leaderLive,
      compatibility,
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private actorDisplayName(actor: string): string {
    const membership = this.groups.getMembershipForAgent(actor)
    if (membership !== undefined) return membership.name
    return actor.slice(0, 8)
  }

  private taskBrief(group: GroupRecord, task: GroupTask): string {
    return [
      '[Agent Groups · Task Assignment]',
      `Group: ${group.name}`,
      `Task: ${task.subject}`,
      `Kind: ${task.kind}`,
      `Description: ${task.description}`,
      `Write scopes: ${task.writeScopes?.join(', ') || '(whole cwd — avoid other tasks)'}`,
      `Blocked by: ${task.blockedBy.join(', ') || 'none'}`,
      'Acceptance criteria:',
      ...task.acceptanceCriteria.map((c) => `  - ${c}`),
      `Task id: ${task.taskId}`,
      'After finishing, call group_complete_task with a structured result (summary, artifacts, changedFiles, tests, completionClaim=true when you believe the task is done).',
      'Use group_report_to_leader for private questions and group_post for group-visible updates.',
    ].join('\n')
  }
}

function resolveLiveStatus(durable: AgentMemberStatus, live: 'running' | 'idle' | undefined): AgentMemberStatus {
  if (durable === 'left' || durable === 'failed' || durable === 'provisioning') return durable
  if (live === 'running') return 'running'
  if (live === 'idle') return 'idle'
  return 'inactive'
}

const PRESET_METADATA_NAME = /^name:\s*(.+)$/m
const PRESET_METADATA_DESCRIPTION = /^description:\s*(.+)$/m

/** List deployment agent presets from the DSH home (第 7 节, read-only). */
function readDeploymentPresets(): Array<{ id: string; name?: string; description?: string }> {
  const roots = [process.env.DSH_HOME, join(process.env.HOME ?? '/', '.dsh')].filter((root): root is string => root !== undefined)
  for (const root of roots) {
    try {
      const presetRoot = join(root, '.agent-presets')
      const entries = readdirSync(presetRoot, { withFileTypes: true })
      const presets: Array<{ id: string; name?: string; description?: string }> = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const id = entry.name
        let name: string | undefined
        let description: string | undefined
        try {
          const text = readFileSync(join(presetRoot, id, 'preset.yml'), 'utf8')
          name = text.match(PRESET_METADATA_NAME)?.[1]?.replace(/^["']|["']$/g, '').trim()
          description = text.match(PRESET_METADATA_DESCRIPTION)?.[1]?.replace(/^["']|["']$/g, '').trim()
        } catch {
          // no metadata file — still list the preset by directory name
        }
        presets.push({ id, name, description })
      }
      return presets
    } catch {
      // no preset root — return nothing rather than failing the surface
    }
  }
  return []
}
