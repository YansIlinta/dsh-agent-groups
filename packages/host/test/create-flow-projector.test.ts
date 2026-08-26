import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CreateFlowService } from '../src/create-flow/service.js'
import { CreateFlowTaskProjector } from '../src/create-flow/task-projector.js'
import { LocalMediaRuntime } from '../src/create-flow/media-runtime.js'
import { makeHarness } from './helpers.js'

describe('Create Flow task projector', () => {
  it('projects verified legacy-template Scriptwriter artifacts into the script stage exactly once', async () => {
    const h = makeHarness()
    const cwd = await mkdtemp(join(tmpdir(), 'create-flow-projector-'))
    const group = await h.groups.initGroup(
      'lead-1',
      'Lead',
      'Video',
      { objective: 'make a video' },
      { cwd, templateId: 'content-team' },
    )
    // The existing template materialization path is profile-based and carries
    // displayRole but may not carry a V0.4 roleId. The projector must support
    // that durable compatibility shape as well as role-based members.
    await h.groups.addMember(group.groupId, {
      sessionId: 'writer-1',
      profileId: 'reviewer',
      name: 'Scriptwriter',
      status: 'idle',
      role: 'member',
      displayRole: 'Scriptwriter',
    })
    const task = await h.tasks.createTask(group.groupId, {
      subject: 'Write final script',
      description: 'Turn the research pack into a production script.',
      kind: 'implementation',
      acceptanceCriteria: ['script is production ready'],
      createdBy: 'lead-1',
    })
    await h.tasks.assign(group.groupId, task.taskId, 'writer-1', 'lead-1')
    await h.tasks.claim(group.groupId, task.taskId, 'writer-1')
    await h.tasks.complete(group.groupId, task.taskId, 'writer-1', {
      summary: 'script complete',
      artifacts: ['production/script.md'],
      completionClaim: true,
    })
    await h.tasks.verify(group.groupId, task.taskId, 'lead-1', true)

    const flow = new CreateFlowService({
      groups: h.groups,
      activity: h.activity,
      notifier: h.notifier,
      media: new LocalMediaRuntime(),
    })
    const projector = new CreateFlowTaskProjector({ groups: h.groups, tasks: h.tasks, notifier: h.notifier, flow })

    expect(await projector.projectTask(group.groupId, task.taskId)).toBe(1)
    expect(await projector.projectTask(group.groupId, task.taskId)).toBe(0)

    const status = await flow.status(group.groupId)
    expect(status.state.artifacts).toHaveLength(1)
    expect(status.state.artifacts[0]).toMatchObject({
      kind: 'script',
      stage: 'script',
      path: 'production/script.md',
    })
    expect(status.state.artifacts[0]?.metadata?.taskId).toBe(task.taskId)
    expect(status.state.artifacts[0]?.metadata?.displayRole).toBe('Scriptwriter')
  })

  it('serializes concurrent projection and deduplicates repeated result paths', async () => {
    const h = makeHarness()
    const cwd = await mkdtemp(join(tmpdir(), 'create-flow-projector-'))
    const group = await h.groups.initGroup(
      'lead-1',
      'Lead',
      'Video',
      { objective: 'make a video' },
      { cwd, templateId: 'content-team' },
    )
    await h.groups.addMember(group.groupId, {
      sessionId: 'writer-1',
      profileId: 'reviewer',
      name: 'Scriptwriter',
      status: 'idle',
      role: 'member',
      displayRole: 'Scriptwriter',
    })
    const task = await h.tasks.createTask(group.groupId, {
      subject: 'Write final script',
      description: 'Produce one verified script artifact.',
      kind: 'implementation',
      acceptanceCriteria: ['script is production ready'],
      createdBy: 'lead-1',
    })
    await h.tasks.assign(group.groupId, task.taskId, 'writer-1', 'lead-1')
    await h.tasks.claim(group.groupId, task.taskId, 'writer-1')
    await h.tasks.complete(group.groupId, task.taskId, 'writer-1', {
      summary: 'script complete',
      artifacts: ['production/script.md', 'production/script.md'],
      completionClaim: true,
    })
    await h.tasks.verify(group.groupId, task.taskId, 'lead-1', true)

    const flow = new CreateFlowService({
      groups: h.groups,
      activity: h.activity,
      notifier: h.notifier,
      media: new LocalMediaRuntime(),
    })
    const projector = new CreateFlowTaskProjector({ groups: h.groups, tasks: h.tasks, notifier: h.notifier, flow })

    const results = await Promise.all([
      projector.projectTask(group.groupId, task.taskId),
      projector.projectTask(group.groupId, task.taskId),
    ])

    expect(results.slice().sort()).toEqual([0, 1])
    const status = await flow.status(group.groupId)
    expect(status.state.artifacts).toHaveLength(1)
    expect(status.state.artifacts[0]?.path).toBe('production/script.md')
  })
})
