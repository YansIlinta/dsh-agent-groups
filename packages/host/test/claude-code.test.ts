/**
 * Phase 4 tests: Claude Code runtime provider surface.
 */
import { describe, expect, it } from 'vitest'
import { ClaudeCodeRuntimeProvider } from '../src/runtime/claude-code.js'

describe('Phase 4: Claude Code Runtime', () => {
  it('is a symmetric AgentRuntimeProvider with provider-owned model catalog', () => {
    const provider = new ClaudeCodeRuntimeProvider({ binPath: '/fake/claude' })
    expect(provider.id).toBe('claude-code')
    expect(provider.name).toContain('Claude')
    expect(provider.listModels().length).toBeGreaterThan(0)
    expect(provider.getCapabilities().workspace).toBe(true)
    expect(provider.getCapabilities().interactiveSession).toBe(false)
  })
})
