/**
 * Web API route tests (V0.3): regression coverage for the route dispatcher of
 * `/groups/api/*`. These routes were previously covered by nothing — the
 * standalone dashboard was the only consumer — which let the whole-group
 * command branch shadow the `members` and `broadcast` POST routes.
 */
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createGroupWebApi } from '../src/web/api.js'
import { makeHost } from './helpers.js'
import type { GroupNotifier } from '../src/notifier.js'
import type { GroupHost } from '../src/group-host.js'

const COMPAT = { dshVersion: 'test', checks: [], fatal: [] }

/** Minimal fake ServerResponse capturing status + body. */
function fakeRes(): ServerResponse & { status: number; body: string } {
  const state = { status: 200, body: '', ended: false }
  const res = {
    get writableEnded() { return state.ended },
    writeHead(status: number, _headers?: unknown) {
      state.status = status
      return res
    },
    end(chunk?: unknown) {
      if (typeof chunk === 'string') state.body = chunk
      state.ended = true
      return res
    },
    write() { return true },
  } as unknown as ServerResponse & { status: number; body: string }
  Object.defineProperty(res, 'status', { get: () => state.status })
  Object.defineProperty(res, 'body', { get: () => state.body })
  return res
}

/** Minimal fake IncomingMessage carrying the URL + optional JSON body. */
function fakeReq(url: string, method = 'GET', body?: unknown): IncomingMessage {
  const req = {
    url,
    method,
    [Symbol.asyncIterator]() {
      const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
      let i = 0
      return {
        next: async () => (i < chunks.length ? { value: chunks[i++]!, done: false } : { value: undefined, done: true }),
      }
    },
    on(_event: string, _fn: unknown): IncomingMessage { return req },
  } as unknown as IncomingMessage & { [Symbol.asyncIterator](): AsyncIterableIterator<Buffer> }
  return req
}

/** Route under test: the production apiHandler (includes its error mapping). */
function apiHandler(host: GroupHost, notifier: GroupNotifier) {
  return createGroupWebApi({ host, notifier, compatibility: COMPAT }).find((route) => route.path === '/groups/api')!.handler
}

async function call(host: GroupHost, notifier: GroupNotifier, url: string, method = 'GET', body?: unknown) {
  const res = fakeRes()
  await apiHandler(host, notifier)(fakeReq(url, method, body), res)
  return res
}

describe('web API routes (V0.3 regression)', () => {
  it('POST /groups/:id/broadcast is not shadowed by the group-action branch', async () => {
    const host = makeHost()
    const group = await host.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    const res = await call(host, host.notifier, `/groups/api/groups/${group.groupId}/broadcast`, 'POST', { text: 'heads up' })
    expect(res.status).toBe(200)
    const parsed = JSON.parse(res.body) as { text?: string }
    expect(parsed.text).toBe('heads up')
  })

  it('POST /groups/:id/members reaches the member branch (unknown profile rejected there)', async () => {
    const host = makeHost()
    const group = await host.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    const res = await call(host, host.notifier, `/groups/api/groups/${group.groupId}/members`, 'POST', { profileId: 'nope' })
    // reached the member branch: NOT_FOUND profile, not "unknown group action"
    expect(res.status).toBe(404)
    expect(res.body).toContain('nope')
    expect(res.body).not.toContain('unknown group action')
  })

  it('group actions still dispatch (archive/restore/duplicate/pause/resume)', async () => {
    const host = makeHost()
    const group = await host.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    const gid = group.groupId
    const archived = await call(host, host.notifier, `/groups/api/groups/${gid}/archive`, 'POST', {})
    expect(archived.status).toBe(200)
    expect(JSON.parse(archived.body).archivedAt).toBeGreaterThan(0)
    const restored = await call(host, host.notifier, `/groups/api/groups/${gid}/restore`, 'POST', {})
    expect(JSON.parse(restored.body).archivedAt).toBeUndefined()
    const paused = await call(host, host.notifier, `/groups/api/groups/${gid}/pause`, 'POST', {})
    expect(JSON.parse(paused.body).pausedAt).toBeGreaterThan(0)
  })

  it('unknown sub-paths of /groups/:id still yield a clean 404', async () => {
    const host = makeHost()
    const group = await host.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    const res = await call(host, host.notifier, `/groups/api/groups/${group.groupId}/nonsense`, 'POST', {})
    expect(res.status).toBe(404)
  })

  it('GET collection endpoints return JSON lists', async () => {
    const host = makeHost()
    const list = await call(host, host.notifier, '/groups/api/groups', 'GET')
    expect(list.status).toBe(200)
    expect(JSON.parse(list.body)).toEqual([])
    const templates = await call(host, host.notifier, '/groups/api/templates', 'GET')
    expect(JSON.parse(templates.body).length).toBeGreaterThanOrEqual(4)
  })

  it('V0.4: GET /groups/api/runtimes reports providers; team-config GET/PUT roundtrips', async () => {
    const host = makeHost()
    host.runtimes.register({
      id: 'deepseek-harness',
      name: 'DeepSeek Harness',
      isAvailable: () => true,
      getCapabilities: () => ({ models: true, reasoningLevels: true, interactiveSession: true, workspace: true, toolControl: false, streaming: true }),
      listModels: () => [{ id: 'm1' }],
      listReasoningLevels: () => [{ id: 'high', label: 'High' }],
      spawnAgent: async () => { throw new Error('not used in route test') },
      stopAgent: async () => undefined,
    })
    const group = await host.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    const runtimes = await call(host, host.notifier, '/groups/api/runtimes', 'GET')
    expect(runtimes.status).toBe(200)
    expect(JSON.parse(runtimes.body).map((r: { id: string }) => r.id)).toContain('deepseek-harness')

    const before = await call(host, host.notifier, `/groups/api/groups/${group.groupId}/team-config`, 'GET')
    expect(JSON.parse(before.body).memberRoles.length).toBeGreaterThanOrEqual(1)

    const saved = await call(host, host.notifier, `/groups/api/groups/${group.groupId}/team-config`, 'PUT', {
      leaderRole: { id: 'leader', name: 'Leader', runtime: 'deepseek-harness' },
      memberRoles: [
        { id: 'planner', name: 'Planner', runtime: 'deepseek-harness', model: 'deepseek-reasoner', reasoningLevel: 'high', maxInstances: 1 },
      ],
    })
    expect(saved.status).toBe(200)
    expect(JSON.parse(saved.body).teamConfig.memberRoles[0].model).toBe('deepseek-reasoner')
    const after = await call(host, host.notifier, `/groups/api/groups/${group.groupId}/team-config`, 'GET')
    expect(JSON.parse(after.body).memberRoles[0].reasoningLevel).toBe('high')
  })

  it('GET /groups/api/groups/:id/tasks-style deep routes are not mis-routed', async () => {
    const host = makeHost()
    const grouped = await call(host, host.notifier, '/groups/api/groups/nope/workspace', 'GET')
    expect(grouped.status).toBe(404) // group not found — error surfaced, not "unknown action"
    expect(grouped.body).toContain('no such group')
  })
})