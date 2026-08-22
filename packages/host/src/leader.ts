/**
 * `@dsh-agent-groups/host/leader` — per-Leader-session addon mounted by the
 * `group-leader` agent preset. Registers the leader tool set and the Team
 * Lead protocol section in the preset scope, so every session composed from it
 * sees them while other sessions do not.
 * @module @dsh-agent-groups/host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GroupHost } from './group-host.js'
import { installLeaderTools } from './leader-tools.js'
import { LEADER_PROTOCOL_SECTION } from './leader-prompt.js'

export const name = 'agent-groups:leader'
export const inject = ['groupHost', 'tools', 'systemPrompt']

export function apply(ctx: Context): void {
  const host = ctx.groupHost as GroupHost
  installLeaderTools(ctx, host)
  ctx.systemPrompt.section(LEADER_PROTOCOL_SECTION)
}
