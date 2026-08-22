/**
 * DeepSeek Harness runtime provider (V0.4): the tenant of the existing DSH
 * agent factory. All DSH member creation funnels through this provider (the
 * leader tools no longer scatter spawn logic around GroupHost). The provider
 * is a thin tenant over `AgentRuntimeAdapter` — same engine, role-configured
 * model / reasoning added on top.
 * @module @dsh-agent-groups/host
 */

import { textContent } from '../group-host.js'
import { groupMessageSource } from '../message-source.js'
import type { AgentRuntimeAdapter } from '../dsh-adapter.js'
import { DEFAULT_REASONING_LEVELS, type AgentRuntimeProvider, type ModelDescriptor, type RuntimeAgentConfig, type RuntimeAgentHandle, type RuntimeCapabilities } from './base.js'

export interface DshDefaultModelSource {
  currentSelection(): { provider?: string; model?: string }
}

const CAPABILITIES: RuntimeCapabilities = {
  models: true,
  reasoningLevels: true,
  interactiveSession: true,
  workspace: true,
  toolControl: false,
  streaming: true,
}

export class DeepSeekHarnessRuntimeProvider implements AgentRuntimeProvider {
  readonly id = 'deepseek-harness'
  readonly name = 'DeepSeek Harness'
  readonly description = 'Native DSH agents (group-member preset): durable sessions, group tools, channel + leader reports.'

  constructor(
    private readonly adapter: AgentRuntimeAdapter,
    private readonly defaultModel: DshDefaultModelSource,
  ) {}

  isAvailable(): boolean {
    // The noop adapter only exists for tests/headless; production mounts the
    // real DSH adapter, so a healthy runtime is available.
    return this.adapter.kind === 'dsh'
  }

  getCapabilities(): RuntimeCapabilities {
    return CAPABILITIES
  }

  listModels(): readonly ModelDescriptor[] {
    const selection = this.defaultModel.currentSelection()
    if (selection.model === undefined) return []
    return [{ id: selection.model, name: `${selection.provider ?? 'default'} / ${selection.model}` }]
  }

  listReasoningLevels(): readonly import('./base.js').ReasoningOption[] {
    return DEFAULT_REASONING_LEVELS
  }

  async spawnAgent(config: RuntimeAgentConfig): Promise<RuntimeAgentHandle> {
    const selection = this.defaultModel.currentSelection()
    await this.adapter.createMemberAgent({
      sessionId: config.agentId,
      parentId: config.parentMemberId ?? '',
      cwd: config.workspace,
      provider: typeof config.metadata?.provider === 'string' ? config.metadata.provider : selection.provider,
      model: config.model ?? selection.model,
      reasoningLevel: config.reasoningLevel,
    })
    return {
      agentId: config.agentId,
      runtime: this.id,
      status: 'running' as const,
      async waitExit() {
        // DSH agents are async peers of the Leader — no process exit to await.
        return { code: 0, output: '' }
      },
      stop: async () => { await this.adapter.disposeMember(config.agentId) },
      sendInput: async (text: string) => {
        await this.adapter.deliver(config.agentId, textContent(text), groupMessageSource(config.groupId, { label: 'role runtime input' }))
      },
    }
  }

  async stopAgent(handle: RuntimeAgentHandle): Promise<void> {
    await handle.stop()
  }
}