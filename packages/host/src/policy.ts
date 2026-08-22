/**
 * Communication policy (第 8 节，第 22 节): the harness-level guard that no
 * group member can use DSH's raw peer-messaging tools to private-message a
 * teammate. Tool-set scoping is the primary boundary (the member preset
 * simply does not register these tools); this `tools/pre-execute` gate is the
 * defense-in-depth that also covers presets or registrations that add them
 * later. The per-call role checks in the host service are the other,
 * authoritative layer.
 * @module @dsh-agent-groups/host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { GroupService } from './group-service.js'

/** Raw DSH peer-messaging / delegation tools that bypass group policy. */
export const RAW_PEER_TOOLS = new Set([
  'send_message',
  'interrupt_agent',
  'list_agents',
  'subagent',
  'subagent_fork',
  'subagent_codex',
  'subagent_claude_code',
  'workflow',
  'ralph',
])

/**
 * Install the global pre-execute policy: when the calling agent is a group
 * member, deny the raw peer tools outright. The Leader (and non-group agents)
 * are unaffected.
 */
export function installMemberPeerContactPolicy(ctx: Context, groups: GroupService): void {
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next) => {
    const agent = exec.agent
    if (agent === undefined || !RAW_PEER_TOOLS.has(exec.name)) {
      return next()
    }
    if (groups.groupForActor(agent.id) === undefined) {
      return next()
    }
    // A member of a group may never reach the raw peer surface.
    const membership = groups.getMembershipForAgent(agent.id)
    if (membership === undefined || membership.role === 'leader') {
      return next()
    }
    return { kind: 'deny', reason: 'Agent Groups policy: group members cannot use raw peer-messaging tools; use group_post / group_report_to_leader instead.' }
  })
}
