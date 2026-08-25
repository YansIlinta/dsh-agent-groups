import { basename } from 'node:path'
import type { GroupService } from '../group-service.js'
import type { TaskService } from '../task-service.js'
import type { GroupNotifier } from '../notifier.js'
import type { CreateFlowArtifactKind, CreateFlowService, CreateFlowStage } from './service.js'

type Projection = { stage: CreateFlowStage; kind: CreateFlowArtifactKind }

const ROLE_STAGE: Readonly<Record<string, Projection>> = {
  'topic-strategist': { stage: 'topic', kind: 'topic' },
  researcher: { stage: 'research', kind: 'source' },
  'material-producer': { stage: 'materials', kind: 'material' },
  scriptwriter: { stage: 'script', kind: 'script' },
  'video-producer': { stage: 'render', kind: 'other' },
}

/**
 * Pre-V0.4/template-materialized members can carry only `displayRole` because
 * the original template path spawned by profile. Keep that durable path
 * compatible while role-based members use the authoritative `roleId` above.
 */
const DISPLAY_ROLE_STAGE: Readonly<Record<string, Projection>> = {
  'Topic Strategist': ROLE_STAGE['topic-strategist']!,
  Researcher: ROLE_STAGE.researcher!,
  'Material Producer': ROLE_STAGE['material-producer']!,
  Scriptwriter: ROLE_STAGE.scriptwriter!,
  'Video Producer': ROLE_STAGE['video-producer']!,
}

/**
 * Bridges the generic Agent Groups task lifecycle into the Create Flow lens.
 * Only VERIFIED task results are projected. The member role determines which
 * production stage receives the result artifact.
 */
export class CreateFlowTaskProjector {
  private readonly groups: GroupService
  private readonly tasks: TaskService
  private readonly notifier: GroupNotifier
  private readonly flow: CreateFlowService
  private readonly taskLocks = new Map<string, Promise<void>>()
  private unsubscribe?: () => void

  constructor(options: { groups: GroupService; tasks: TaskService; notifier: GroupNotifier; flow: CreateFlowService }) {
    this.groups = options.groups
    this.tasks = options.tasks
    this.notifier = options.notifier
    this.flow = options.flow
  }

  start(): void {
    if (this.unsubscribe !== undefined) return
    this.unsubscribe = this.notifier.subscribe((update) => {
      if (update.event?.type !== 'verification_passed' || update.event.refTaskId === undefined) return
      void this.projectTask(update.groupId, update.event.refTaskId).catch((error) => {
        console.error('[create-flow] failed to project verified task artifacts', error)
      })
    })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  async projectTask(groupId: string, taskId: string): Promise<number> {
    const lockKey = `${groupId}:${taskId}`
    const previous = this.taskLocks.get(lockKey) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    const tail = previous.then(() => gate)
    this.taskLocks.set(lockKey, tail)
    await previous
    try {
      return await this.projectTaskUnlocked(groupId, taskId)
    } finally {
      release()
      if (this.taskLocks.get(lockKey) === tail) this.taskLocks.delete(lockKey)
    }
  }

  private async projectTaskUnlocked(groupId: string, taskId: string): Promise<number> {
    const group = this.groups.requireGroup(groupId)
    if (group.templateId !== 'content-team') return 0
    const task = this.tasks.requireTask(groupId, taskId)
    if (task.verification?.passed !== true || task.result === undefined || task.ownerId === undefined) return 0
    const member = this.groups.getMembership(groupId, task.ownerId)
    const projection = member?.roleId !== undefined
      ? ROLE_STAGE[member.roleId]
      : member?.displayRole !== undefined
        ? DISPLAY_ROLE_STAGE[member.displayRole]
        : undefined
    if (projection === undefined) return 0

    const status = await this.flow.status(groupId)
    const projectedPaths = new Set(
      status.state.artifacts
        .filter((artifact) => artifact.metadata?.taskId === taskId && artifact.path !== undefined)
        .map((artifact) => artifact.path!),
    )
    let added = 0
    for (const path of task.result.artifacts) {
      if (projectedPaths.has(path)) continue
      await this.flow.addArtifact(groupId, task.ownerId, {
        kind: projection.kind,
        stage: projection.stage,
        title: `${task.subject}: ${basename(path) || path}`,
        path,
        metadata: {
          taskId,
          ownerId: task.ownerId,
          roleId: member?.roleId ?? null,
          displayRole: member?.displayRole ?? null,
          projectedFromTask: true,
        },
      })
      projectedPaths.add(path)
      added += 1
    }
    return added
  }
}
