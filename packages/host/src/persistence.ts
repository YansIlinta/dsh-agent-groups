/**
 * Durable persistence wiring for DSH Agent Groups: a single DSH storage
 * domain with one table per durable fact family, opened over the browser
 * host's JSON backend. All state is plugin-owned; DSH core is untouched.
 * @module @dsh-agent-groups/host
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type {
  ActivityEvent,
  AgentProfile,
  ChannelMessage,
  GroupMember,
  GroupRecord,
  GroupTask,
  KnownLeader,
  PrivateMessage,
} from './core-types.js'

export const DOMAIN_NAME = 'agent_groups'
export const DOMAIN_VERSION = 1

// ── record schemas (validated at the durable read boundary) ───────────────

const str = z.string()

const TASK_KINDS = ['planning', 'research', 'implementation', 'review', 'verification', 'other'] as const

const ACTIVITY_TYPES = [
  'mission_created',
  'mission_completed',
  'agent_joined',
  'agent_started',
  'agent_idle',
  'agent_failed',
  'member_interrupted',
  'member_removed',
  'task_created',
  'task_assigned',
  'task_claimed',
  'task_completed',
  'task_updated',
  'task_reopened',
  'task_failed',
  'group_message',
  'message_pinned',
  'private_message',
  'verification_passed',
  'verification_failed',
  'leader_replanned',
  'notes_updated',
  'group_duplicated',
  'group_status',
  'member_spawn_requested',
  'member_runtime_starting',
  'member_runtime_started',
  'member_runtime_failed',
  'member_runtime_stopped',
  'team_config_updated',
  'runtime_session_started',
  'runtime_session_resumed',
  'runtime_session_ready',
  'runtime_session_disconnected',
  'runtime_session_failed',
  'runtime_session_closed',
  'runtime_turn_started',
  'runtime_turn_completed',
  'runtime_turn_failed',
  'runtime_turn_cancelled',
  'runtime_approval_required',
  'runtime_input_required',
  'runtime_approval_answered',
  'runtime_request_answered',
  'runtime_turn_queued',
  'runtime_turn_steered',
  'runtime_steer_failed',
  'runtime_request_timed_out',
  'task_attempt_started',
  'task_attempt_completed',
  'task_attempt_failed',
  'task_attempt_cancelled',
  'task_attempt_lost',
  'task_dispatch_requested',
  'task_dispatch_started',
  'task_dispatch_delivered',
  'task_dispatch_ambiguous',
] as const

const profileSchema = z.object({
  id: str,
  name: str,
  presetId: str.optional(),
  description: str,
  capabilities: z.array(str),
  responsibilities: z.array(str).optional(),
  preferredTaskTypes: z.array(z.enum(TASK_KINDS)).optional(),
  model: str.optional(),
  provider: str.optional(),
  tags: z.array(str).optional(),
  defaultWriteScopes: z.array(str).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const workstreamSchema = z.object({
  id: str,
  title: str,
  description: str.optional(),
  createdAt: z.number(),
})

const missionSchema = z.object({
  objective: str,
  constraints: z.array(str),
  deliverables: z.array(str),
  acceptanceCriteria: z.array(str),
  risks: z.array(str),
})

const roleDefinitionSchema = z.object({
  id: str,
  name: str,
  description: str.optional(),
  runtime: str,
  profile: str.optional(),
  model: str.optional(),
  reasoningLevel: str.optional(),
  systemPrompt: str.optional(),
  maxInstances: z.number().optional(),
  defaultInstances: z.number().optional(),
  tools: z.array(str).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const teamConfigSchema = z.object({
  leaderRole: roleDefinitionSchema,
  memberRoles: z.array(roleDefinitionSchema),
})

const groupSchema = z.object({
  groupId: str,
  name: str,
  status: z.enum(['active', 'completed']),
  leaderSessionId: str,
  mission: missionSchema,
  workstreams: z.array(workstreamSchema),
  createdAt: z.number(),
  completedAt: z.number().optional(),
  cwd: str.optional(),
  workspaceMode: z.enum(['shared', 'worktree']).optional(),
  pausedAt: z.number().optional(),
  archivedAt: z.number().optional(),
  notes: str.optional(),
  notesUpdatedAt: z.number().optional(),
  templateId: str.optional(),
  maxMembers: z.number().optional(),
  updatedAt: z.number().optional(),
  teamConfig: teamConfigSchema.optional(),
})

const runtimeSessionSchema = z.object({
  runtime: str,
  provider: str.optional(),
  providerSessionId: str.optional(),
  providerThreadId: str.optional(),
  workspace: str.optional(),
  model: str.optional(),
  reasoningLevel: str.optional(),
  providerCapabilities: z.record(z.string(), z.unknown()).optional(),
  queuedTurns: z.array(z.object({
    seq: z.number(),
    kind: z.enum(['task', 'followup']),
    taskId: str.optional(),
    text: str,
    queuedAt: z.number(),
    behindTurnId: str.optional(),
  })).optional(),
  state: str.optional(),
  lastTurnId: str.optional(),
  lastTaskId: str.optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
})

const memberSchema = z.object({
  sessionId: str,
  groupId: str,
  profileId: str,
  name: str,
  status: z.enum(['provisioning', 'idle', 'inactive', 'failed', 'left']),
  role: z.enum(['leader', 'member']),
  joinedAt: z.number(),
  currentTaskId: str.optional(),
  error: str.optional(),
  lastActiveAt: z.number().optional(),
  displayRole: str.optional(),
  roleId: str.optional(),
  runtime: str.optional(),
  model: str.optional(),
  reasoningLevel: str.optional(),
  // V0.5: durable runtime-session metadata (optional → legacy members load).
  runtimeSession: runtimeSessionSchema.optional(),
})

const taskResultSchema = z.object({
  taskId: str,
  summary: str,
  artifacts: z.array(str),
  changedFiles: z.array(str).optional(),
  tests: z.array(z.object({ command: str, passed: z.boolean(), output: str.optional() })).optional(),
  risks: z.array(str).optional(),
  unresolved: z.array(str).optional(),
  completionClaim: z.boolean(),
  submittedAt: z.number(),
})

const verificationSchema = z.object({
  verifiedBy: str,
  passed: z.boolean(),
  notes: str.optional(),
  timestamp: z.number(),
})

const taskSchema = z.object({
  groupId: str,
  taskId: str,
  parentId: str.optional(),
  kind: z.enum(['planning', 'research', 'implementation', 'review', 'verification', 'other']),
  requiredCapabilities: z.array(str).optional(),
  acceptanceCriteria: z.array(str),
  expectedArtifacts: z.array(str).optional(),
  priority: z.enum(['low', 'normal', 'high', 'critical', 'urgent']),
  createdBy: str,
  assignedBy: str.optional(),
  verifierTaskIds: z.array(str).optional(),
  retryOf: str.optional(),
  workstreamId: str.optional(),
  tags: z.array(str).optional(),
  subject: str,
  description: str,
  writeScopes: z.array(str).optional(),
  blockedBy: z.array(str),
  ownerId: str.optional(),
  heldAt: z.number().optional(),
  heldBy: str.optional(),
  status: z.enum(['pending', 'blocked', 'in_progress', 'review', 'completed', 'failed']),
  revision: z.number(),
  attempt: z.number(),
  attempts: z.array(z.object({
    attemptId: str,
    groupId: str,
    taskId: str,
    sequence: z.number(),
    memberId: str,
    runtime: str.optional(),
    providerSessionId: str.optional(),
    turnId: str,
    status: z.enum(['running', 'completed', 'failed', 'cancelled', 'lost']),
    startedAt: z.number(),
    endedAt: z.number().optional(),
    summary: str.optional(),
    failure: str.optional(),
  })).optional(),
  dispatch: z.object({
    sequence: z.number(),
    ownerId: str,
    requestedBy: str,
    requestedAt: z.number(),
    state: z.enum(['pending', 'dispatching', 'delivered', 'ambiguous']),
    leaseId: str.optional(),
    leaseAt: z.number().optional(),
    deliveredAt: z.number().optional(),
    failure: str.optional(),
  }).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  result: taskResultSchema.optional(),
  verification: verificationSchema.optional(),
})

const channelSchema = z.object({
  id: str,
  groupId: str,
  senderId: str,
  senderName: str,
  timestamp: z.number(),
  kind: z.enum(['message', 'status', 'task', 'system']),
  text: str,
  refTaskId: str.optional(),
  replyToMessageId: str.optional(),
  pinnedAt: z.number().optional(),
  pinnedBy: str.optional(),
})

const privateSchema = z.object({
  id: str,
  groupId: str,
  senderId: str,
  senderName: str,
  recipientId: str,
  direction: z.enum(['leader-to-member', 'member-to-leader', 'user-to-leader', 'leader-to-user']),
  timestamp: z.number(),
  text: str,
})

const leaderSchema = z.object({
  sessionId: str,
  firstSeenAt: z.number(),
  lastSeenAt: z.number(),
})

const activitySchema = z.object({
  id: str,
  groupId: str,
  timestamp: z.number(),
  type: z.enum(ACTIVITY_TYPES),
  actorId: str.optional(),
  actorName: str.optional(),
  refTaskId: str.optional(),
  refMemberId: str.optional(),
  payload: z.record(z.string(), z.unknown()),
})

/** The whole durable surface in one declarations object. */
export const AGENT_GROUPS_DOMAIN = defineDomain({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  tables: {
    profiles: domainTable<string, AgentProfile>(profileSchema),
    groups: domainTable<string, GroupRecord>(groupSchema),
    members: domainTable<string, GroupMember>(memberSchema),
    tasks: domainTable<string, GroupTask>(taskSchema),
    channel: domainTable<string, ChannelMessage>(channelSchema),
    private: domainTable<string, PrivateMessage>(privateSchema),
    activity: domainTable<string, ActivityEvent>(activitySchema),
    leaders: domainTable<string, KnownLeader>(leaderSchema),
  },
})

export type AgentGroupsDomainSpec = typeof AGENT_GROUPS_DOMAIN

/** Open the domain over the host's storage facility. */
export function openAgentGroupsDomain(facility: DomainFacility): Promise<Domain<typeof AGENT_GROUPS_DOMAIN>> {
  return facility.open(AGENT_GROUPS_DOMAIN)
}

/** Table name → record factory helper for building typed stores. */
export const TABLES = ['profiles', 'groups', 'members', 'tasks', 'channel', 'private', 'activity', 'leaders'] as const
export type AgentGroupsTableName = (typeof TABLES)[number]

/** Per-table zod schemas (exported for tests and tooling). */
export const RECORD_SCHEMAS: Record<AgentGroupsTableName, z.ZodType> = {
  profiles: profileSchema,
  groups: groupSchema,
  members: memberSchema,
  tasks: taskSchema,
  channel: channelSchema,
  private: privateSchema,
  activity: activitySchema,
  leaders: leaderSchema,
}

/**
 * Validate a raw durable record of one table. Returns the parsed value, or
 * throws the zod issue on legacy-mismatched data (fail loud at the read
 * boundary). Used by tests to prove backward compatibility of old records.
 */
export function parseRecord<V>(table: AgentGroupsTableName, value: unknown): V {
  return RECORD_SCHEMAS[table].parse(value) as V
}
