// End-to-end durability verification: open the agent-groups domain over the
// REAL storage stack (the same cordis plugins the dsh web profile mounts),
// write a synthetic group record, close, reopen in a fresh app, read it back.
// Uses the installed `@dsh-agent-groups/host` package from the web profile.
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HOME = homedir()
const ROOT = process.env.DSH_STORAGE_ROOT ?? join(HOME, '.dsh', 'storages')
const PROFILE_MODULES = join(HOME, '.dsh', 'profiles', 'node_modules')
const require = createRequire(pathToFileURL(join(PROFILE_MODULES, 'anchor.js')).href)

const [{ Context }, { default: Storage }, storageJson, storageDomain] = await Promise.all([
  import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href),
  import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage')).href),
  import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage-json')).href),
  import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage-domain')).href),
])
const { AGENT_GROUPS_DOMAIN } = await import(
  pathToFileURL(join(PROFILE_MODULES, '@dsh-agent-groups', 'host', 'lib', 'persistence.js')).href,
)

async function boot() {
  const ctx = new Context()
  ctx.plugin(Storage)
  ctx.plugin(storageJson, { root: ROOT })
  ctx.plugin(storageDomain, { backend: 'json' })
  await ctx.fiber.await()
  // The domain form mounts on the hub from a nested inject fiber; poll for it.
  for (let i = 0; i < 40; i++) {
    try {
      ctx.storage.domain // throws `form-not-mounted` until the form activates
      return ctx
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error('[durability] domain form never mounted')
}

const GROUP_ID = 'durability-check-group'
const record = {
  groupId: GROUP_ID,
  name: 'Durability Check',
  status: 'active',
  leaderSessionId: 'lead-check',
  mission: {
    objective: 'verify durable state across reloads',
    constraints: [],
    deliverables: ['proof'],
    acceptanceCriteria: ['record readable after reopen'],
    risks: [],
  },
  workstreams: [],
  createdAt: Date.now(),
}

let ctx = await boot()
let facility = ctx.storage.domain
let domain = await facility.open(AGENT_GROUPS_DOMAIN)
await domain.table('groups').put(GROUP_ID, record)
console.log('[durability] wrote group record into', ROOT)

// ← simulated process reload: fresh context, fresh facility, same files
ctx = await boot()
facility = ctx.storage.domain
domain = await facility.open(AGENT_GROUPS_DOMAIN)
const readBack = domain.table('groups').get(GROUP_ID)
if (!readBack) throw new Error('[durability] FAILED: record lost after reload')
console.log('[durability] reloaded record:', readBack.name, '/', readBack.mission.objective)
await domain.table('groups').delete(GROUP_ID)
console.log('[durability] test record cleaned up')
console.log('[durability] OK — durable state survives a full process reload')