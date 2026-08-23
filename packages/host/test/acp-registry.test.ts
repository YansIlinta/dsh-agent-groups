import { describe, expect, it } from 'vitest'
import { loadACPRegistryDefinitions } from '../src/runtime/acp-registry.js'

const registry = JSON.stringify({
  version: '1.0.0',
  agents: [
    { id: 'safe-agent', name: 'Safe Agent', version: '1.2.3', description: 'test agent', distribution: { npx: { package: '@example/safe-agent@1.2.3', args: ['--acp'], env: { DISABLE_UPDATE: '1' } } } },
    { id: 'binary-only', name: 'Binary Agent', version: '1.0.0', distribution: { binary: {} } },
  ],
})

describe('ACP Registry profile discovery', () => {
  it('materializes only explicitly allowlisted, pinned npx agents', () => {
    expect(loadACPRegistryDefinitions(registry, [])).toEqual([])
    expect(loadACPRegistryDefinitions(registry, ['safe-agent'])).toEqual([expect.objectContaining({
      id: 'acp-registry:safe-agent',
      args: ['-y', '@example/safe-agent@1.2.3', '--acp'],
      source: 'registry',
    })])
  })

  it('rejects missing/unsupported and option-shaped packages', () => {
    expect(() => loadACPRegistryDefinitions(registry, ['binary-only'])).toThrow('unsupported')
    const unsafe = JSON.stringify({ agents: [{ id: 'bad', name: 'Bad', version: '1', distribution: { npx: { package: '--exec=oops' } } }] })
    expect(() => loadACPRegistryDefinitions(unsafe, ['bad'])).toThrow('unsafe npx package')
    const unpinned = JSON.stringify({ agents: [{ id: 'latest', name: 'Latest', version: '1.2.3', distribution: { npx: { package: 'latest-agent' } } }] })
    expect(() => loadACPRegistryDefinitions(unpinned, ['latest'])).toThrow('unpinned npx package')
  })
})
