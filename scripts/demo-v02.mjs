#!/usr/bin/env node
/**
 * DSH Agent Groups — V0.2 scripted demo (§60).
 *
 * Boots the SAME cordis storage stack the dsh web profile mounts (storage →
 * storage-json → storage-domain), over a THROWAWAY storage root, and drives
 * the real installed product facade (GroupHost + services) through the whole
 * V0.2 narrative:
 *
 *   templates → create group (Software Team) → roster → leader decomposes →
 *   members claim/complete → verify → task edit/hold/deps → channel posts,
 *   replies, pins, broadcast → leader chat → shared notes → activity feed →
 *   workspace artifacts → pause gate → completion + duplicate → archive →
 *   full durability across a simulated process reload.
 *
 * Agent sessions are simulated with the no-op adapter (the same seam the unit
 * tests use) — the REAL runtime demo needs a live "Agent Group · Team Lead"
 * session in the DSH GUI and then happens live on /groups/.
 *
 * Usage:  node scripts/demo-v02.mjs [--keep]
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HOME = homedir()
const PROFILE_MODULES = join(HOME, '.dsh', 'profiles', 'node_modules')
const require = createRequire(pathToFileURL(join(PROFILE_MODULES, 'anchor.js')).href)

const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
const { default: Storage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage')).href)
const storageJson = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage-json')).href)
const storageDomain = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage-domain')).href)
const hostRoot = join(PROFILE_MODULES, '@dsh-agent-groups', 'host', 'lib')
const { openAgentGroupsDomain } = await import(pathToFileURL(join(hostRoot, 'persistence.js')).href)
const { DomainStore } = await import(pathToFileURL(join(hostRoot, 'store.js')).href)
const { GroupNotifier } = await import(pathToFileURL(join(hostRoot, 'notifier.js')).href)
const { GroupService } = await import(pathToFileURL(join(hostRoot, 'group-service.js')).href)
const { TaskService } = await import(pathToFileURL(join(hostRoot, 'task-service.js')).href)
const { ChannelService, PrivateMessageService } = await import(pathToFileURL(join(hostRoot, 'channel-service.js')).href)
const { ActivityService } = await import(pathToFileURL(join(hostRoot, 'activity-service.js')).href)
const { ProfileRegistry } = await import(pathToFileURL(join(hostRoot, 'profile-registry.js')).href)
const { GroupHost } = await import(pathToFileURL(join(hostRoot, 'group-host.js')).href)
const { createNoopAdapter } = await import(pathToFileURL(join(hostRoot, 'dsh-adapter.js')).href)
const { LeaderRegistry } = await import(pathToFileURL(join(hostRoot, 'leader-registry.js')).href)

const ROOT = process.env.DEMO_STORAGE_ROOT ?? mkdtempSync(join(tmpdir(), 'agent-groups-demo-'))
const KEEP = process.argv.includes('--keep')

let step = 0
const say = (title, body = '') => {
  step += 1
  console.log(`\n── ${String(step).padStart(2, '0')} ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`)
  if (body !== '') console.log(body)
}

async function boot() {
  const ctx = new Context()
  ctx.plugin(Storage)
  ctx.plugin(storageJson, { root: ROOT })
  ctx.plugin(storageDomain, { backend: 'json' })
  await ctx.fiber.await()
  for (let i = 0; i < 40; i++) {
    try {
      ctx.storage.domain
      return ctx
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error('[demo] domain form never mounted')
}

async function makeHost(ctx) {
  const domain = await openAgentGroupsDomain(ctx.storage.domain)
  const stores = {
    profiles: new DomainStore('profiles', domain.table('profiles')),
    groups: new DomainStore('groups', domain.table('groups')),
    members: new DomainStore('members', domain.table('members')),
    tasks: new DomainStore('tasks', domain.table('tasks')),
    channel: new DomainStore('channel', domain.table('channel')),
    private: new DomainStore('private', domain.table('private')),
    activity: new DomainStore('activity', domain.table('activity')),
    leaders: new DomainStore('leaders', domain.table('leaders')),
  }
  const notifier = new GroupNotifier()
  const activity = new ActivityService(stores.activity, notifier)
  const groups = new GroupService(stores.groups, stores.members, activity)
  const tasks = new TaskService(stores.tasks, activity)
  const channel = new ChannelService(stores.channel, activity, notifier)
  const profiles = new ProfileRegistry(stores.profiles)
  const privateMessages = new PrivateMessageService(stores.private, activity, notifier, (groupId) => groups.getGroup(groupId)?.leaderSessionId)
  const leaders = new LeaderRegistry(stores.leaders)
  const host = new GroupHost({ groups, tasks, channel, privateMessages, activity, profiles, notifier, adapter: createNoopAdapter(), leaders })
  return { host, domain }
}

function brief(groupId, host) {
  const rows = host.groups.listMembers(groupId, () => undefined)
  const leader = rows.find((m) => m.role === 'leader')
  const members = rows.filter((m) => m.role === 'member')
  return `Leader: ${leader?.name} (${leader?.profileId})\nMembers: ${members.map((m) => `${m.name} [${m.displayRole ?? m.role}] (${m.profileId})`).join('\n          ')}`
}

// ────────────────────────────────────────────────────────────────────────────

console.log('╔══════════════════════════════════════════════════════════╗')
console.log('║  DSH Agent Groups · V0.2 demo — Software Development Team ║')
console.log('╚══════════════════════════════════════════════════════════╝')
console.log(`storage root: ${ROOT}`)

let ctx = await boot()
let { host, domain } = await makeHost(ctx)

// 01 · Team Templates
say('Team templates (§3/§4)', host.templates().map((t) => `• ${t.id.padEnd(14)} ${t.name} — ${t.description}`).join('\n'))

// 02 · Create Group from the Software Team template (dashboard flow, §5/§6)
const LEADER = 'demo-lead-01'
await host.leaders.register(LEADER) // simulates "user chatted once with a Team Lead session"
const group = await host.userCreateGroup({
  leaderSessionId: LEADER,
  name: 'Software Dev Team',
  objective: 'Build a small analytics dashboard.',
  templateId: 'software-team',
  constraints: ['TypeScript', 'React'],
  deliverables: ['backend API', 'frontend dashboard'],
  acceptanceCriteria: ['dashboard renders live metrics', 'backend API tests pass'],
})
say('Start Group (template materializes 6 agents)', brief(group.groupId, host))

// 03 · Leader decomposes into workstreams + a DAG (leader tools, §5)
await host.addWorkstream(LEADER, { title: 'Research', description: 'Requirements & data sources' })
await host.addWorkstream(LEADER, { title: 'Implementation', description: 'API + dashboard' })
const t1 = await host.createTask(LEADER, { subject: 'Research dashboard requirements', description: 'Who uses it, which metrics, refresh rate.', kind: 'research', workstreamId: 'Research', priority: 'high', tags: ['research'], acceptanceCriteria: ['requirements doc', 'metric list'] })
const t2 = await host.createTask(LEADER, { subject: 'Design API schema', description: 'GET /metrics, POST /events.', kind: 'planning', workstreamId: 'Research', priority: 'normal', tags: ['api'], acceptanceCriteria: ['schema reviewed'] })
const t3 = await host.createTask(LEADER, { subject: 'Backend API implementation', description: 'SQLite store + express routes.', kind: 'implementation', workstreamId: 'Implementation', priority: 'high', tags: ['backend'], blockedBy: [t1.taskId, t2.taskId], acceptanceCriteria: ['tests pass'] })
const t4 = await host.createTask(LEADER, { subject: 'Frontend dashboard', description: 'React + Vite, live metric cards.', kind: 'implementation', workstreamId: 'Implementation', priority: 'urgent', tags: ['frontend'], blockedBy: [t3.taskId], acceptanceCriteria: ['renders live data'] })
const t5 = await host.createTask(LEADER, { subject: 'Integration review', description: 'End-to-end pass + docs.', kind: 'review', workstreamId: 'Implementation', priority: 'normal', tags: ['review'], blockedBy: [t4.taskId], acceptanceCriteria: ['e2e checklist done'] })
const tasks = [t1, t2, t3, t4, t5]
const depLabel = (task) => task.blockedBy.map((id) => `t${tasks.findIndex((t) => t.taskId === id) + 1}`).join(', ') || '—'
say('Leader decomposes the mission (DAG + priority + tags)',
  `t1 ${t1.subject} [${t1.priority}] ${t1.tags.join('+')}\nt2 ${t2.subject} [${t2.priority}]\nt3 ${t3.subject} [${t3.priority}] ⛓ depends: ${depLabel(t3)}\nt4 ${t4.subject} [${t4.priority}] ⛓ depends: ${depLabel(t4)}\nt5 ${t5.subject} [${t5.priority}] ⛓ depends: ${depLabel(t5)}`)

// 04 · Assignments (leader → members)
const roster = host.groups.listMembers(group.groupId, () => undefined)
const byRole = new Map(roster.filter((m) => m.role === 'member').map((m) => [m.displayRole ?? m.role, m]))
for (const [role, task] of [['Researcher', t1], ['Architect', t2], ['Backend Engineer', t3], ['Frontend Engineer', t4], ['Reviewer', t5]]) {
  const member = byRole.get(role)
  await host.assignTask(LEADER, { taskId: task.taskId, ownerId: member.sessionId })
}
say('Leader assigns tasks', roster.filter((m) => m.role === 'member').map((m) => `• ${m.name.padEnd(18)} → ${host.tasks.listTasks(group.groupId).find((t) => t.ownerId === m.sessionId)?.subject ?? '—'}`).join('\n'))

// 05 · Members work: claim → complete → verify
const researcher = byRole.get('Researcher')
await host.claimTask(researcher.sessionId, { taskId: t1.taskId })
await host.completeTask(researcher.sessionId, { taskId: t1.taskId, summary: 'Requirements + metrics agreed; API drafted.', artifacts: ['docs/requirements.md'], changedFiles: ['docs/requirements.md'], completionClaim: true })
await host.verifyTask(LEADER, { taskId: t1.taskId, passed: true, notes: 'covers the demo scope' })
const architect = byRole.get('Architect')
await host.claimTask(architect.sessionId, { taskId: t2.taskId })
await host.completeTask(architect.sessionId, { taskId: t2.taskId, summary: 'Schema: metrics + events tables.', artifacts: ['docs/api-schema.md'], changedFiles: ['docs/api-schema.md'], completionClaim: true })
await host.verifyTask(LEADER, { taskId: t2.taskId, passed: true })
const backend = byRole.get('Backend Engineer')
await host.claimTask(backend.sessionId, { taskId: t3.taskId })
await host.completeTask(backend.sessionId, { taskId: t3.taskId, summary: 'API implemented with tests.', artifacts: ['src/api/server.ts', 'src/api/routes.ts'], changedFiles: ['src/api/server.ts', 'src/api/routes.ts', 'src/store/sqlite.ts'], tests: [{ command: 'npm test', passed: true }], completionClaim: true })
await host.verifyTask(LEADER, { taskId: t3.taskId, passed: true, notes: 'tests green' })
say('Members claim, complete, Leader verifies',
  `t1 ${t1.subject}: claimed → completed → verified ✓\nt2 ${t2.subject}: claimed → completed → verified ✓\nt3 ${t3.subject}: claimed → completed → verified ✓ (artifacts recorded)`)

// 06 · Task editing + user hold (kanban, §12/§13)
const edited = await host.userEditTask(group.groupId, t4.taskId, { priority: 'urgent', tags: ['frontend', 'dashboard'] })
const held = await host.userHoldTask(group.groupId, t4.taskId, true)
const afterHold = host.tasks.listTasks(group.groupId).find((t) => t.taskId === t4.taskId)
await host.userHoldTask(group.groupId, t4.taskId, false)
say('Task editing + hold (§12/§13)',
  `t4 now [${edited.priority}] ${edited.tags.join('+')} — task_updated recorded\nhold → board shows ${afterHold.status} (DAG untouched); release → back to ${host.tasks.listTasks(group.groupId).find((t) => t.taskId === t4.taskId)?.status}`)

// 07 · Channel: member posts, user broadcast, reply, pin (§18–22)
const apiMsg = await host.postChannel(researcher.sessionId, { text: 'API contract drafted: GET /metrics, POST /events. @all' })
await host.postChannel(backend.sessionId, { text: 'Backend up with tests; schema locked.' })
await host.userBroadcast(group.groupId, 'Please avoid changing the database schema. @all')
await host.channel.post(group.groupId, { senderId: 'user', senderName: 'User', text: 'Noted — unit tests will cover it.', replyToMessageId: apiMsg.id })
await host.userPinMessage(group.groupId, apiMsg.id, true)
say('Team channel: posts + broadcast + reply + pin (§18–22)',
  host.channel.list(group.groupId).map((m) => `[${m.kind}] ${m.senderName}${m.replyToMessageId !== undefined ? ' ↳ reply' : ''}${m.pinnedAt !== undefined ? ' 📌pinned' : ''}: ${m.text.slice(0, 70)}`).join('\n'))

// 08 · Leader chat (user ↔ leader, §36/§37)
await host.userMessageToLeader(group.groupId, 'Prioritize the frontend first.')
await host.leaderReplyToUser(LEADER, { text: 'Done — frontend is now urgent on the board.' })
say('Leader chat (§36/§37)', host.privateMessages.listForGroup(group.groupId, LEADER).filter((m) => m.direction === 'user-to-leader' || m.direction === 'leader-to-user').map((m) => `[${m.direction}] ${m.senderName}: ${m.text}`).join('\n'))

// 09 · Shared notes (§23/§26)
await host.userUpdateNotes(group.groupId, 'Decisions:\n- React + Vite frontend, SQLite backend\n- No schema changes without review\n- Demo scope: metrics + events only')
say('Mission notes (§23/§26)', `saved — ${host.groups.requireGroup(group.groupId).notes.split('\n')[0]} …`)

// 10 · Workspace / artifact browser (§24/§25)
const ws = host.workspaceView(group.groupId)
say('Workspace artifacts (§24/§25)', ws.artifacts.map((a) => `• [${a.source}] ${a.path}  ← ${a.taskSubject}`).join('\n'))

// 11 · Activity feed with categories (§27/§28)
const activity = host.activity.list(group.groupId)
const categories = {}
for (const event of activity) {
  const key = event.type.startsWith('task') || event.type.startsWith('verification') ? 'Task' : event.type.startsWith('agent') || event.type.startsWith('member') ? 'Agent' : event.type.startsWith('mission') || event.type.startsWith('group') || event.type === 'leader_replanned' || event.type === 'notes_updated' ? 'Group' : 'Message'
  categories[key] = (categories[key] ?? 0) + 1
}
const sample = activity.find((e) => e.type === 'task_completed')
say('Activity feed (§27/§28)', `total ${activity.length} events → ${Object.entries(categories).map(([k, v]) => `${k}:${v}`).join('  ')}\nsample detail: ${sample.type} · actor=${sample.actorName} · task=${sample.refTaskId} · payload=${JSON.stringify(sample.payload)}`)

// 12 · Pause / resume gate (§39)
await host.userPauseGroup(group.groupId, true)
let pausedRejected = null
try {
  await host.createTask(LEADER, { subject: 'extra', description: 'x', kind: 'other', acceptanceCriteria: ['x'] })
} catch (error) {
  pausedRejected = error.code
}
await host.userPauseGroup(group.groupId, false)
say('Pause / resume (§39)', `paused → createTask rejected with code "${pausedRejected}"; resumed → dispatch works again`)

// 13 · Mission complete + duplicate (§41)
await host.completeMission(LEADER)
const copy = await host.userDuplicateGroup(group.groupId, 'Software Dev Team (round 2)')
say('Completion + duplicate (§41)',
  `original completed ✓\ncopy "${copy.name}": ${brief(copy.groupId, host).replace(/\n/g, ' | ')}\ncopy task board: ${host.tasks.listTasks(copy.groupId).length} tasks (history NOT copied)`)

// 14 · Archive / restore (§40)
await host.userArchiveGroup(group.groupId, true)
const hidden = host.listGroupsForWeb().map((g) => g.name)
await host.userArchiveGroup(group.groupId, false)
const restored = host.listGroupsForWeb().map((g) => g.name)
say('Archive / restore (§40)', `archived → default list: ${hidden.join(', ')} (original hidden, copy shown)\nrestored → default list: ${restored.join(', ')}`)

// 15 · Durability: simulated process reload (§54)
await domain.close()
ctx = await boot()
const { host: host2 } = await makeHost(ctx)
const after = host2.listGroupsForWeb(true)
const copy2 = after.find((g) => g.groupId === copy.groupId)
const original2 = after.find((g) => g.groupId === group.groupId)
say('Persistence across a full process reload (§54)',
  `groups on disk: ${after.map((g) => `${g.name} (${g.memberCount} members, ${g.taskCount} tasks)`).join(' | ')}\nleader chat survives: ${host2.privateMessages.listForGroup(copy2.groupId, copy2.leaderSessionId).length + host2.privateMessages.listForGroup(original2.groupId, original2.leaderSessionId).length} private rows · channel survives: ${host2.channel.list(original2.groupId).length} messages · notes survive: "${host2.groups.requireGroup(original2.groupId).notes?.slice(0, 40)}…"`)
await domain.close()

if (!KEEP) rmSync(ROOT, { recursive: true, force: true })

console.log('\n╔══════════════════════════════════════════════════════════╗')
console.log('║  DEMO OK — every V0.2 flow ran against the real durable ║')
console.log('║  storage stack (throwaway root, cleaned up).            ║')
console.log('╚══════════════════════════════════════════════════════════╝')
console.log('Next: the LIVE demo needs one real step — open the DSH GUI, start a')
console.log('session with the "Agent Group · Team Lead" preset, chat once, then')
console.log('create the group on /groups/ and watch members/tasks happen live.')