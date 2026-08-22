/**
 * Member tool set (第 24 节). Only sessions composed from the `group-member`
 * preset (members materialized by the Leader) see these tools. Members have no
 * leader-only tools and no raw peer-messaging tool; all group communication
 * flows through the channel or the Leader.
 * @module @dsh-agent-groups/host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GroupHost } from './group-host.js'
import { registerGroupTool, type GroupToolDef, strArg, strOptArg, listOptArg, boolArg, numOptArg } from './tools.js'

const string = 'string' as const
const number = 'number' as const

export const MEMBER_TOOLS: readonly GroupToolDef[] = [
  {
    name: 'group_status',
    description: 'Show which group you belong to, your role, and your live status.',
    run: (host, actor) => host.actorStatus(actor),
  },
  {
    name: 'group_list_members',
    description: 'List the group roster: names, profiles, and live statuses.',
    run: (host, actor) => host.roster(actor),
  },
  {
    name: 'group_list_profiles',
    description: 'List available Agent Profiles (roles) the Leader may materialize.',
    run: (host) => host.profilesView(),
  },
  {
    name: 'group_list_tasks',
    description: 'List the group task board with statuses, owners, and blocked-by edges.',
    run: (host, actor) => host.taskBoard(actor),
  },
  {
    name: 'group_get_task',
    description: 'Read one task in full, including acceptance criteria and write scopes.',
    parameters: {
      taskId: { type: string, required: true, description: 'Task id.' },
    },
    run: (host, actor, args) => host.taskDetail(actor, strArg(args, 'taskId')),
  },
  {
    name: 'group_claim_task',
    description: 'Claim a permitted task (unowned, or assigned to you) and start working it.',
    parameters: {
      taskId: { type: string, required: true, description: 'Task id to claim.' },
    },
    run: (host, actor, args) => host.claimTask(actor, { taskId: strArg(args, 'taskId') }),
  },
  {
    name: 'group_complete_task',
    description: 'Submit your structured completion result for a task you own. completionClaim=true means YOU believe it is done; the Leader still verifies it.',
    parameters: {
      taskId: { type: string, required: true, description: 'Task id.' },
      summary: { type: string, required: true, description: 'Short summary of what was done.' },
      artifacts: { type: string, description: 'Comma-separated artifact paths produced.' },
      changedFiles: { type: string, description: 'Comma-separated changed file paths.' },
      tests: { type: string, description: 'Semicolon-separated "{command}:{pass|fail}" test results.' },
      risks: { type: string, description: 'Comma-separated risks you noticed.' },
      unresolved: { type: string, description: 'Comma-separated unresolved items.' },
      completionClaim: { type: string, enum: ['true', 'false'], description: 'Whether you claim the task is complete.' },
    },
    run: (host, actor, args) =>
      host.completeTask(actor, {
        taskId: strArg(args, 'taskId'),
        summary: strArg(args, 'summary'),
        artifacts: listOptArg(args, 'artifacts') ?? [],
        changedFiles: listOptArg(args, 'changedFiles'),
        tests: parseTests(strOptArg(args, 'tests')),
        risks: listOptArg(args, 'risks'),
        unresolved: listOptArg(args, 'unresolved'),
        completionClaim: args.completionClaim === undefined ? true : boolArg(args, 'completionClaim'),
      }),
  },
  {
    name: 'group_post',
    description: 'Post a public message to the Group Channel. Everyone, including the Leader, can read it. Optionally reply to an existing message.',
    parameters: {
      text: { type: string, required: true, description: 'Channel message text.' },
      replyToMessageId: { type: string, description: 'Channel message id this post replies to (simple thread).' },
    },
    run: (host, actor, args) => host.postChannel(actor, { text: strArg(args, 'text'), replyToMessageId: strOptArg(args, 'replyToMessageId') }),
  },
  {
    name: 'group_report_to_leader',
    description: 'Send a PRIVATE report to the Leader. It does not appear in the Group Channel.',
    parameters: {
      text: { type: string, required: true, description: 'Private report text.' },
    },
    run: (host, actor, args) => host.reportToLeader(actor, { text: strArg(args, 'text') }),
  },
  {
    name: 'group_fetch_channel',
    description: 'Read recent Group Channel messages.',
    parameters: {
      limit: { type: number, description: 'How many recent messages to read (default 100).' },
    },
    run: (host, actor, args) => host.channelFeed(actor, undefined, numOptArg(args, 'limit') ?? 100),
  },
]

/** Install the member tool set into the calling scope. */
export function installMemberTools(ctx: Context, host: GroupHost): void {
  for (const spec of MEMBER_TOOLS) {
    registerGroupTool(ctx, host, spec)
  }
}

function parseTests(value: string | undefined): Array<{ command: string; passed: boolean; output?: string }> | undefined {
  if (value === undefined || value.trim() === '') return undefined
  return value.split(';').map((part) => part.trim()).filter((part) => part.length > 0).map((entry) => {
    const colon = entry.lastIndexOf(':')
    if (colon > 0) {
      return { command: entry.slice(0, colon).trim(), passed: entry.slice(colon + 1).trim().toLowerCase().startsWith('pass') }
    }
    return { command: entry, passed: false }
  })
}
