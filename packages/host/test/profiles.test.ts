import { describe, expect, it } from 'vitest'
import { makeHarness } from './helpers.js'

describe('profile registry', () => {
  it('ships the five built-in profiles with capability metadata', async () => {
    const h = makeHarness()
    const profiles = h.profiles.list()
    const ids = profiles.map((p) => p.id)
    expect(ids).toEqual(expect.arrayContaining(['product-planner', 'frontend-engineer', 'implementation-engineer', 'reviewer', 'acceptance-agent']))
    for (const profile of profiles) {
      expect(profile.capabilities.length).toBeGreaterThan(0)
      expect(profile.description.length).toBeGreaterThan(0)
    }
  })

  it('supports register / get / remove against the durable table', async () => {
    const h = makeHarness()
    await h.profiles.register({
      id: 'data-engineer',
      name: 'Data Engineer',
      description: 'Pipeline specialist',
      capabilities: ['python', 'sql'],
    })
    expect(h.profiles.get('data-engineer')?.name).toBe('Data Engineer')
    const removed = await h.profiles.remove('data-engineer')
    expect(removed).toBe(true)
    expect(h.profiles.get('data-engineer')).toBeUndefined()
  })

  it('requires an existing profile before materialization', async () => {
    const h = makeHarness()
    expect(() => h.profiles.require('nope')).toThrow()
  })
})
