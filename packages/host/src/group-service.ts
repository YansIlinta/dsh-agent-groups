/**
 * Group service: durable group records, rosters, role ownership, mission and
 * workstream state. Every role decision an operation needs is answered here —
 * the enforcement point the tools call into (delegation, not system prompts).
 * @module @dsh-agent-groups/host
 */

import { randomUUID } from 'node:crypto'
import type {
  AgentMemberStatus,
  GroupId,
  GroupMember,
  GroupRecord,
  GroupStatus,
  Mission,
  TaskId,
  TeamConfig,
  Workstream,
  WorkstreamId,
} from './core-types.js'
import type { TableStore } from './store.js'
import { scopedKey } from './store.js'
import { ActivityService } from './activity-service.js'

export class GroupError extends Error {
  readonly code: GroupErrorCode

  constructor(code: GroupErrorCode, message: string) {
    super(message)
    this.name = 'GroupError'
    this.code = code
  }
}

export type GroupErrorCode =
  | 'NOT_LEADER'
  | 'NOT_MEMBER'
  | 'NO_GROUP'
  | 'ACTIVE_GROUP_EXISTS'
  | 'NOT_FOUND'
  | 'ALREADY_MEMBER'
  | 'CONFLICT'
  | 'PAUSED'
  | 'ARCHIVED'
  | 'ROLE_NOT_FOUND'
  | 'ROLE_INSTANCE_LIMIT'
  | 'RUNTIME_UNAVAILABLE'
  | 'MODEL_UNAVAILABLE'
  | 'REASONING_UNAVAILABLE'
  | 'SPAWN_FAILED'
  // V0.5: loud runtime failure vocabulary (requirement §21)
  | 'SESSION_START_FAILED'
  | 'SESSION_RESUME_FAILED'
  | 'TURN_START_FAILED'
  | 'TURN_TIMEOUT'
  | 'TURN_INTERRUPTED'
  | 'RUNTIME_DISCONNECTED'

export interface MissionInput {
  readonly objective: string
  readonly constraints?: readonly string[]
  readonly deliverables?: readonly string[]
  readonly acceptanceCriteria?: readonly string[]
  readonly risks?: readonly string[]
}

export interface MemberView extends GroupMember {
  /** Live classification merged with the durable lifecycle position. */
  readonly liveStatus: AgentMemberStatus
}

export interface LiveStatusResolver {
  (sessionId: string): 'running' | 'idle' | undefined
}

export function resolveMemberViewStatus(member: GroupMember, live: 'running' | 'idle' | undefined): AgentMemberStatus {
  if (member.status === 'left') return 'left'
  if (member.status === 'failed') return 'failed'
  if (live === 'running') return 'running'
  if (live === 'idle') return 'idle'
  if (member.status === 'provisioning') return 'provisioning'
  return 'inactive'
}

export class GroupService {
  private readonly groups: TableStore<string, GroupRecord>
  private readonly members: TableStore<string, GroupMember>
  private readonly activity: ActivityService

  constructor(
    groups: TableStore<string, GroupRecord>,
    members: TableStore<string, GroupMember>,
    activity: ActivityService,
  ) {
    this.groups = groups
    this.members = members
    this.activity = activity
  }

  // ── group lifecycle ───────────────────────────────────────────────────────

  async initGroup(
    leaderSessionId: string,
    leaderName: string,
    name: string,
    missionInput: MissionInput,
    options?: { templateId?: string; maxMembers?: number; cwd?: string; teamConfig?: TeamConfig },
  ): Promise<GroupRecord> {
    const existingActive = this.activeGroupForActor(leaderSessionId)
    if (existingActive !== undefined) {
      throw new GroupError(
        'ACTIVE_GROUP_EXISTS',
        `session ${leaderSessionId} already leads active group ${existingActive.groupId}; complete or leave it first`,
      )
    }
    const groupId = randomUUID()
    const now = Date.now()
    const mission: Mission = {
      objective: missionInput.objective,
      constraints: missionInput.constraints ?? [],
      deliverables: missionInput.deliverables ?? [],
      acceptanceCriteria: missionInput.acceptanceCriteria ?? [],
      risks: missionInput.risks ?? [],
    }
    const group: GroupRecord = {
      groupId,
      name,
      status: 'active',
      leaderSessionId,
      mission,
      workstreams: [],
      createdAt: now,
      updatedAt: now,
      ...(options?.templateId !== undefined ? { templateId: options.templateId } : {}),
      ...(options?.maxMembers !== undefined ? { maxMembers: options.maxMembers } : {}),
      ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options?.teamConfig !== undefined ? { teamConfig: options.teamConfig } : {}),
    }
    const leader: GroupMember = {
      sessionId: leaderSessionId,
      groupId,
      profileId: 'leader',
      name: leaderName,
      status: 'idle',
      role: 'leader',
      joinedAt: now,
    }
    await this.groups.put(groupId, group)
    await this.members.put(scopedKey(groupId, leaderSessionId), leader)
    await this.activity.append({
      groupId,
      type: 'mission_created',
      actorId: leaderSessionId,
      actorName: leaderName,
      payload: { groupName: name },
    })
    await this.activity.append({
      groupId,
      type: 'agent_joined',
      actorId: leaderSessionId,
      actorName: leaderName,
      refMemberId: leaderSessionId,
      payload: { role: 'leader', profileId: 'leader' },
    })
    return group
  }

  async completeMission(groupId: GroupId, bySessionId: string): Promise<GroupRecord> {
    this.assertLeader(groupId, bySessionId)
    const group = await this.withGroup(groupId, (current) => ({
      ...current,
      status: 'completed' as GroupStatus,
      completedAt: Date.now(),
      updatedAt: Date.now(),
    }))
    await this.activity.append({
      groupId,
      type: 'mission_completed',
      actorId: bySessionId,
      refMemberId: bySessionId,
    })
    return group
  }

  // ── V0.2: pause / archive / notes / settings / duplicate (user console) ──

  isPaused(group: GroupRecord): boolean {
    return group.pausedAt !== undefined
  }

  isArchived(group: GroupRecord): boolean {
    return group.archivedAt !== undefined
  }

  /** Dispatch gate: paused groups reject new work, messaging stays open. */
  assertDispatchable(group: GroupRecord): void {
    if (group.pausedAt !== undefined) {
      throw new GroupError('PAUSED', `group "${group.name}" is paused; resume it to dispatch new work`)
    }
  }

  /** Archived groups reject further mutations except restore / reads. */
  assertMutable(group: GroupRecord): void {
    if (group.archivedAt !== undefined) {
      throw new GroupError('ARCHIVED', `group "${group.name}" is archived; restore it to modify`)
    }
  }

  async setPaused(groupId: GroupId, paused: boolean, byName: string): Promise<GroupRecord> {
    const group = await this.withGroup(groupId, (current) => ({
      ...current,
      ...(paused ? { pausedAt: Date.now() } : { pausedAt: undefined }),
      updatedAt: Date.now(),
    }))
    await this.activity.append({
      groupId,
      type: 'group_status',
      actorName: byName,
      payload: { state: paused ? 'paused' : 'resumed' },
    })
    return group
  }

  async archiveGroup(groupId: GroupId, archived: boolean, byName: string): Promise<GroupRecord> {
    const group = await this.withGroup(groupId, (current) => ({
      ...current,
      ...(archived ? { archivedAt: Date.now() } : { archivedAt: undefined }),
      updatedAt: Date.now(),
    }))
    await this.activity.append({
      groupId,
      type: 'group_status',
      actorName: byName,
      payload: { state: archived ? 'archived' : 'restored' },
    })
    return group
  }

  async updateNotes(groupId: GroupId, notes: string, byName: string): Promise<GroupRecord> {
    const group = await this.withGroup(groupId, (current) => ({
      ...current,
      notes,
      notesUpdatedAt: Date.now(),
      updatedAt: Date.now(),
    }))
    await this.activity.append({
      groupId,
      type: 'notes_updated',
      actorName: byName,
      payload: { length: notes.length },
    })
    return group
  }

  async updateGroupSettings(
    groupId: GroupId,
    patch: { name?: string; maxMembers?: number },
    byName: string,
  ): Promise<GroupRecord> {
    const fields: string[] = []
    if (patch.name !== undefined) fields.push('name')
    if (patch.maxMembers !== undefined) fields.push('maxMembers')
    const group = await this.withGroup(groupId, (current) => ({
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.maxMembers !== undefined ? { maxMembers: patch.maxMembers } : {}),
      updatedAt: Date.now(),
    }))
    await this.activity.append({
      groupId,
      type: 'group_status',
      actorName: byName,
      payload: { state: 'settings', fields },
    })
    return group
  }

  /**
   * Duplicate a group's MISSION setup into a fresh group (same name + "(copy)"
   * unless given, same mission/workstreams/template/settings, same leader).
   * No members, tasks, messages or activity are copied (第 41 节).
   */
  async duplicateGroup(sourceGroupId: GroupId, name?: string): Promise<GroupRecord> {
    const source = this.requireGroup(sourceGroupId)
    const target = await this.initGroup(
      source.leaderSessionId,
      this.memberName(source, source.leaderSessionId),
      name ?? `${source.name} (copy)`,
      source.mission,
      {
        templateId: source.templateId,
        maxMembers: source.maxMembers,
        cwd: source.cwd,
        teamConfig: source.teamConfig,
      },
    )
    const copied = await this.withGroup(target.groupId, (current) => ({
      ...current,
      workstreams: source.workstreams,
      teamConfig: source.teamConfig,
      updatedAt: Date.now(),
    }))
    await this.activity.append({
      groupId: target.groupId,
      type: 'group_duplicated',
      actorName: 'User',
      payload: { sourceGroupId },
    })
    return copied
  }

  private memberName(group: GroupRecord, sessionId: string): string {
    const member = this.members.get(scopedKey(group.groupId, sessionId))
    return member?.name ?? sessionId.slice(0, 8)
  }

  /** Atomic RMW that also stamps `updatedAt` (V0.2 history surface). */
  async withGroupTouch<T>(groupId: GroupId, fn: (current: GroupRecord) => GroupRecord): Promise<GroupRecord> {
    return this.withGroup(groupId, (current) => ({ ...fn(current), updatedAt: Date.now() }))
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  listGroups(): GroupRecord[] {
    return [...this.groups.entries()].map(([, group]) => group).sort((a, b) => a.createdAt - b.createdAt)
  }

  getGroup(groupId: GroupId): GroupRecord | undefined {
    return this.groups.get(groupId)
  }

  requireGroup(groupId: GroupId): GroupRecord {
    const group = this.groups.get(groupId)
    if (group === undefined) throw new GroupError('NOT_FOUND', `no such group: ${groupId}`)
    return group
  }

  /** Group whose leader or member is the given session, active first. */
  groupForActor(sessionId: string): GroupRecord | undefined {
    const active = this.activeGroupForActor(sessionId)
    if (active !== undefined) return active
    for (const [key, member] of this.members.entries()) {
      if (member.sessionId === sessionId && member.status !== 'left') {
        const group = this.groups.get(member.groupId)
        if (group !== undefined) return group
      }
    }
    return undefined
  }

  private activeGroupForActor(sessionId: string): GroupRecord | undefined {
    for (const [, group] of this.groups.entries()) {
      if (group.status !== 'active') continue
      if (group.leaderSessionId === sessionId) return group
      const member = this.members.get(scopedKey(group.groupId, sessionId))
      if (member !== undefined && member.status !== 'left' && member.status !== 'failed') return group
    }
    return undefined
  }

  // ── roles ─────────────────────────────────────────────────────────────────

  isLeader(groupId: GroupId, sessionId: string): boolean {
    const group = this.groups.get(groupId)
    return group !== undefined && group.leaderSessionId === sessionId
  }

  isMember(groupId: GroupId, sessionId: string): boolean {
    const member = this.members.get(scopedKey(groupId, sessionId))
    return member !== undefined && member.status !== 'left'
  }

  getMembership(groupId: GroupId, sessionId: string): GroupMember | undefined {
    const member = this.members.get(scopedKey(groupId, sessionId))
    return member === undefined || member.status === 'left' ? undefined : member
  }

  /** Any current membership (any group) for the given session, used by the policy gate. */
  getMembershipForAgent(sessionId: string): GroupMember | undefined {
    for (const [key, member] of this.members.entries()) {
      if (member.sessionId === sessionId && member.status !== 'left') return member
    }
    return undefined
  }

  assertLeader(groupId: GroupId, sessionId: string): GroupMember {
    const member = this.getMembership(groupId, sessionId)
    if (!this.isLeader(groupId, sessionId)) {
      throw new GroupError(
        'NOT_LEADER',
        `session ${sessionId} is not the leader of group ${groupId}`,
      )
    }
    if (member === undefined) throw new GroupError('NOT_MEMBER', `no membership for ${sessionId}`)
    return member
  }

  assertMember(groupId: GroupId, sessionId: string): GroupMember {
    const member = this.getMembership(groupId, sessionId)
    if (member === undefined) throw new GroupError('NOT_MEMBER', `no membership for ${sessionId}`)
    return member
  }

  /** Resolve which group an actor operates in, requiring the given role. */
  resolveActorGroup(sessionId: string, role: 'leader' | 'member', groupId?: GroupId): GroupRecord {
    const target = groupId === undefined ? this.groupForActor(sessionId) : this.groups.get(groupId)
    if (target === undefined) throw new GroupError('NO_GROUP', 'actor is not in a group')
    if (role === 'leader') {
      this.assertLeader(target.groupId, sessionId)
    } else {
      this.assertMember(target.groupId, sessionId)
    }
    return target
  }

  // ── members ───────────────────────────────────────────────────────────────

  async addMember(groupId: GroupId, member: Omit<GroupMember, 'joinedAt' | 'groupId'>): Promise<GroupMember> {
    this.requireGroup(groupId)
    const key = scopedKey(groupId, member.sessionId)
    if (this.members.get(key) !== undefined) throw new GroupError('ALREADY_MEMBER', `already a member: ${member.sessionId}`)
    const record: GroupMember = { ...member, groupId, joinedAt: Date.now() }
    await this.members.put(key, record)
    await this.activity.append({
      groupId,
      type: 'agent_joined',
      actorId: member.sessionId,
      actorName: member.name,
      refMemberId: member.sessionId,
      payload: { role: member.role, profileId: member.profileId },
    })
    return record
  }

  async patchMember(
    groupId: GroupId,
    sessionId: string,
    patch: Partial<Pick<GroupMember, 'status' | 'currentTaskId' | 'error' | 'lastActiveAt' | 'name' | 'runtimeSession'>>,
  ): Promise<GroupMember | undefined> {
    const key = scopedKey(groupId, sessionId)
    try {
      return (await this.members.update(key, (current) => ({ ...current, ...patch }) as GroupMember))
    } catch {
      return undefined
    }
  }

  async removeMember(groupId: GroupId, sessionId: string): Promise<void> {
    await this.members.put(scopedKey(groupId, sessionId), {
      ...this.requireMember(groupId, sessionId),
      status: 'left',
    })
  }

  requireMember(groupId: GroupId, sessionId: string): GroupMember {
    const member = this.members.get(scopedKey(groupId, sessionId))
    if (member === undefined) throw new GroupError('NOT_MEMBER', `no membership for ${sessionId}`)
    return member
  }

  listMembers(groupId: GroupId, live: LiveStatusResolver): MemberView[] {
    const rows: MemberView[] = []
    for (const [key, member] of this.members.entries()) {
      if (member.groupId !== groupId) continue
      rows.push({ ...member, liveStatus: resolveMemberViewStatus(member, live(member.sessionId)) })
    }
    rows.sort((a, b) => a.joinedAt - b.joinedAt)
    return rows
  }

  // ── mission / workstreams ─────────────────────────────────────────────────

  async updateMission(groupId: GroupId, patch: Partial<Mission>): Promise<GroupRecord> {
    return this.withGroup(groupId, (current) => ({ ...current, mission: { ...current.mission, ...patch } }))
  }

  async addWorkstream(groupId: GroupId, title: string, description?: string): Promise<Workstream> {
    const workstream: Workstream = { id: randomUUID(), title, createdAt: Date.now(), ...(description !== undefined ? { description } : {}) }
    await this.withGroup(groupId, (current) => ({ ...current, workstreams: [...current.workstreams, workstream] }))
    return workstream
  }

  async requireWorkstream(groupId: GroupId, workstreamId: WorkstreamId): Promise<Workstream> {
    const group = this.requireGroup(groupId)
    const found = group.workstreams.find((ws) => ws.id === workstreamId)
    if (found === undefined) throw new GroupError('NOT_FOUND', `no workstream ${workstreamId}`)
    return found
  }

  /** Atomic read-modify-write helper for group records. */
  async withGroup<T>(groupId: GroupId, fn: (current: GroupRecord) => GroupRecord): Promise<GroupRecord> {
    const result = (await this.groups.update(groupId, fn)) as GroupRecord
    return result
  }
}
