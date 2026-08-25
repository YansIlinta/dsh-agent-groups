import type { CreateFlowArtifactKind, CreateFlowStage } from './service.js'

/**
 * Create Flow's production vocabulary lives here so tools, APIs, task
 * projection, and workflow readiness all consume the same ordered contract.
 *
 * This mirrors the registry pattern used by extensible visual systems: stage
 * definitions describe themselves, while orchestration remains owned by Agent
 * Groups rather than by this registry.
 */
export const CREATE_FLOW_STAGES = [
  'topic',
  'research',
  'materials',
  'script',
  'voice',
  'captions',
  'render',
] as const satisfies readonly CreateFlowStage[]

export const CREATE_FLOW_ARTIFACT_KINDS = [
  'topic',
  'source',
  'material',
  'script',
  'audio',
  'captions',
  'video',
  'other',
] as const satisfies readonly CreateFlowArtifactKind[]

export type CreateFlowWorkflowStageId =
  | 'topic'
  | 'research'
  | 'materials'
  | 'script'
  | 'scenes'
  | 'voice_captions'
  | 'render'
  | 'verify'

export interface CreateFlowTaskProjection {
  readonly stage: CreateFlowStage
  readonly kind: CreateFlowArtifactKind
}

export interface CreateFlowWorkflowStageDefinition {
  readonly id: CreateFlowWorkflowStageId
  readonly order: number
  readonly label: string
  /** Persistent production role responsible for task-driven stage evidence. */
  readonly roleId?: string
  /** Compatibility label for pre-V0.4/template-materialized members. */
  readonly displayRole?: string
  /** Verified task artifacts from this role project through this mapping. */
  readonly taskProjection?: CreateFlowTaskProjection
  /** Production-state stages represented by this workflow stage. */
  readonly productionStages: readonly CreateFlowStage[]
}

export const CREATE_FLOW_WORKFLOW_REGISTRY = [
  defineCreateFlowStage({
    id: 'topic',
    order: 10,
    label: 'Topic',
    roleId: 'topic-strategist',
    displayRole: 'Topic Strategist',
    taskProjection: { stage: 'topic', kind: 'topic' },
    productionStages: ['topic'],
  }),
  defineCreateFlowStage({
    id: 'research',
    order: 20,
    label: 'Research',
    roleId: 'researcher',
    displayRole: 'Researcher',
    taskProjection: { stage: 'research', kind: 'source' },
    productionStages: ['research'],
  }),
  defineCreateFlowStage({
    id: 'materials',
    order: 30,
    label: 'Materials',
    roleId: 'material-producer',
    displayRole: 'Material Producer',
    taskProjection: { stage: 'materials', kind: 'material' },
    productionStages: ['materials'],
  }),
  defineCreateFlowStage({
    id: 'script',
    order: 40,
    label: 'Script',
    roleId: 'scriptwriter',
    displayRole: 'Scriptwriter',
    taskProjection: { stage: 'script', kind: 'script' },
    productionStages: ['script'],
  }),
  defineCreateFlowStage({
    id: 'scenes',
    order: 50,
    label: 'Scenes',
    productionStages: [],
  }),
  defineCreateFlowStage({
    id: 'voice_captions',
    order: 60,
    label: 'Voice / Captions',
    productionStages: ['voice', 'captions'],
  }),
  defineCreateFlowStage({
    id: 'render',
    order: 70,
    label: 'Render',
    roleId: 'video-producer',
    displayRole: 'Video Producer',
    taskProjection: { stage: 'render', kind: 'other' },
    productionStages: ['render'],
  }),
  defineCreateFlowStage({
    id: 'verify',
    order: 80,
    label: 'Verify',
    productionStages: [],
  }),
] as const satisfies readonly CreateFlowWorkflowStageDefinition[]

const BY_ROLE_ID = new Map<string, CreateFlowWorkflowStageDefinition>()
const BY_DISPLAY_ROLE = new Map<string, CreateFlowWorkflowStageDefinition>()
for (const definition of CREATE_FLOW_WORKFLOW_REGISTRY) {
  if (definition.roleId !== undefined) BY_ROLE_ID.set(definition.roleId, definition)
  if (definition.displayRole !== undefined) BY_DISPLAY_ROLE.set(definition.displayRole, definition)
}

export function defineCreateFlowStage(definition: CreateFlowWorkflowStageDefinition): CreateFlowWorkflowStageDefinition {
  return definition
}

/** Resolve durable role identity first, then the legacy display-role fallback. */
export function createFlowStageForRole(roleId?: string, displayRole?: string): CreateFlowWorkflowStageDefinition | undefined {
  return (roleId !== undefined ? BY_ROLE_ID.get(roleId) : undefined)
    ?? (displayRole !== undefined ? BY_DISPLAY_ROLE.get(displayRole) : undefined)
}

export function projectionForCreateFlowRole(roleId?: string, displayRole?: string): CreateFlowTaskProjection | undefined {
  return createFlowStageForRole(roleId, displayRole)?.taskProjection
}
