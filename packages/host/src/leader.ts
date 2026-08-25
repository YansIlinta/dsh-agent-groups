/**
 * `@dsh-agent-groups/host/leader` — per-Leader-session addon mounted by the
 * `group-leader` agent preset. Registers the leader tool set and the Team
 * Lead protocol section in the preset scope, so every session composed from it
 * sees them while other sessions do not.
 * @module @dsh-agent-groups/host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GroupHost } from './group-host.js'
import type { CreateFlowService } from './create-flow/service.js'
import { installLeaderTools } from './leader-tools.js'
import { installCreateFlowLeaderTools } from './create-flow/leader-tools.js'
import { LEADER_PROTOCOL_SECTION } from './leader-prompt.js'

export const name = 'agent-groups:leader'
export const inject = ['groupHost', 'createFlow', 'tools', 'systemPrompt']

export function apply(ctx: Context): void {
  const host = ctx.groupHost as GroupHost
  const createFlow = (ctx as Context & { createFlow: CreateFlowService }).createFlow
  installLeaderTools(ctx, host)
  installCreateFlowLeaderTools(ctx, host, createFlow)
  ctx.systemPrompt.section(LEADER_PROTOCOL_SECTION)
}
