// Append (or no-op if already present) an `- insert:` patch entry to a DSH
// profile's cordis.patch.yml. Uses the exact `yaml` implementation the DSH
// loader uses (resolved from the local dsh install) so serialization stays
// byte-compatible with the loader's own round-trip.
//
// Usage: node scripts/patch-profile.mjs <patchFile> <id> <name>
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [, , patchFile, id = 'agent-groups', name = '@dsh-agent-groups/host'] = process.argv

if (!patchFile) {
  console.error('usage: patch-profile.mjs <patchFile> [id] [name]')
  process.exit(2)
}

const require = createRequire(import.meta.url)

function resolveYaml() {
  const candidates = [
    join(homedir(), '.dsh', 'node_modules', 'yaml'),
    '/home/ubuntu/.nvm/versions/node/v22.23.1/lib/node_modules/@deepseek-ai/dsh/node_modules/yaml',
  ]
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch {
      // continue
    }
  }
  throw new Error('could not resolve the yaml package (needs a local dsh install)')
}

const YAML = resolveYaml()

let text = readFileSync(patchFile, 'utf8').trim()

// Idempotency: skip when our row is already present.
if (text.includes(`id: ${id}`) || text.includes(`name: ${name}`)) {
  console.log(`[agent-groups] ${id} already patched into ${patchFile}`)
  process.exit(0)
}

// Parse into a plain array (the "top-level YAML array of patch entries").
let entries = []
try {
  const parsed = YAML.parse(text)
  entries = Array.isArray(parsed) ? parsed : parsed === undefined || parsed === null ? [] : [parsed]
} catch (error) {
  console.error(`[agent-groups] cannot parse ${patchFile} as YAML (${error}); append the fragment manually:`)
  console.error(`- insert:\n    - id: ${id}\n      name: ${name}`)
  process.exit(1)
}

entries.push({ insert: [{ id, name }] })
writeFileSync(patchFile, `${YAML.stringify(entries)}`, 'utf8')
console.log(`[agent-groups] patched ${id} into ${patchFile}`)
