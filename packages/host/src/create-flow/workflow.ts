import type { GroupTask } from '../core-types.js'
import type { GroupHost } from '../group-host.js'
import type { CreateFlowService, CreateFlowState, CreateFlowStatus } from './service.js'
import {
  CREATE_FLOW_WORKFLOW_REGISTRY,
  type CreateFlowWorkflowStageDefinition,
  type CreateFlowWorkflowStageId,
} from './registry.js'

export type CreateFlowReadinessState = 'complete' | 'ready' | 'blocked'
export type CreateFlowRecommendedActionKind =
  | 'delegate_task'
  | 'continue_task'
  | 'verify_task'
  | 'reopen_task'
  | 'assemble_scenes'
  | 'generate_voice'
  | 'render_timeline'
  | 'verify_output'

/**
 * Allocation facts for one production role. This is a projection, not a spawn
 * command: the Leader still decides whether continuity or additional parallel
 * capacity is the better choice for the concrete task graph.
 */
export interface CreateFlowRoleAllocation {
  readonly roleId: string
  readonly memberIds: readonly string[]
  readonly instanceCount: number
  readonly maxInstances?: number
  readonly canSpawnMore: boolean
  /** True when this workfront has no materialized instance yet. */
  readonly spawnSuggested: boolean
}

export interface CreateFlowRecommendedAction {
  readonly action: CreateFlowRecommendedActionKind
  readonly reason: string
  readonly roleId?: string
  readonly tool?: string
  readonly taskIds?: readonly string[]
  /** Current persistent-member capacity for role-backed task work. */
  readonly allocation?: CreateFlowRoleAllocation
}

export interface CreateFlowStageEvidence {
  /** Current retry-chain leaves for task-backed stages; historical ancestors are omitted. */
  readonly taskIds: readonly string[]
  readonly artifactIds: readonly string[]
  readonly sceneIds: readonly string[]
  readonly jobIds: readonly string[]
}

export interface CreateFlowStageReadiness {
  readonly id: CreateFlowWorkflowStageId
  readonly order: number
  readonly label: string
  readonly status: CreateFlowReadinessState
  readonly blockers: readonly string[]
  readonly evidence: CreateFlowStageEvidence
  readonly recommendedActions: readonly CreateFlowRecommendedAction[]
}

export interface CreateFlowWorkflowReadiness {
  /** First incomplete stage in display order. Kept as a compact UI hint, not a scheduler cursor. */
  readonly focusStage?: CreateFlowWorkflowStageId
  /** Every incomplete stage whose declared production dependencies are complete. */
  readonly readyStages: readonly CreateFlowWorkflowStageId[]
  readonly complete: boolean
  readonly stages: readonly CreateFlowStageReadiness[]
  readonly blockers: readonly string[]
  readonly recommendedActions: readonly CreateFlowRecommendedAction[]
}

export interface CreateFlowWorkbenchStatus extends CreateFlowStatus {
  /** Pure projection from Agent Groups truth + Create Flow production state. */
  readonly workflow: CreateFlowWorkflowReadiness
}

/**
 * Read the production status plus a machine-readable stage projection.
 * Nothing in `workflow` is persisted to `.create-flow/state.json`.
 */
export async function readCreateFlowWorkbenchStatus(
  host: GroupHost,
  createFlow: CreateFlowService,
  groupId: string,
): Promise<CreateFlowWorkbenchStatus> {
  const status = await createFlow.status(groupId)
  return {
    ...status,
    workflow: projectCreateFlowWorkflow(host, groupId, status.state),
  }
}

/**
 * Derive stage readiness from authoritative Agent Groups task/verification
 * state plus Create Flow's production projection. The registry declares only
 * production dependencies; independent stages can therefore become ready in
 * parallel while concrete task decomposition stays in Agent Groups.
 *
 * This function never mutates either source of truth and therefore cannot
 * become a second orchestrator.
 */
export function projectCreateFlowWorkflow(
  host: GroupHost,
  groupId: string,
  state: CreateFlowState,
): CreateFlowWorkflowReadiness {
  const group = host.groups.requireGroup(groupId)
  const tasks = host.tasks.listTasks(groupId)
  const rows: CreateFlowStageReadiness[] = []
  const rowsById = new Map<CreateFlowWorkflowStageId, CreateFlowStageReadiness>()

  for (const definition of CREATE_FLOW_WORKFLOW_REGISTRY) {
    const evaluation = evaluateStage(host, groupId, state, tasks, definition, group.status === 'completed')
    const unmetDependencies = (definition.requires ?? []).filter((stageId) => rowsById.get(stageId)?.status !== 'complete')
    const status: CreateFlowReadinessState = unmetDependencies.length > 0
      ? 'blocked'
      : evaluation.complete ? 'complete' : 'ready'
    const blockers = status === 'blocked'
      ? [`Prerequisite stages ${unmetDependencies.map((stageId) => rowsById.get(stageId)?.label ?? stageId).join(', ')} are not complete.`]
      : evaluation.blockers
    const recommendedActions = status === 'ready' ? evaluation.recommendedActions : []
    const row: CreateFlowStageReadiness = {
      id: definition.id,
      order: definition.order,
      label: definition.label,
      status,
      blockers,
      evidence: evaluation.evidence,
      recommendedActions,
    }
    rows.push(row)
    rowsById.set(definition.id, row)
  }

  const focus = rows.find((row) => row.status !== 'complete')
  const ready = rows.filter((row) => row.status === 'ready')
  return {
    ...(focus !== undefined ? { focusStage: focus.id } : {}),
    readyStages: ready.map((row) => row.id),
    complete: focus === undefined,
    stages: rows,
    blockers: ready.flatMap((row) => row.blockers),
    recommendedActions: ready.flatMap((row) => row.recommendedActions),
  }
}

interface StageEvaluation {
  readonly complete: boolean
  readonly blockers: readonly string[]
  readonly evidence: CreateFlowStageEvidence
  readonly recommendedActions: readonly CreateFlowRecommendedAction[]
}

function evaluateStage(
  host: GroupHost,
  groupId: string,
  state: CreateFlowState,
  tasks: readonly GroupTask[],
  definition: CreateFlowWorkflowStageDefinition,
  missionCompleted: boolean,
): StageEvaluation {
  if (definition.id === 'scenes') return evaluateScenes(state)
  if (definition.id === 'voice_captions') return evaluateVoiceAndCaptions(state)
  if (definition.id === 'render') return evaluateRender(state)
  if (definition.id === 'verify') return evaluateVerification(state, missionCompleted)
  return evaluateTaskStage(host, groupId, state, tasks, definition)
}

function evaluateTaskStage(
  host: GroupHost,
  groupId: string,
  state: CreateFlowState,
  tasks: readonly GroupTask[],
  definition: CreateFlowWorkflowStageDefinition,
): StageEvaluation {
  const matching = definition.roleId === undefined
    ? []
    : tasks.filter((task) => {
        if (task.ownerId === undefined) return false
        const member = host.groups.getMembership(groupId, task.ownerId)
        return member?.roleId === definition.roleId || member?.displayRole === definition.displayRole
      })
  const current = currentWorkfrontTasks(matching)
  const verified = current.filter(taskVerified)
  const currentTaskIds = current.map((task) => task.taskId)
  const artifactIds = state.artifacts
    .filter((artifact) => typeof artifact.metadata?.taskId === 'string' && currentTaskIds.includes(artifact.metadata.taskId))
    .map((artifact) => artifact.artifactId)

  // A fan-out stage converges only when every CURRENT retry-chain leaf has
  // passed acceptance. One successful branch must never close sibling work.
  if (current.length > 0 && verified.length === current.length) {
    return {
      complete: true,
      blockers: [],
      evidence: evidence({ taskIds: currentTaskIds, artifactIds }),
      recommendedActions: [],
    }
  }

  const role = definition.displayRole ?? definition.roleId ?? definition.label
  const allocation = roleAllocation(host, groupId, definition)
  if (current.length === 0) {
    const capacityHint = allocation?.spawnSuggested
      ? ` No ${role} instance is materialized yet; spawn the role when creating the first task.`
      : allocation !== undefined && allocation.instanceCount > 0
        ? ` Reuse one of the ${allocation.instanceCount} persistent ${role} instance${allocation.instanceCount === 1 ? '' : 's'} when continuity helps.`
        : ''
    const fanoutHint = allocation?.canSpawnMore
      ? ' Additional instances remain available for genuinely independent parallel subproblems.'
      : ''
    return {
      complete: false,
      blockers: [`No current ${role} task is available.`],
      evidence: evidence(),
      recommendedActions: [{
        action: 'delegate_task',
        roleId: definition.roleId,
        ...(allocation !== undefined ? { allocation } : {}),
        reason: `Create and assign the ${definition.label} work to the ${role} role. Split independent subproblems into parallel Agent Groups tasks when useful.${capacityHint}${fanoutHint}`,
      }],
    }
  }

  const unresolved = current.filter((task) => !taskVerified(task))
  const reviewable = unresolved.filter((task) => task.status === 'review' || task.status === 'completed')
  const failed = unresolved.filter((task) => task.status === 'failed')
  const inFlight = unresolved.filter((task) => task.status !== 'review' && task.status !== 'completed' && task.status !== 'failed')
  const actions: CreateFlowRecommendedAction[] = []

  if (reviewable.length > 0) {
    actions.push({
      action: 'verify_task',
      roleId: definition.roleId,
      taskIds: reviewable.map((task) => task.taskId),
      tool: 'leader_verify_task',
      ...(allocation !== undefined ? { allocation } : {}),
      reason: `Verify the ${reviewable.length} reviewable ${definition.label} task${reviewable.length === 1 ? '' : 's'}; sibling branches remain open until the whole workfront converges.`,
    })
  }
  if (failed.length > 0) {
    actions.push({
      action: 'reopen_task',
      roleId: definition.roleId,
      taskIds: failed.map((task) => task.taskId),
      tool: 'leader_reopen_task',
      ...(allocation !== undefined ? { allocation } : {}),
      reason: `Recover the ${failed.length} failed ${definition.label} task${failed.length === 1 ? '' : 's'} by reopening the same node or creating a retry after replanning. Failed historical ancestors stop blocking once a newer retry leaf exists.`,
    })
  }
  if (inFlight.length > 0) {
    actions.push({
      action: 'continue_task',
      roleId: definition.roleId,
      taskIds: inFlight.map((task) => task.taskId),
      ...(allocation !== undefined ? { allocation } : {}),
      reason: `Continue the ${inFlight.length} open ${definition.label} task${inFlight.length === 1 ? '' : 's'}; independent ready stages may proceed concurrently.`,
    })
  }

  return {
    complete: false,
    blockers: [
      `${definition.label} workfront has converged ${verified.length}/${current.length} current task${current.length === 1 ? '' : 's'}; ${unresolved.length} remain open.`,
      ...failed.map((task) => `Task ${task.taskId} failed and needs reopen/retry or explicit replanning.`),
    ],
    evidence: evidence({ taskIds: currentTaskIds, artifactIds }),
    recommendedActions: actions,
  }
}

/**
 * Collapse retry history to the current workfront leaves. If A failed and B is
 * a retry of A, A remains auditable in Agent Groups but B alone represents the
 * live production obligation. Longer retry chains collapse the same way.
 */
function currentWorkfrontTasks(tasks: readonly GroupTask[]): GroupTask[] {
  if (tasks.length <= 1) return [...tasks]
  const ids = new Set(tasks.map((task) => task.taskId))
  const superseded = new Set<string>()
  for (const task of tasks) {
    if (task.retryOf !== undefined && ids.has(task.retryOf)) superseded.add(task.retryOf)
  }
  return tasks.filter((task) => !superseded.has(task.taskId))
}

function taskVerified(task: GroupTask): boolean {
  return task.verification?.passed === true
}

function roleAllocation(
  host: GroupHost,
  groupId: string,
  definition: CreateFlowWorkflowStageDefinition,
): CreateFlowRoleAllocation | undefined {
  if (definition.roleId === undefined) return undefined
  const members = host.groups
    .listMembers(groupId, () => undefined)
    .filter((member) =>
      member.role === 'member'
        && member.status !== 'left'
        && (member.roleId === definition.roleId || member.displayRole === definition.displayRole),
    )
  const group = host.groups.requireGroup(groupId)
  const role = host.teamConfig(group).memberRoles.find((candidate) => candidate.id === definition.roleId)
  const maxInstances = role?.maxInstances
  const canSpawnMore = maxInstances === undefined || members.length < maxInstances
  return {
    roleId: definition.roleId,
    memberIds: members.map((member) => member.sessionId),
    instanceCount: members.length,
    ...(maxInstances !== undefined ? { maxInstances } : {}),
    canSpawnMore,
    spawnSuggested: members.length === 0 && canSpawnMore,
  }
}

function evaluateScenes(state: CreateFlowState): StageEvaluation {
  const sceneIds = state.scenes.map((scene) => scene.sceneId)
  if (state.scenes.length === 0) {
    return {
      complete: false,
      blockers: ['No timeline scenes have been assembled.'],
      evidence: evidence(),
      recommendedActions: [{
        action: 'assemble_senes' as CreateFlowRecommendedActionKind,
        tool: 'leader_create_flow_upsert_scene',
        reason: 'Translate the accepted script/materials into an ordered scene timeline.',
      }],
    }
  }

  const incomplete = state.scenes.filter((scene) => !scene.visualPath || (!scene.audioPath && scene.durationSec === undefined))
  if (incomplete.length > 0) {
    return {
      complete: false,
      blockers: incomplete.map((scene) => `Scene ${scene.sceneId} needs a visual plus audioPath or durationSec.`),
      evidence: evidence({ sceneIds }),
      recommendedActions: [{
        action: 'assemble_scenes',
        tool: 'leader_create_flow_upsert_scene',
        reason: 'Complete the non-renderable scene definitions before media production.',
      }],
    }
  }

  return {
    complete: true,
    blockers: [],
    evidence: evidence({ sceneIds }),
    recommendedActions: [],
  }
}

function evaluateVoiceAndCaptions(state: CreateFlowState): StageEvaluation {
  const sceneIds = state.scenes.map((scene) => scene.sceneId)
  const narrationWithoutAudio = state.scenes.filter((scene) => Boolean(scene.narration?.trim()) && !scene.audioPath)
  const mediaArtifacts = state.artifacts.filter((artifact) => artifact.stage === 'voice' || artifact.stage === 'captions')
  const mediaJobs = state.jobs.filter((job) => (job.kind === 'tts' || job.kind === 'asr') && job.status === 'completed')

  if (narrationWithoutAudio.length > 0) {
    return {
      complete: false,
      blockers: narrationWithoutAudio.map((scene) => `Scene ${scene.sceneId} has narration but no audioPath.`),
      evidence: evidence({
        sceneIds,
        artifactIds: mediaArtifacts.map((artifact) => artifact.artifactId),
        jobIds: mediaJobs.map((job) => job.jobId),
      }),
      recommendedActions: [{
        action: 'generate_voice',
        tool: 'leader_create_flow_tts',
        reason: 'Generate or attach narration audio for scenes that declare narration text.',
      }],
    }
  }

  return {
    complete: state.scenes.length > 0,
    blockers: state.scenes.length > 0 ? [] : ['No scenes are available for voice/caption preparation.'],
    evidence: evidence({
      sceneIds,
      artifactIds: mediaArtifacts.map((artifact) => artifact.artifactId),
      jobIds: mediaJobs.map((job) => job.jobId),
    }),
    recommendedActions: [],
  }
}

function evaluateRender(state: CreateFlowState): StageEvaluation {
  const completedJobs = state.jobs.filter((job) =>
    (job.kind === 'render' || job.kind === 'timeline_render') && job.status === 'completed',
  )
  const completedJobIds = new Set(completedJobs.map((job) => job.jobId))
  const videos = state.artifacts.filter((artifact) =>
    artifact.kind === 'video'
      && artifact.stage === 'render'
      && typeof artifact.metadata?.jobId === 'string'
      && completedJobIds.has(artifact.metadata.jobId),
  )

  if (videos.length === 0) {
    return {
      complete: false,
      blockers: ['No video artifact is backed by a completed Create Flow render job.'],
      evidence: evidence({ jobIds: completedJobs.map((job) => job.jobId) }),
      recommendedActions: [{
        action: 'render_timeline',
        tool: 'leader_create_flow_render_timeline',
        reason: 'Render the ordered scene timeline and inspect the produced MP4.',
      }],
    }
  }

  return {
    complete: true,
    blockers: [],
    evidence: evidence({
      artifactIds: videos.map((artifact) => artifact.artifactId),
      jobIds: completedJobs.map((job) => job.jobId),
    }),
    recommendedActions: [],
  }
}

function evaluateVerification(state: CreateFlowState, missionCompleted: boolean): StageEvaluation {
  const videos = state.artifacts.filter((artifact) => artifact.kind === 'video' && artifact.stage === 'render')
  return {
    complete: missionCompleted,
    blockers: missionCompleted
      ? []
      : ['Final output still requires normal Agent Groups Leader/Verifier acceptance.'],
    evidence: evidence({ artifactIds: videos.map((artifact) => artifact.artifactId) }),
    recommendedActions: missionCompleted
      ? []
      : [{
          action: 'verify_output',
          tool: 'leader_complete_mission',
          reason: 'Inspect the final output against Mission acceptance criteria; complete the Mission only after it passes.',
        }],
  }
}

function evidence(input: Partial<CreateFlowStageEvidence> = {}): CreateFlowStageEvidence {
  return {
    taskIds: input.taskIds ?? [],
    artifactIds: input.artifactIds ?? [],
    sceneIds: input.sceneIds ?? [],
    jobIds: input.jobIds ?? [],
  }
}
