/**
 * `@dsh-agent-groups/host/member` — per-member addon mounted by the
 * `group-member` agent preset. Registers the member tool set and the Group
 * Member protocol section in the preset scope. Members never receive the raw
 * peer-messaging tool (see policy.ts for the defense-in-depth gate).
 * @module @dsh-agent-groups/host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GroupHost } from './group-host.js'
import { installMemberTools } from './member-tools.js'
import { MEMBER_PROTOCOL_SECTION } from './member-prompt.js'

export const name = 'agent-groups:member'
export const inject = ['groupHost', 'tools', 'systemPrompt']

export function apply(ctx: Context): void {
  const host = ctx.groupHost as GroupHost
  installMemberTools(ctx, host)
  ctx.systemPrompt.section(MEMBER_PROTOCOL_SECTION)
}
