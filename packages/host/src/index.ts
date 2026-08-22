/**
 * DSH Agent Groups — main host plugin. The plugin is deliberately independent
 * of the DeepSeek Harness checkout: it composes only public Cordis services
 * (`ctx.storageDomain`, `ctx.webServer`, `ctx.agents`, `ctx.agentPresets`,
 * `ctx.tools`, `ctx.systemPrompt`), opens a plugin-owned durable domain, and
 * serves the group Agent Groups page on the same webserver as the DSH GUI.
 *
 * Mount this plugin into a profile (the shipped overlay in
 * `@dsh-agent-groups/profiles`) and compose sessions from the `group-leader`
 * / `group-member` agent presets.
 * @module @dsh-agent-groups/host
 */

import type { Context } from '@deepseek-ai/cordis'
import { openAgentGroupsDomain } from './persistence.js'
import { DomainStore } from './store.js'
import type { ActivityEvent, AgentProfile, ChannelMessage, GroupMember, GroupRecord, GroupTask, KnownLeader, PrivateMessage } from './core-types.js'
import { GroupService } from './group-service.js'
import { TaskService } from './task-service.js'
import { ChannelService, PrivateMessageService } from './channel-service.js'
import { ActivityService } from './activity-service.js'
import { ProfileRegistry } from './profile-registry.js'
import { GroupNotifier } from './notifier.js'
import { GroupHost } from './group-host.js'
import { DshAgentRuntimeAdapter, type DefaultModelSelection } from './dsh-adapter.js'
import { installMemberPeerContactPolicy } from './policy.js'
import { buildCompatibilityReport, detectSurfaces, printCompatibility } from './compatibility.js'
import { createGroupWebApi } from './web/api.js'
import { LeaderRegistry } from './leader-registry.js'
import { RuntimeRegistry } from './runtime/registry.js'
import { DeepSeekHarnessRuntimeProvider } from './runtime/deepseek-harness.js'
import { CodexRuntimeProvider } from './runtime/codex.js'
import { ExternalAgentBridge } from './runtime/bridge.js'
import { ClaudeCodeRuntimeProvider } from './runtime/claude-code.js'
import { ClaudeRuntimeProvider } from './runtime/claude.js'

export { GroupHost } from './group-host.js'
export { GroupError, type GroupErrorCode } from './group-service.js'
export { groupMessageSource } from './message-source.js'
export { DshAgentRuntimeAdapter, createNoopAdapter, type AgentRuntimeAdapter, MEMBER_PRESET_ID, LEADER_PRESET_ID } from './dsh-adapter.js'
export { LEADER_PROTOCOL_SECTION, leadSectionText } from './leader-prompt.js'
export { MEMBER_PROTOCOL_SECTION, memberSectionText } from './member-prompt.js'
export { detectWriteOverlaps, scopesOverlap } from './conflicts.js'
export { LeaderRegistry } from './leader-registry.js'
export { TEAM_TEMPLATES, listTemplates, getTemplate, requireTemplate, templateMemberSlots } from './template-registry.js'
export { MemoryStore } from './store.js'
export type { TableStore } from './store.js'
export { RuntimeRegistry, RuntimeError } from './runtime/registry.js'
export { DeepSeekHarnessRuntimeProvider } from './runtime/deepseek-harness.js'
export { CodexRuntimeProvider, CODEX_FALLBACK_MODELS } from './runtime/codex.js'
export { CodexAppServerConnection, CodexProtocolError, CodexBinaryProcessHost } from './runtime/codex-protocol.js'
export type { CodexProcessHost, CodexChildLike, CodexInboundMessage, RequestId } from './runtime/codex-protocol.js'
export { ClaudeCodeRuntimeProvider } from './runtime/claude-code.js'
export { ClaudeRuntimeProvider, CLAUDE_FALLBACK_MODELS } from './runtime/claude.js'
export type { ClaudeQueryFactory, ClaudeQueryLike, ClaudeQueryParams } from './runtime/claude.js'
export type { RuntimeSession, RuntimeTurnHandle, RuntimeTurnResult, RuntimeTurnInput, RuntimeSessionInfo, RuntimeSessionStatus, SessionRuntimeProvider } from './runtime/base.js'
export { isSessionProvider, DEFAULT_REASONING_LEVELS } from './runtime/base.js'
export type { RuntimeEvent, RuntimeSessionEvent, RuntimeTurnEvent, RuntimePendingRequest, RuntimeEventListener } from './runtime/events.js'
export { teamConfigFor, templateTeamConfig, ROLE_TEMPLATES, LEADER_ROLE, GENERALIST_ROLE } from './runtime/team-config.js'
export type { AgentRuntimeProvider, RuntimeAgentHandle, RuntimeAgentConfig, RuntimeCapabilities, ModelDescriptor, ReasoningOption } from './runtime/base.js'
export { createRuntimeMessage, deliverRuntimeMessage, runtimeMessageText } from './runtime/message.js'
export type { RuntimeMessage, RuntimeMessageType, RuntimePriority, RuntimeMessageSink, CreateRuntimeMessageInput } from './runtime/message.js'
export { PromptCompiler, compileAgentPrompt, compilePrompt, estimateTokens, DEFAULT_MAX_CONTEXT_TOKENS } from './prompt-compiler.js'
export { ExternalAgentBridge } from './runtime/bridge.js'
export { AgentContextService, createEmptyCursor } from './runtime/context.js'
export { RuntimeRecovery } from './runtime/recovery.js'
export type { RecoveryOptions } from './runtime/recovery.js'
export { RUNTIME_PRESETS, ROLE_PRESETS, TEAM_PRESETS, getRuntimePreset, getRolePreset, getTeamPreset, resolveRolePreset, resolveTeamPreset } from './runtime/presets.js'
export type { RuntimePreset, RolePreset, TeamPreset, TeamPresetRoleRef } from './runtime/presets.js'
export type { AgentContextCursor, AgentContextDelta } from './runtime/context.js'
export { BRIDGE_MARKER, parseBridgeAction, codexBridgeInstructions, executeBridgeAction } from './runtime/codex-bridge.js'
export type { CodexBridgeAction } from './runtime/codex-bridge.js'
export type { ExternalBridgeMethod, ExternalBridgeParams, ExternalAgentContext, ExternalBridgeCall } from './runtime/bridge.js'
export type { PromptSection, PromptCompileOptions, CompiledPrompt, CompiledPromptSection, AgentPromptLayers, AgentTaskPrompt, AgentRelevantContext } from './prompt-compiler.js'
export * from './core-types.js'

export const name = 'agent-groups'
export const inject = ['storageDomain', 'webServer', 'agents', 'agentPresets']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The DSH Agent Groups product service (leader & member operations). */
    groupHost: GroupHost
  }
}

export async function apply(ctx: Context): Promise<void> {
  const presence = detectSurfaces(ctx)
  const report = buildCompatibilityReport(ctx, presence)
  printCompatibility(report)
  if (report.fatal.length > 0) {
    throw new Error(`DSH Agent Groups cannot load: ${report.fatal.join('; ')}`)
  }

  // Durable plugin-owned store (typed per table).
  const domain = await openAgentGroupsDomain(ctx.storageDomain)
  const stores = {
    profiles: new DomainStore<string, AgentProfile>('profiles', domain.table('profiles')),
    groups: new DomainStore<string, GroupRecord>('groups', domain.table('groups')),
    members: new DomainStore<string, GroupMember>('members', domain.table('members')),
    tasks: new DomainStore<string, GroupTask>('tasks', domain.table('tasks')),
    channel: new DomainStore<string, ChannelMessage>('channel', domain.table('channel')),
    private: new DomainStore<string, PrivateMessage>('private', domain.table('private')),
    activity: new DomainStore<string, ActivityEvent>('activity', domain.table('activity')),
    leaders: new DomainStore<string, KnownLeader>('leaders', domain.table('leaders')),
  }

  const notifier = new GroupNotifier()
  const activity = new ActivityService(stores.activity, notifier)
  const groups = new GroupService(stores.groups, stores.members, activity)
  const tasks = new TaskService(stores.tasks, activity)
  const channel = new ChannelService(stores.channel, activity, notifier)
  const profiles = new ProfileRegistry(stores.profiles)
  const agentDefaultModel = ctx.get('agentDefaultModel') as { currentSelection(): DefaultModelSelection } | undefined
  const adapter = new DshAgentRuntimeAdapter({
    agents: ctx.agents,
    agentPresets: ctx.agentPresets,
    agentDefaultModel,
  })
  const privateMessages = new PrivateMessageService(
    stores.private,
    activity,
    notifier,
    (groupId) => groups.getGroup(groupId)?.leaderSessionId,
  )
  const leaders = new LeaderRegistry(stores.leaders)

  // V0.4/V0.5: runtime registry — role-based spawns resolve through providers.
  const runtimes = new RuntimeRegistry()
  runtimes.register(new DeepSeekHarnessRuntimeProvider(
    adapter,
    { currentSelection: () => (agentDefaultModel?.currentSelection() ?? {}) },
  ))
  let codexBridge: ExternalAgentBridge | undefined
  // V0.5: the persistent Codex App Server provider (one thread per member).
  runtimes.register(new CodexRuntimeProvider())
  // V0.5: the persistent Claude Agent SDK provider (resume-by-session-id).
  runtimes.register(new ClaudeRuntimeProvider())
  // Legacy bridge-based Claude Code CLI provider (kept for stored roles).
  runtimes.register(new ClaudeCodeRuntimeProvider({ getBridge: () => codexBridge }))

  const host = new GroupHost({ groups, tasks, channel, privateMessages, activity, profiles, notifier, adapter, leaders, runtimes })
  codexBridge = new ExternalAgentBridge(host)
  ctx.provide('groupHost', host)

  // V0.5: re-attach durable member sessions after a host restart.
  void host.resumeAllMemberRuntimes()

  // Policy: no raw peer messaging for group members (defense-in-depth).
  installMemberPeerContactPolicy(ctx, groups)

  // Data API (`/groups/api/*`) on the same webserver as the DSH GUI; the
  // native page (client bundle) is loaded by the DSH shell itself.
  for (const route of createGroupWebApi({ host, notifier, compatibility: report })) {
    ctx.webServer.register(route)
  }

  ctx.effect(() => () =>
    Promise.allSettled([
      adapter.drain(),
      domain.close(),
    ]).then(() => undefined),
  )
}
