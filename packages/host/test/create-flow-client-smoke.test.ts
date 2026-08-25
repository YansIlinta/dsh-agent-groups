import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const BASE = fileURLToPath(new URL('../src/native-client/index.js', import.meta.url))
const CREATE_FLOW = fileURLToPath(new URL('../src/native-client/create-flow.js', import.meta.url))

describe('Create Flow native client extension', () => {
  it('evaluates after the Agent Groups client and preserves the plugin apply contract', () => {
    const source = `${readFileSync(BASE, 'utf8')}\n${readFileSync(CREATE_FLOW, 'utf8')}`
    const noop = () => {}
    const sandbox = {
      React: {
        useState: () => [undefined, noop],
        useEffect: noop,
        useCallback: (fn: unknown) => fn,
        Fragment: Symbol('Fragment'),
        createElement: () => ({}),
      },
      primitives: { Button: 'Button', Input: 'Input', Modal: 'Modal', Pill: 'Pill' },
      module: { exports: {} as { apply?: (ctx: unknown) => void } },
      exports: {},
      console,
      Date,
      JSON,
      encodeURIComponent,
      setTimeout,
      clearTimeout,
      window: undefined,
      fetch: noop,
    }
    vm.createContext(sandbox)
    vm.runInContext(source, sandbox, { filename: 'native-client+create-flow.js' })
    expect(typeof sandbox.module.exports.apply).toBe('function')
    expect(() => sandbox.module.exports.apply?.({ get: () => undefined })).not.toThrow()
  })

  it('contains the production stages and wires all local media actions through the dynamic endpoint', () => {
    const source = readFileSync(CREATE_FLOW, 'utf8')
    for (const stage of ['topic', 'research', 'materials', 'script', 'voice', 'captions', 'render']) {
      expect(source).toContain(`'${stage}'`)
    }
    expect(source).toContain('/groups/api/create-flow/${encodeURIComponent(groupId)}/${kind}')
    expect(source).toContain("run('tts', payload)")
    expect(source).toContain("run('asr', payload)")
    expect(source).toContain("run('render', payload)")
  })
})
