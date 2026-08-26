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

async function createFlowFixture() {
  const host = makeHost()
  const cwd = await mkdtemp(join(tmpdir(), 'create-flow-readiness-'))
  const group = await host.groups.initGroup(
    'lead-1',
    'Lead',
    'Video',
    { objective: 'make a video' },
    { cwd, templateId: 'content-team' },
  )
  const flow = new CreateFlowService({
    groups: host.groups,
    activity: host.activity,
    notifier: host.notifier,
    media: new LocalMediaRuntime(),
  })
  return { host, group, flow }
}

async function addRoleMember(
  host: ReturnType<typeof makeHost>,
  groupId: string,
  input: { sessionId: string; roleId: string; displayRole: string },
) {
  await host.groups.addMember(groupId, {
    sessionId: input.sessionId,
    profileId: 'group-member',
    name: input.displayRole,
    status: 'idle',
    role: 'member',
    roleId: input.roleId,
    displayRole: input.displayRole,
  })
}

async function verifyTopic(host: ReturnType<typeof makeHost>, groupId: string, ownerId: string) {
  const task = await host.tasks.createTask(groupId, {
    subject: 'Approve topic direction',
    description: 'Choose and justify the production topic.',
    kind: 'planning',
    acceptanceCriteria: ['topic direction is accepted'],
    createdBy: 'lead-1',
  })
  await host.tasks.assign(groupId, task.taskId, ownerId, 'lead-1')
  await host.tasks.claim(groupId, task.taskId, ownerId)
  await host.tasks.complete(groupId, task.taskId, ownerId, {
    summary: 'topic selected',
    artifacts: ['production/topic-approved.md'],
    completionClaim: true,
  })
  await host.tasks.verify(groupId, task.taskId, 'lead-1', true)
  return task
}

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

  it('exposes independent ready stages and lazy role capacity together', async () => {
    const { host, group, flow } = await createFlowFixture()
    await addRoleMember(host, group.groupId, {
      sessionId: 'topic-1',
      roleId: 'topic-strategist',
      displayRole: 'Topic Strategist',
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
    expect(status.workflow.blockers[0]).toContain('No current Topic Strategist task')
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

    const topic = await verifyTopic(host, group.groupId, 'topic-1')

    status = await readCreateFlowWorkbenchStatus(host, flow, group.groupId)
    expect(status.workflow.stages[0]).toMatchObject({ status: 'complete' })
    expect(status.workflow.stages[0]?.evidence.taskIds).toContain(topic.taskId)
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

  it('keeps a fan-out stage open until every current sibling task converges', async () => {
    const { host, group, flow } = await createFlowFixture()
    await addRoleMember(host, group.groupId, {
      sessionId: 'topic-1',
      roleId: 'topic-strategist',
      displayRole: 'Topic Strategist',
    })
    await addRoleMember(host, group.groupId, {
      sessionId: 'research-1',
      roleId: 'researcher',
      displayRole: 'Researcher',
    })
    await verifyTopic(host, group.groupId, 'topic-1')

    const first = await host.tasks.createTask(group.groupId, {
      subject: 'Research factual evidence',
      description: 'Gather primary-source evidence.',
      kind: 'research',
      acceptanceCriteria: ['sources are traceable'],
      createdBy: 'lead-1',
    })
    const second = await host.tasks.createTask(group.groupId, {
      subject: 'Research counterpoints',
      description: 'Gather independent counter-evidence.',
      kind: 'research',
      acceptanceCriteria: ['counterpoints are sourced'],
      createdBy: 'lead-1',
    })
    for (const task of [first, second]) {
      await host.tasks.assign(group.groupId, task.taskId, 'research-1', 'lead-1')
      await host.tasks.claim(group.groupId, task.taskId, 'research-1')
      await host.tasks.complete(group.groupId, task.taskId, 'research-1', {
        summary: task.subject,
        artifacts: [`production/${task.taskId}.md`],
        completionClaim: true,
      })
    }
    await host.tasks.verify(group.groupId, first.taskId, 'lead-1', true)

    let status = await readCreateFlowWorkbenchStatus(host, flow, group.groupId)
    const research = status.workflow.stages.find((stage) => stage.id === 'research')
    expect(research).toMatchObject({ status: 'ready' })
    expect(research?.blockers[0]).toContain('converged 1/2')
    expect(research?.evidence.taskIds).toEqual([first.taskId, second.taskId])
    expect(research?.recommendedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'verify_task', taskIds: [second.taskId] }),
    ]))
    expect(status.workflow.stages.find((stage) => stage.id === 'script')).toMatchObject({ status: 'blocked' })

    await host.tasks.verify(group.groupId, second.taskId, 'lead-1', true)
    status = await readCreateFlowWorkbenchStatus(host, flow, group.groupId)
    expect(status.workflow.stages.find((stage) => stage.id === 'research')).toMatchObject({ status: 'complete' })
  })

  it('collapses failed retry ancestors and evaluates only the current retry leaf', async () => {
    const { host, group, flow } = await createFlowFixture()
    await addRoleMember(host, group.groupId, {
      sessionId: 'topic-1',
      roleId: 'topic-strategist',
      displayRole: 'Topic Strategist',
    })
    await addRoleMember(host, group.groupId, {
      sessionId: 'research-1',
      roleId: 'researcher',
      displayRole: 'Researcher',
    })
    await verifyTopic(host, group.groupId, 'topic-1')

    const failed = await host.tasks.createTask(group.groupId, {
      subject: 'Research primary source',
      description: 'Find a primary source.',
      kind: 'research',
      acceptanceCriteria: ['primary source found'],
      createdBy: 'lead-1',
    })
    await host.tasks.assign(group.groupId, failed.taskId, 'research-1', 'lead-1')
    await host.tasks.claim(group.groupId, failed.taskId, 'research-1')
    await host.tasks.complete(group.groupId, failed.taskId, 'research-1', {
      summary: 'insufficient source',
      artifacts: [],
      completionClaim: true,
    })
    await host.tasks.verify(group.groupId, failed.taskId, 'lead-1', false)

    let status = await readCreateFlowWorkbenchStatus(host, flow, group.groupId)
    expect(status.workflow.stages.find((stage) => stage.id === 'research')?.recommendedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'reopen_task', taskIds: [failed.taskId] }),
    ]))

    const retry = await host.tasks.createTask(group.groupId, {
      subject: 'Retry primary-source research',
      description: 'Search alternate primary-source repositories.',
      kind: 'research',
      acceptanceCriteria: ['primary source found'],
      createdBy: 'lead-1',
      retryOf: failed.taskId,
    })
    await host.tasks.assign(group.groupId, retry.taskId, 'research-1', 'lead-1')
    await host.tasks.claim(group.groupId, retry.taskId, 'research-1')
    await host.tasks.complete(group.groupId, retry.taskId, 'research-1', {
      summary: 'source found',
      artifacts: ['production/source.md'],
      completionClaim: true,
    })
    await host.tasks.verify(group.groupId, retry.taskId, 'lead-1', true)

    status = await readCreateFlowWorkbenchStatus(host, flow, group.groupId)
    const research = status.workflow.stages.find((stage) => stage.id === 'research')
    expect(research).toMatchObject({ status: 'complete' })
    expect(research?.evidence.taskIds).toEqual([retry.taskId])
    expect(research?.evidence.taskIds).not.toContain(failed.taskId)
  })
})
