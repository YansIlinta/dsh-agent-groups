/**
 * Agent Groups web API: durable JSON snapshots + a live SSE stream, served on
 * the same webserver as the DSH GUI (no separate origin, no CORS). The DSH-
 * native page (client bundle) reads through these endpoints; every request
 * goes through `GroupHost` — the same role-checked service the tools use.
 * @module @dsh-agent-groups/host
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { GroupHost } from '../group-host.js'
import { GroupError } from '../group-service.js'
import type { GroupNotifier } from '../notifier.js'
import type { CompatibilityReport } from '../core-types.js'

export function createGroupWebApi(options: {
  host: GroupHost
  notifier: GroupNotifier
  compatibility: CompatibilityReport
}): WebRoute[] {
  const { host, notifier, compatibility } = options

  const apiHandler: WebRoute['handler'] = async (req, res) => {
    try {
      await handleApi(req, res, host, notifier, compatibility)
    } catch (error) {
      if (res.writableEnded) return
      if (error instanceof GroupError) {
        const status = error.code === 'NOT_FOUND' || error.code === 'NOT_MEMBER' ? 404 : 409
        sendJson(res, status, { error: 'group_error', code: error.code, message: error.message })
        return
      }
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  // V0.3: the standalone dashboard is gone; /groups/ and any non-API path
  // redirect to the DSH shell (the native page lives in the shell itself).
  const legacyRedirect: WebRoute['handler'] = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname.startsWith('/groups/api')) {
      apiHandler(req, res)
      return
    }
    res.writeHead(302, { location: '/' })
    res.end()
  }

  return [
    { kind: 'prefix', path: '/groups/api', handler: apiHandler },
    { kind: 'prefix', path: '/groups', handler: legacyRedirect },
  ]
}

// ── API handler ─────────────────────────────────────────────────────────────

/**
 * Route dispatcher for `/groups/api/*`. Exported for the route test suite
 * (test/api-routes.test.ts) which injects fake IncomingMessage/ServerResponse
 * objects — the standalone dashboard never exercised these routes, which let
 * the broadcast/members shadowing bug survive until the native UI migration.
 */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  host: GroupHost,
  notifier: GroupNotifier,
  compatibility: CompatibilityReport,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const segments = url.pathname.split('/').filter(Boolean) // ['groups','api',...]
  const rest = decodePath(segments.slice(2))
  const method = req.method ?? 'GET'

  if (rest.length === 0 && method === 'GET') {
    // /groups/api/… → capabilities hint
    sendJson(res, 200, {
      name: 'agent-groups',
      paths: ['groups', 'group/:id', 'events', 'templates', 'sessions/leaders', 'profiles'],
    })
    return
  }

  // ── read-only collections ─────────────────────────────────────────────────

  if (rest.length === 1 && rest[0] === 'groups' && method === 'GET') {
    const includeArchived = url.searchParams.get('includeArchived') === '1'
    sendJson(res, 200, host.listGroupsForWeb(includeArchived))
    return
  }

  if (rest.length === 1 && rest[0] === 'templates' && method === 'GET') {
    sendJson(res, 200, host.templates())
    return
  }

  if (rest.length === 2 && rest[0] === 'sessions' && rest[1] === 'leaders' && method === 'GET') {
    sendJson(res, 200, host.listLeadersForWeb())
    return
  }

  if (rest.length === 1 && rest[0] === 'profiles' && method === 'GET') {
    sendJson(res, 200, host.profilesViewWithPresets())
    return
  }

  if (rest.length === 1 && rest[0] === 'events' && method === 'GET') {
    await streamEvents(req, res, notifier, url.searchParams.get('groupId') ?? undefined)
    return
  }

  // ── group create + whole-group commands ───────────────────────────────────

  if (rest.length === 1 && rest[0] === 'groups' && method === 'POST') {
    const body = (await readJsonBody(req)) ?? {}
    const group = await host.userCreateGroup({
      leaderSessionId: stringOf(body.leaderSessionId, 'leaderSessionId'),
      name: stringOf(body.name, 'name'),
      objective: stringOf(body.objective, 'objective'),
      constraints: listOf(body.constraints),
      deliverables: listOf(body.deliverables),
      acceptanceCriteria: listOf(body.acceptanceCriteria),
      risks: listOf(body.risks),
      templateId: optionalString(body.templateId),
      maxMembers: optionalNumber(body.maxMembers),
      members: Array.isArray(body.members)
        ? (body.members as Array<Record<string, unknown>>).map((slot) => ({
            role: optionalString(slot.role),
            profile: stringOf(slot.profile, 'members[].profile'),
            name: optionalString(slot.name),
          }))
        : undefined,
    })
    sendJson(res, 200, group)
    return
  }

  if (rest.length === 2 && rest[0] === 'group' && method === 'GET') {
    sendJson(res, 200, host.snapshot(rest[1]!, compatibility))
    return
  }

  if (rest.length === 2 && rest[0] === 'group' && method === 'POST') {
    const body = (await readJsonBody(req)) ?? {}
    const text = typeof body?.text === 'string' ? body.text : ''
    if (text.trim() === '') {
      sendJson(res, 400, { error: 'text required' })
      return
    }
    const ok = await host.userMessageToLeader(rest[1]!, text)
    sendJson(res, ok ? 200 : 409, ok ? { ok: true } : { error: 'group is not active' })
    return
  }

  if (rest.length === 3 && rest[0] === 'groups' && method === 'POST' && GROUP_ACTIONS.has(rest[2] ?? '')) {
    const groupId = rest[1]!
    const action = rest[2]!
    if (action === 'pause') {
      sendJson(res, 200, await host.userPauseGroup(groupId, true))
    } else if (action === 'resume') {
      sendJson(res, 200, await host.userPauseGroup(groupId, false))
    } else if (action === 'archive') {
      sendJson(res, 200, await host.userArchiveGroup(groupId, true))
    } else if (action === 'restore') {
      sendJson(res, 200, await host.userArchiveGroup(groupId, false))
    } else if (action === 'duplicate') {
      const body = (await readJsonBody(req)) ?? {}
      sendJson(res, 200, await host.userDuplicateGroup(groupId, optionalString(body.name)))
    }
    return
  }

  if (rest.length === 2 && rest[0] === 'groups' && method === 'PATCH') {
    const body = (await readJsonBody(req)) ?? {}
    const patch: { name?: string; maxMembers?: number } = {}
    if (body.name !== undefined) patch.name = stringOf(body.name, 'name')
    if (body.maxMembers !== undefined) patch.maxMembers = Number(body.maxMembers)
    sendJson(res, 200, await host.userUpdateSettings(rest[1]!, patch))
    return
  }

  // ── V0.4: team configuration + runtimes ──────────────────────────────────

  if (rest.length === 1 && rest[0] === 'runtimes' && method === 'GET') {
    sendJson(res, 200, await host.runtimesView())
    return
  }

  if (rest.length === 3 && rest[0] === 'groups' && rest[2] === 'team-config' && method === 'GET') {
    const group = host.groups.requireGroup(rest[1]!)
    sendJson(res, 200, host.teamConfig(group))
    return
  }

  if (rest.length === 3 && rest[0] === 'groups' && rest[2] === 'team-config' && method === 'PUT') {
    const body = (await readJsonBody(req)) ?? {}
    sendJson(res, 200, await host.updateTeamConfig(rest[1]!, normalizeTeamConfig(body), 'User'))
    return
  }

  // ── notes / workspace ─────────────────────────────────────────────────────

  if (rest.length === 3 && rest[0] === 'groups' && rest[2] === 'notes' && method === 'GET') {
    const view = host.workspaceView(rest[1]!)
    sendJson(res, 200, { notes: view.notes ?? '', notesUpdatedAt: view.notesUpdatedAt })
    return
  }

  if (rest.length === 3 && rest[0] === 'groups' && rest[2] === 'notes' && method === 'PUT') {
    const body = (await readJsonBody(req)) ?? {}
    const notes = typeof body.notes === 'string' ? body.notes : ''
    sendJson(res, 200, await host.userUpdateNotes(rest[1]!, notes))
    return
  }

  if (rest.length === 3 && rest[0] === 'groups' && rest[2] === 'workspace' && method === 'GET') {
    sendJson(res, 200, host.workspaceView(rest[1]!))
    return
  }

  if (rest.length === 3 && rest[0] === 'groups' && rest[2] === 'leader-chat' && method === 'GET') {
    sendJson(res, 200, leaderChat(host, rest[1]!))
    return
  }

  // ── members ───────────────────────────────────────────────────────────────

  if (rest.length === 3 && rest[0] === 'groups' && rest[2] === 'members' && method === 'POST') {
    const body = (await readJsonBody(req)) ?? {}
    if (body.role !== undefined) {
      // V0.4: role-based member (Team Configuration decides the runtime config)
      const member = await host.userSpawnByRole(rest[1]!, {
        role: stringOf(body.role, 'role'),
        name: optionalString(body.name),
      })
      sendJson(res, 200, member)
      return
    }
    const member = await host.userSpawnMember(rest[1]!, {
      profileId: stringOf(body.profileId, 'profileId'),
      name: optionalString(body.name),
      displayRole: optionalString(body.displayRole),
    })
    sendJson(res, 200, member)
    return
  }

  if (rest.length === 4 && rest[0] === 'groups' && rest[2] === 'members' && method === 'PATCH') {
    const body = (await readJsonBody(req)) ?? {}
    const patch: { name?: string; displayRole?: string } = {}
    if (body.name !== undefined) patch.name = stringOf(body.name, 'name')
    if (body.displayRole !== undefined) patch.displayRole = optionalString(body.displayRole)
    const updated = await host.userPatchMember(rest[1]!, rest[3]!, patch)
    sendJson(res, 200, updated ?? { error: 'member not found' })
    return
  }

  if (rest.length === 4 && rest[0] === 'groups' && rest[2] === 'members' && method === 'DELETE') {
    await host.userRemoveMember(rest[1]!, rest[3]!)
    sendJson(res, 200, { ok: true })
    return
  }

  // ── tasks ─────────────────────────────────────────────────────────────────

  if (rest.length === 4 && rest[0] === 'groups' && rest[2] === 'tasks' && method === 'PATCH') {
    const body = (await readJsonBody(req)) ?? {}
    if (body.held !== undefined) {
      const held = body.held === true || body.held === 'true'
      sendJson(res, 200, await host.userHoldTask(rest[1]!, rest[3]!, held))
      return
    }
    const patch: Record<string, unknown> = {}
    for (const key of ['subject', 'description', 'priority', 'ownerId', 'assignedBy', 'workstreamId'] as const) {
      if (body[key] !== undefined) patch[key] = body[key]
    }
    if (body.tags !== undefined) patch.tags = Array.isArray(body.tags) ? body.tags.map(String) : optionalString(body.tags)?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
    if (body.blockedBy !== undefined) patch.blockedBy = Array.isArray(body.blockedBy) ? body.blockedBy.map(String) : optionalString(body.blockedBy)?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
    sendJson(res, 200, await host.userEditTask(rest[1]!, rest[3]!, patch))
    return
  }

  // ── channel messages: pin / reply ────────────────────────────────────────

  if (rest.length === 5 && rest[0] === 'groups' && rest[2] === 'messages' && rest[4] === 'pin' && method === 'POST') {
    const body = (await readJsonBody(req)) ?? {}
    const pinned = body.pinned === true || body.pinned === 'true'
    sendJson(res, 200, await host.userPinMessage(rest[1]!, rest[3]!, pinned))
    return
  }

  if (rest.length === 5 && rest[0] === 'groups' && rest[2] === 'messages' && rest[4] === 'reply' && method === 'POST') {
    const body = (await readJsonBody(req)) ?? {}
    const text = typeof body.text === 'string' ? body.text : ''
    if (text.trim() === '') {
      sendJson(res, 400, { error: 'text required' })
      return
    }
    const group = host.groups.requireGroup(rest[1]!)
    host.groups.assertMutable(group)
    sendJson(res, 200, await host.channel.post(group.groupId, {
      senderId: 'user',
      senderName: 'User',
      text,
      replyToMessageId: rest[3]!,
    }))
    return
  }

  if (rest.length === 3 && rest[0] === 'groups' && rest[2] === 'broadcast' && method === 'POST') {
    const body = (await readJsonBody(req)) ?? {}
    const text = typeof body.text === 'string' ? body.text : ''
    if (text.trim() === '') {
      sendJson(res, 400, { error: 'text required' })
      return
    }
    sendJson(res, 200, await host.userBroadcast(rest[1]!, text))
    return
  }

  // ── artifact preview ──────────────────────────────────────────────────────

  if (rest.length === 4 && rest[0] === 'groups' && rest[2] === 'artifacts' && rest[3] === 'read' && method === 'GET') {
    const path = url.searchParams.get('path') ?? ''
    sendJson(res, 200, host.artifactPreview(rest[1]!, path))
    return
  }

  sendJson(res, 404, { error: 'not found', path: rest.join('/') })
}

/** Leader Chat: every user↔leader private exchange of one group. */
function leaderChat(host: GroupHost, groupId: string): unknown[] {
  const group = host.groups.requireGroup(groupId)
  return host.privateMessages
    .listForGroup(group.groupId, group.leaderSessionId)
    .filter((m) => m.direction === 'user-to-leader' || m.direction === 'leader-to-user')
}


/** Coerce an inbound TeamConfig body into the durable shape. */
function normalizeTeamConfig(body: Record<string, unknown>): import('../core-types.js').TeamConfig {
  const roles = (def: unknown): Array<Record<string, unknown>> => (Array.isArray(def) ? def : []) as Array<Record<string, unknown>>
  const roleDef = (raw: unknown, fallbackId: string): import('../core-types.js').AgentRoleDefinition => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const id = optionalString(r.id) ?? fallbackId
    return {
      id,
      name: optionalString(r.name) ?? id,
      description: optionalString(r.description),
      runtime: optionalString(r.runtime) ?? 'deepseek-harness',
      profile: optionalString(r.profile),
      model: optionalString(r.model),
      reasoningLevel: optionalString(r.reasoningLevel),
      systemPrompt: optionalString(r.systemPrompt),
      maxInstances: optionalNumber(r.maxInstances),
      defaultInstances: optionalNumber(r.defaultInstances),
      tools: Array.isArray(r.tools) ? r.tools.map(String) : undefined,
      metadata: typeof r.metadata === 'object' && r.metadata !== null ? r.metadata as Record<string, unknown> : undefined,
    }
  }
  const leaderRaw = (typeof body.leaderRole === 'object' && body.leaderRole !== null ? body.leaderRole : {}) as Record<string, unknown>
  return {
    leaderRole: roleDef(leaderRaw, optionalString(leaderRaw.id) ?? 'leader'),
    memberRoles: roles(body.memberRoles).map((r, index) => roleDef(r, `role-${index + 1}`)),
  }
}

function stringOf(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`invalid argument "${name}"`)
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return String(value)
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function listOf(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean)
  return undefined
}

function streamEvents(req: IncomingMessage, res: ServerResponse, notifier: GroupNotifier, groupId: string | undefined): Promise<void> {
  return new Promise((resolve) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write('retry: 3000\n\n')
    const unsub = notifier.subscribe((update) => {
      if (groupId !== undefined && update.groupId !== groupId) return
      res.write(`event: update\ndata: ${JSON.stringify(update)}\n\n`)
    })
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n')
    }, 15000)
    req.on('close', () => {
      clearInterval(heartbeat)
      unsub()
      resolve()
    })
    req.on('error', () => {
      clearInterval(heartbeat)
      unsub()
      resolve()
    })
  })
}

// ── body / response helpers ─────────────────────────────────────────────────

const MAX_BODY = 512 * 1024

/** Whole-group POST commands under `/groups/:id/` (whitelist; siblings like
 * `members`/`broadcast` must fall through to their own route branches). */
const GROUP_ACTIONS = new Set(['pause', 'resume', 'archive', 'restore', 'duplicate'])

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    throw new Error('invalid JSON body')
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function decodePath(parts: string[]): string[] {
  return parts.map((part) => {
    try {
      return decodeURIComponent(part)
    } catch {
      return part
    }
  })
}
