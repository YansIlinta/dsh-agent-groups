/**
 * Runtime registry (V0.4): id → provider lookup. Register once at plugin
 * start; spawn paths resolve roles through this registry so external Coding
 * Agent runtimes stay decoupled from GroupHost and the tools.
 * @module @dsh-agent-groups/host
 */

import type { AgentRuntimeProvider } from './base.js'

/** Fail-fast runtime errors, mapped to GroupError codes by GroupHost. */
export class RuntimeError extends Error {
  readonly code: 'UNAVAILABLE' | 'MODEL' | 'REASONING' | 'SPAWN'
  constructor(code: RuntimeError['code'], message: string) {
    super(message)
    this.name = 'RuntimeError'
    this.code = code
  }
}

export class RuntimeRegistry {
  private readonly providers = new Map<string, AgentRuntimeProvider>()

  register(provider: AgentRuntimeProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`runtime provider "${provider.id}" already registered`)
    }
    this.providers.set(provider.id, provider)
  }

  get(id: string): AgentRuntimeProvider | undefined {
    return this.providers.get(id)
  }

  require(id: string): AgentRuntimeProvider {
    const provider = this.providers.get(id)
    if (provider === undefined) {
      throw new RuntimeError('UNAVAILABLE', `runtime "${id}" is not registered on this host`)
    }
    return provider
  }

  list(): AgentRuntimeProvider[] {
    return [...this.providers.values()]
  }

  async assertUsable(id: string): Promise<AgentRuntimeProvider> {
    const provider = this.require(id)
    const available = await provider.isAvailable()
    if (!available) {
      throw new RuntimeError('UNAVAILABLE', `the ${provider.name} runtime is not available on this host (not configured / not installed)`)
    }
    return provider
  }
}