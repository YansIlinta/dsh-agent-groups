/**
 * V0.4.1: native-client Role Editor smoke suite.
 *
 * The repo has NO DOM test infrastructure for the native client (plain
 * CommonJS/React-createElement — the repo standard is `node --check` on the
 * built bundle; see docs/role-editor-investigation.md Q7). This suite follows
 * the standalone VM-sandbox smoke the UI engineer ran during development
 * (evaluates the SOURCE with stubbed React/primitives) and folds it into the
 * vitest chain so `npm test` covers it: the pure Role Editor helpers
 * (wizardSteps / credentialFacts / providerIdOf) behave per the acceptance
 * criteria, the loader contract survives, and the source never contains
 * secret-material literals.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const CLIENT_SOURCE = fileURLToPath(new URL('../src/native-client/index.js', import.meta.url))

interface ClientHelpers {
  wizardSteps?: (runtime?: string, reasoning?: { efforts: Array<{ id: string }> }) => Array<{ id: string }>
  credentialFacts?: (cred: unknown) => Record<string, unknown>
  providerIdOf?: (entry: Record<string, unknown> | undefined) => unknown
  DSH_RUNTIME_ID?: string
}

interface ClientSandbox extends ClientHelpers {
  module: { exports: { apply?: (...args: unknown[]) => unknown } }
}

/** Evaluate the client SOURCE in a VM sandbox with stubbed React/primitives
 * (the environment promised by scripts/build-native-client.mjs's factory). */
function evaluateClient(): ClientSandbox {
  const source = readFileSync(CLIENT_SOURCE, 'utf8')
  const noop = () => {}
  const sandbox: ClientSandbox = {
    React: {
      useState: () => [undefined, noop],
      useEffect: noop,
      useCallback: (f: (...args: unknown[]) => unknown) => f,
      useRef: () => ({ current: null }),
      useMemo: (f: () => unknown) => f(),
      Fragment: Symbol('Fragment'),
      createElement: () => ({}),
    },
    primitives: { Button: 'Button', Input: 'Input', Modal: 'Modal', Pill: 'Pill' },
    module: { exports: {} },
    exports: {},
    console,
    Date,
    JSON,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    window: undefined,
  } as unknown as ClientSandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'native-client/index.js' })
  return sandbox
}

describe('V0.4.1: native client Role Editor helpers (VM sandbox, no DOM)', () => {
  it('evaluates against stubbed React/primitives and keeps the loader contract (module.exports.apply)', () => {
    const sandbox = evaluateClient()
    expect(typeof sandbox.module.exports.apply).toBe('function')
  })

  it('wizardSteps: DSH runtime with a reasoning-capable model → exact 8-step sequence', () => {
    const sandbox = evaluateClient()
    const reasoning = { efforts: [{ id: 'high', name: 'High', description: 'deep' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' }
    const full = sandbox.wizardSteps!('deepseek-harness', reasoning).map((s) => s.id)
    expect(full).toEqual(['name', 'runtime', 'provider', 'auth', 'model', 'reasoning', 'instructions', 'create'])
  })

  it('wizardSteps: model exposes NO reasoning efforts → Reasoning step hidden', () => {
    const sandbox = evaluateClient()
    const noEfforts = sandbox.wizardSteps!('deepseek-harness', { efforts: [] }).map((s) => s.id)
    expect(noEfforts).toEqual(['name', 'runtime', 'provider', 'auth', 'model', 'instructions', 'create'])
  })

  it('wizardSteps: no model selected yet (reasoning undefined) → no Reasoning step', () => {
    const sandbox = evaluateClient()
    const noModel = sandbox.wizardSteps!('deepseek-harness', undefined).map((s) => s.id)
    expect(noModel).not.toContain('reasoning')
  })

  it('wizardSteps: ACP runtime keeps current behavior (Name→Runtime→Instructions→Create)', () => {
    const sandbox = evaluateClient()
    const acp = sandbox.wizardSteps!('codex', undefined).map((s) => s.id)
    expect(acp).toEqual(['name', 'runtime', 'instructions', 'create'])
  })

  it('credentialFacts normalizes the flat ProviderCredentialStatus view', () => {
    const sandbox = evaluateClient()
    const flat = sandbox.credentialFacts!({ configured: true, source: 'env', writable: false, settingsNs: 'llm-deepseek', settingsPath: [], credentialRef: 'DEEPSEEK_API_KEY' })
    expect(flat.configured).toBe(true)
    expect(flat.source).toBe('env')
    expect(flat.credentialRef).toBe('DEEPSEEK_API_KEY')
    expect(flat.settingsNs).toBe('llm-deepseek')
  })

  it('credentialFacts normalizes the nested credential status (final contract entry)', () => {
    const sandbox = evaluateClient()
    const entry = sandbox.credentialFacts!({ settingsNs: 'llm-deepseek', credentialRef: 'DEEPSEEK_API_KEY', credential: { configured: false, source: 'env', writable: true } })
    expect(entry.configured).toBe(false)
    expect(entry.source).toBe('env')
    expect(entry.writable).toBe(true)
    expect(entry.settingsNs).toBe('llm-deepseek')
    expect(entry.credentialRef).toBe('DEEPSEEK_API_KEY')
  })

  it('credentialFacts normalizes the per-provider endpoint shape {provider, credential:{…}}', () => {
    const sandbox = evaluateClient()
    const endpoint = sandbox.credentialFacts!({ credential: { configured: true, source: 'env' } })
    expect(endpoint.configured).toBe(true)
    expect(endpoint.source).toBe('env')
    expect(endpoint.settingsNs).toBeUndefined()
  })

  it('credentialFacts tolerates absent input (never throws)', () => {
    const sandbox = evaluateClient()
    expect(Object.keys(sandbox.credentialFacts!(undefined)).length).toBe(0)
    expect(Object.keys(sandbox.credentialFacts!(null)).length).toBe(0)
  })

  it('credentialFacts normalizes the legacy entry (kind: settings) view', () => {
    const sandbox = evaluateClient()
    const legacy = sandbox.credentialFacts!({ configured: false, entry: { kind: 'settings', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode-go'], credentialRef: 'OPENAI_API_KEY' } })
    expect(legacy.configured).toBe(false)
    expect(legacy.settingsNs).toBe('llm-pi-ai')
    expect((legacy.settingsPath as string[]).join('/')).toBe('providers/opencode-go')
    expect(legacy.credentialRef).toBe('OPENAI_API_KEY')
  })

  it('providerIdOf reads id ?? provider across both view keys', () => {
    const sandbox = evaluateClient()
    expect(sandbox.providerIdOf!({ id: 'deepseek-official' })).toBe('deepseek-official')
    expect(sandbox.providerIdOf!({ provider: 'opencode-go' })).toBe('opencode-go')
    expect(sandbox.providerIdOf!({})).toBeUndefined()
  })

  it('source contains NO secret-material literals (values, not reference names)', () => {
    const source = readFileSync(CLIENT_SOURCE, 'utf8')
    // never a real key-shaped value, never an inline apiKey/api_key value
    expect(source).not.toMatch(/sk-[A-Za-z0-9]{10,}/)
    expect(source).not.toMatch(/apiKey\s*:\s*['"][^'"]+['"]/)
    expect(source).not.toMatch(/api_key\s*[:=]\s*['"][^'"]+['"]/)
    expect(source).not.toMatch(/['"]sk-['"]/)
    // the only durable storage the client writes is its own last-view key
    expect(source.match(/localStorage\.setItem/g)?.length ?? 0).toBeLessThanOrEqual(1)
  })
})
