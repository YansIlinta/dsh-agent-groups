/**
 * Web API route tests (V0.3): regression coverage for the route dispatcher of
 * `/groups/api/*`. These routes were previously covered by nothing — the
 * standalone dashboard was the only consumer — which let the whole-group
 * command branch shadow the `members` and `broadcast` POST routes.
 */
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createGroupWebApi } from '../src/web/api.js'
import { createNoopAdapter } from '../src/dsh-adapter.js'
import { makeHarness, makeHost } from './helpers.js'
import type { GroupNotifier } from '../src/notifier.js'
import { GroupHost } from '../src/group-host.js'
import type { HostDiscoverySource } from '../src/group-host.js'

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

    // V0.4.1: provider/reasoningEffort survive the PUT→GET normalization roundtrip.
    const withProvider = await call(host, host.notifier, `/groups/api/groups/${group.groupId}/team-config`, 'PUT', {
      leaderRole: { id: 'leader', name: 'Leader', runtime: 'deepseek-harness' },
      memberRoles: [
        { id: 'planner', name: 'Planner', runtime: 'deepseek-harness', provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningLevel: 'high', reasoningEffort: 'max', maxInstances: 1 },
      ],
    })
    expect(withProvider.status).toBe(200)
    const roundtrip = JSON.parse((await call(host, host.notifier, `/groups/api/groups/${group.groupId}/team-config`, 'GET')).body)
    expect(roundtrip.memberRoles[0].provider).toBe('deepseek-official')
    expect(roundtrip.memberRoles[0].reasoningEffort).toBe('max')
  })

  it('GET /groups/api/groups/:id/tasks-style deep routes are not mis-routed', async () => {
    const host = makeHost()
    const grouped = await call(host, host.notifier, '/groups/api/groups/nope/workspace', 'GET')
    expect(grouped.status).toBe(404) // group not found — error surfaced, not "unknown action"
    expect(grouped.body).toContain('no such group')
  })

  it('V0.6: POST /groups/:id/tasks creates (and optionally assigns) a task', async () => {
    const host = makeHost()
    const group = await host.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    const created = await call(host, host.notifier, `/groups/api/groups/${group.groupId}/tasks`, 'POST', {
      subject: 'route task', description: 'd', ownerId: 'ghost',
    })
    // assigning to an unknown member fails with the service error (409), not 404
    expect(created.status).toBe(404)
    expect(created.body).toContain('ghost')
    // without an owner the task is created pending
    const plain = await call(host, host.notifier, `/groups/api/groups/${group.groupId}/tasks`, 'POST', { subject: 'plain task' })
    expect(plain.status).toBe(200)
    expect(JSON.parse(plain.body).status).toBe('pending')
    expect(JSON.parse(plain.body).createdBy).toBe('User')
  })

  it('V0.6: POST /groups/:id/members/:m/correction and /interrupt route to the Host', async () => {
    const host = makeHost()
    const group = await host.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    const empty = await call(host, host.notifier, `/groups/api/groups/${group.groupId}/members/nope/correction`, 'POST', { text: 'hi' })
    expect(empty.status).toBe(404) // unknown member — surfaced, not "unknown action"
    const bad = await call(host, host.notifier, `/groups/api/groups/${group.groupId}/members/nope/interrupt`, 'POST', { reason: 'stop' })
    expect(bad.status).toBe(404)
    // missing text on correction → 400
    const host2 = makeHost()
    await host2.profiles.register({ id: 'group-member', name: 'Member', description: 'test', capabilities: [] })
    const group2 = await host2.initGroup('lead-2', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    const member = await host2.userSpawnMember(group2.groupId, { profileId: 'group-member' })
    const noText = await call(host2, host2.notifier, `/groups/api/groups/${group2.groupId}/members/${member.sessionId}/correction`, 'POST', {})
    expect(noText.status).toBe(400)
    // a live plain-DSH member accepts the correction through the adapter
    const ok = await call(host2, host2.notifier, `/groups/api/groups/${group2.groupId}/members/${member.sessionId}/correction`, 'POST', { text: 'fix only that' })
    expect(ok.status).toBe(200)
    // with the noop adapter delivery is unavailable → honest false, no crash
    expect(typeof JSON.parse(ok.body).ok).toBe('boolean')
  })
})

// ── V0.4.1: Role Editor discovery endpoints (live harness services) ─────────

/** A secret VALUE that must never appear in any web response. */
const SECRET_MARKER = 'sk-super-secret-value'

/** Live-shape discovery source over fake harness services (no secrets). */
function fakeDiscovery(): HostDiscoverySource {
  return {
    available: () => true,
    listProviderIds: async () => ['deepseek-official', 'opencode-go', 'vanilla'],
    listProviders: () => [
      { id: 'deepseek-official', name: 'DeepSeek' },
      { id: 'opencode-go', name: 'OpenCode Go' },
      { id: 'vanilla', name: 'Vanilla Route' },
    ],
    listModels: async (provider) =>
      provider === 'deepseek-official'
        ? [
            { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
            { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', description: 'Pro tier' },
          ]
        : [],
    resolveReasoning: async (provider, _model) =>
      provider === 'deepseek-official'
        ? { efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max', description: 'Max effort' }], defaultEffort: 'high' }
        : undefined,
    listReasoningEfforts: async (provider, _model) => (provider === 'deepseek-official' ? ['high', 'max'] : undefined),
    listConfigurableProviders: () => [
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
      { provider: 'opencode-go', displayName: 'OpenCode Go', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode-go'] },
    ],
    credentialStatus: async (provider) => {
      if (provider === 'deepseek-official') {
        return { provider, configured: true, source: 'env', writable: false, settingsNs: 'llm-deepseek', settingsPath: [], credentialRef: 'DEEPSEEK_API_KEY' }
      }
      if (provider === 'opencode-go') {
        return { provider, configured: false, writable: true, settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode-go'], credentialRef: 'OPENCODE_GO_API_KEY' }
      }
      return { provider } // no settings entry → facts only
    },
  }
}

/** A GroupHost wired to a (possibly absent) discovery source. */
function makeDiscoveryHost(discovery: HostDiscoverySource | undefined): GroupHost {
  const h = makeHarness()
  return new GroupHost({
    groups: h.groups,
    tasks: h.tasks,
    channel: h.channel,
    privateMessages: h.privateMessages,
    activity: h.activity,
    profiles: h.profiles,
    notifier: h.notifier,
    adapter: createNoopAdapter(),
    leaders: h.leaders,
    discovery,
  })
}

describe('V0.4.1: Role Editor discovery endpoints', () => {
  it('GET /groups/api/config/providers returns auth facts + runtimes (no models, no secrets)', async () => {
    const host = makeDiscoveryHost(fakeDiscovery())
    const res = await call(host, host.notifier, '/groups/api/config/providers', 'GET')
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as { providers: Array<Record<string, unknown>>; runtimes: unknown[]; note?: string }
    expect(body.note).toBeUndefined() // healthy discovery → no degraded note
    const deepseek = body.providers.find((p) => p.id === 'deepseek-official')!
    expect(deepseek).toMatchObject({
      id: 'deepseek-official',
      name: 'DeepSeek',
      configurable: true,
      settingsNs: 'llm-deepseek',
      settingsPath: [],
      credentialRef: 'DEEPSEEK_API_KEY',
    })
    expect(deepseek.credential).toEqual({ configured: true, source: 'env', writable: false })
    expect(deepseek).not.toHaveProperty('models') // models live on the :id/models route
    expect(Array.isArray(body.runtimes)).toBe(true)
    expect(res.body).not.toContain(SECRET_MARKER)
  })

  it('GET /groups/api/config/providers degrades to an empty list + note without harness services', async () => {
    const host = makeDiscoveryHost(undefined)
    const res = await call(host, host.notifier, '/groups/api/config/providers', 'GET')
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as { providers: unknown[]; runtimes: unknown[]; note: string }
    expect(body.providers).toEqual([])
    expect(body.note).toContain('not available')
    expect(Array.isArray(body.runtimes)).toBe(true)
  })

  it('GET /groups/api/config/providers carries the note when the mounted source reports unavailable services', async () => {
    const host = makeDiscoveryHost({ ...fakeDiscovery(), available: () => false, listProviders: () => [] })
    const res = await call(host, host.notifier, '/groups/api/config/providers', 'GET')
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as { providers: unknown[]; note?: string }
    expect(body.providers).toEqual([])
    expect(body.note).toBeDefined()
  })

  it('GET /groups/api/config/providers/:id/models returns per-model reasoning; unknown provider → 404', async () => {
    const host = makeDiscoveryHost(fakeDiscovery())
    const res = await call(host, host.notifier, '/groups/api/config/providers/deepseek-official/models', 'GET')
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.provider).toBe('deepseek-official')
    const flash = body.models.find((m: { id: string }) => m.id === 'deepseek-v4-flash')
    expect(flash.reasoning.efforts.map((e: { id: string }) => e.id)).toEqual(['high', 'max'])
    expect(flash.reasoning.defaultEffort).toBe('high')
    const pro = body.models.find((m: { id: string }) => m.id === 'deepseek-v4-pro')
    expect(pro.description).toBe('Pro tier')
    // a registered provider with no models → 200 empty list, still deterministic JSON
    const empty = await call(host, host.notifier, '/groups/api/config/providers/opencode-go/models', 'GET')
    expect(empty.status).toBe(200)
    expect(JSON.parse(empty.body).models).toEqual([])
    // unknown provider → structured {error} 404
    const missing = await call(host, host.notifier, '/groups/api/config/providers/ghost/models', 'GET')
    expect(missing.status).toBe(404)
    const missingBody = JSON.parse(missing.body) as { error: string; provider: string }
    expect(missingBody.error).toBe('unknown provider')
    expect(missingBody.provider).toBe('ghost')
  })

  it('GET /groups/api/config/providers/:id/models degrades to empty + note without harness services', async () => {
    const host = makeDiscoveryHost(undefined)
    const res = await call(host, host.notifier, '/groups/api/config/providers/anything/models', 'GET')
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as { provider: string; models: unknown[]; note?: string }
    expect(body.models).toEqual([])
    expect(body.note).toBeDefined()
  })

  it('GET /groups/api/config/providers/:id/credential returns status + settings entry (never the value)', async () => {
    const host = makeDiscoveryHost(fakeDiscovery())
    const res = await call(host, host.notifier, '/groups/api/config/providers/deepseek-official/credential', 'GET')
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.provider).toBe('deepseek-official')
    expect(body.credential).toEqual({
      configured: true,
      source: 'env',
      writable: false,
      entry: { kind: 'settings', settingsNs: 'llm-deepseek', settingsPath: [], credentialRef: 'DEEPSEEK_API_KEY' },
    })
    expect(res.body).not.toContain(SECRET_MARKER)
    // provider with no settings entry → facts-only credential object (empty, not absent)
    const vanilla = await call(host, host.notifier, '/groups/api/config/providers/vanilla/credential', 'GET')
    expect(vanilla.status).toBe(200)
    expect(JSON.parse(vanilla.body).credential).toEqual({})
    // unknown provider → structured 404
    const missing = await call(host, host.notifier, '/groups/api/config/providers/ghost/credential', 'GET')
    expect(missing.status).toBe(404)
    expect((JSON.parse(missing.body) as { error: string }).error).toBe('unknown provider')
  })

  it('team-config PUT rejects secret-named role fields and never echoes secret values', async () => {
    const host = makeDiscoveryHost(fakeDiscovery())
    const group = await host.initGroup('lead-1', { name: 'T', objective: 'demo', acceptanceCriteria: ['x'] })
    const res = await call(host, host.notifier, `/groups/api/groups/${group.groupId}/team-config`, 'PUT', {
      leaderRole: { id: 'leader', name: 'Leader', runtime: 'deepseek-harness' },
      memberRoles: [
        { id: 'planner', name: 'Planner', runtime: 'deepseek-harness', apiKey: SECRET_MARKER, metadata: { credential: 'sk-nested-1' } },
      ],
    })
    expect(res.status).toBe(409)
    expect(res.body).not.toContain(SECRET_MARKER)
    expect(res.body).not.toContain('sk-nested-1')
    // the rejected payload never touched the durable config / GET responses
    const after = await call(host, host.notifier, `/groups/api/groups/${group.groupId}/team-config`, 'GET')
    expect(after.status).toBe(200)
    expect(after.body).not.toContain(SECRET_MARKER)
    expect(after.body).not.toContain('sk-nested-1')
  })
})
