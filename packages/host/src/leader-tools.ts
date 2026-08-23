/**
 * Leader tool set (第 11/23 节). Only a session composed from the
 * `group-leader` preset sees these tools; every call still re-verifies the
 * durable leader role inside GroupHost before acting.
 * @module @dsh-agent-groups/host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GroupHost } from './group-host.js'
import { registerGroupTool, type GroupToolDef, strArg, strOptArg, listOptArg, boolArg, numOptArg } from './tools.js'
import type { TaskKind, TaskPriority, TaskStatus } from './core-types.js'

const string = 'string' as const
const number = 'number' as const

export const LEADER_TOOLS: readonly GroupToolDef[] = [
  {
    name: 'leader_init_group',
    description: 'Create the Agent Group: materialize the Mission, register THIS session as the group Leader, and open the Group Channel.',
    parameters: {
      name: { type: string, required: true, description: 'Short name for the group, e.g. "Dashboard Team".' },
      objective: { type: string, required: true, description: 'The Mission goal, e.g. "Add an Analytics Dashboard to the project".' },
      constraints: { type: string, description: 'Comma-separated constraints (stack, budgets, boundaries).' },
      deliverables: { type: string, description: 'Comma-separated expected deliverables.' },
      acceptanceCriteria: { type: string, description: 'Comma-separated acceptance criteria.' },
      risks: { type: string, description: 'Comma-separated known risks.' },
      workspaceMode: { type: string, description: 'Member workspace policy: "shared" (default) or isolated Git "worktree".' },
    },
    run: (host, actor, args) =>
      host.initGroup(actor, {
        name: strArg(args, 'name'),
        objective: strArg(args, 'objective'),
        constraints: listOptArg(args, 'constraints'),
        deliverables: listOptArg(args, 'deliverables'),
        acceptanceCriteria: listOptArg(args, 'acceptanceCriteria'),
        risks: listOptArg(args, 'risks'),
        workspaceMode: strOptArg(args, 'workspaceMode') === 'worktree' ? 'worktree' : 'shared',
      }),
  },
  {
    name: 'leader_status',
    description: 'Read the current group overview: roster with live status, task board, workstreams, and the latest channel activity. Use this before delegating.',
    run: (host, actor) => host.statusOverview(actor),
  },
  {
    name: 'leader_spawn_member',
    description: 'Materialize a Member from an Agent Profile as a durable teammate of this group (legacy path). List profiles with group_list_profiles first. Prefer leader_spawn_role for role-based spawns driven by the Team Configuration.',
    parameters: {
      profileId: { type: string, required: true, description: 'Agent profile id to materialize (e.g. frontend-engineer).' },
      name: { type: string, description: 'Optional display name; defaults to the profile name.' },
    },
    run: (host, actor, args) => host.spawnMember(actor, { profileId: strArg(args, 'profileId'), name: strOptArg(args, 'name') }),
  },
  {
    name: 'leader_spawn_role',
    description: 'Spawn a Member from a TEAM ROLE — the Team Configuration decides runtime, model, reasoning and profile. Do not guess model or reasoning ids yourself: pick the role id that fits the current need (planner for planning, researcher for research, implementation for coding, reviewer for review, …). Use leader_team_status to see available roles, running instances and instance limits.',
    parameters: {
      role: { type: string, required: true, description: 'Team role id to materialize (see leader_team_status for available roles).' },
      name: { type: string, description: 'Optional display name; defaults to the role name.' },
    },
    run: (host, actor, args) => host.spawnByRole(actor, { role: strArg(args, 'role'), name: strOptArg(args, 'name') }),
  },
  {
    name: 'leader_team_status',
    description: 'Read the Team Configuration: every role with its runtime, model, reasoning level, profile and max instances, plus how many instances of each role are currently running. Use this before spawning roles.',
    parameters: {},
    run: (host, actor) => host.teamStatus(actor),
  },
  {
    name: 'leader_add_workstream',
    description: 'Add a long-lived workstream (phase) under the Mission.',
    parameters: {
      title: { type: string, required: true, description: 'Workstream title, e.g. "Backend".' },
      description: { type: string, description: 'Optional workstream description.' },
    },
    run: (host, actor, args) => host.addWorkstream(actor, { title: strArg(args, 'title'), description: strOptArg(args, 'description') }),
  },
  {
    name: 'leader_replan',
    description: 'Revise the Mission understanding and/or add workstreams, recording that the Leader replanned after new information.',
    parameters: {
      reason: { type: string, required: true, description: 'Why the plan changed (e.g. a verification failure).' },
      missionObjective: { type: string, description: 'Updated Mission objective when the goal changed.' },
      acceptanceCriteria: { type: string, description: 'Replacement comma-separated acceptance criteria when they changed.' },
      newWorkstreams: { type: string, description: 'Comma-separated titles of new workstreams to add, if any.' },
    },
    run: (host, actor, args) =>
      host.replan(actor, {
        reason: strArg(args, 'reason'),
        mission: args.missionObjective !== undefined || args.acceptanceCriteria !== undefined
          ? { objective: strOptArg(args, 'missionObjective'), acceptanceCriteria: listOptArg(args, 'acceptanceCriteria') }
          : undefined,
        newWorkstreams: listOptArg(args, 'newWorkstreams')?.map((title) => ({ title })),
      }),
  },
  {
    name: 'leader_create_task',
    description: 'Create an executable Task on the group task board with acceptance criteria. Tasks you create are not assigned yet; assign them with leader_assign_task.',
    parameters: {
      subject: { type: string, required: true, description: 'Short task title.' },
      description: { type: string, required: true, description: 'Detailed task description.' },
      kind: { type: string, required: true, enum: ['planning', 'research', 'implementation', 'review', 'verification', 'other'], description: 'Task kind.' },
      workstreamId: { type: string, description: 'Owning workstream id from the mission plan.' },
      acceptanceCriteria: { type: string, required: true, description: 'Comma-separated acceptance criteria.' },
      requiredCapabilities: { type: string, description: 'Comma-separated capabilities the assigned member should have.' },
      expectedArtifacts: { type: 'string', description: 'Comma-separated expected artifacts.' },
      priority: { type: string, enum: ['low', 'normal', 'high', 'critical', 'urgent'], description: 'Task priority (default normal).' },
      tags: { type: string, description: 'Comma-separated tags (frontend, backend, research, docs, bug, …).' },
      writeScopes: { type: string, description: 'Comma-separated write scopes (paths). Keep these disjoint across parallel tasks.' },
      blockedBy: { type: string, description: 'Comma-separated taskIds this task depends on.' },
    },
    run: (host, actor, args) =>
      host.createTask(actor, {
        subject: strArg(args, 'subject'),
        description: strArg(args, 'description'),
        kind: strArg(args, 'kind') as TaskKind,
        workstreamId: strOptArg(args, 'workstreamId'),
        acceptanceCriteria: listOptArg(args, 'acceptanceCriteria') ?? [],
        requiredCapabilities: listOptArg(args, 'requiredCapabilities'),
        expectedArtifacts: listOptArg(args, 'expectedArtifacts'),
        priority: (strOptArg(args, 'priority') ?? 'normal') as TaskPriority,
        tags: listOptArg(args, 'tags'),
        writeScopes: listOptArg(args, 'writeScopes'),
        blockedBy: listOptArg(args, 'blockedBy'),
      }),
  },
  {
    name: 'leader_assign_task',
    description: "Assign a created Task to a member by sessionId and deliver the task brief to that member's inbox. The member then claims and works it.",
    parameters: {
      taskId: { type: string, required: true, description: 'Task id to assign.' },
      ownerId: { type: string, required: true, description: 'Member session id (from leader_status / group_list_members).' },
    },
    run: (host, actor, args) => host.assignTask(actor, { taskId: strArg(args, 'taskId'), ownerId: strArg(args, 'ownerId') }),
  },
  {
    name: 'leader_create_verifier_task',
    description: 'Create a verification/review task over a completed task. A member claiming completion is not verification.',
    parameters: {
      overTaskId: { type: string, required: true, description: 'Task that completed and needs independent verification.' },
      subject: { type: string, required: true, description: 'Verifier task title.' },
      description: { type: string, required: true, description: 'What the verifier must check.' },
    },
    run: (host, actor, args) => host.createVerifierTask(actor, {
      overTaskId: strArg(args, 'overTaskId'),
      subject: strArg(args, 'subject'),
      description: strArg(args, 'description'),
    }),
  },
  {
    name: 'leader_verify_task',
    description: 'Accept (passed=true) or reject (passed=false) a completed task. Failures trigger replanning; completion of the Mission still requires your explicit leader_complete_mission.',
    parameters: {
      taskId: { type: string, required: true, description: 'Task to verify.' },
      passed: { type: string, required: true, enum: ['true', 'false'], description: 'Verification verdict.' },
      notes: { type: string, description: 'Optional notes for the verdict.' },
    },
    run: (host, actor, args) => host.verifyTask(actor, { taskId: strArg(args, 'taskId'), passed: boolArg(args, 'passed'), notes: strOptArg(args, 'notes') }),
  },
  {
    name: 'leader_reopen_task',
    description: 'Reopen a failed (or any) task for another attempt on the same node.',
    parameters: {
      taskId: { type: string, required: true, description: 'Task to reopen.' },
      reason: { type: string, description: 'Reopen reason.' },
    },
    run: (host, actor, args) => host.reopenTask(actor, { taskId: strArg(args, 'taskId'), reason: strOptArg(args, 'reason') }),
  },
  {
    name: 'leader_retry_task',
    description: 'Create a fresh retry task referencing the failed one as its retry-of (keeps history).',
    parameters: {
      taskId: { type: string, required: true, description: 'Failed task to retry.' },
      subject: { type: string, description: 'Optional new subject; defaults to "Retry: <original>".' },
    },
    run: (host, actor, args) => host.retryTask(actor, { taskId: strArg(args, 'taskId'), subject: strOptArg(args, 'subject') }),
  },
  {
    name: 'leader_fail_task',
    description: 'Mark a task failed with a reason.',
    parameters: {
      taskId: { type: string, required: true, description: 'Task to fail.' },
      reason: { type: string, required: true, description: 'Failure reason.' },
    },
    run: (host, actor, args) => host.markTaskFailed(actor, { taskId: strArg(args, 'taskId'), reason: strArg(args, 'reason') }),
  },
  {
    name: 'leader_message_member',
    description: 'Send a PRIVATE direct message to one member. It does not appear in the Group Channel.',
    parameters: {
      memberId: { type: string, required: true, description: 'Member session id.' },
      text: { type: string, required: true, description: 'Private message text.' },
    },
    run: (host, actor, args) => host.messageMember(actor, { memberSessionId: strArg(args, 'memberId'), text: strArg(args, 'text') }),
  },
  {
    name: 'leader_broadcast',
    description: 'Post a message to the Group Channel, visible to every member and the Agent Groups page. Optionally reply to an existing channel message.',
    parameters: {
      text: { type: string, required: true, description: 'Channel message text.' },
      replyToMessageId: { type: string, description: 'Channel message id this post replies to (simple thread).' },
    },
    run: (host, actor, args) => host.broadcast(actor, { text: strArg(args, 'text'), kind: 'message', replyToMessageId: strOptArg(args, 'replyToMessageId') }),
  },
  {
    name: 'leader_reply_user',
    description: 'Reply to the user in the Agent Groups Leader Chat. The reply appears there and in your normal chat.',
    parameters: {
      text: { type: string, required: true, description: 'Reply text for the user.' },
    },
    run: (host, actor, args) => host.leaderReplyToUser(actor, { text: strArg(args, 'text') }),
  },
  {
    name: 'leader_update_notes',
    description: 'Update the shared Mission Notes (constraints, decisions, context) — durable and shown in the Agent Groups workspace.',
    parameters: {
      notes: { type: string, required: true, description: 'Full notes text (replaces previous notes).' },
    },
    run: (host, actor, args) => host.leaderUpdateNotes(actor, { notes: strArg(args, 'notes') }),
  },
  {
    name: 'leader_pause_group',
    description: 'Pause the group: no new tasks or members are dispatched until resumed. Messaging and verification stay open.',
    parameters: {},
    run: (host, actor) => host.leaderSetPaused(actor, true),
  },
  {
    name: 'leader_resume_group',
    description: 'Resume a paused group so task and member dispatch work again.',
    parameters: {},
    run: (host, actor) => host.leaderSetPaused(actor, false),
  },
  {
    name: 'leader_interrupt_member',
    description: 'Interrupt a member’s current turn (cancel) with a reason.',
    parameters: {
      memberId: { type: string, required: true, description: 'Member session id to interrupt.' },
      reason: { type: string, required: true, description: 'Why the interrupt happens.' },
    },
    run: (host, actor, args) => host.interruptMember(actor, { memberSessionId: strArg(args, 'memberId'), reason: strArg(args, 'reason') }),
  },
  {
    name: 'leader_wait',
    description: 'Wait up to the given seconds, then return live member statuses and open tasks. Use it to wait for in-flight members.',
    parameters: {
      seconds: { type: number, description: 'Seconds to wait before sampling (0-30, default 0).' },
    },
    run: async (host, actor, args) => {
      const seconds = Math.min(30, Math.max(0, numOptArg(args, 'seconds') ?? 0))
      if (seconds > 0) await sleep(seconds * 1000)
      return host.statusOverview(actor)
    },
  },
  {
    name: 'leader_complete_mission',
    description: 'Mark the whole Mission completed. Only the Leader can do this; it is irreversible on the group.',
    run: (host, actor) => host.completeMission(actor),
  },
]

/** Install the leader tool set into the calling scope. */
export function installLeaderTools(ctx: Context, host: GroupHost): void {
  for (const spec of LEADER_TOOLS) {
    registerGroupTool(ctx, host, spec)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
