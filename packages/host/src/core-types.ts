/**
 * Shared data vocabulary for DSH Agent Groups. Every value in this file is
 * plain JSON-serializable data (optional fields are stored only when present);
 * it is the contract between the host services, the model-facing tools, and
 * the dashboard web API.
 * @module @dsh-agent-groups/host
 */

// ── identities ─────────────────────────────────────────────────────────────

export type GroupId = string
export type SessionScopedId = string
export type TaskId = string
export type WorkstreamId = string
export type AgentProfileId = string
export type ChannelMessageId = string
export type ActivityId = string
export type PrivateMessageId = string

// ── statuses ───────────────────────────────────────────────────────────────

/** Member lifecycle status. `running` is derived live, not stored. */
export type AgentMemberStatus =
  | 'provisioning'
  | 'running'
  | 'idle'
  | 'inactive'
  | 'failed'
  | 'left'

/** Task state machine. Review/Failed are product-level, derived in product metadata. */
export type TaskStatus =
  | 'pending'
  | 'blocked'
  | 'in_progress'
  | 'review'
  | 'completed'
  | 'failed'

export type GroupStatus = 'active' | 'completed'

export type TaskKind =
  | 'planning'
  | 'research'
  | 'implementation'
  | 'review'
  | 'verification'
  | 'other'

export type TaskPriority = 'low' | 'normal' | 'high' | 'critical' | 'urgent'

// ── Agent Profile (第 2 节) ─────────────────────────────────────────────────

/** One consumable agent role description. */
export interface AgentProfile {
  readonly id: AgentProfileId
  readonly name: string
  readonly presetId?: string
  readonly description: string
  readonly capabilities: readonly string[]
  readonly responsibilities?: readonly string[]
  readonly preferredTaskTypes?: readonly TaskKind[]
  readonly model?: string
  readonly provider?: string
  readonly tags?: readonly string[]
  readonly defaultWriteScopes?: readonly string[]
  readonly metadata?: Readonly<Record<string, unknown>>
}

// ── Group / Mission / Workstream (第 5 节) ─────────────────────────────────

export interface Workstream {
  readonly id: WorkstreamId
  readonly title: string
  readonly description?: string
  readonly createdAt: number
}

/** The Leader's understanding of the mission (第 11 节 A). */
export interface Mission {
  readonly objective: string
  readonly constraints: readonly string[]
  readonly deliverables: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly risks: readonly string[]
}

export interface GroupRecord {
  readonly groupId: GroupId
  readonly name: string
  readonly status: GroupStatus
  /** Durable session id of the group's single Leader agent. */
  readonly leaderSessionId: string
  readonly mission: Mission
  readonly workstreams: readonly Workstream[]
  readonly createdAt: number
  readonly completedAt?: number
  /** Working directory members spawned under (snapshotted at creation). */
  readonly cwd?: string
  /** V0.2: pause gate — set while the group must not dispatch new work. */
  readonly pausedAt?: number
  /** V0.2: durable hiding marker; archived groups stay readable. */
  readonly archivedAt?: number
  /** V0.2: persistent shared notes (Mission Notes / Workspace Notes). */
  readonly notes?: string
  readonly notesUpdatedAt?: number
  /** Team template this group was started from (built-in template id). */
  readonly templateId?: string
  /** Optional roster cap enforced when adding members. */
  readonly maxMembers?: number
  /** Last durable mutation timestamp (set by mutators via withGroup). */
  readonly updatedAt?: number
}

// ── Members (第 3/4 节) ────────────────────────────────────────────────────

export interface GroupMember {
  /** Durable session id; acts as the member identity. */
  readonly sessionId: string
  readonly groupId: GroupId
  readonly profileId: AgentProfileId
  readonly name: string
  /** Durable lifecycle position; `running` is derived live from the Agent. */
  readonly status: AgentMemberStatus
  readonly role: 'leader' | 'member'
  readonly joinedAt: number
  readonly currentTaskId?: TaskId
  readonly error?: string
  readonly lastActiveAt?: number
  /** V0.2: display-only role label, independent from the Agent Profile. */
  readonly displayRole?: string
}

// ── Tasks (第 5/6/12 节) ───────────────────────────────────────────────────

/** Product metadata layered over the task graph (§6). */
export interface GroupTaskMetadata {
  readonly groupId: GroupId
  readonly taskId: TaskId
  readonly parentId?: TaskId
  readonly kind: TaskKind
  readonly requiredCapabilities?: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly expectedArtifacts?: readonly string[]
  readonly priority: TaskPriority
  readonly createdBy: string
  readonly assignedBy?: string
  readonly verifierTaskIds?: readonly string[]
  readonly retryOf?: TaskId
  /** Owning workstream in the mission plan. */
  readonly workstreamId?: string
  /** Simple string tags (frontend, backend, research, docs, bug, …). */
  readonly tags?: readonly string[]
}

/** A DAG node: the product metadata plus the DSH-family task graph fields. */
export interface GroupTask extends GroupTaskMetadata {
  readonly subject: string
  readonly description: string
  readonly writeScopes?: readonly string[]
  readonly blockedBy: readonly TaskId[]
  readonly ownerId?: string
  readonly status: TaskStatus
  /** V0.2: user/leader held the task — board shows it as blocked. */
  readonly heldAt?: number
  readonly heldBy?: string
  /** Monotonic revision for optimistic concurrency control. */
  readonly revision: number
  readonly attempt: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly result?: AgentTaskResult
  readonly verification?: TaskVerification
}

export interface TaskVerification {
  readonly verifiedBy: string
  readonly passed: boolean
  readonly notes?: string
  readonly timestamp: number
}

/** Structured completion report an executing agent submits (§12). */
export interface AgentTaskResult {
  readonly taskId: TaskId
  readonly summary: string
  readonly artifacts: readonly string[]
  readonly changedFiles?: readonly string[]
  readonly tests?: ReadonlyArray<{ readonly command: string; readonly passed: boolean; readonly output?: string }>
  readonly risks?: readonly string[]
  readonly unresolved?: readonly string[]
  /** The agent's own claim; it does not complete the Mission by itself. */
  readonly completionClaim: boolean
  readonly submittedAt: number
}

// ── Group Channel (第 9 节) ────────────────────────────────────────────────

export type ChannelMessageKind = 'message' | 'status' | 'task' | 'system'

export interface ChannelMessage {
  readonly id: ChannelMessageId
  readonly groupId: GroupId
  readonly senderId: string
  readonly senderName: string
  readonly timestamp: number
  readonly kind: ChannelMessageKind
  /** Plain text render of the content blocks (dashboard + model-facing). */
  readonly text: string
  readonly refTaskId?: TaskId
  /** V0.2: thread parent for simple replies. */
  readonly replyToMessageId?: ChannelMessageId
  /** V0.2: set while the message is pinned to the channel header. */
  readonly pinnedAt?: number
  readonly pinnedBy?: string
}

// ── Private Leader ⇄ Member / User (第 10 节) ─────────────────────────────

export type PrivateDirection =
  | 'leader-to-member'
  | 'member-to-leader'
  | 'user-to-leader'
  | 'leader-to-user'

export interface PrivateMessage {
  readonly id: PrivateMessageId
  readonly groupId: GroupId
  readonly senderId: string
  readonly senderName: string
  readonly recipientId: string
  readonly direction: PrivateDirection
  readonly timestamp: number
  readonly text: string
}

// ── Activity Timeline (第 18 节) ───────────────────────────────────────────

/** Defined activity vocabulary; `payload` carries kind-specific JSON. */
export type ActivityType =
  | 'mission_created'
  | 'mission_completed'
  | 'agent_joined'
  | 'agent_started'
  | 'agent_idle'
  | 'agent_failed'
  | 'member_interrupted'
  | 'member_removed'
  | 'task_created'
  | 'task_assigned'
  | 'task_claimed'
  | 'task_completed'
  | 'task_updated'
  | 'task_reopened'
  | 'task_failed'
  | 'group_message'
  | 'message_pinned'
  | 'private_message'
  | 'verification_passed'
  | 'verification_failed'
  | 'leader_replanned'
  | 'notes_updated'
  | 'group_duplicated'
  | 'group_status'

export interface ActivityEvent {
  readonly id: ActivityId
  readonly groupId: GroupId
  readonly timestamp: number
  readonly type: ActivityType
  readonly actorId?: string
  readonly actorName?: string
  readonly refTaskId?: TaskId
  readonly refMemberId?: string
  readonly payload: Readonly<Record<string, unknown>>
}

// ── Web transport ──────────────────────────────────────────────────────────

/** Plain identity of one web client connection (browser tab). */
export type WebClientId = string

/** SSE delta pushed to dashboard clients. */
export interface GroupUpdate {
  readonly seq: number
  readonly groupId: GroupId
  readonly kind: 'activity' | 'channel' | 'task' | 'member' | 'group'
  readonly event?: ActivityEvent
}

/** Full dashboard state for one group (§15–18). */
export interface GroupSnapshot {
  readonly group: GroupRecord
  readonly members: ReadonlyArray<GroupMember & { readonly liveStatus: AgentMemberStatus }>
  readonly tasks: readonly GroupTask[]
  readonly channel: readonly ChannelMessage[]
  readonly privateMessages: readonly PrivateMessage[]
  readonly activity: readonly ActivityEvent[]
  readonly profiles: readonly AgentProfile[]
  readonly leaderLive: boolean
  readonly compatibility: CompatibilityReport
}

// ── Compatibility diagnostic (第 27 节) ───────────────────────────────────

export interface CompatibilityReport {
  readonly dshVersion: string
  readonly checks: ReadonlyArray<{ readonly name: string; readonly ok: boolean; readonly detail?: string }>
  readonly fatal: readonly string[]
}

// ── V0.2: Team Templates (第 3/4 节) ───────────────────────────────────────

/** One member slot in a team template. */
export interface TemplateMemberSpec {
  readonly role: string
  readonly profile: string
  readonly count?: number
}

/** A preset team: leader profile + member slots the user can adjust. */
export interface TeamTemplate {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly leaderProfile: string
  readonly members: readonly TemplateMemberSpec[]
  readonly icon?: string
}

// ── V0.2: known leader sessions (Create Group UI) ──────────────────────────

/** Durable record of a session that acted as a group Leader. */
export interface KnownLeader {
  readonly sessionId: string
  readonly firstSeenAt: number
  readonly lastSeenAt: number
}

// ── V0.2: workspace surface (第 24–26 节) ─────────────────────────────────

/** One artifact surfaced from a task's structured result. */
export interface WorkspaceArtifact {
  readonly path: string
  readonly source: 'artifact' | 'changed'
  readonly taskId: TaskId
  readonly taskSubject: string
  readonly createdBy: string
  readonly createdAt: number
}

/** Compact group list item for the dashboard home (第 42/43 节). */
export interface GroupListItem {
  readonly groupId: GroupId
  readonly name: string
  readonly status: GroupStatus
  readonly leaderSessionId: string
  readonly missionObjective: string
  readonly memberCount: number
  readonly taskCount: number
  readonly createdAt: number
  readonly updatedAt?: number
  readonly pausedAt?: number
  readonly archivedAt?: number
}
