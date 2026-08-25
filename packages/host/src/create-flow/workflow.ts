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
  | 'assemble_scenes'
  | 'generate_voice'
  | 'render_timeline'
  | 'verify_output'

export interface CreateFlowRecommendedAction {
  readonly action: CreateFlowRecommendedActionKind
  readonly reason: string
  readonly roleId?: string
  readonly tool?: string
  readonly taskIds?: readonly string[]
}

export interface CreateFlowStageEvidence {
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
  /** First stage whose gate is not complete; undefined only after mission completion. */
  readonly focusStage?: CreateFlowWorkflowStageId
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
 * state plus Create Flow's production projection. This function never mutates
 * either source of truth and therefore cannot become a second orchestrator.
 */
export function projectCreateFlowWorkflow(
  host: GroupHost,
  groupId: string,
  state: CreateFlowState,
): CreateFlowWorkflowReadiness {
  const group = host.groups.requireGroup(groupId)
  const tasks = host.tasks.listTasks(groupId)
  const rows: CreateFlowStageReadiness[] = []
  let prerequisitesComplete = true

  for (const definition of CREATE_FLOW_WORKFLOW_REGISTRY) {
    const evaluation = evaluateStage(host, groupId, state, tasks, definition, group.status === 'completed')
    const status: CreateFlowReadinessState = prerequisitesComplete
      ? evaluation.complete ? 'complete' : 'ready'
      : 'blocked'
    const blockers = status === 'blocked'
      ? [`Prerequisite stage ${rows.at(-1)?.label ?? 'unknown'} is not complete.`]
      : evaluation.blockers
    const recommendedActions = status === 'blocked' ? [] : evaluation.recommendedActions

    rows.push({
      id: definition.id,
      order: definition.order,
      label: definition.label,
      status,
      blockers,
      evidence: evaluation.evidence,
      recommendedActions,
    })
    prerequisitesComplete = prerequisitesComplete && status === 'complete'
  }

  const focus = rows.find((row) => row.status !== 'complete')
  return {
    ...(focus !== undefined ? { focusStage: focus.id } : {}),
    complete: focus === undefined,
    stages: rows,
    blockers: focus?.blockers ?? [],
    recommendedActions: focus?.recommendedActions ?? [],
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
  const verified = matching.filter((task) => task.verification?.passed === true)
  const taskIds = matching.map((task) => task.taskId)
  const artifactIds = state.artifacts
    .filter((artifact) => typeof artifact.metadata?.taskId === 'string' && taskIds.includes(artifact.metadata.taskId))
    .map((artifact) => artifact.artifactId)

  if (verified.length > 0) {
    return {
      complete: true,
      blockers: [],
      evidence: evidence({ taskIds: verified.map((task) => task.taskId), artifactIds }),
      recommendedActions: [],
    }
  }

  const role = definition.displayRole ?? definition.roleId ?? definition.label
  if (matching.length === 0) {
    return {
      complete: false,
      blockers: [`No verified ${role} task is available.`],
      evidence: evidence(),
      recommendedActions: [{
        action: 'delegate_task',
        roleId: definition.roleId,
        reason: `Create and assign the ${definition.label} work to the ${role} role, then verify its result.`,
      }],
    }
  }

  const reviewable = matching.filter((task) => task.status === 'review' || task.status === 'completed')
  return {
    complete: false,
    blockers: [`${role} task work exists but has not passed Leader/Verifier acceptance.`],
    evidence: evidence({ taskIds }),
    recommendedActions: reviewable.length > 0
      ? [{
          action: 'verify_task',
          roleId: definition.roleId,
          taskIds: reviewable.map((task) => task.taskId),
          tool: 'leader_verify_task',
          reason: `Inspect the ${definition.label} result and verify it before advancing.`,
        }]
      : [{
          action: 'continue_task',
          roleId: definition.roleId,
          taskIds,
          reason: `Continue the in-flight ${definition.label} work before verification.`,
        }],
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
        action: 'assemble_scenes',
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
