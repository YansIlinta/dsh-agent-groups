/**
 * DSH runtime adapter: the only module that calls `@deepseek-ai/dsh-*` agent
 * services. The product layer talks to `AgentRuntimeAdapter`; swapping the
 * mechanism (or adapting to a future Agent Teams API) only touches this file.
 * @module @dsh-agent-groups/host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'

export const MEMBER_PRESET_ID = 'group-member'
export const LEADER_PRESET_ID = 'group-leader'

/** One live agent's observable facts. */
export interface LiveAgent {
  readonly sessionId: string
  readonly agent: Agent
  /** `running` while a driver is active; `idle` otherwise. */
  readonly status: 'running' | 'idle'
}

export interface MemberCreateSpec {
  readonly sessionId: string
  /** Leader session id, recorded as the durable parent lineage. */
  readonly parentId: string
  readonly cwd?: string
  readonly provider?: string
  readonly model?: string
}

/**
 * The runtime operations the host uses. Tests provide a fake implementation.
 */
export interface AgentRuntimeAdapter {
  readonly kind: 'dsh' | 'fake'
  /** Create a durable member Agent (a continuable teammate of the Leader). */
  createMemberAgent(spec: MemberCreateSpec): Promise<void>
  liveAgent(sessionId: string): LiveAgent | undefined
  resumeAgent(sessionId: string): Promise<LiveAgent | undefined>
  /** Live-first, else cold-resume; returns the live agent when recoverable. */
  ensureLive(sessionId: string): Promise<LiveAgent | undefined>
  /** Deliver a waking turn (used for DMs and task assignments). */
  deliver(sessionId: string, content: ContentBlock[], source: MessageSource): Promise<boolean>
  /** Inject non-waking context for the next step (used for notices). */
  inject(sessionId: string, content: ContentBlock[], source: MessageSource): void
  /** Interrupt a member's current turn. */
  interrupt(sessionId: string, reason: string): boolean
  /** Dispose a member's agent handle (owner-only teardown). */
  disposeMember(sessionId: string): Promise<void>
  /** Tear down every still-open member handle (plugin unload). */
  drain(): Promise<void>
}

/** No-op adapter used when the agent runtime is unavailable (tests, headless). */
export function createNoopAdapter(): AgentRuntimeAdapter {
  return {
    kind: 'fake',
    async createMemberAgent() {},
    liveAgent() { return undefined },
    async resumeAgent() { return undefined },
    async ensureLive() { return undefined },
    async deliver() { return false },
    inject() {},
    interrupt() { return false },
    async disposeMember() {},
    async drain() {},
  }
}

/** Minimal view of the dsh default-model selection service (avoids a hard dependency). */
export interface DefaultModelSelection {
  readonly provider: string
  readonly model: string
}

interface DefaultModelSource {
  currentSelection(): DefaultModelSelection
}

interface DshAdapterDeps {
  readonly agents: AgentRegistry
  readonly agentPresets: AgentPresets
  /** Optional: default provider/model for member agents that lack a selection. */
  readonly agentDefaultModel?: DefaultModelSource
}

/** Production adapter over `ctx.agents` / `ctx.agentPresets`. */
export class DshAgentRuntimeAdapter implements AgentRuntimeAdapter {
  readonly kind = 'dsh' as const
  private readonly agents: AgentRegistry
  private readonly agentPresets: AgentPresets
  private readonly agentDefaultModel?: DefaultModelSource
  private readonly handles = new Map<string, Awaited<ReturnType<AgentRegistry['create']>>>()

  constructor(deps: DshAdapterDeps) {
    this.agents = deps.agents
    this.agentPresets = deps.agentPresets
    this.agentDefaultModel = deps.agentDefaultModel
  }

  /** Default provider/model selection, empty when no source is mounted. */
  private selection(): { provider?: string; model?: string } {
    const selection = this.agentDefaultModel?.currentSelection()
    if (selection === undefined) return {}
    return { provider: selection.provider, model: selection.model }
  }

  async createMemberAgent(spec: MemberCreateSpec): Promise<void> {
    const sessionId = SessionId(spec.sessionId)
    const selection = this.selection()
    const handle = await this.agents.create({
      sessionId,
      meta: {
        cwd: spec.cwd,
        parentSession: SessionId(spec.parentId),
        origin: 'subagent',
      },
      agentOptions: {
        provider: spec.provider ?? selection.provider,
        model: spec.model ?? selection.model,
      },
      setup: async (agentCtx: Context) => {
        // The member world: work tools + group member tools + member section,
        // taken from the shipped `group-member` agent preset.
        await this.agentPresets.mount(agentCtx, MEMBER_PRESET_ID)
      },
    })
    this.handles.set(spec.sessionId, handle)
  }

  liveAgent(sessionId: string): LiveAgent | undefined {
    const agent = this.agents.get(SessionId(sessionId))
    if (agent === undefined) return undefined
    return { sessionId, agent, status: agent.status }
  }

  async resumeAgent(sessionId: string): Promise<LiveAgent | undefined> {
    const existing = this.liveAgent(sessionId)
    if (existing !== undefined) return existing
    try {
      const selection = this.selection()
      const handle = await this.agents.resume({
        resumeSessionId: SessionId(sessionId),
        agentOptions: {
          provider: selection.provider,
          model: selection.model,
        },
        setup: async (agentCtx: Context) => {
          await this.agentPresets.mount(agentCtx, MEMBER_PRESET_ID)
        },
      })
      this.handles.set(sessionId, handle)
      return this.liveAgent(sessionId)
    } catch {
      return undefined
    }
  }

  async ensureLive(sessionId: string): Promise<LiveAgent | undefined> {
    const live = this.liveAgent(sessionId)
    if (live !== undefined) return live
    return this.resumeAgent(sessionId)
  }

  async deliver(sessionId: string, content: ContentBlock[], source: MessageSource): Promise<boolean> {
    const live = await this.ensureLive(sessionId)
    if (live === undefined) return false
    live.agent.followup(createUserMessage({ content, source }))
    return true
  }

  inject(sessionId: string, content: ContentBlock[], source: MessageSource): void {
    const live = this.liveAgent(sessionId)
    if (live === undefined) return
    live.agent.inject(createUserMessage({ content, source }))
  }

  interrupt(sessionId: string, reason: string): boolean {
    const live = this.liveAgent(sessionId)
    if (live === undefined) return false
    void reason
    live.agent.cancel({ kind: 'user' }, { keepInbox: true })
    return true
  }

  async disposeMember(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId)
    if (handle === undefined) return
    this.handles.delete(sessionId)
    await handle.dispose()
  }

  async drain(): Promise<void> {
    const handles = [...this.handles.values()]
    this.handles.clear()
    await Promise.allSettled(handles.map(handle => handle.dispose()))
  }
}
