import type { ACPAgentDefinition } from './acp.js'

type ObjectValue = Record<string, unknown>

function object(value: unknown): ObjectValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ObjectValue : undefined
}

/**
 * Convert explicitly selected ACP Registry entries into pinned npx profiles.
 * Registry metadata is discovery data, not ambient authority: nothing is
 * executable unless its id appears in the caller-owned allowlist.
 */
export function loadACPRegistryDefinitions(json: string | undefined, allowlist: readonly string[]): ACPAgentDefinition[] {
  if (json === undefined || json.trim() === '' || allowlist.length === 0) return []
  const root = object(JSON.parse(json))
  if (root === undefined || !Array.isArray(root.agents)) throw new Error('ACP registry document requires an agents array')
  const selected = new Set(allowlist)
  const definitions: ACPAgentDefinition[] = []
  for (const raw of root.agents) {
    const agent = object(raw)
    if (agent === undefined || typeof agent.id !== 'string' || !selected.has(agent.id)) continue
    if (typeof agent.name !== 'string' || typeof agent.version !== 'string') throw new Error(`invalid ACP registry entry: ${agent.id}`)
    const npx = object(object(agent.distribution)?.npx)
    if (npx === undefined || typeof npx.package !== 'string') continue
    if (npx.package.startsWith('-') || !/^[A-Za-z0-9@._/+~-]+$/.test(npx.package)) {
      throw new Error(`unsafe npx package in ACP registry entry: ${agent.id}`)
    }
    if (!npx.package.endsWith(`@${agent.version}`)) {
      throw new Error(`unpinned npx package in ACP registry entry: ${agent.id}`)
    }
    const args = npx.args === undefined ? [] : npx.args
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw new Error(`invalid npx args in ACP registry entry: ${agent.id}`)
    const envObject = npx.env === undefined ? undefined : object(npx.env)
    if (npx.env !== undefined && (envObject === undefined || !Object.values(envObject).every((value) => typeof value === 'string'))) {
      throw new Error(`invalid npx env in ACP registry entry: ${agent.id}`)
    }
    definitions.push({
      id: `acp-registry:${agent.id}`,
      name: `${agent.name} (ACP Registry)`,
      description: typeof agent.description === 'string' ? agent.description : `ACP Registry ${agent.id}@${agent.version}`,
      command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      args: ['-y', npx.package, ...args],
      env: envObject as Record<string, string> | undefined,
      source: 'registry',
    })
  }
  const found = new Set(definitions.map((definition) => definition.id.slice('acp-registry:'.length)))
  const missing = allowlist.filter((id) => !found.has(id))
  if (missing.length > 0) throw new Error(`ACP registry agents unavailable or unsupported (npx required): ${missing.join(', ')}`)
  return definitions
}

export function loadConfiguredACPRegistryDefinitions(
  json = process.env.AGENT_GROUPS_ACP_REGISTRY_JSON,
  ids = process.env.AGENT_GROUPS_ACP_REGISTRY_AGENTS,
): ACPAgentDefinition[] {
  const allowlist = ids?.split(',').map((id) => id.trim()).filter(Boolean) ?? []
  return loadACPRegistryDefinitions(json, allowlist)
}
