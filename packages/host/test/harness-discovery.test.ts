/**
 * V0.4.1: host-side harness discovery unit tests — live-service wrapping with
 * fake llm/credentials/settings services. Verifies the narrow surface, the
 * credential status derivation (least-hardcoded settings entry point), and the
 * no-credential-values guarantee.
 */
import { describe, expect, it } from 'vitest'
import { HarnessDiscovery, type CredentialsServiceLike, type HarnessDiscoveryDeps, type LlmServiceLike, type SettingsServiceLike } from '../src/harness-discovery.js'

/** A secret VALUE that must never appear in any discovery output. */
const SECRET_MARKER = 'sk-super-secret-value'

function fakeLlm(): LlmServiceLike {
  return {
    listProviders: () => [
      { id: 'deepseek-official', name: 'DeepSeek' },
      { id: 'opencode-go', name: 'OpenCode Go' },
    ],
    listModels: async (provider) => provider === 'deepseek-official'
      ? [
          { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
          { provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        ]
      : [],
    resolveModelInfo: async (provider, model) => {
      if (provider === 'deepseek-official') {
        return {
          provider,
          id: model,
          name: model,
          reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' },
        }
      }
      if (provider === 'unknown-route') throw new Error('no such provider')
      return { provider, id: model, name: model } // no reasoning surface
    },
    listConfigurableProviders: () => [
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
      { provider: 'opencode-go', displayName: 'OpenCode Go', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode-go'] },
    ],
  }
}

/** Mirror SettingsProvider.describe({redactSecrets:true}): strip secret slots; the apiKeyEnv REFERENCE NAME stays. */
function redactedValue(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/secret/i.test(key) && key !== 'apiKey'))
}

function fakeSettings(secret = SECRET_MARKER): SettingsServiceLike & { redactionAsked: boolean[] } {
  const redactionAsked: boolean[] = []
  return {
    redactionAsked,
    describe: (options) => {
      redactionAsked.push(options?.redactSecrets === true)
      return [
        {
          ns: 'llm-deepseek',
          value: options?.redactSecrets === true
            ? redactedValue({ apiKeyEnv: 'DEEPSEEK_API_KEY', apiKey: secret })
            : { apiKeyEnv: 'DEEPSEEK_API_KEY', apiKey: secret },
        },
        {
          ns: 'llm-pi-ai',
          value: options?.redactSecrets === true
            ? redactedValue({ providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY', apiKey: secret } } })
            : { providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY', apiKey: secret } } },
        },
      ]
    },
  }
}

function fakeCredentials(): CredentialsServiceLike & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    describe: async (ref) => {
      asked.push(ref)
      if (ref === 'DEEPSEEK_API_KEY') return { configured: true, source: 'env', writable: false }
      return { configured: false, writable: true }
    },
  }
}

function makeDiscovery(extra: Partial<HarnessDiscoveryDeps> = {}): HarnessDiscovery {
  return new HarnessDiscovery({
    llm: fakeLlm(),
    credentials: fakeCredentials(),
    settings: fakeSettings(),
    ...extra,
  })
}

describe('V0.4.1: harness discovery', () => {
  it('lists live providers and per-provider models (no static arrays)', async () => {
    const d = makeDiscovery()
    expect(d.listProviders().map((p) => p.id)).toEqual(['deepseek-official', 'opencode-go'])
    const models = await d.listModels('deepseek-official')
    expect(models.map((m) => m.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(await d.listModels('opencode-go')).toEqual([]) // live result, not a fallback
  })

  it('resolves per-model reasoning efforts + default; absent reasoning surface → undefined', async () => {
    const d = makeDiscovery()
    const reasoning = await d.resolveReasoning('deepseek-official', 'deepseek-v4-flash')
    expect(reasoning?.efforts.map((e) => e.id)).toEqual(['high', 'max'])
    expect(reasoning?.defaultEffort).toBe('high')
    expect(reasoning?.efforts[0]?.name).toBe('High')
    // provider/model with no reasoning surface AND unknown routes both degrade
    expect(await d.resolveReasoning('opencode-go', 'x')).toBeUndefined()
    expect(await d.resolveReasoning('unknown-route', 'x')).toBeUndefined()
  })

  it('exposes configurable-provider settings entry points (least-hardcoded seam)', () => {
    const d = makeDiscovery()
    const entries = d.listConfigurableProviders()
    expect(entries.find((e) => e.provider === 'deepseek-official')).toMatchObject({ settingsNs: 'llm-deepseek', settingsPath: [] })
    expect(entries.find((e) => e.provider === 'opencode-go')).toMatchObject({ settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode-go'] })
  })

  it('credentialStatus derives the ref from the settings entry point and describes it — NEVER the value', async () => {
    const d = makeDiscovery()
    const deepseek = await d.credentialStatus('deepseek-official')
    expect(deepseek.configured).toBe(true)
    expect(deepseek.source).toBe('env')
    expect(deepseek.writable).toBe(false)
    expect(deepseek.settingsNs).toBe('llm-deepseek')
    expect(deepseek.settingsPath).toEqual([])
    expect(deepseek.credentialRef).toBe('DEEPSEEK_API_KEY')
    // profile-path entry (pi-ai per-provider profiles)
    const opencode = await d.credentialStatus('opencode-go')
    expect(opencode.credentialRef).toBe('OPENCODE_GO_API_KEY')
    expect(opencode.configured).toBe(false)
    // no settings entry → facts only
    const ghost = await d.credentialStatus('ghost-route')
    expect(ghost).toEqual({ provider: 'ghost-route' })
  })

  it('never leaks credential values into any discovery output', async () => {
    const settings = fakeSettings()
    const d = new HarnessDiscovery({ llm: fakeLlm(), credentials: fakeCredentials(), settings })
    const joined = JSON.stringify({
      providers: d.listProviders(),
      models: await d.listModels('deepseek-official'),
      reasoning: await d.resolveReasoning('deepseek-official', 'deepseek-v4-flash'),
      statuses: [
        await d.credentialStatus('deepseek-official'),
        await d.credentialStatus('opencode-go'),
      ],
    })
    expect(joined).not.toContain(SECRET_MARKER)
    // ... but the REFERENCE NAME (env-var id) is exposed, exactly like the
    // harness' own Models settings page (it is a label, not a secret).
    expect(joined).toContain('DEEPSEEK_API_KEY')
    // the secret-bearing path was stripped by asking for REDACTED descriptors
    expect(settings.redactionAsked).toHaveLength(2)
    expect(settings.redactionAsked.every((asked) => asked === true)).toBe(true)
  })

  it('degrades gracefully when harness services are absent (headless/tests)', async () => {
    const d = new HarnessDiscovery({})
    expect(d.listProviders()).toEqual([])
    expect(await d.listProviderIds()).toEqual([])
    expect(await d.listModels('x')).toEqual([])
    expect(await d.resolveReasoning('x', 'y')).toBeUndefined()
    expect(await d.listReasoningEfforts('x', 'y')).toBeUndefined()
    expect(await d.credentialStatus('x')).toEqual({ provider: 'x' })
    expect(d.listConfigurableProviders()).toEqual([])
  })

  it('narrow seam: listReasoningEfforts resolves defaults for unpinned roles; unknown caps → undefined', async () => {
    const d = makeDiscovery({ defaultSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) })
    // provider+model pinned → efforts from resolveModelInfo
    expect(await d.listReasoningEfforts('deepseek-official', 'deepseek-v4-flash')).toEqual(['high', 'max'])
    // unpinned role → default selection route
    expect(await d.listReasoningEfforts(undefined, undefined)).toEqual(['high', 'max'])
    // capabilities unknown → undefined (accept, runtime gates)
    expect(await d.listReasoningEfforts('opencode-go', 'x')).toBeUndefined()
  })
})
