/**
 * Task service: the group's structured task DAG. A task carries the DSH-family
 * graph fields (blockedBy / owner / status / revision) plus the product
 * metadata from the Agent Groups spec. Optimistic concurrency is enforced with
 * a monotonic `revision`; every mutation goes through an atomic RMW so no
 * interleaved writer can lose an update.
 * @module @dsh-agent-groups/host
 */

import { randomUUID } from 'node:crypto'
import type {
  AgentTaskResult,
  GroupId,
  GroupTask,
  TaskId,
  TaskAttemptRecord,
  TaskAttemptStatus,
  TaskKind,
  TaskPriority,
  TaskStatus,
  TaskVerification,
} from './core-types.js'
import type { TableStore } from './store.js'
import { scopedKey } from './store.js'
import { ActivityService } from './activity-service.js'
import { GroupError } from './group-service.js'

export interface TaskInput {
  readonly subject: string
  readonly description: string
  readonly kind: TaskKind
  readonly workstreamId?: string
  readonly parentId?: TaskId
  readonly requiredCapabilities?: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly expectedArtifacts?: readonly string[]
  readonly priority?: TaskPriority
  readonly writeScopes?: readonly string[]
  readonly blockedBy?: readonly TaskId[]
  readonly createdBy: string
  readonly assignedBy?: string
  readonly retryOf?: TaskId
  /** V0.2: simple free-form tags. */
  readonly tags?: readonly string[]
}

/** V0.2: editable fields of a non-terminal task (第 12 节). */
export interface TaskUpdatePatch {
  readonly subject?: string
  readonly description?: string
  readonly priority?: TaskPriority
  readonly tags?: readonly string[]
  readonly blockedBy?: readonly TaskId[]
  readonly ownerId?: string
  readonly assignedBy?: string
  readonly workstreamId?: string
}

export class TaskService {
  private readonly tasks: TableStore<string, GroupTask>
  private readonly activity: ActivityService

  constructor(tasks: TableStore<string, GroupTask>, activity: ActivityService) {
    this.tasks = tasks
    this.activity = activity
  }

  async createTask(groupId: GroupId, input: TaskInput): Promise<GroupTask> {
    const now = Date.now()
    const task: GroupTask = {
      groupId,
      taskId: randomUUID(),
      parentId: input.parentId,
      kind: input.kind,
      requiredCapabilities: input.requiredCapabilities ?? [],
      acceptanceCriteria: input.acceptanceCriteria,
      expectedArtifacts: input.expectedArtifacts ?? [],
      priority: input.priority ?? 'normal',
      createdBy: input.createdBy,
      assignedBy: input.assignedBy,
      verifierTaskIds: [],
      retryOf: input.retryOf,
      subject: input.subject,
      description: input.description,
      writeScopes: input.writeScopes ?? [],
      blockedBy: input.blockedBy ?? [],
      status: 'pending',
      revision: 1,
      attempt: 1,
      createdAt: now,
      updatedAt: now,
      workstreamId: input.workstreamId,
      tags: input.tags ?? [],
    }
    for (const optionalField of [
      'parentId',
      'assignedBy',
      'retryOf',
      'requiredCapabilities',
      'expectedArtifacts',
      'verifierTaskIds',
      'writeScopes',
      'workstreamId',
      'tags',
    ] as const) {
      if (task[optionalField] === undefined || (Array.isArray(task[optionalField]) && task[optionalField].length === 0)) {
        delete (task as unknown as Record<string, unknown>)[optionalField]
      }
    }
    await this.tasks.put(scopedKey(groupId, task.taskId), task)
    await this.activity.append({
      groupId,
      type: 'task_created',
      actorId: input.createdBy,
      refTaskId: task.taskId,
      payload: { subject: task.subject, kind: task.kind, retryOf: task.retryOf ?? null },
    })
    return task
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  /**
   * V0.2: edit a non-terminal task's editable fields (subject, description,
   * priority, tags, dependencies, assignee, workstream). Emits `task_updated`.
   */
  async updateTask(
    groupId: GroupId,
    taskId: TaskId,
    by: string,
    patch: TaskUpdatePatch,
    expectedRevision?: number,
  ): Promise<GroupTask> {
    const existing = this.requireTask(groupId, taskId)
    if (existing.status === 'completed' || existing.status === 'failed') {
      throw new GroupError('CONFLICT', `task ${taskId} is ${existing.status} and cannot be edited`)
    }
    if (patch.subject !== undefined && patch.subject.trim() === '') {
      throw new GroupError('CONFLICT', 'task subject must not be empty')
    }
    if (patch.blockedBy !== undefined) {
      if (patch.blockedBy.includes(taskId)) throw new GroupError('CONFLICT', 'a task cannot depend on itself')
      for (const dep of patch.blockedBy) this.requireTask(groupId, dep)
    }
    const fields: string[] = []
    for (const key of ['subject', 'description', 'priority', 'tags', 'blockedBy', 'ownerId', 'assignedBy', 'workstreamId'] as const) {
      if (patch[key] !== undefined) fields.push(key)
    }
    const task = await this.mutate(groupId, taskId, expectedRevision, (current) => ({
      ...current,
      ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.tags !== undefined ? { tags: [...patch.tags] } : {}),
      ...(patch.blockedBy !== undefined ? { blockedBy: [...patch.blockedBy] } : {}),
      ...(patch.ownerId !== undefined ? { ownerId: patch.ownerId } : {}),
      ...(patch.assignedBy !== undefined ? { assignedBy: patch.assignedBy } : {}),
      ...(patch.workstreamId !== undefined ? { workstreamId: patch.workstreamId } : {}),
      updatedAt: Date.now(),
    }))
    await this.activity.append({
      groupId,
      type: 'task_updated',
      actorId: by,
      refTaskId: taskId,
      payload: { subject: task.subject, fields },
    })
    return task
  }

  /**
   * V0.2: user/leader holds or releases a task (board shows held tasks as
   * blocked without touching the DAG). `held=false` clears the marker.
   */
  async setHeld(groupId: GroupId, taskId: TaskId, by: string, held: boolean): Promise<GroupTask> {
    const task = await this.mutate(groupId, taskId, undefined, (current) => {
      if (current.status === 'completed' || current.status === 'failed') {
        throw new GroupError('CONFLICT', `task ${taskId} is ${current.status} and cannot be held`)
      }
      return {
        ...current,
        ...(held ? { heldAt: Date.now(), heldBy: by } : { heldAt: undefined, heldBy: undefined }),
        updatedAt: Date.now(),
      }
    })
    await this.activity.append({
      groupId,
      type: 'task_updated',
      actorId: by,
      refTaskId: taskId,
      payload: { subject: task.subject, fields: ['held'] },
    })
    return task
  }

  getTask(groupId: GroupId, taskId: TaskId): GroupTask | undefined {
    return this.tasks.get(scopedKey(groupId, taskId))
  }

  requireTask(groupId: GroupId, taskId: TaskId): GroupTask {
    const task = this.tasks.get(scopedKey(groupId, taskId))
    if (task === undefined) throw new GroupError('NOT_FOUND', `no such task: ${taskId}`)
    return task
  }

  listTasks(groupId: GroupId): GroupTask[] {
    const byId = new Map<string, GroupTask>()
    const rows: GroupTask[] = []
    for (const [key, task] of this.tasks.entries()) {
      if (task.groupId !== groupId) continue
      byId.set(task.taskId, task)
      rows.push({ ...task, status: derivedStatus(task, byId) })
    }
    rows.sort((a, b) => a.createdAt - b.createdAt)
    return rows
  }

  /** Start one immutable task execution attempt, idempotently by turn id. */
  async startAttempt(groupId: GroupId, taskId: TaskId, input: {
    memberId: string
    turnId: string
    runtime?: string
    providerSessionId?: string
  }): Promise<TaskAttemptRecord> {
    const current = this.requireTask(groupId, taskId)
    const existing = current.attempts?.find((attempt) => attempt.turnId === input.turnId)
    if (existing !== undefined) return existing
    const started: TaskAttemptRecord = {
      attemptId: randomUUID(),
      groupId,
      taskId,
      sequence: current.attempt,
      memberId: input.memberId,
      runtime: input.runtime,
      providerSessionId: input.providerSessionId,
      turnId: input.turnId,
      status: 'running',
      startedAt: Date.now(),
    }
    const task = await this.mutate(groupId, taskId, undefined, (latest) => {
      if (latest.attempts?.some((attempt) => attempt.turnId === input.turnId)) return latest
      return { ...latest, attempts: [...(latest.attempts ?? []), started], updatedAt: Date.now() }
    })
    const attempt = task.attempts?.find((item) => item.turnId === input.turnId) ?? started
    await this.activity.append({
      groupId,
      type: 'task_attempt_started',
      actorId: input.memberId,
      refTaskId: taskId,
      refMemberId: input.memberId,
      payload: { attemptId: attempt.attemptId, sequence: attempt.sequence, turnId: input.turnId, runtime: input.runtime ?? null },
    })
    return attempt
  }

  /** Settle an attempt once; late duplicate terminal events are idempotent. */
  async settleAttempt(groupId: GroupId, taskId: TaskId, turnId: string, status: Exclude<TaskAttemptStatus, 'running'>, detail?: string): Promise<TaskAttemptRecord | undefined> {
    const current = this.requireTask(groupId, taskId)
    const found = current.attempts?.find((attempt) => attempt.turnId === turnId)
    if (found === undefined) return undefined
    if (found.status !== 'running') return found
    const task = await this.mutate(groupId, taskId, undefined, (latest) => ({
      ...latest,
      attempts: latest.attempts?.map((attempt) => attempt.turnId === turnId && attempt.status === 'running'
        ? {
            ...attempt,
            status,
            endedAt: Date.now(),
            ...(status === 'completed' ? { summary: detail } : { failure: detail }),
          }
        : attempt),
      updatedAt: Date.now(),
    }))
    const settled = task.attempts?.find((attempt) => attempt.turnId === turnId)
    if (settled !== undefined) {
      const type = status === 'completed' ? 'task_attempt_completed'
        : status === 'failed' ? 'task_attempt_failed'
          : status === 'cancelled' ? 'task_attempt_cancelled'
            : 'task_attempt_lost'
      await this.activity.append({
        groupId,
        type,
        actorId: settled.memberId,
        refTaskId: taskId,
        refMemberId: settled.memberId,
        payload: { attemptId: settled.attemptId, sequence: settled.sequence, turnId, detail: detail ?? null },
      })
    }
    return settled
  }

  // ── transitions ───────────────────────────────────────────────────────────

  async assign(groupId: GroupId, taskId: TaskId, ownerId: string, assignedBy: string, expectedRevision?: number): Promise<GroupTask> {
    const task = await this.mutate(groupId, taskId, expectedRevision, (current) => ({
      ...current,
      ownerId,
      assignedBy,
      updatedAt: Date.now(),
    }))
    await this.activity.append({
      groupId,
      type: 'task_assigned',
      actorId: assignedBy,
      refTaskId: taskId,
      refMemberId: ownerId,
      payload: { subject: task.subject, ownerId },
    })
    return task
  }

  async claim(groupId: GroupId, taskId: TaskId, memberId: string, expectedRevision?: number): Promise<GroupTask> {
    const task = await this.mutate(groupId, taskId, expectedRevision, (current) => {
      if (current.status === 'completed' || current.status === 'failed') {
        throw new GroupError('CONFLICT', `task ${taskId} is ${current.status} and cannot be claimed`)
      }
      if (current.ownerId !== undefined && current.ownerId !== memberId) {
        throw new GroupError('CONFLICT', `task ${taskId} is assigned to ${current.ownerId}`)
      }
      return { ...current, ownerId: memberId, status: 'in_progress' as TaskStatus, updatedAt: Date.now() }
    })
    await this.activity.append({
      groupId,
      type: 'task_claimed',
      actorId: memberId,
      refTaskId: taskId,
      refMemberId: memberId,
      payload: { subject: task.subject },
    })
    return task
  }

  /** The executing agent submits its structured result; the task moves to review. */
  async complete(groupId: GroupId, taskId: TaskId, memberId: string, result: Omit<AgentTaskResult, 'taskId' | 'submittedAt'>, expectedRevision?: number): Promise<GroupTask> {
    const submitted: AgentTaskResult = { ...result, taskId, submittedAt: Date.now() }
    const task = await this.mutate(groupId, taskId, expectedRevision, (current) => {
      if (current.ownerId !== undefined && current.ownerId !== memberId) {
        throw new GroupError('CONFLICT', `task ${taskId} is owned by ${current.ownerId}, not ${memberId}`)
      }
      if (current.status === 'completed' || current.status === 'review') {
        throw new GroupError('CONFLICT', `task ${taskId} is already ${current.status}`)
      }
      return { ...current, status: 'review' as TaskStatus, result: submitted, updatedAt: Date.now() }
    })
    await this.activity.append({
      groupId,
      type: 'task_completed',
      actorId: memberId,
      refTaskId: taskId,
      refMemberId: memberId,
      payload: { subject: task.subject, completionClaim: submitted.completionClaim },
    })
    return task
  }

  /** The Leader accepts or rejects an agent's completion claim. */
  async verify(groupId: GroupId, taskId: TaskId, verifierId: string, passed: boolean, notes?: string): Promise<GroupTask> {
    const verification: TaskVerification = {
      verifiedBy: verifierId,
      passed,
      timestamp: Date.now(),
      ...(notes !== undefined ? { notes } : {}),
    }
    const task = await this.mutate(groupId, taskId, undefined, (current) => {
      if (current.status !== 'review' && current.status !== 'failed' && current.status !== 'in_progress') {
        if (current.status === 'completed') throw new GroupError('CONFLICT', `task ${taskId} already verified`)
      }
      return {
        ...current,
        status: passed ? ('completed' as TaskStatus) : ('failed' as TaskStatus),
        verification,
        updatedAt: Date.now(),
      }
    })
    await this.activity.append({
      groupId,
      type: passed ? 'verification_passed' : 'verification_failed',
      actorId: verifierId,
      refTaskId: taskId,
      payload: { subject: task.subject, notes: notes ?? null },
    })
    return task
  }

  /** Leader reopens a failed/passed task for another attempt (retry on the same node). */
  async reopen(groupId: GroupId, taskId: TaskId, by: string, reason?: string): Promise<GroupTask> {
    const task = await this.mutate(groupId, taskId, undefined, (current) => ({
      ...current,
      status: 'pending' as TaskStatus,
      attempt: current.attempt + 1,
      updatedAt: Date.now(),
    }))
    await this.activity.append({
      groupId,
      type: 'task_reopened',
      actorId: by,
      refTaskId: taskId,
      payload: { subject: task.subject, reason: reason ?? null, attempt: task.attempt },
    })
    return task
  }

  async markFailed(groupId: GroupId, taskId: TaskId, by: string, reason: string): Promise<GroupTask> {
    const task = await this.mutate(groupId, taskId, undefined, (current) => ({
      ...current,
      status: 'failed' as TaskStatus,
      updatedAt: Date.now(),
    }))
    await this.activity.append({
      groupId,
      type: 'task_failed',
      actorId: by,
      refTaskId: taskId,
      payload: { subject: task.subject, reason },
    })
    return task
  }

  /** Create a dependency surface task (review/verification) over a completed one. */
  async createVerifierTask(groupId: GroupId, overTaskId: TaskId, input: TaskInput): Promise<GroupTask> {
    const over = this.requireTask(groupId, overTaskId)
    const task = await this.createTask(groupId, {
      ...input,
      kind: input.kind === 'other' ? 'verification' : input.kind,
      blockedBy: [...(input.blockedBy ?? []), overTaskId],
      parentId: overTaskId,
    })
    await this.mutate(groupId, overTaskId, undefined, (current) => ({
      ...current,
      verifierTaskIds: [...(current.verifierTaskIds ?? []), task.taskId],
      updatedAt: Date.now(),
    }))
    return task
  }

  // ── CAS machinery ─────────────────────────────────────────────────────────

  private async mutate(groupId: GroupId, taskId: TaskId, expectedRevision: number | undefined, fn: (current: GroupTask) => GroupTask): Promise<GroupTask> {
    try {
      return await this.tasks.update(scopedKey(groupId, taskId), (current) => {
        if (expectedRevision !== undefined && current.revision !== expectedRevision) {
          throw new GroupError('CONFLICT', `task ${taskId} revision ${expectedRevision} is stale (current ${current.revision})`)
        }
        return { ...fn(current), revision: current.revision + 1 }
      })
    } catch (error) {
      if (error instanceof GroupError) throw error
      throw new GroupError('NOT_FOUND', `no such task: ${taskId}`)
    }
  }
}

/** Pending tasks whose dependencies are incomplete surface as `blocked`. */
function derivedStatus(task: GroupTask, byId: Map<string, GroupTask>): TaskStatus {
  if (task.status !== 'pending') return task.status
  if (task.heldAt !== undefined) return 'blocked'
  const blocked = task.blockedBy.some((id) => byId.get(id)?.status !== 'completed')
  return blocked ? 'blocked' : 'pending'
}
