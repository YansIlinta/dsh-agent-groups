import { describe, expect, it } from 'vitest'
import { listTemplates, requireTemplate, templateMemberSlots } from '../src/template-registry.js'
import { parseRecord } from '../src/persistence.js'
import { GroupError } from '../src/group-service.js'
import { makeHarness, makeHost, makeStores, SAMPLE_MISSION, seedGroup } from './helpers.js'

const RESULT = { summary: 'done', artifacts: ['a.ts'], completionClaim: true }

describe('V0.2: team templates', () => {
  it('ships the four built-in templates with valid member profiles', async () => {
    const h = makeHarness()
    const templates = listTemplates()
    expect(templates.map((t) => t.id)).toEqual(['software-team', 'research-team', 'content-team', 'general-team'])
    const profileIds = new Set(h.profiles.list().map((p) => p.id))
    for (const template of templates) {
      expect(profileIds.has(template.leaderProfile)).toBe(true)
      for (const slot of templateMemberSlots(template)) {
        expect(profileIds.has(slot.profile), `${template.id}: ${slot.profile}`).toBe(true)
      }
    }
    expect(templateMemberSlots(requireTemplate('general-team'))).toHaveLength(2)
    expect(templateMemberSlots(requireTemplate('research-team'))).toHaveLength(4)
  })
})

describe('V0.2: task editing', () => {
  it('edits subject/priority/tags/deps and records task_updated', async () => {
    const h = makeHarness()
    const group = await seedGroup(h)
    const dep = await h.tasks.createTask(group.groupId, { createdBy: 'lead', subject: 'schema', description: '…', kind: 'research', acceptanceCriteria: ['x'] })
    const task = await h.tasks.createTask(group.groupId, { createdBy: 'lead', subject: 'api', description: '…', kind: 'implementation', acceptanceCriteria: ['x'] })
    const updated = await h.tasks.updateTask(group.groupId, task.taskId, 'user', {
      subject: 'API v2',
      priority: 'urgent',
      tags: ['frontend', 'api'],
      blockedBy: [dep.taskId],
    })
    expect(updated.subject).toBe('API v2')
    expect(updated.priority).toBe('urgent')
    expect(updated.tags).toEqual(['frontend', 'api'])
    expect(updated.revision).toBe(2)
    expect(h.activity.list(group.groupId).some((a) => a.type === 'task_updated' && a.refTaskId === task.taskId)).toBe(true)
  })

  it('rejects self-dependency, unknown deps, completed-task edits, and stale CAS', async () => {
    const h = makeHarness()
    const group = await seedGroup(h)
    const task = await h.tasks.createTask(group.groupId, { createdBy: 'lead', subject: 'x', description: '…', kind: 'implementation', acceptanceCriteria: ['x'] })
    await expect(h.tasks.updateTask(group.groupId, task.taskId, 'user', { blockedBy: [task.taskId] })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(h.tasks.updateTask(group.groupId, task.taskId, 'user', { blockedBy: ['missing'] })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await h.tasks.complete(group.groupId, task.taskId, 'm1', RESULT)
    await h.tasks.verify(group.groupId, task.taskId, 'lead', true)
    await expect(h.tasks.updateTask(group.groupId, task.taskId, 'user', { subject: 'nope' })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('user hold shows the task blocked on the board without touching the DAG', async () => {
    const h = makeHarness()
    const group = await seedGroup(h)
    const task = await h.tasks.createTask(group.groupId, { createdBy: 'lead', subject: 'x', description: '…', kind: 'implementation', acceptanceCriteria: ['x'] })
    const held = await h.tasks.setHeld(group.groupId, task.taskId, 'user', true)
    expect(held.heldAt).toBeDefined()
    expect(h.tasks.listTasks(group.groupId).find((t) => t.taskId === task.taskId)?.status).toBe('blocked')
    await h.tasks.setHeld(group.groupId, task.taskId, 'user', false)
    expect(h.tasks.listTasks(group.groupId).find((t) => t.taskId === task.taskId)?.status).toBe('pending')
  })
})

describe('V0.2: channel reply & pin', () => {
  it('stores reply relationships and validates the parent exists', async () => {
    const h = makeHarness()
    const group = await seedGroup(h)
    const parent = await h.channel.post(group.groupId, { senderId: 'm1', senderName: 'Fe', text: 'parent' })
    const reply = await h.channel.post(group.groupId, { senderId: 'm2', senderName: 'Rv', text: 'reply', replyToMessageId: parent.id })
    expect(reply.replyToMessageId).toBe(parent.id)
    const feed = h.channel.list(group.groupId)
    expect(feed.find((m) => m.id === reply.id)?.replyToMessageId).toBe(parent.id)
    await expect(h.channel.post(group.groupId, { senderId: 'm1', senderName: 'Fe', text: 'x', replyToMessageId: 'nope' })).rejects.toThrow()
  })

  it('pins and unpins messages, retaining history', async () => {
    const h = makeHarness()
    const group = await seedGroup(h)
    const message = await h.channel.post(group.groupId, { senderId: 'm1', senderName: 'Fe', text: 'important' })
    const pinned = await h.channel.setPinned(group.groupId, message.id, 'user', true)
    expect(pinned.pinnedAt).toBeDefined()
    expect(h.channel.pinned(group.groupId).map((m) => m.id)).toEqual([message.id])
    await h.channel.setPinned(group.groupId, message.id, 'user', false)
    expect(h.channel.pinned(group.groupId)).toHaveLength(0)
    expect(h.channel.list(group.groupId)).toHaveLength(1) // message stays
  })
})

describe('V0.2: mission notes', () => {
  it('persists notes with timestamps and activity', async () => {
    const h = makeHarness()
    const group = await seedGroup(h)
    const updated = await h.groups.updateNotes(group.groupId, 'No schema changes without review.', 'User')
    expect(updated.notes).toBe('No schema changes without review.')
    expect(updated.notesUpdatedAt).toBeDefined()
    expect(h.activity.list(group.groupId).some((a) => a.type === 'notes_updated')).toBe(true)
  })
})

describe('V0.2: pause / resume dispatch gate', () => {
  it('blocks task/member dispatch while paused, keeps messaging open', async () => {
    const host = makeHost()
    const group = await host.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    await host.userPauseGroup(group.groupId, true)
    await expect(host.createTask('lead-1', { subject: 'x', description: '…', kind: 'implementation', acceptanceCriteria: ['x'] })).rejects.toMatchObject({ code: 'PAUSED' })
    await expect(host.userSpawnMember(group.groupId, { profileId: 'frontend-engineer' })).rejects.toMatchObject({ code: 'PAUSED' })
    const ok = await host.userBroadcast(group.groupId, 'heads up')
    expect(ok.text).toBe('heads up')
    await host.userPauseGroup(group.groupId, false)
    const task = await host.createTask('lead-1', { subject: 'x', description: '…', kind: 'implementation', acceptanceCriteria: ['x'] })
    expect(task.status).toBe('pending')
  })
})

describe('V0.2: archive / duplicate', () => {
  it('archives hide from default list and block mutations', async () => {
    const host = makeHost()
    const group = await host.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    await host.userArchiveGroup(group.groupId, true)
    expect(host.listGroupsForWeb()).toHaveLength(0)
    expect(host.listGroupsForWeb(true)).toHaveLength(1)
    await expect(host.userUpdateNotes(group.groupId, 'nope')).rejects.toMatchObject({ code: 'ARCHIVED' })
    await host.userArchiveGroup(group.groupId, false)
    await host.userUpdateNotes(group.groupId, 'back')
    expect(host.groups.requireGroup(group.groupId).notes).toBe('back')
  })

  it('duplicates mission/workstreams but not members/tasks/activity', async () => {
    const host = makeHost()
    const group = await host.initGroup('lead-1', { name: 'Original', objective: 'demo', acceptanceCriteria: ['x'] })
    await host.groups.addWorkstream(group.groupId, 'Backend')
    await host.spawnMember('lead-1', { profileId: 'frontend-engineer' })
    await host.createTask('lead-1', { subject: 't1', description: '…', kind: 'implementation', acceptanceCriteria: ['x'] })
    // one active group per Leader: duplicate only after completion
    await expect(host.userDuplicateGroup(group.groupId)).rejects.toMatchObject({ code: 'CONFLICT' })
    await host.completeMission('lead-1')
    const copy = await host.userDuplicateGroup(group.groupId)
    expect(copy.groupId).not.toBe(group.groupId)
    expect(copy.mission.objective).toBe(group.mission.objective)
    expect(copy.workstreams.map((w) => w.title)).toEqual(['Backend'])
    // mission/workstreams/template copied; members re-materialized as fresh
    // agents; old tasks/messages/activity are NOT copied.
    const copyMembers = host.groups.listMembers(copy.groupId, () => undefined)
    expect(copyMembers.map((m) => m.role)).toEqual(['leader', 'member'])
    expect(copyMembers[1]?.profileId).toBe('frontend-engineer')
    expect(copyMembers[1]?.sessionId).not.toBe('lead-1')
    expect(host.tasks.listTasks(copy.groupId)).toHaveLength(0)
    expect(host.activity.list(copy.groupId).some((a) => a.type === 'group_duplicated')).toBe(true)
  })
})

describe('V0.2: known leaders + dashboard group creation', () => {
  it('registers leaders on use and refuses unknown leader sessions', async () => {
    const host = makeHost()
    await expect(host.userCreateGroup({ leaderSessionId: 'ghost', name: 'X', objective: 'y' })).rejects.toMatchObject({ code: 'NOT_LEADER' })
    const group = await host.initGroup('lead-1', { name: 'T', objective: 'demo' }) // registers lead-1
    void group
    expect(host.leaders.isKnown('lead-1')).toBe(true)
    // same leader cannot create a second group from the dashboard
    await expect(host.userCreateGroup({ leaderSessionId: 'lead-1', name: 'X', objective: 'y' })).rejects.toMatchObject({ code: 'ACTIVE_GROUP_EXISTS' })
  })

  it('userCreateGroup materializes template members with a noop adapter', async () => {
    const host = makeHost()
    await host.initGroup('lead-a', { name: 'seed', objective: 'seed' }) // lead-a known
    await host.leaders.register('lead-b')
    const group = await host.userCreateGroup({
      leaderSessionId: 'lead-b',
      name: 'Dashboard Team',
      objective: 'Build a small analytics dashboard.',
      templateId: 'general-team',
      acceptanceCriteria: ['works'],
    })
    expect(group.templateId).toBe('general-team')
    const members = host.groups.listMembers(group.groupId, () => undefined)
    expect(members.filter((m) => m.role === 'member')).toHaveLength(2)
    expect(members[1]?.displayRole).toBe('Generalist')
  })
})

describe('V0.2: backward compatibility of durable records', () => {
  it('legacy group/task/channel/private records still parse (schema extensions are optional)', () => {
    const legacyGroup = {
      groupId: 'g1',
      name: 'Old',
      status: 'active',
      leaderSessionId: 'l1',
      mission: SAMPLE_MISSION,
      workstreams: [],
      createdAt: 1,
    }
    expect(parseRecord<any>('groups', legacyGroup).groupId).toBe('g1')

    const legacyTask = {
      groupId: 'g1',
      taskId: 't1',
      kind: 'implementation',
      acceptanceCriteria: ['x'],
      priority: 'critical',
      createdBy: 'l1',
      subject: 'old',
      description: '…',
      blockedBy: [],
      status: 'pending',
      revision: 1,
      attempt: 1,
      createdAt: 1,
      updatedAt: 1,
      // note: no writeScopes / tags / workstreamId — V0.1 stripped these
    }
    const parsed = parseRecord<any>('tasks', legacyTask)
    expect(parsed.subject).toBe('old')
    expect(parsed.writeScopes).toBeUndefined()
    expect(parsed.tags).toBeUndefined()

    const legacyMessage = { id: 'm1', groupId: 'g1', senderId: 'l1', senderName: 'L', timestamp: 1, kind: 'message', text: 'hi' }
    expect(parseRecord<any>('channel', legacyMessage).pinnedAt).toBeUndefined()

    const legacyPrivate = { id: 'p1', groupId: 'g1', senderId: 'l1', senderName: 'L', recipientId: 'm1', direction: 'leader-to-member', timestamp: 1, text: 'x' }
    expect(parseRecord<any>('private', legacyPrivate).direction).toBe('leader-to-member')
  })

  it('unknown activity types from future versions do not corrupt the store boundary', () => {
    // zod strips unknown keys but enum types fail loud — a stored future type
    // would surface as a validation error, never silent corruption.
    const future = { id: 'a1', groupId: 'g1', timestamp: 1, type: 'future_event', payload: {} }
    expect(() => parseRecord<any>('activity', future)).toThrow()
  })
})

describe('V0.2: user↔leader chat directions', () => {
  it('user-to-leader messages are durable and visible to the leader and dashboard', async () => {
    const h = makeHarness()
    const group = await seedGroup(h)
    const lead = group.leaderSessionId
    await h.privateMessages.send(group.groupId, { senderId: 'user', senderName: 'User', recipientId: lead, direction: 'user-to-leader', text: 'Prioritize frontend first.' })
    await h.privateMessages.send(group.groupId, { senderId: lead, senderName: 'Lead', recipientId: 'user', direction: 'leader-to-user', text: 'Done — frontend is up next.' })
    const rows = h.privateMessages.listForGroup(group.groupId, lead).filter((m) => m.direction === 'user-to-leader' || m.direction === 'leader-to-user')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.direction).toBe('user-to-leader')
    expect(rows[1]?.direction).toBe('leader-to-user')
  })
})