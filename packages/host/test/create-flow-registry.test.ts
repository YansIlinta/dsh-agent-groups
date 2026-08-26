import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalMediaRuntime } from '../src/create-flow/media-runtime.js'
import {
  CREATE_FLOW_ARTIFACT_KINDS,
  CREATE_FLOW_STAGES,
  CREATE_FLOW_WORKFLOW_REGISTRY,
  projectionForCreateFlowRole,
} from '../src/create-flow/registry.js'
import { CreateFlowService } from '../src/create-flow/service.js'
import { readCreateFlowWorkbenchStatus } from '../src/create-flow/workflow.js'
import { makeHost } from './helpers.js'

describe('Create Flow registry and readiness', () => {
  it('keeps one ordered registry for stages, production dependencies and durable role projection', () => {
    expect(CREATE_FLOW_STAGES).toEqual(['topic', 'research', 'materials', 'script', 'voice', 'captions', 'render'])
    expect(CREATE_FLOW_ARTIFACT_KINDS).toContain('video')
    expect(CREATE_FLOW_WORKFLOW_REGISTRY.map((stage) => stage.id)).toEqual([
      'topic',
      'research',
      'materials',
      'script',
      'scenes',
      'voice_captions',
      'render',
      'verify',
    ])
    expect(new Set(CREATE_FLOW_WORKFLOW_REGISTRY.map((stage) => stage.order)).size).toBe(CREATE_FLOW_WORKFLOW_REGISTRY.length)
    expect(CREATE_FLOW_WORKFLOW_REGISTRY.find((stage) => stage.id === 'research')?.requires).toEqual(['topic'])
    expect(CREATE_FLOW_WORKFLOW_REGISTRY.find((stage) => stage.id === 'materials')?.requires).toEqual(['topic'])
    expect(CREATE_FLOW_WORKFLOW_REGISTRY.find((stage) => stage.id === 'script')?.requires).toEqual(['research', 'materials'])
    expect(projectionForCreateFlowRole('scriptwriter')).toEqual({ stage: 'script', kind: 'script' })
    expect(projectionForCreateFlowRole(undefined, 'Scriptwriter')).toEqual({ stage: 'script', kind: 'script' })
  })

  it('derives readiness from Agent Groups task state and exposes independent ready stages together', async () => {
    const host = makeHost()
    const cwd = await mkdtemp(join(tmpdir(), 'create-flow-readiness-'))
    const group = await host.groups.initGroup(
      'lead-1',
      'Lead',
      'Video',
      { objective: 'make a video' },
      { cwd, templateId: 'content-team' },
    )
    await host.groups.addMember(group.groupId, {
      sessionId: 'topic-1',
      profileId: 'planner',
      name: 'Topic Strategist',
      status: 'idle',
      role: 'member',
      roleId: 'topic-strategist',
      displayRole: 'Topic Strategist',
    })

    const flow = new CreateFlowService({
      groups: host.groups,
      activity: host.activity,
      notifier: host.notifier,
      media: new LocalMediaRuntime(),
    })

    await flow.addArtifact(group.groupId, 'lead-1', {
      kind: 'topic',
      stage: 'topic',
      title: 'Unverified topic note',
      path: 'production/topic.md',
    })

    let status = await readCreateFlowWorkbenchStatus(host, flow, group.groupId)
    expect(status.workflow.focusStage).toBe('topic')
    expect(status.workflow.readyStages).toEqual(['topic'])
    expect(status.workflow.stages[0]).toMatchObject({ status: 'ready' })
    expect(status.workflow.stages.find((stage) => stage.id === 'research')).toMatchObject({ status: 'blocked' })
    expect(status.workflow.stages.find((stage) => stage.id === 'materials')).toMatchObject({ status: 'blocked' })
    expect(status.workflow.blockers[0]).toContain('No verified Topic Strategist task')
    expect(status.workflow.recommendedActions[0]).toMatchObject({
      action: 'delegate_task',
      roleId: 'topic-strategist',
      allocation: {
        instanceCount: 1,
        maxInstances: 2,
        canSpawnMore: true,
        spawnSuggested: false,
      },
    })
    expect(await flow.status(group.groupId)).not.toHaveProperty('workflow')

    const task = await host.tasks.createTask(group.groupId, {
      subject: 'Approve topic direction',
      description: 'Choose and justify the production topic.',
      kind: 'planning',
      acceptanceCriteria: ['topic direction is accepted'],
      createdBy: 'lead-1',
    })
    await host.tasks.assign(group.groupId, task.taskId, 'topic-1', 'lead-1')
    await host.tasks.claim(group.groupId, task.taskId, 'topic-1')
    await host.tasks.complete(group.groupId, task.taskId, 'topic-1', {
      summary: 'topic selected',
      artifacts: ['production/topic-approved.md'],
      completionClaim: true,
    })
    await host.tasks.verify(group.groupId, task.taskId, 'lead-1', true)

    status = await readCreateFlowWorkbenchStatus(host, flow, group.groupId)
    expect(status.workflow.stages[0]).toMatchObject({ status: 'complete' })
    expect(status.workflow.stages[0]?.evidence.taskIds).toContain(task.taskId)
    expect(status.workflow.focusStage).toBe('research')
    expect(status.workflow.readyStages).toEqual(['research', 'materials'])
    expect(status.workflow.stages.find((stage) => stage.id === 'research')).toMatchObject({ status: 'ready' })
    expect(status.workflow.stages.find((stage) => stage.id === 'materials')).toMatchObject({ status: 'ready' })
    expect(status.workflow.stages.find((stage) => stage.id === 'script')).toMatchObject({ status: 'blocked' })
    expect(status.workflow.recommendedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'delegate_task',
        roleId: 'researcher',
        allocation: expect.objectContaining({
          instanceCount: 0,
          maxInstances: 3,
          canSpawnMore: true,
          spawnSuggested: true,
        }),
      }),
      expect.objectContaining({
        action: 'delegate_task',
        roleId: 'material-producer',
        allocation: expect.objectContaining({
          instanceCount: 0,
          maxInstances: 2,
          canSpawnMore: true,
          spawnSuggested: true,
        }),
      }),
    ]))
  })
})
