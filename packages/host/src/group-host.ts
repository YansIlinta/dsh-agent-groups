/**
 * GroupHost: the product service tools and the web API call into. Every
 * operation resolves the actor's DURABLE role before doing anything, then
 * delegates to the owning sub-service, persists through the domain store, and
 * pushes the change to the notifier. This is the enforcement point — a system
 * prompt is never the boundary (第 8/22 节).
 * @module @dsh-agent-groups/host
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, normalize } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  ActivityEvent,
  AgentMemberStatus,
  AgentProfile,
  AgentRoleDefinition,
  AgentTaskResult,
  ChannelMessage,
  CompatibilityReport,
  GroupId,
  GroupListItem,
  GroupMember,
  GroupRecord,
  GroupSnapshot,
  GroupTask,
  KnownLeader,
  Mission,
  PrivateMessage,
  TaskKind,
  TaskPriority,
  TaskStatus,
  TeamConfig,
  TeamTemplate,
  Workstream,
  WorkspaceArtifact,
} from './core-types.js'
import { GroupService, GroupError, type MissionInput, type MemberView } from './group-service.js'
import { TaskService, type TaskInput, type TaskUpdatePatch } from './task-service.js'
import { ChannelService, PrivateMessageService } from './channel-service.js'
import { ActivityService } from './activity-service.js'
import { ProfileRegistry } from './profile-registry.js'
import { type AgentRuntimeAdapter } from './dsh-adapter.js'
import { GroupNotifier } from './notifier.js'
import { groupMessageSource } from './message-source.js'
import { LeaderRegistry } from './leader-registry.js'
import { listTemplates, requireTemplate, templateMemberSlots } from './template-registry.js'
import { RuntimeRegistry, RuntimeError } from './runtime/registry.js'
import { isSessionProvider, type AgentRuntimeProvider, type RuntimeAgentConfig, type RuntimeAgentHandle, type RuntimeSession, type RuntimeSessionInfo, type RuntimeTurnHandle, type RuntimeTurnResult } from './runtime/base.js'
import type { RuntimeEvent, RuntimePendingRequest } from './runtime/events.js'
import type { MemberRuntimeState, RuntimeQueuedTurn, RuntimeRequestView } from './core-types.js'
import { teamConfigFor } from './runtime/team-config.js'
import { createRuntimeMessage, runtimeMessageText } from './runtime/message.js'
import { GitWorktreeWorkspaceManager, type WorkspaceManager } from './runtime/workspace.js'

export function textContent(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

export interface LeaderActor {
  readonly group: GroupRecord
  readonly leader: GroupMember
}

export type { RoleProviderDiscovery, HostDiscoverySource } from './harness-discovery.js'
import type { HostDiscoverySource } from './harness-discovery.js'

/** One selectable reasoning effort in the discovery view. */
export interface DiscoveryReasoningEffortView {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** One model in the discovery view (with per-model reasoning when known). */
export interface DiscoveryModelView {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning?: { readonly efforts: readonly DiscoveryReasoningEffortView[]; readonly defaultEffort?: string }
}

/** One provider in the discovery view (never contains credential values). */
export interface DiscoveryProviderView {
  readonly provider: string
  readonly name: string
  /** Route has a configurable settings entry point. */
  readonly configurable: boolean
  readonly models: readonly DiscoveryModelView[]
  readonly credential?: import('./harness-discovery.js').ProviderCredentialStatus
}

/** One provider entry in the Role Editor Authentication step (no models here,
 * no credential values anywhere — only status facts + the settings entry
 * point). */
export interface DiscoveryProviderEntryView {
  readonly id: string
  readonly name: string
  /** Route has a configurable settings entry point (settingsNs + settingsPath). */
  readonly configurable: boolean
  /** Settings entry point of the provider route (least-hardcoded credential
   * seam; the Reference NAME below is a label, never a value). */
  readonly settingsNs?: string
  readonly settingsPath?: readonly string[]
  /** The credential REFERENCE NAME (env-var id), never its value. */
  readonly credentialRef?: string
  readonly credential: {
    readonly configured?: boolean
    readonly source?: string
    readonly writable?: boolean
  }
}

/** Credential status for one provider route in the wizard (never the value). */
export interface DiscoveryProviderCredentialView {
  readonly configured?: boolean
  readonly source?: string
  readonly writable?: boolean
  /** Where the credential is configured. `kind: 'settings'` → the harness
   * settings panel (there is no deep-linkable URL in the shell today, so
   * `kind: 'url'` is reserved for future entry points). */
  readonly entry?: {
    readonly kind: 'settings' | 'url'
    readonly settingsNs?: string
    readonly settingsPath?: readonly string[]
    readonly credentialRef?: string
  }
}

/** Shown by the discovery endpoints when the harness services are absent. */
export const DISCOVERY_UNAVAILABLE_NOTE =
  'harness discovery services are not available in this process; the provider catalog is empty'

/** Team-config provider gating applies to the DSH runtime only. */
const DSH_RUNTIME_ID = 'deepseek-harness'

/**
 * Defense in depth: reject any role payload that carries a secret-named field
 * (apiKey / secret / credential — case and separator insensitive) anywhere in
 * the role object, including nested `metadata`. Secrets (or credential refs)
 * must never enter team config or durable records; auth stays owned by the
 * harness settings, never by role payloads. Slight intentional over-match
 * (e.g. `secretary`) is acceptable for field NAMES.
 */
function hasSecretField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSecretField)
  if (typeof value === 'object' && value !== null) {
    return Object.keys(value).some((key) => {
      const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
      return /apikey|secret|credential/.test(normalized) || hasSecretField((value as Record<string, unknown>)[key])
    })
  }
  return false
}

/**
 * The complete host surface. Constructed in the plugin's `apply` with the
 * domain-backed stores and the DSH adapter; each method is role-guarded.
 */
export class GroupHost {
  readonly groups: GroupService
  readonly tasks: TaskService
  readonly channel: ChannelService
  readonly privateMessages: PrivateMessageService
  readonly activity: ActivityService
  readonly profiles: ProfileRegistry
  readonly notifier: GroupNotifier
  readonly leaders: LeaderRegistry
  readonly runtimes: RuntimeRegistry
  private readonly adapter: AgentRuntimeAdapter
  /** V0.5: per-member live runtime sessions (session ⊃ turns ⊃ tasks). */
  private readonly memberRuntimes = new Map<string, MemberRuntime>()
  /** Per-member restart reconciliation backoff; avoids retry/event storms. */
  private readonly runtimeResumeBackoff = new Map<string, { failures: number; nextAt: number }>()
  /** Ensures a terminal event cannot settle before its durable Attempt exists. */
  private readonly attemptStarts = new Map<string, Promise<unknown>>()
  private readonly workspaces: WorkspaceManager
  /** V0.4.1: optional live harness discovery source for team-config gating + views. */
  private readonly discovery?: HostDiscoverySource

  constructor(options: {
    groups: GroupService
    tasks: TaskService
    channel: ChannelService
    privateMessages: PrivateMessageService
    activity: ActivityService
    profiles: ProfileRegistry
    notifier: GroupNotifier
    adapter: AgentRuntimeAdapter
    leaders: LeaderRegistry
    runtimes?: RuntimeRegistry
    workspaces?: WorkspaceManager
    /** V0.4.1: optional live harness discovery source (see HostDiscoverySource). */
    discovery?: HostDiscoverySource
  }) {
    this.groups = options.groups
    this.tasks = options.tasks
    this.channel = options.channel
    this.privateMessages = options.privateMessages
    this.activity = options.activity
    this.profiles = options.profiles
    this.notifier = options.notifier
    this.adapter = options.adapter
    this.leaders = options.leaders
    this.runtimes = options.runtimes ?? new RuntimeRegistry()
    this.workspaces = options.workspaces ?? new GitWorktreeWorkspaceManager()
    this.discovery = options.discovery
  }

  // ── actor resolution ──────────────────────────────────────────────────────

  private leaderActor(actor: string, groupId?: GroupId): LeaderActor {
    void this.leaders.register(actor)
    const group = this.groups.resolveActorGroup(actor, 'leader', groupId)
    return { group, leader: this.groups.assertLeader(group.groupId, actor) }
  }

  private memberContext(actor: string, groupId?: GroupId): { group: GroupRecord; member: GroupMember } {
    const group = this.groups.resolveActorGroup(actor, 'member', groupId)
    return { group, member: this.groups.assertMember(group.groupId, actor) }
  }

  // ── team configuration (V0.4) ─────────────────────────────────────────────

  /** Team roles with the V0.4 migration: no stored config → derived defaults. */
  teamConfig(group: GroupRecord): TeamConfig {
    return teamConfigFor(group.templateId, group.teamConfig)
  }

  async updateTeamConfig(groupId: GroupId, next: TeamConfig, actorName: string): Promise<GroupRecord> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    const roleIds = new Set<string>()
    const check = async (definition: AgentRoleDefinition): Promise<void> => {
      if (definition.id === '' || roleIds.has(definition.id)) {
        throw new GroupError('CONFLICT', `duplicate or empty role id "${definition.id}"`)
      }
      roleIds.add(definition.id)
      if (definition.maxInstances !== undefined && definition.maxInstances < 1) {
        throw new GroupError('CONFLICT', `role "${definition.id}": maxInstances must be >= 1`)
      }
      if (definition.reasoningLevel !== undefined && !['low', 'medium', 'high'].includes(definition.reasoningLevel)) {
        throw new GroupError('CONFLICT', `role "${definition.id}": unsupported reasoning level "${definition.reasoningLevel}" (use low/medium/high)`)
      }
      // V0.4.1: defense in depth — secrets must never enter team config.
      if (hasSecretField(definition)) {
        throw new GroupError('CONFLICT', `role "${definition.id}": secret-bearing field names (apiKey/secret/credential) are not allowed in role payloads`)
      }
      const provider = definition.provider
      if (provider !== undefined && (typeof provider !== 'string' || provider.trim() === '')) {
        throw new GroupError('CONFLICT', `role "${definition.id}": provider must be a non-empty string when set`)
      }
      const effort = definition.reasoningEffort
      if (effort !== undefined && (typeof effort !== 'string' || effort.trim() === '')) {
        throw new GroupError('CONFLICT', `role "${definition.id}": reasoningEffort must be a non-empty string when set`)
      }
      // Capability gating is DSH-only; non-DSH runtimes keep current behavior.
      // The optional `discovery` source (harness-discovery.ts, mounted in
      // index.ts) gates against the LIVE harness catalog (ctx.llm). When it is
      // absent (tests/headless), we validate shape only and the runtime gates
      // at spawn/request time.
      if (definition.runtime !== DSH_RUNTIME_ID || this.discovery === undefined) return
      const providers = await this.discovery.listProviderIds()
      if (providers.length > 0 && provider !== undefined && !providers.includes(provider)) {
        throw new GroupError('PROVIDER_UNAVAILABLE', `role "${definition.id}": provider "${provider}" is not in the harness discovery catalog`)
      }
      if (effort !== undefined) {
        const efforts = await this.discovery.listReasoningEfforts(provider, definition.model)
        if (efforts !== undefined && efforts.length > 0 && !efforts.includes(effort)) {
          throw new GroupError('REASONING_UNAVAILABLE', `role "${definition.id}": reasoningEffort "${effort}" is not available for${provider !== undefined ? ` provider "${provider}"` : ' the default provider'}${definition.model !== undefined ? ` / model "${definition.model}"` : ''}`)
        }
      }
      // V0.4.1: legacy abstract level guard (investigation Q3 ⚠ — live
      // incident). On the DSH runtime the abstract low/medium/high level is
      // passed DIRECTLY as the adapter effort id and the request path rejects
      // ids the model does not offer (UNSUPPORTED_REASONING_EFFORT), so a
      // level like 'medium' spawns members that die on their first turn. When
      // the route's real effort set is resolvable and the abstract level id is
      // not among it, reject at save time with the offered ids instead of
      // letting the request path kill the member. No silent remapping — the
      // user picks an offered effort or leaves it unset for the adapter default.
      if (definition.reasoningLevel !== undefined && effort === undefined) {
        const efforts = await this.discovery.listReasoningEfforts(provider, definition.model)
        if (efforts !== undefined && efforts.length > 0 && !efforts.includes(definition.reasoningLevel)) {
          throw new GroupError('REASONING_UNAVAILABLE', `role "${definition.id}": abstract reasoningLevel "${definition.reasoningLevel}" is not an offered effort id for${provider !== undefined ? ` provider "${provider}"` : ' the default provider'}${definition.model !== undefined ? ` / model "${definition.model}"` : ''} (offered: ${efforts.join(', ')}); set reasoningEffort to one of these, or unset both to keep the provider default`)
        }
      }
    }
    await check(next.leaderRole)
    for (const definition of next.memberRoles) await check(definition)
    const updated = await this.groups.withGroupTouch(groupId, (current) => ({ ...current, teamConfig: next }))
    await this.activity.append({
      groupId,
      type: 'team_config_updated',
      actorName,
      payload: { roles: next.memberRoles.map((r) => r.id).join(',') },
    })
    this.notifier.emit(groupId, 'group', undefined)
    return updated
  }

  // ── role-based spawn (V0.4) ───────────────────────────────────────────────

  // ── role-based spawn (V0.4) ───────────────────────────────────────────────

  /**
   * Leader spawns by team role (leader_spawn_member({role})). The TeamConfig
   * decides runtime/model/reasoning/profile; the Leader only picks the role.
   * A restricted override (model/reasoning only) is supported for explicit
   * cases but never changes the runtime or the TeamConfig itself.
   */
  async spawnByRole(actor: string, input: { role: string; name?: string; override?: { model?: string; reasoningLevel?: string } }): Promise<GroupMember> {
    const { group } = this.leaderActor(actor)
    this.groups.assertDispatchable(group)
    return this.spawnRoleInto(group.groupId, input.role, input.name, input.override, actor)
  }

  /** User console: same path, actor label 'User' (Add Member by role). */
  async userSpawnByRole(groupId: GroupId, input: { role: string; name?: string }): Promise<GroupMember> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    this.groups.assertDispatchable(group)
    return this.spawnRoleInto(group.groupId, input.role, input.name, undefined, 'User')
  }

  private async spawnRoleInto(
    groupId: GroupId,
    roleId: string,
    name: string | undefined,
    override: { model?: string; reasoningLevel?: string } | undefined,
    requestedBy: string,
  ): Promise<GroupMember> {
    const group = this.groups.requireGroup(groupId)
    const config = this.teamConfig(group)
    const role = config.memberRoles.find((r) => r.id === roleId)
    if (role === undefined) {
      throw new GroupError('ROLE_NOT_FOUND', `no team role "${roleId}" — available roles: ${config.memberRoles.map((r) => r.id).join(', ')}`)
    }
    const instances = this.groups
      .listMembers(group.groupId, () => undefined)
      .filter((m) => m.role === 'member' && m.status !== 'left' && m.roleId === roleId).length
    if (role.maxInstances !== undefined && instances >= role.maxInstances) {
      throw new GroupError('ROLE_INSTANCE_LIMIT', `role "${roleId}" is at its instance limit (${role.maxInstances})`)
    }
    let provider: AgentRuntimeProvider
    try {
      provider = await this.runtimes.assertUsable(role.runtime)
    } catch (error) {
      if (error instanceof RuntimeError) throw new GroupError('RUNTIME_UNAVAILABLE', error.message)
      throw error
    }

    const model = override?.model ?? role.model
    const reasoningLevel = override?.reasoningLevel ?? role.reasoningLevel
    const capabilities = await provider.getCapabilities()
    if (model !== undefined && capabilities.models && capabilities.dynamicModels !== false) {
      const models = await provider.listModels()
      if (models.length > 0 && !models.some((m) => m.id === model)) {
        throw new GroupError('MODEL_UNAVAILABLE', `model "${model}" is not available on the ${provider.name} runtime`)
      }
    }
    if (reasoningLevel !== undefined) {
      const levels = (await provider.listReasoningLevels?.()) ?? []
      if (levels.length > 0 && !levels.some((level) => level.id === reasoningLevel)) {
        throw new GroupError('REASONING_UNAVAILABLE', `reasoning level "${reasoningLevel}" is not available on the ${provider.name} runtime`)
      }
    }

    await this.activity.append({
      groupId,
      type: 'member_spawn_requested',
      actorId: requestedBy,
      payload: { role: roleId, runtime: role.runtime, provider: role.provider, model, reasoningLevel, reasoningEffort: role.reasoningEffort },
    })
    const agentId = randomUUID()
    let workspace: string | undefined
    try {
      workspace = await this.workspaces.prepare({
        groupId,
        memberId: agentId,
        cwd: group.cwd,
        mode: group.workspaceMode ?? 'shared',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.activity.append({
        groupId,
        type: 'member_runtime_failed',
        actorId: requestedBy,
        payload: { role: roleId, runtime: role.runtime, error: message },
      })
      throw new GroupError('SPAWN_FAILED', `failed to prepare ${role.name} workspace: ${message}`)
    }
    const roleConfig: RuntimeAgentConfig = {
      groupId,
      agentId,
      role: roleId,
      profile: role.profile,
      provider: role.provider,
      model,
      reasoningLevel,
      reasoningEffort: role.reasoningEffort,
      systemPrompt: role.systemPrompt,
      workspace,
      parentMemberId: group.leaderSessionId,
      metadata: role.metadata,
    }
    try {
      if (isSessionProvider(provider)) {
        // Materialization is the runtime-readiness boundary: initialize the
        // provider, create the durable conversation, and apply advertised
        // config before a member can appear usable or receive a task. This
        // removes the spawn→first-dispatch race and surfaces auth/config/new
        // session failures synchronously.
        const session = await provider.createSession(roleConfig)
        await session.start()
        this.attachMemberRuntime(groupId, agentId, roleConfig, session)
      } else {
        // Legacy provider: process handle, no session semantics.
        const handle = await provider.spawnAgent(roleConfig)
        this.memberRuntimes.set(agentId, {
          kind: 'legacy',
          groupId,
          memberId: agentId,
          config: roleConfig,
          handle,
          state: 'starting',
          pendingRequests: new Map(),
          activeTurn: undefined,
          queuedTurns: [],
          turnSeq: 0,
        })
        // NEVER treat exit as success: exit only records a stopped/failed
        // runtime (a completed TURN is the only completion path).
        void handle.waitExit()
          .then((result) => this.onLegacyRuntimeExit(groupId, agentId, result))
          .catch(() => undefined)
      }
    } catch (error) {
      await this.activity.append({
        groupId,
        type: 'member_runtime_failed',
        actorId: requestedBy,
        payload: { role: roleId, runtime: role.runtime, error: error instanceof Error ? error.message : String(error) },
      })
      throw new GroupError('SPAWN_FAILED', `failed to start ${role.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const member = await this.groups.addMember(group.groupId, {
      sessionId: agentId,
      profileId: role.profile ?? 'group-member',
      name: name ?? role.name,
      role: 'member',
      status: 'idle',
      displayRole: role.name,
      roleId: roleId,
      runtime: role.runtime,
      provider: role.provider,
      model,
      reasoningLevel,
      reasoningEffort: role.reasoningEffort,
      runtimeSession: this.runtimeMetadata(agentId),
    })

    await this.activity.append({
      groupId,
      type: 'member_runtime_started',
      actorName: member.name,
      refMemberId: agentId,
      payload: { role: roleId, runtime: role.runtime, provider: role.provider, model, reasoningLevel, reasoningEffort: role.reasoningEffort },
    })
    await this.channel.post(group.groupId, {
      senderId: 'system',
      senderName: 'System',
      kind: 'system',
      text: `${member.name} joined as ${role.name} (runtime: ${role.runtime}${role.provider !== undefined ? `, provider: ${role.provider}` : ''}${model !== undefined ? `, model: ${model}` : ''}${role.reasoningEffort !== undefined ? `, reasoningEffort: ${role.reasoningEffort}` : ''}${reasoningLevel !== undefined && role.reasoningEffort === undefined ? `, reasoning: ${reasoningLevel}` : ''}).`,
    })
    return member
  }

  // ── V0.5 member runtime registry (sessions ⊃ turns ⊃ tasks) ───────────────

  /**
   * Attach a live provider session to a member and start forwarding normalized
   * runtime events into the Activity Timeline + member state machine.
   */
  private attachMemberRuntime(groupId: GroupId, memberId: string, config: RuntimeAgentConfig, session: RuntimeSession, queuedTurns: readonly RuntimeQueuedTurn[] = []): void {
    const entry: MemberRuntime = {
      kind: 'session',
      groupId,
      memberId,
      config,
      session,
      state: 'starting',
      pendingRequests: new Map(),
      activeTurn: undefined,
      queuedTurns: [...queuedTurns],
      turnSeq: queuedTurns.reduce((max, turn) => Math.max(max, turn.seq), 0),
    }
    this.memberRuntimes.set(memberId, entry)
    session.subscribe((event) => this.onRuntimeEvent(memberId, event))
  }

  /** Re-attach after a host restart using the durable member record. */
  private async resumeMemberRuntime(group: GroupRecord, member: GroupMember): Promise<void> {
    if (this.memberRuntimes.has(member.sessionId)) return
    if (member.runtime === undefined || member.runtimeSession === undefined) return
    const provider = this.runtimes.get(member.runtime)
    if (provider === undefined || !isSessionProvider(provider)) return
    const resumed = await provider.createSession({
      groupId: group.groupId,
      agentId: member.sessionId,
      role: member.roleId ?? 'generalist',
      provider: member.runtimeSession.provider,
      model: member.model,
      reasoningLevel: member.reasoningLevel,
      reasoningEffort: member.runtimeSession.reasoningEffort,
      workspace: member.runtimeSession.workspace ?? group.cwd,
      parentMemberId: group.leaderSessionId,
      metadata: { provider: member.runtimeSession.provider },
    }, member.runtimeSession as RuntimeSessionInfo)
    this.attachMemberRuntime(group.groupId, member.sessionId, {
      groupId: group.groupId,
      agentId: member.sessionId,
      role: member.roleId ?? 'generalist',
      provider: member.runtimeSession.provider,
      model: member.model,
      reasoningLevel: member.reasoningLevel,
      reasoningEffort: member.runtimeSession.reasoningEffort,
      workspace: member.runtimeSession.workspace ?? group.cwd,
      parentMemberId: group.leaderSessionId,
    }, resumed, member.runtimeSession.queuedTurns)
    this.setRuntimeState(member.sessionId, 'starting')
  }

  /** Serializable durable metadata for the member record (no secrets ever). */
  private runtimeMetadata(memberId: string): import('./core-types.js').RuntimeSessionDurable | undefined {
    const entry = this.memberRuntimes.get(memberId)
    if (entry === undefined || entry.kind !== 'session') return undefined
    const info = entry.session.info()
    return {
      runtime: info.runtime,
      provider: info.provider,
      providerSessionId: info.providerSessionId,
      providerThreadId: info.providerThreadId,
      workspace: info.workspace,
      model: info.model,
      reasoningLevel: info.reasoningLevel,
      reasoningEffort: info.reasoningEffort,
      providerCapabilities: info.providerCapabilities,
      queuedTurns: [...entry.queuedTurns],
      state: info.state,
      lastTurnId: info.lastTurnId,
      lastTaskId: info.lastTaskId,
      createdAt: info.createdAt,
      updatedAt: info.updatedAt,
    }
  }

  private persistRuntimeMetadata(groupId: GroupId, memberId: string): void {
    const durable = this.runtimeMetadata(memberId)
    if (durable === undefined) return
    void this.groups.patchMember(groupId, memberId, { runtimeSession: durable }).catch(() => undefined)
  }

  private setRuntimeState(memberId: string, state: MemberRuntimeState): void {
    const entry = this.memberRuntimes.get(memberId)
    if (entry === undefined) return
    if (entry.state === state) return
    entry.state = state
    this.notifier.emit(entry.groupId, 'member', undefined)
  }

  private runtimeStateOf(memberId: string): MemberRuntimeState | undefined {
    return this.memberRuntimes.get(memberId)?.state
  }

  private activeTurnOf(memberId: string): { turnId: string; taskId?: string } | undefined {
    return this.memberRuntimes.get(memberId)?.activeTurn
  }

  /** V0.6: authoritative view of the member's queued future turns (UI). */
  private queuedTurnsOf(memberId: string): RuntimeQueuedTurn[] | undefined {
    const queued = this.memberRuntimes.get(memberId)?.queuedTurns
    return queued !== undefined && queued.length > 0
      ? queued.map((turn) => ({ ...turn, text: turn.text.slice(0, 200) }))
      : undefined
  }

  private requestsForGroup(groupId: GroupId): RuntimeRequestView[] {
    const views: RuntimeRequestView[] = []
    for (const entry of this.memberRuntimes.values()) {
      if (entry.groupId !== groupId) continue
      for (const request of entry.pendingRequests.values()) {
        const member = this.groups.getMembership(groupId, entry.memberId)
        views.push({
          requestId: request.requestId,
          requestKind: request.requestKind,
          memberId: entry.memberId,
          memberName: member?.name ?? entry.memberId.slice(0, 8),
          turnId: request.turnId,
          taskId: request.taskId,
          description: request.description,
          timestamp: request.timestamp,
          defaultAction: request.defaultAction,
          allowedActions: request.allowedActions,
        })
      }
    }
    return views
  }

  /** Normalized runtime event → durable activity + member state machine. */
  private onRuntimeEvent(memberId: string, event: RuntimeEvent): void {
    const entry = this.memberRuntimes.get(memberId)
    if (entry === undefined || entry.kind !== 'session') return // late event after removal
    const groupId = entry.groupId
    const member = this.groups.getMembership(groupId, memberId)
    const actorName = member?.name ?? memberId.slice(0, 8)

    switch (event.type) {
      case 'session.started': {
        this.setRuntimeState(memberId, 'starting')
        if (event.metadata?.resumed !== true && !this.hasDurableSessionMetadata(entry)) {
          void this.activity.append({ groupId, type: 'runtime_session_started', actorName, refMemberId: memberId, payload: { runtime: entry.session.info().runtime } })
        }
        return
      }
      case 'session.ready': {
        if (this.hasDurableSessionMetadata(entry)) {
          this.setRuntimeState(memberId, 'idle')
          void this.activity.append({ groupId, type: 'runtime_session_resumed', actorName, refMemberId: memberId, payload: { runtime: entry.session.info().runtime } })
        } else {
          this.setRuntimeState(memberId, 'idle')
          void this.activity.append({ groupId, type: 'runtime_session_ready', actorName, refMemberId: memberId, payload: { runtime: entry.session.info().runtime, providerThreadId: event.providerThreadId } })
        }
        this.persistRuntimeMetadata(groupId, memberId)
        return
      }
      case 'session.disconnected': {
        // V0.6: a provider transport crash is NOT a member lifecycle failure.
        // The member keeps its durable identity; the session is marked
        // disconnected and re-attaches the SAME provider conversation on the
        // next dispatch. Only unrecoverable session failures destroy the
        // member status.
        this.setRuntimeState(memberId, 'disconnected')
        void this.activity.append({ groupId, type: 'runtime_session_disconnected', actorName, refMemberId: memberId, payload: { reason: event.reason } })
        if (event.unrecoverable === true) {
          void this.groups.patchMember(groupId, memberId, { error: event.reason ?? 'runtime session disconnected', status: 'failed' }).catch(() => undefined)
        } else {
          void this.groups.patchMember(groupId, memberId, { error: event.reason ?? 'runtime session disconnected' }).catch(() => undefined)
        }
        this.persistRuntimeMetadata(groupId, memberId)
        const disconnectedTask = entry.activeTurn?.taskId
        if (event.turnId !== undefined && disconnectedTask !== undefined) {
          void this.settleRuntimeAttempt(groupId, disconnectedTask, event.turnId, 'lost', event.reason)
        }
        return
      }
      case 'session.reconnecting': {
        this.setRuntimeState(memberId, 'reconnecting')
        return
      }
      case 'session.failed': {
        this.setRuntimeState(memberId, 'failed')
        void this.activity.append({ groupId, type: 'runtime_session_failed', actorName, refMemberId: memberId, payload: { reason: event.reason } })
        void this.groups.patchMember(groupId, memberId, { error: event.reason ?? 'runtime session failed', status: 'failed' }).catch(() => undefined)
        this.persistRuntimeMetadata(groupId, memberId)
        return
      }
      case 'session.closed': {
        this.setRuntimeState(memberId, 'closed')
        void this.activity.append({ groupId, type: 'runtime_session_closed', actorName, refMemberId: memberId, payload: { reason: event.reason } })
        this.persistRuntimeMetadata(groupId, memberId)
        return
      }
      case 'turn.started': {
        this.setRuntimeState(memberId, 'working')
        // V0.6: provider-initiated turns must be visible to the Host. If the
        // Host did not start this turn, adopt it as the authoritative active
        // turn so the runtime never runs a turn the Host cannot see.
        if (entry.activeTurn === undefined) {
          entry.activeTurn = { turnId: event.turnId, taskId: event.taskId }
        }
        void this.activity.append({ groupId, type: 'runtime_turn_started', actorName, refMemberId: memberId, refTaskId: event.taskId, payload: { turnId: event.turnId } })
        if (event.taskId !== undefined) {
          const info = entry.session.info()
          const started = this.tasks.startAttempt(groupId, event.taskId, {
            memberId,
            turnId: event.turnId,
            runtime: info.runtime,
            providerSessionId: info.providerSessionId,
          }).catch(() => undefined)
          this.attemptStarts.set(event.turnId, started)
        }
        this.persistRuntimeMetadata(groupId, memberId)
        return
      }
      case 'turn.queued': {
        // V0.6: single authoritative queue — the Host records every queued
        // future turn (task OR correction) and drains it after the active
        // turn reaches a terminal state.
        entry.queuedTurns.push({
          seq: ++entry.turnSeq,
          kind: event.kind,
          taskId: event.taskId,
          text: event.text,
          queuedAt: event.timestamp,
          behindTurnId: event.behindTurnId,
        })
        this.persistRuntimeMetadata(groupId, memberId)
        void this.activity.append({
          groupId,
          type: 'runtime_turn_queued',
          actorName,
          refMemberId: memberId,
          refTaskId: event.taskId,
          payload: { kind: event.kind, behindTurnId: event.behindTurnId ?? null, seq: entry.turnSeq },
        })
        this.notifier.emit(groupId, 'member', undefined)
        return
      }
      case 'turn.steered': {
        void this.activity.append({
          groupId,
          type: 'runtime_turn_steered',
          actorName,
          refMemberId: memberId,
          refTaskId: event.taskId,
          payload: { turnId: event.turnId },
        })
        this.notifier.emit(groupId, 'member', undefined)
        return
      }
      case 'turn.output.delta':
      case 'turn.reasoning.delta':
      case 'turn.tool.started':
      case 'turn.tool.completed':
        return // ephemeral streaming — NEVER written to the durable store
      case 'turn.approval.required': {
        entry.pendingRequests.set(event.request.requestId, event.request)
        this.setRuntimeState(memberId, 'needs_approval')
        void this.activity.append({ groupId, type: 'runtime_approval_required', actorName, refMemberId: memberId, refTaskId: event.request.taskId, payload: { requestId: event.request.requestId, description: event.request.description, turnId: event.request.turnId } })
        this.notifier.emit(groupId, 'member', undefined)
        return
      }
      case 'turn.input.required': {
        entry.pendingRequests.set(event.request.requestId, event.request)
        this.setRuntimeState(memberId, 'waiting_input')
        void this.activity.append({ groupId, type: 'runtime_input_required', actorName, refMemberId: memberId, refTaskId: event.request.taskId, payload: { requestId: event.request.requestId, description: event.request.description, turnId: event.request.turnId } })
        this.notifier.emit(groupId, 'member', undefined)
        return
      }
      case 'turn.permission.denied': {
        this.setRuntimeState(memberId, entry.activeTurn !== undefined ? 'working' : 'idle')
        return
      }
      case 'turn.completed': {
        // Late events from an OLD turn never touch the current one.
        if (entry.activeTurn !== undefined && entry.activeTurn.turnId !== event.turnId) return
        const completedTask = entry.activeTurn?.taskId ?? event.taskId
        entry.activeTurn = undefined
        this.setRuntimeState(memberId, 'idle')
        void this.activity.append({ groupId, type: 'runtime_turn_completed', actorName, refMemberId: memberId, refTaskId: completedTask, payload: { turnId: event.turnId, status: event.result.status } })
        // A COMPLETED TURN, not a process exit, is the completion claim:
        void this.settleRuntimeAttempt(groupId, completedTask, event.turnId, 'completed', event.result.summary)
          .then(() => this.onTurnCompleted(memberId, event.turnId, completedTask, event.result))
          .then(() => this.drainQueuedTurns(memberId))
        this.persistRuntimeMetadata(groupId, memberId)
        // V0.6: the next queued future turn starts deterministically after the
        // Attempt and bound Task both reach terminal state (same session,
        // same member). This ordering prevents a newer turn from masking the
        // older task's completion claim.
        return
      }
      case 'turn.failed': {
        if (entry.activeTurn !== undefined && entry.activeTurn.turnId !== event.turnId) return
        const failedTask = entry.activeTurn?.taskId ?? event.taskId
        entry.activeTurn = undefined
        this.setRuntimeState(memberId, 'idle')
        void this.activity.append({ groupId, type: 'runtime_turn_failed', actorName, refMemberId: memberId, refTaskId: failedTask, payload: { turnId: event.turnId, reason: event.reason } })
        void this.settleRuntimeAttempt(groupId, failedTask, event.turnId, 'failed', event.reason)
          .then(() => this.onTurnFailed(memberId, failedTask, event.reason))
          .then(() => this.drainQueuedTurns(memberId))
        this.persistRuntimeMetadata(groupId, memberId)
        return
      }
      case 'turn.cancelled': {
        if (entry.activeTurn !== undefined && entry.activeTurn.turnId !== event.turnId) return
        const cancelledTask = entry.activeTurn?.taskId ?? event.taskId
        entry.activeTurn = undefined
        this.setRuntimeState(memberId, 'idle')
        void this.activity.append({ groupId, type: 'runtime_turn_cancelled', actorName, refMemberId: memberId, refTaskId: cancelledTask, payload: { turnId: event.turnId, reason: event.reason } })
        // V0.6 cancellation policy: an interrupted turn is NOT success and NOT
        // failure — its task returns to a defined retryable state (pending),
        // the member stops carrying it, and the transition is persisted in the
        // Activity Timeline. A queued future task may then start.
        void this.settleRuntimeAttempt(groupId, cancelledTask, event.turnId, 'cancelled', event.reason)
          .then(() => this.onTurnCancelled(groupId, memberId, cancelledTask, event.reason))
          .then(() => this.drainQueuedTurns(memberId))
        this.persistRuntimeMetadata(groupId, memberId)
        return
      }
      case 'request.timeout': {
        // V0.6: a pending request expired — the provider executed its safe
        // default; the Host clears the request and persists the event.
        const request = entry.pendingRequests.get(event.requestId)
        entry.pendingRequests.delete(event.requestId)
        this.setRuntimeState(memberId, entry.activeTurn !== undefined ? 'working' : 'idle')
        void this.activity.append({
          groupId,
          type: 'runtime_request_timed_out',
          actorName,
          refMemberId: memberId,
          refTaskId: event.taskId,
          payload: {
            requestId: event.requestId,
            requestKind: event.requestKind,
            action: event.action,
            delivered: event.delivered === true,
            description: request?.description ?? null,
          },
        })
        this.notifier.emit(groupId, 'member', undefined)
        return
      }
      case 'provider.error': {
        void this.activity.append({ groupId, type: 'member_runtime_failed', actorName, refMemberId: memberId, payload: { code: event.code, error: event.message } })
        return
      }
    }
  }

  private async settleRuntimeAttempt(
    groupId: GroupId,
    taskId: string | undefined,
    turnId: string,
    status: 'completed' | 'failed' | 'cancelled' | 'lost',
    detail?: string,
  ): Promise<void> {
    if (taskId === undefined) return
    await this.attemptStarts.get(turnId)
    this.attemptStarts.delete(turnId)
    await this.tasks.settleAttempt(groupId, taskId, turnId, status, detail).catch(() => undefined)
  }

  /** Did this member enter the process with durable session metadata? */
  private hasDurableSessionMetadata(entry: SessionMemberRuntime): boolean {
    const member = this.groups.getMembership(entry.groupId, entry.memberId)
    if (member === undefined) return false
    return member.runtimeSession !== undefined && member.runtimeSession.providerSessionId !== undefined
  }

  /**
   * Turn-safe completion: the claim lands on the task that THIS turn was
   * started for (`turn.taskId`), never on whatever the member is currently
   * assigned — a late event from Turn A can never complete Turn B.
   */
  private async onTurnCompleted(memberId: string, turnId: string, taskId: string | undefined, result: RuntimeTurnResult): Promise<void> {
    const entry = this.memberRuntimes.get(memberId)
    if (entry === undefined || entry.kind !== 'session') return
    if (entry.activeTurn !== undefined) return // a newer turn is active
    const groupId = entry.groupId
    const member = this.groups.getMembership(groupId, memberId)
    if (member === undefined || member.status === 'left') return
    if (result.status !== 'completed') return
    const target = taskId ?? member.currentTaskId
    if (target === undefined) {
      // Conversational turn without an attached task — nothing to claim.
      return
    }
    try {
      const task = this.tasks.requireTask(groupId, target)
      if (task.status === 'in_progress' || task.status === 'pending' || task.status === 'blocked') {
        await this.tasks.complete(groupId, target, memberId, {
          summary: result.summary ?? `${member.name} finished the task.`,
          artifacts: result.artifacts ?? [],
          changedFiles: result.changedFiles,
          tests: result.tests as AgentTaskResult['tests'],
          risks: result.risks,
          unresolved: result.unresolved,
          completionClaim: true,
        })
        await this.groups.patchMember(groupId, memberId, { lastActiveAt: Date.now(), currentTaskId: undefined })
        const leader = this.groups.getMembership(groupId, this.groups.requireGroup(groupId).leaderSessionId)
        if (leader !== undefined) {
          await this.adapter.deliver(
            leader.sessionId,
            textContent(this.completionNotice(memberId, this.tasks.requireTask(groupId, target))),
            groupMessageSource(groupId, { direction: 'member-to-leader', label: 'task completion notice' }),
          )
        }
      }
    } catch {
      // Task missing/closed — the claim is dropped loudly (activity already
      // recorded the turn result).
    }
  }

  /** A failed turn fails the attached task LOUDLY (no silent successes). */
  private async onTurnFailed(memberId: string, taskId: string | undefined, reason: string | undefined): Promise<void> {
    const entry = this.memberRuntimes.get(memberId)
    if (entry === undefined || entry.kind !== 'session') return
    if (entry.activeTurn !== undefined) return
    const groupId = entry.groupId
    const member = this.groups.getMembership(groupId, memberId)
    if (member === undefined || member.status === 'left') return
    const target = taskId ?? member.currentTaskId
    if (target === undefined) return
    try {
      const task = this.tasks.requireTask(groupId, target)
      if (task.status === 'in_progress' || task.status === 'pending' || task.status === 'blocked') {
        await this.tasks.markFailed(groupId, target, memberId, reason ?? 'runtime turn failed')
        await this.groups.patchMember(groupId, memberId, { error: reason ?? 'runtime turn failed' })
      }
    } catch {
      // task already closed — fine
    }
  }

  /**
   * V0.6 cancellation policy: an interrupted turn is NOT a success and NOT a
   * failure. The task bound to the cancelled turn returns to a defined
   * retryable state (`pending`, reopen semantics — persisted + activity), the
   * member stops carrying it (`currentTaskId` cleared), and the member stays
   * usable on the SAME provider session.
   */
  private async onTurnCancelled(groupId: GroupId, memberId: string, taskId: string | undefined, reason: string | undefined): Promise<void> {
    const member = this.groups.getMembership(groupId, memberId)
    if (member === undefined || member.status === 'left') return
    const target = taskId ?? member.currentTaskId
    if (target === undefined) return
    try {
      const task = this.tasks.requireTask(groupId, target)
      if (task.status === 'in_progress' || task.status === 'pending' || task.status === 'blocked') {
        await this.tasks.reopen(groupId, target, memberId, `interrupted: ${reason ?? 'leader interrupt'}`)
      }
    } catch {
      // task already closed — the cancelled turn only settles itself
    }
    await this.groups.patchMember(groupId, memberId, { currentTaskId: undefined, error: undefined }).catch(() => undefined)
  }

  /**
   * V0.6: drain the authoritative per-member queue of future turns after the
   * active turn reached a terminal state (completed/failed/cancelled) or the
   * member claimed completion (DSH). Starts the next queued turn on the SAME
   * provider session — task turns and corrections run in FIFO order, and the
   * started turn's task binding is its own.
   */
  private async drainQueuedTurns(memberId: string): Promise<void> {
    const entry = this.memberRuntimes.get(memberId)
    if (entry === undefined || entry.kind !== 'session') return
    if (entry.activeTurn !== undefined) return // a turn is active — wait
    if (entry.state === 'working' || entry.state === 'waiting_input' || entry.state === 'needs_approval') return
    const next = entry.queuedTurns.shift()
    if (next === undefined) return
    if (typeof entry.session.startTaskTurn !== 'function') {
      // Provider cannot start turns — keep the item queued (never dropped).
      entry.queuedTurns.unshift(next)
      this.persistRuntimeMetadata(entry.groupId, memberId)
      return
    }
    try {
      const handle = await entry.session.startTaskTurn({ text: next.text, taskId: next.taskId, turnKind: next.kind })
      if (handle !== undefined) {
        entry.activeTurn = { turnId: handle.turnId, taskId: handle.taskId }
        this.persistRuntimeMetadata(entry.groupId, memberId)
        // V0.6: the started queued task becomes the member's current task
        // (re-applied here so a concurrent cancellation policy cannot leave
        // the cursor stale).
        if (next.kind === 'task' && next.taskId !== undefined) {
          await this.groups.patchMember(entry.groupId, memberId, { currentTaskId: next.taskId, error: undefined }).catch(() => undefined)
        }
      }
    } catch (error) {
      // The queued turn could not start — keep it queued (re-queue) and fail
      // LOUDLY so the Leader/UI can act; the member session stays intact.
      entry.queuedTurns.unshift(next)
      this.persistRuntimeMetadata(entry.groupId, memberId)
      void this.activity.append({
        groupId: entry.groupId,
        type: 'member_runtime_failed',
        actorName: memberId.slice(0, 8),
        refMemberId: memberId,
        refTaskId: next.taskId,
        payload: { code: 'TURN_START_FAILED', error: error instanceof Error ? error.message : String(error), queuedTurnRequeued: true },
      })
    }
  }

  /**
   * Deliver one task assignment / leader follow-up to a member runtime.
   *
   * V0.6 semantics (never conflated):
   *  - session idle → `startTaskTurn` (a new turn on the SAME conversation);
   *  - session busy + NEW task → `queueTaskTurn` — a separate queued future
   *    turn; the ACTIVE turn is NEVER retargeted to another task;
   *  - session busy + guidance → `steerActiveTurn` — steering into the active
   *    turn where the provider supports it; providers that cannot steer live
   *    report `{queued}` and the guidance becomes the next turn on the same
   *    session. A typed steer failure is never silently dropped.
   *  - legacy handles → text input (no exit-based completion ever).
   */
  private async deliverToMemberRuntime(groupId: GroupId, memberId: string, text: string, taskId?: string): Promise<boolean> {
    const entry = this.memberRuntimes.get(memberId)
    if (entry === undefined) {
      // A runtime member with no live session after a restart: resume failed
      // or was never attempted — fail LOUDLY, never start a fresh conversation
      // silently (requirement §21).
      const member = this.groups.getMembership(groupId, memberId)
      if (member?.runtime !== undefined && member.status !== 'left') {
        throw new GroupError('SESSION_RESUME_FAILED', `member ${member.name} has no live runtime session; the provider session could not be resumed — retry the task after resume, or spawn a new member`)
      }
      return false
    }
    if (entry.kind === 'session') {
      const session = entry.session
      const busy = entry.activeTurn !== undefined || entry.state === 'working' || entry.state === 'waiting_input' || entry.state === 'needs_approval'
      if (busy) {
        if (taskId !== undefined) {
          // NEW TASK on a busy member → a queued future turn on the SAME
          // session. The active turn keeps its own task binding.
          if (session.queueTaskTurn === undefined) {
            throw new GroupError('TURN_START_FAILED', `member runtime cannot queue a future task turn (${session.runtime}) — interrupt the current turn first`)
          }
          await session.queueTaskTurn({ text, taskId, turnKind: 'task' })
        } else {
          // Leader guidance → steering for the current work where supported.
          let outcome
          try {
            outcome = await session.steerActiveTurn?.({ text, turnKind: 'followup' })
          } catch (error) {
            // Typed steer failure (CodexSteerError): the instruction is NOT
            // dropped — it was already recorded as a queued next turn by the
            // provider (turn.queued event) before throwing. Persist the
            // failure loudly and treat the delivery as queued.
            void this.activity.append({
              groupId,
              type: 'runtime_steer_failed',
              actorName: memberId.slice(0, 8),
              refMemberId: memberId,
              payload: { code: error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'TURN_STEER_FAILED', error: error instanceof Error ? error.message : String(error), queued: true },
            })
            this.notifier.emit(groupId, 'member', undefined)
            return true
          }
          if (outcome !== undefined && 'queued' in outcome && outcome.queued === true) {
            // Provider cannot steer live — already recorded via turn.queued.
            this.notifier.emit(groupId, 'member', undefined)
          }
        }
        return true
      }
      let handle
      try {
        handle = await session.startTaskTurn({ text, taskId, turnKind: taskId !== undefined ? 'task' : 'followup' })
      } catch (error) {
        if (error instanceof GroupError) throw error
        throw new GroupError('TURN_START_FAILED', `failed to start a runtime turn for member: ${error instanceof Error ? error.message : String(error)}`)
      }
      entry.activeTurn = { turnId: handle.turnId, taskId: handle.taskId }
      return true
    }
    // legacy handle
    try {
      await entry.handle.deliver?.({ type: 'task_assignment', groupId, senderId: 'leader', recipientId: memberId, taskId, timestamp: Date.now(), payload: { text } })
        ?? entry.handle.sendInput?.(text)
    } catch {
      return false
    }
    return true
  }

  /** Legacy provider exit: NEVER a successful task result. Records stopped/failed. */
  private async onLegacyRuntimeExit(groupId: GroupId, agentId: string, result: { code: number; output: string }): Promise<void> {
    let member: GroupMember
    try {
      member = this.groups.requireMember(groupId, agentId)
    } catch {
      return // member already removed
    }
    if (member.status === 'left') return
    this.memberRuntimes.delete(agentId)
    if (result.code === 0) {
      await this.activity.append({
        groupId,
        type: 'member_runtime_stopped',
        actorName: member.name,
        refMemberId: agentId,
        payload: { exitCode: 0, role: member.roleId, runtime: member.runtime },
      })
      await this.groups.patchMember(groupId, agentId, { status: 'failed', error: 'runtime process exited without a completed turn' })
    } else {
      const snippet = result.output.trim().slice(-300)
      await this.activity.append({
        groupId,
        type: 'member_runtime_failed',
        actorName: member.name,
        refMemberId: agentId,
        payload: { exitCode: result.code, role: member.roleId, runtime: member.runtime, snippet },
      })
      await this.groups.patchMember(groupId, agentId, { error: snippet.length > 0 ? `runtime exited ${result.code}: ${snippet}` : `runtime exited ${result.code}`, status: 'failed' })
    }
  }

  /** Registry view for the Team Configuration UI (no secrets, §32/§33). */
  async runtimesView(): Promise<Array<{
    id: string
    name: string
    description?: string
    available: boolean
    readiness?: import('./runtime/base.js').RuntimeReadiness
    capabilities: import('./runtime/base.js').RuntimeCapabilities
    models: readonly import('./runtime/base.js').ModelDescriptor[]
    reasoningLevels: readonly import('./runtime/base.js').ReasoningOption[]
  }>> {
    return Promise.all(this.runtimes.list().map(async (provider) => {
      const available = await provider.isAvailable()
      return {
        id: provider.id,
        name: provider.name,
        description: provider.description,
        available,
        readiness: provider.getReadiness === undefined ? undefined : await provider.getReadiness(),
        capabilities: await provider.getCapabilities(),
        models: await provider.listModels(),
        reasoningLevels: await provider.listReasoningLevels?.() ?? [],
      }
    }))
  }

  // ── V0.4.1: live harness discovery (Role Editor data surface) ──────────────

  /**
   * Live harness view: registered providers with their per-model reasoning
   * efforts + default and credential status. NEVER contains credential values
   * (only `credentialRef` names/status; see ProviderCredentialStatus).
   */
  async discoveryView(): Promise<DiscoveryProviderView[]> {
    const discovery = this.discovery
    if (discovery === undefined) return []
    const configurable = new Set(discovery.listConfigurableProviders().map((entry) => entry.provider))
    return Promise.all(discovery.listProviders().map(async (p) => {
      const models = await discovery.listModels(p.id)
      const modelViews = await Promise.all(models.map(async (m) => {
        const reasoning = await discovery.resolveReasoning(p.id, m.id)
        return {
          id: m.id,
          name: m.name,
          ...(m.description === undefined ? {} : { description: m.description }),
          ...(reasoning === undefined ? {} : {
            reasoning: {
              efforts: reasoning.efforts,
              ...(reasoning.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort }),
            },
          }),
        }
      }))
      return {
        provider: p.id,
        name: p.name,
        configurable: configurable.has(p.id),
        models: modelViews,
        credential: await discovery.credentialStatus(p.id),
      }
    }))
  }

  /**
   * V0.4.1: true when a live discovery source is mounted AND its harness
   * services resolved — the signal for the web API's degraded-mode note.
   */
  discoveryLive(): boolean {
    if (this.discovery === undefined) return false
    return this.discovery.available?.() ?? true
  }

  /**
   * V0.4.1: LIGHT provider list for the wizard's Authentication step (id/name/
   * configurable + credential status + settings entry point — never models,
   * never credential values). `[]` when no discovery source is mounted.
   */
  async discoveryProvidersView(): Promise<DiscoveryProviderEntryView[]> {
    const discovery = this.discovery
    if (discovery === undefined) return []
    const configurable = new Set(discovery.listConfigurableProviders().map((entry) => entry.provider))
    return Promise.all(discovery.listProviders().map(async (p) => {
      const status = await discovery.credentialStatus(p.id)
      return {
        id: p.id,
        name: p.name,
        configurable: configurable.has(p.id),
        ...(status.settingsNs === undefined ? {} : { settingsNs: status.settingsNs, settingsPath: [...(status.settingsPath ?? [])] }),
        ...(status.credentialRef === undefined ? {} : { credentialRef: status.credentialRef }),
        credential: {
          ...(status.configured === undefined ? {} : { configured: status.configured }),
          ...(status.source === undefined ? {} : { source: status.source }),
          ...(status.writable === undefined ? {} : { writable: status.writable }),
        },
      }
    }))
  }

  /**
   * V0.4.1: live models + per-model reasoning for ONE provider (Model/Reasoning
   * wizard steps). `undefined` → provider unknown (web layer sends 404);
   * degraded (no source / services absent) → `{ models: [], note }`.
   */
  async providerModelsView(provider: string): Promise<{ models: readonly DiscoveryModelView[]; note?: string } | undefined> {
    const discovery = this.discovery
    if (discovery === undefined) return { models: [], note: DISCOVERY_UNAVAILABLE_NOTE }
    if ((discovery.available?.() ?? true) === false) return { models: [], note: DISCOVERY_UNAVAILABLE_NOTE }
    if (!discovery.listProviders().some((p) => p.id === provider)) return undefined
    const models = await discovery.listModels(provider)
    const views = await Promise.all(models.map(async (m) => {
      const reasoning = await discovery.resolveReasoning(provider, m.id)
      return {
        id: m.id,
        name: m.name,
        ...(m.description === undefined ? {} : { description: m.description }),
        ...(reasoning === undefined ? {} : {
          reasoning: {
            efforts: reasoning.efforts,
            ...(reasoning.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort }),
          },
        }),
      }
    }))
    return { models: views }
  }

  /**
   * V0.4.1: credential STATUS facts for ONE provider (Authentication step) —
   * never the value. `undefined` → provider unknown (404); degraded →
   * `{ credential: {}, note }`.
   */
  async providerCredentialView(provider: string): Promise<{ credential: DiscoveryProviderCredentialView; note?: string } | undefined> {
    const discovery = this.discovery
    if (discovery === undefined) return { credential: {}, note: DISCOVERY_UNAVAILABLE_NOTE }
    if ((discovery.available?.() ?? true) === false) return { credential: {}, note: DISCOVERY_UNAVAILABLE_NOTE }
    if (!discovery.listProviders().some((p) => p.id === provider)) return undefined
    const status = await discovery.credentialStatus(provider)
    const view: DiscoveryProviderCredentialView = {
      ...(status.configured === undefined ? {} : { configured: status.configured }),
      ...(status.source === undefined ? {} : { source: status.source }),
      ...(status.writable === undefined ? {} : { writable: status.writable }),
      ...(status.settingsNs === undefined ? {} : {
        entry: {
          kind: 'settings',
          settingsNs: status.settingsNs,
          settingsPath: [...(status.settingsPath ?? [])],
          ...(status.credentialRef === undefined ? {} : { credentialRef: status.credentialRef }),
        },
      }),
    }
    return { credential: view }
  }

  /** Leader view of the Team Configuration + live instance counts. */
  teamStatus(actor: string): unknown {
    const { group } = this.leaderActor(actor)
    const config = this.teamConfig(group)
    const members = this.groups.listMembers(group.groupId, () => undefined)
    return {
      leaderRoleId: config.leaderRole.id,
      roles: config.memberRoles.map((role) => ({
        id: role.id,
        name: role.name,
        runtime: role.runtime,
        model: role.model ?? null,
        reasoningLevel: role.reasoningLevel ?? null,
        profile: role.profile ?? null,
        maxInstances: role.maxInstances ?? null,
        running: members.filter((member) => member.roleId === role.id && member.status !== 'left').length,
      })),
    }
  }

  // ── Leader operations ─────────────────────────────────────────────────────

  async initGroup(
    actor: string,
    input: { name: string; objective: string; constraints?: string[]; deliverables?: string[]; acceptanceCriteria?: string[]; risks?: string[]; workspaceMode?: 'shared' | 'worktree' },
  ): Promise<GroupRecord> {
    void this.leaders.register(actor)
    const cwd = this.adapter.liveAgent(actor)?.agent.session.header.cwd
    const group = await this.groups.initGroup(actor, this.actorDisplayName(actor), input.name, input, {
      cwd,
      workspaceMode: input.workspaceMode ?? 'shared',
      teamConfig: teamConfigFor(undefined, undefined),
    })
    await this.channel.post(group.groupId, {
      senderId: 'system',
      senderName: 'System',
      kind: 'system',
      text: `Group "${group.name}" created with mission: ${input.objective}`,
    })
    return this.groups.requireGroup(group.groupId)
  }

  async spawnMember(actor: string, input: { profileId: string; name?: string; displayRole?: string }): Promise<GroupMember> {
    const { group } = this.leaderActor(actor)
    this.groups.assertDispatchable(group)
    return this.spawnMemberInto(group.groupId, input)
  }

  /**
   * Shared member materialization (leader-tool path AND user console path).
   * Guards: profile exists, optional profile-repeat policy for template slots,
   * roster cap, dispatchable. `profileRepeat` allows template count>1 slots of
   * one profile (the leader tool keeps the one-member-per-profile rule).
   */
  private async spawnMemberInto(
    groupId: string,
    input: { profileId: string; name?: string; displayRole?: string },
    opts?: { profileRepeat?: boolean },
  ): Promise<GroupMember> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    this.groups.assertDispatchable(group)
    const profile = this.profiles.require(input.profileId)
    if ((opts?.profileRepeat ?? false) !== true) {
      const existing = this.groups
        .listMembers(group.groupId, () => undefined)
        .find((member) => member.profileId === input.profileId && member.role === 'member' && member.status !== 'left')
      if (existing !== undefined) {
        throw new GroupError('ALREADY_MEMBER', `a member from profile "${input.profileId}" already exists (${existing.name})`)
      }
    }
    const memberCount = this.groups.listMembers(group.groupId, () => undefined).filter((m) => m.status !== 'left').length
    if (group.maxMembers !== undefined && memberCount >= group.maxMembers) {
      throw new GroupError('CONFLICT', `roster cap reached (maxMembers=${group.maxMembers}); raise the cap in group settings to add more`)
    }
    const memberSessionId = randomUUID()
    await this.adapter.createMemberAgent({
      sessionId: memberSessionId,
      parentId: group.leaderSessionId,
      cwd: group.cwd,
      provider: profile.provider,
      model: profile.model,
    })
    const member = await this.groups.addMember(group.groupId, {
      sessionId: memberSessionId,
      profileId: profile.id,
      name: input.name ?? profile.name,
      role: 'member',
      status: 'idle',
      ...(input.displayRole !== undefined ? { displayRole: input.displayRole } : {}),
    })
    await this.adapter.deliver(memberSessionId, textContent(this.spawnNotice(group)), groupMessageSource(group.groupId, { label: 'group membership notice' }))
    await this.channel.post(group.groupId, {
      senderId: 'system',
      senderName: 'System',
      kind: 'system',
      text: `${member.name} joined the group (profile: ${profile.name}).`,
    })
    return member
  }

  private spawnNotice(group: GroupRecord): string {
    return [
      '[Agent Groups · Welcome]',
      `You have joined the group "${group.name}" as a member.`,
      `Mission: ${group.mission.objective}`,
      `Your leader session is ${group.leaderSessionId}.`,
      'You can list the task board (group_list_tasks), claim a task (group_claim_task),',
      'post to the channel (group_post), and report privately to the leader (group_report_to_leader).',
      'You cannot direct-message another teammate; channel posts and leader reports are your group communication.',
    ].join('\n')
  }

  async addWorkstream(actor: string, input: { title: string; description?: string }): Promise<Workstream> {
    const { group } = this.leaderActor(actor)
    return this.groups.addWorkstream(group.groupId, input.title, input.description)
  }

  async replan(actor: string, input: { reason: string; mission?: Partial<Mission>; newWorkstreams?: Array<{ title: string; description?: string }> }): Promise<GroupRecord> {
    const { group } = this.leaderActor(actor)
    if (input.mission !== undefined) await this.groups.updateMission(group.groupId, input.mission)
    for (const ws of input.newWorkstreams ?? []) await this.groups.addWorkstream(group.groupId, ws.title, ws.description)
    await this.activity.append({
      groupId: group.groupId,
      type: 'leader_replanned',
      actorId: actor,
      refMemberId: group.leaderSessionId,
      payload: { reason: input.reason },
    })
    this.notifier.emit(group.groupId, 'group', undefined)
    return this.groups.requireGroup(group.groupId)
  }

  async createTask(actor: string, input: Omit<TaskInput, 'createdBy'>): Promise<GroupTask> {
    const { group } = this.leaderActor(actor)
    this.groups.assertDispatchable(group)
    return this.tasks.createTask(group.groupId, { ...input, createdBy: actor })
  }

  async createVerifierTask(actor: string, input: { overTaskId: string; subject: string; description: string; assignedBy?: string }): Promise<GroupTask> {
    const { group } = this.leaderActor(actor)
    this.groups.assertDispatchable(group)
    return this.tasks.createVerifierTask(group.groupId, input.overTaskId, {
      subject: input.subject,
      description: input.description,
      kind: 'verification',
      acceptanceCriteria: ['Pass/fail evidence reported'],
      expectedArtifacts: ['verdict + evidence'],
      priority: 'high',
      createdBy: actor,
      assignedBy: input.assignedBy,
    })
  }

  async assignTask(actor: string, input: { taskId: string; ownerId: string; expectedRevision?: number; deliver?: boolean }): Promise<GroupTask> {
    const { group } = this.leaderActor(actor)
    this.groups.assertDispatchable(group)
    this.groups.requireMember(group.groupId, input.ownerId)
    const task = await this.tasks.assign(group.groupId, input.taskId, input.ownerId, actor, input.expectedRevision, input.deliver !== false)
    if (input.deliver !== false) {
      await this.dispatchAssignedTask(group, task, input.ownerId, actor)
    }
    return task
  }

  /**
   * V0.6: deliver an assigned task to its owner's runtime with the correct
   * turn semantics — a new TURN when idle, a QUEUED future turn when the
   * member is busy (never a retarget of the running turn).
   */
  private async dispatchAssignedTask(group: GroupRecord, task: GroupTask, ownerId: string, assignedBy: string): Promise<void> {
    const leaseId = await this.tasks.beginDispatch(group.groupId, task.taskId, ownerId)
    try {
      // record the member's current task (external runtimes cannot claim themselves)
      await this.groups.patchMember(group.groupId, ownerId, { currentTaskId: task.taskId })
      const message = createRuntimeMessage({
        type: 'task_assignment',
        groupId: group.groupId,
        senderId: assignedBy,
        recipientId: ownerId,
        taskId: task.taskId,
        priority: task.priority,
        payload: {
          taskId: task.taskId,
          subject: task.subject,
          description: task.description,
          kind: task.kind,
          acceptanceCriteria: task.acceptanceCriteria,
          writeScopes: task.writeScopes,
          blockedBy: task.blockedBy,
          taskBrief: this.taskBrief(group, task),
        },
      })
      const text = runtimeMessageText(message)
      if (this.memberRuntimes.has(ownerId)) {
        // Runtime members route through their persistent SESSION: the
        // assignment becomes a TURN (or a queued future turn when busy), and
        // the session ensures the member's OWN configuration on attach.
        await this.deliverToMemberRuntime(group.groupId, ownerId, text, task.taskId)
      } else if (this.groups.getMembership(group.groupId, ownerId)?.runtime !== undefined) {
        // A runtime member with no live session = resume failed or was never
        // attempted — fail LOUDLY; never start a fresh conversation silently.
        const ownerRecord = this.groups.requireMember(group.groupId, ownerId)
        throw new GroupError('SESSION_RESUME_FAILED', `member ${ownerRecord.name} has no live runtime session; the provider session could not be resumed — retry the task after resume, or spawn a new member`)
      } else {
        // Plain DSH profile members keep the waking deliver path.
        await this.adapter.deliver(
          ownerId,
          textContent(text),
          groupMessageSource(group.groupId, { direction: 'leader-to-member', label: 'task assignment' }),
        )
      }
      await this.tasks.markDispatchDelivered(group.groupId, task.taskId, leaseId)
    } catch (error) {
      const reason = `task delivery outcome is uncertain: ${error instanceof Error ? error.message : String(error)}`
      await this.tasks.markDispatchAmbiguous(group.groupId, task.taskId, leaseId, reason).catch(() => undefined)
      const latest = this.tasks.requireTask(group.groupId, task.taskId)
      if (latest.status !== 'completed' && latest.status !== 'review' && latest.status !== 'failed') {
        await this.tasks.markFailed(group.groupId, task.taskId, 'runtime-dispatcher', reason).catch(() => undefined)
      }
      await this.groups.patchMember(group.groupId, ownerId, { currentTaskId: undefined, error: reason }).catch(() => undefined)
      throw error
    }
  }

  async verifyTask(actor: string, input: { taskId: string; passed: boolean; notes?: string }): Promise<GroupTask> {
    const { group } = this.leaderActor(actor)
    const task = await this.tasks.verify(group.groupId, input.taskId, actor, input.passed, input.notes)
    if (input.passed && task.ownerId !== undefined) {
      await this.groups.patchMember(group.groupId, task.ownerId, { currentTaskId: undefined })
    }
    return task
  }

  async reopenTask(actor: string, input: { taskId: string; reason?: string }): Promise<GroupTask> {
    const { group } = this.leaderActor(actor)
    this.groups.assertDispatchable(group)
    return this.tasks.reopen(group.groupId, input.taskId, actor, input.reason)
  }

  async retryTask(actor: string, input: { taskId: string; subject?: string }): Promise<GroupTask> {
    const { group } = this.leaderActor(actor)
    this.groups.assertDispatchable(group)
    const original = this.tasks.requireTask(group.groupId, input.taskId)
    return this.tasks.createTask(group.groupId, {
      subject: input.subject ?? `Retry: ${original.subject}`,
      description: original.description,
      kind: original.kind,
      acceptanceCriteria: original.acceptanceCriteria,
      expectedArtifacts: original.expectedArtifacts,
      priority: original.priority,
      writeScopes: original.writeScopes,
      blockedBy: original.blockedBy,
      createdBy: actor,
      retryOf: original.taskId,
    })
  }

  async markTaskFailed(actor: string, input: { taskId: string; reason: string }): Promise<GroupTask> {
    const { group } = this.leaderActor(actor)
    return this.tasks.markFailed(group.groupId, input.taskId, actor, input.reason)
  }

  async messageMember(actor: string, input: { memberSessionId: string; text: string }): Promise<PrivateMessage> {
    const { group } = this.leaderActor(actor)
    const member = this.groups.requireMember(group.groupId, input.memberSessionId)
    const message = await this.privateMessages.send(group.groupId, {
      senderId: actor,
      senderName: this.actorDisplayName(actor),
      recipientId: member.sessionId,
      direction: 'leader-to-member',
      text: input.text,
    })
    // V0.5: the leader's follow-up reaches the member's RUNTIME — the same
    // Codex thread / Claude session / DSH agent (never a brand-new agent).
    if (this.memberRuntimes.has(member.sessionId)) {
      await this.deliverToMemberRuntime(group.groupId, member.sessionId, `[Private message from Leader]\n${input.text}`)
    } else {
      await this.adapter.deliver(
        member.sessionId,
        textContent(`[Private message from Leader]\n${input.text}`),
        groupMessageSource(group.groupId, { direction: 'leader-to-member', label: 'private message from Leader' }),
      )
    }
    return message
  }

  async broadcast(actor: string, input: { text: string; kind?: 'message' | 'status' | 'task'; replyToMessageId?: string }): Promise<ChannelMessage> {
    const { group } = this.leaderActor(actor)
    return this.channel.post(group.groupId, { senderId: actor, senderName: this.actorDisplayName(actor), kind: input.kind, text: input.text, replyToMessageId: input.replyToMessageId })
  }

  async interruptMember(actor: string, input: { memberSessionId: string; reason: string }): Promise<boolean> {
    const { group } = this.leaderActor(actor)
    this.groups.requireMember(group.groupId, input.memberSessionId)
    let ok = this.adapter.interrupt(input.memberSessionId, input.reason)
    const entry = this.memberRuntimes.get(input.memberSessionId)
    if (entry?.kind === 'session' && entry.session.interrupt !== undefined) {
      try {
        await entry.session.interrupt(input.reason)
        ok = true
      } catch {
        ok = ok // DSH interrupt already handled it
      }
    }
    // V0.6: the interruption itself is NOT a success — the runtime emits
    // `turn.cancelled` and the Host applies the cancellation policy (task →
    // pending/retryable, activity persisted, queued future turns may start).
    // The member keeps its durable identity; no error is carved into the
    // roster for a normal interrupt.
    await this.activity.append({
      groupId: group.groupId,
      type: 'member_interrupted',
      actorId: actor,
      refMemberId: input.memberSessionId,
      payload: { reason: input.reason },
    })
    return ok
  }

  async completeMission(actor: string, groupId?: GroupId): Promise<GroupRecord> {
    const { group } = this.leaderActor(actor, groupId)
    const reopened = (await this.tasks.listTasks(group.groupId)).filter(
      (task) => task.status !== 'completed' && task.status !== 'failed',
    )
    const completed = await this.groups.completeMission(group.groupId, actor)
    await this.channel.post(group.groupId, {
      senderId: actor,
      senderName: this.actorDisplayName(actor),
      kind: 'status',
      text: reopened.length > 0
        ? `Leader completed the mission with ${reopened.length} open task(s).`
        : 'Leader completed the mission. All tasks closed.',
    })
    return completed
  }

  // ── Member operations ─────────────────────────────────────────────────────

  async claimTask(actor: string, input: { taskId: string; expectedRevision?: number }, groupId?: GroupId): Promise<GroupTask> {
    const { group } = this.memberContext(actor, groupId)
    this.groups.assertDispatchable(group)
    const task = await this.tasks.claim(group.groupId, input.taskId, actor, input.expectedRevision)
    await this.groups.patchMember(group.groupId, actor, { currentTaskId: task.taskId })
    return task
  }

  async completeTask(actor: string, input: { taskId: string; summary: string; artifacts: string[]; changedFiles?: string[]; tests?: AgentTaskResult['tests']; risks?: string[]; unresolved?: string[]; completionClaim: boolean }, groupId?: GroupId): Promise<GroupTask> {
    const { group } = this.memberContext(actor, groupId)
    const task = await this.tasks.complete(group.groupId, input.taskId, actor, {
      summary: input.summary,
      artifacts: input.artifacts,
      changedFiles: input.changedFiles,
      tests: input.tests,
      risks: input.risks,
      unresolved: input.unresolved,
      completionClaim: input.completionClaim,
    })
    await this.groups.patchMember(group.groupId, actor, { lastActiveAt: Date.now(), currentTaskId: undefined })
    // DSH members claim their own completion → the runtimes settle to idle.
    const entry = this.memberRuntimes.get(actor)
    if (entry?.kind === 'session') {
      // V0.6: the claim is the DSH turn's terminal state — clear the active
      // turn cursor so the next queued future task starts deterministically
      // on the SAME DSH session.
      if (entry.activeTurn !== undefined) entry.activeTurn = undefined
      this.setRuntimeState(actor, 'idle')
      this.persistRuntimeMetadata(group.groupId, actor)
      void this.drainQueuedTurns(actor)
    }
    const leader = this.groups.getMembership(group.groupId, group.leaderSessionId)
    if (leader !== undefined) {
      await this.adapter.deliver(
        group.leaderSessionId,
        textContent(this.completionNotice(actor, task)),
        groupMessageSource(group.groupId, { direction: 'member-to-leader', label: 'task completion notice' }),
      )
    }
    return task
  }

  private completionNotice(actor: string, task: GroupTask): string {
    return [
      `[Task completion · ${task.subject}]`,
      `Member ${actor} submitted a completion claim for task ${task.taskId}.`,
      `Summary: ${task.result?.summary ?? '(none)'}`,
      `Artifacts: ${(task.result?.artifacts ?? []).join(', ') || '(none)'}`,
      `Review it with leader_verify_task(taskId="${task.taskId}", passed=<bool>).`,
    ].join('\n')
  }

  async postChannel(actor: string, input: { text: string; replyToMessageId?: string }, groupId?: GroupId): Promise<ChannelMessage> {
    const { group } = this.memberContext(actor, groupId)
    return this.channel.post(group.groupId, { senderId: actor, senderName: this.actorDisplayName(actor), text: input.text, replyToMessageId: input.replyToMessageId })
  }

  async reportToLeader(actor: string, input: { text: string }, groupId?: GroupId): Promise<PrivateMessage> {
    const { group } = this.memberContext(actor, groupId)
    const message = await this.privateMessages.send(group.groupId, {
      senderId: actor,
      senderName: this.actorDisplayName(actor),
      recipientId: group.leaderSessionId,
      direction: 'member-to-leader',
      text: input.text,
    })
    await this.adapter.deliver(
      group.leaderSessionId,
      textContent(`[Private report from member ${this.actorDisplayName(actor)}]\n${input.text}`),
      groupMessageSource(group.groupId, { direction: 'member-to-leader', label: 'private report from member' }),
    )
    return message
  }

  async actorStatus(actor: string, groupId?: GroupId): Promise<{ groupId: string; role: 'leader' | 'member'; status: AgentMemberStatus }> {
    const { group, member } = this.memberContext(actor, groupId)
    const live = this.adapter.liveAgent(actor)
    return { groupId: group.groupId, role: member.role, status: member.role === 'member' ? resolveLiveStatus(member.status, live?.status) : member.status }
  }

  // ── reads (both roles + web) ──────────────────────────────────────────────

  roster(actor: string, groupId?: GroupId): MemberView[] {
    const { group } = this.actorContext(actor, groupId)
    return this.groups.listMembers(group.groupId, (sessionId) => this.adapter.liveAgent(sessionId)?.status)
  }

  taskBoard(actor: string, groupId?: GroupId): GroupTask[] {
    const { group } = this.actorContext(actor, groupId)
    return this.tasks.listTasks(group.groupId)
  }

  taskDetail(actor: string, taskId: string, groupId?: GroupId): GroupTask {
    const { group } = this.actorContext(actor, groupId)
    return this.tasks.requireTask(group.groupId, taskId)
  }

  channelFeed(actor: string, groupId?: GroupId, limit = 200): ChannelMessage[] {
    const { group } = this.actorContext(actor, groupId)
    return this.channel.list(group.groupId, limit)
  }

  privateMessagesView(actor: string, groupId?: GroupId): PrivateMessage[] {
    const { group } = this.actorContext(actor, groupId)
    const membership = this.groups.getMembership(group.groupId, actor)
    if (membership?.role === 'leader') return this.privateMessages.listForGroup(group.groupId, actor)
    return this.privateMessages.listForPrincipal(group.groupId, actor)
  }

  profilesView(): AgentProfile[] {
    return this.profiles.list()
  }

  activityFeed(actor: string, groupId?: GroupId, limit = 500): ActivityEvent[] {
    const { group } = this.actorContext(actor, groupId)
    return this.activity.list(group.groupId, limit)
  }

  private actorContext(actor: string, groupId?: GroupId): { group: GroupRecord } {
    if (groupId !== undefined) {
      const group = this.groups.requireGroup(groupId)
      if (!this.groups.isLeader(groupId, actor) && !this.groups.isMember(groupId, actor)) {
        throw new GroupError('NO_GROUP', `actor ${actor} is not part of group ${groupId}`)
      }
      return { group }
    }
    const group = this.groups.groupForActor(actor)
    if (group === undefined) throw new GroupError('NO_GROUP', 'actor is not in a group')
    return { group }
  }

  // ── web / user ────────────────────────────────────────────────────────────

  /** Compact overview used by leader_status / leader_wait. */
  statusOverview(actor: string): unknown {
    try {
      const { group } = this.leaderActor(actor)
      const roster = this.groups.listMembers(group.groupId, (sessionId) => this.adapter.liveAgent(sessionId)?.status)
      const tasks = this.tasks.listTasks(group.groupId)
      const channel = this.channel.list(group.groupId, 40)
      return {
        group: { id: group.groupId, name: group.name, status: group.status, mission: group.mission.objective, workstreams: group.workstreams },
        members: roster.map((member) => ({
          sessionId: member.sessionId,
          name: member.name,
          profileId: member.profileId,
          status: member.liveStatus,
          currentTask: member.currentTaskId ?? null,
        })),
        tasks: tasks.map((task) => ({
          taskId: task.taskId,
          subject: task.subject,
          status: task.status,
          owner: task.ownerId ?? null,
          kind: task.kind,
          blockedBy: task.blockedBy,
          writeScopes: task.writeScopes,
        })),
        recentActivity: channel.slice(-10),
      }
    } catch (error) {
      if (error instanceof GroupError && error.code === 'NO_GROUP') {
        return { note: 'No group is bound to this session yet. Call leader_init_group first.' }
      }
      throw error
    }
  }

  listGroupsForWeb(includeArchived = false): GroupListItem[] {
    return this.groups
      .listGroups()
      .filter((group) => includeArchived || group.archivedAt === undefined)
      .map((group) => {
        const members = this.groups.listMembers(group.groupId, () => undefined)
        return {
          groupId: group.groupId,
          name: group.name,
          status: group.status,
          leaderSessionId: group.leaderSessionId,
          missionObjective: group.mission.objective,
          memberCount: members.filter((member) => member.status !== 'left').length,
          taskCount: this.tasks.listTasks(group.groupId).length,
          createdAt: group.createdAt,
          updatedAt: group.updatedAt,
          pausedAt: group.pausedAt,
          archivedAt: group.archivedAt,
        }
      })
      .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
  }

  async userMessageToLeader(groupId: GroupId, text: string): Promise<boolean> {
    const group = this.groups.requireGroup(groupId)
    if (group.status === 'completed' || group.archivedAt !== undefined) return false
    await this.privateMessages.send(group.groupId, {
      senderId: 'user',
      senderName: 'User',
      recipientId: group.leaderSessionId,
      direction: 'user-to-leader',
      text,
    })
    return this.adapter.deliver(group.leaderSessionId, textContent(text), { kind: 'user' })
  }

  /** V0.2: Leader replies to the user inside the Agent Groups page Leader Chat. */
  async leaderReplyToUser(actor: string, input: { text: string }): Promise<PrivateMessage> {
    const { group } = this.leaderActor(actor)
    return this.privateMessages.send(group.groupId, {
      senderId: actor,
      senderName: this.actorDisplayName(actor),
      recipientId: 'user',
      direction: 'leader-to-user',
      text: input.text,
    })
  }

  /** V0.2: Leader edits the shared Mission Notes. */
  async leaderUpdateNotes(actor: string, input: { notes: string }): Promise<GroupRecord> {
    const { group } = this.leaderActor(actor)
    return this.groups.updateNotes(group.groupId, input.notes, this.actorDisplayName(actor))
  }

  /** V0.2: Leader pauses/resumes its own group (dispatch gate only). */
  async leaderSetPaused(actor: string, paused: boolean): Promise<GroupRecord> {
    const { group } = this.leaderActor(actor)
    const record = await this.groups.setPaused(group.groupId, paused, this.actorDisplayName(actor))
    return record
  }

  /** V0.2: user → team broadcast, posted on the Group Channel. */
  async userBroadcast(groupId: GroupId, text: string): Promise<ChannelMessage> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    return this.channel.post(group.groupId, { senderId: 'user', senderName: 'User', text })
  }

  // ── V0.2: user console (create / manage team) ─────────────────────────────

  /**
   * Create a group from the Agent Groups page: binds a KNOWN leader session (one that
   * already acted as a Leader) so the role model is never bypassed; the bound
   * session must own no group yet. Optional team template materializes the
   * member slots immediately (custom member lists allowed instead).
   */
  async userCreateGroup(input: {
    leaderSessionId: string
    name: string
    objective: string
    constraints?: string[]
    deliverables?: string[]
    acceptanceCriteria?: string[]
    risks?: string[]
    templateId?: string
    maxMembers?: number
    workspaceMode?: 'shared' | 'worktree'
    members?: Array<{ role?: string; profile: string; name?: string }>
  }): Promise<GroupRecord> {
    const { leaderSessionId } = input
    if (!this.leaders.isKnown(leaderSessionId)) {
      throw new GroupError('NOT_LEADER', `session ${leaderSessionId} has not acted as a Leader yet — start a session with the Team Lead preset and chat with it first`)
    }
    if (this.groups.groupForActor(leaderSessionId) !== undefined) {
      throw new GroupError('ACTIVE_GROUP_EXISTS', `session ${leaderSessionId} already belongs to a group`)
    }
    const cwd = this.adapter.liveAgent(leaderSessionId)?.agent.session.header.cwd
    const group = await this.groups.initGroup(leaderSessionId, 'Leader', input.name, input, {
      templateId: input.templateId,
      maxMembers: input.maxMembers,
      cwd,
      workspaceMode: input.workspaceMode ?? 'shared',
      teamConfig: teamConfigFor(input.templateId, undefined),
    })
    await this.channel.post(group.groupId, {
      senderId: 'system',
      senderName: 'System',
      kind: 'system',
      text: `Group "${group.name}" created via the Agent Groups page with mission: ${input.objective}`,
    })
    let slots: Array<{ role?: string; profile: string; name?: string }> = input.members ?? []
    if (input.templateId !== undefined && slots.length === 0) {
      const template = requireTemplate(input.templateId)
      slots = templateMemberSlots(template).map((slot) => ({ ...slot }))
    }
    const profileCounts = new Map<string, number>()
    for (const slot of slots) {
      const repeat = profileCounts.get(slot.profile) ?? 0
      profileCounts.set(slot.profile, repeat + 1)
      const name = slot.name ?? (repeat === 0 ? slot.role : `${slot.role} ${repeat + 1}`)
      try {
        await this.spawnMemberInto(group.groupId, { profileId: slot.profile, name, displayRole: slot.role }, { profileRepeat: true })
      } catch (error) {
        if (error instanceof GroupError && (error.code === 'ALREADY_MEMBER' || error.code === 'PAUSED' || error.code === 'CONFLICT')) {
          await this.channel.post(group.groupId, {
            senderId: 'system',
            senderName: 'System',
            kind: 'system',
            text: `Skipped member slot ${slot.profile}: ${error.message}`,
          })
          continue
        }
        throw error
      }
    }
    return this.groups.requireGroup(group.groupId)
  }

  /** V0.2: Agent Groups page "Add Member" — same gates as the leader spawn path. */
  async userSpawnMember(groupId: GroupId, input: { profileId: string; name?: string; displayRole?: string }): Promise<GroupMember> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    this.groups.assertDispatchable(group)
    return this.spawnMemberInto(group.groupId, input)
  }

  /** V0.2: remove/archive a member; history and messages stay (第 9 节). */
  async userRemoveMember(groupId: GroupId, memberSessionId: string): Promise<void> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    const member = this.groups.requireMember(group.groupId, memberSessionId)
    if (member.role === 'leader') throw new GroupError('CONFLICT', 'the Leader cannot be removed')
    // Mark the member left FIRST so a concurrent runtime callback (from the
    // session or a stop) cannot resurrect it; then close the runtime session
    // / dispose the DSH handle.
    await this.groups.removeMember(group.groupId, memberSessionId)
    const entry = this.memberRuntimes.get(memberSessionId)
    this.memberRuntimes.delete(memberSessionId)
    if (entry?.kind === 'session') {
      await entry.session.close().catch(() => undefined)
    } else if (entry?.kind === 'legacy') {
      await entry.handle.stop().catch(() => undefined)
    }
    await this.adapter.disposeMember(memberSessionId)
    await this.activity.append({
      groupId,
      type: 'member_removed',
      actorName: 'User',
      refMemberId: memberSessionId,
      payload: { name: member.name, profileId: member.profileId },
    })
    await this.channel.post(group.groupId, {
      senderId: 'system',
      senderName: 'System',
      kind: 'system',
      text: `${member.name} was removed from the team.`,
    })
  }

  /** V0.2: rename the display name / display role of a member. */
  async userPatchMember(
    groupId: GroupId,
    memberSessionId: string,
    patch: { name?: string; displayRole?: string },
  ): Promise<GroupMember | undefined> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    return this.groups.patchMember(group.groupId, memberSessionId, patch)
  }

  // ── V0.6: user console runtime actions (same Host contract, User actor) ──

  /**
   * V0.6: the User can create a task from the Agent Groups page (the Leader
   * keeps the full leader_create_task surface; this is the page console path).
   */
  async userCreateTask(groupId: GroupId, input: { subject: string; description?: string; kind?: TaskKind; acceptanceCriteria?: string[]; priority?: TaskPriority; ownerId?: string }): Promise<GroupTask> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    this.groups.assertDispatchable(group)
    const task = await this.tasks.createTask(group.groupId, {
      subject: input.subject,
      description: input.description ?? '',
      kind: input.kind ?? 'implementation',
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      priority: input.priority,
      createdBy: 'User',
    })
    if (input.ownerId !== undefined) {
      this.groups.requireMember(group.groupId, input.ownerId)
      await this.tasks.assign(group.groupId, task.taskId, input.ownerId, 'User')
      await this.dispatchAssignedTask(group, task, input.ownerId, 'User')
    }
    return task
  }

  /** V0.6: assign an existing task to a member from the page console. */
  async userAssignTask(groupId: GroupId, taskId: string, ownerId: string): Promise<GroupTask> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    this.groups.assertDispatchable(group)
    this.groups.requireMember(group.groupId, ownerId)
    const task = await this.tasks.assign(group.groupId, taskId, ownerId, 'User')
    await this.dispatchAssignedTask(group, task, ownerId, 'User')
    return task
  }

  /**
   * V0.6: the User can send a CORRECTION about a member's current work — it
   * routes through the same runtime steering/queue semantics as the Leader's
   * guidance (never spawns a replacement member, never retargets a turn).
   */
  async userSendCorrection(groupId: GroupId, memberId: string, text: string): Promise<boolean> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    this.groups.requireMember(group.groupId, memberId)
    const message = `[User correction]\n${text}`
    if (this.memberRuntimes.has(memberId)) {
      return this.deliverToMemberRuntime(group.groupId, memberId, message)
    }
    return this.adapter.deliver(memberId, textContent(message), groupMessageSource(group.groupId, { label: 'user correction' }))
  }

  /** V0.6: the User can interrupt a member's current turn (User actor). */
  async userInterruptMember(groupId: GroupId, memberId: string, reason: string): Promise<boolean> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    this.groups.requireMember(group.groupId, memberId)
    let ok = this.adapter.interrupt(memberId, reason)
    const entry = this.memberRuntimes.get(memberId)
    if (entry?.kind === 'session' && entry.session.interrupt !== undefined) {
      try {
        await entry.session.interrupt(reason)
        ok = true
      } catch {
        ok = ok // DSH interrupt already handled it
      }
    }
    await this.activity.append({
      groupId,
      type: 'member_interrupted',
      actorId: 'User',
      refMemberId: memberId,
      payload: { reason },
    })
    return ok
  }

  async userPauseGroup(groupId: GroupId, paused: boolean): Promise<GroupRecord> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    return this.groups.setPaused(group.groupId, paused, 'User')
  }

  async userArchiveGroup(groupId: GroupId, archived: boolean): Promise<GroupRecord> {
    const group = this.groups.requireGroup(groupId)
    if (group.status === 'completed' && !archived) {
      // restoring a completed group is allowed (settings), keep status
    }
    return this.groups.archiveGroup(group.groupId, archived, 'User')
  }

  async userDuplicateGroup(groupId: GroupId, name?: string): Promise<GroupRecord> {
    const group = this.groups.requireGroup(groupId)
    if (group.status !== 'completed' && group.archivedAt === undefined) {
      throw new GroupError('CONFLICT', 'duplicate only after the mission is completed or archived — one active group per Leader')
    }
    const copy = await this.groups.duplicateGroup(group.groupId, name)
    const roster = this.groups.listMembers(group.groupId, () => undefined).filter((m) => m.role === 'member' && m.status !== 'left')
    for (const member of roster) {
      try {
        await this.spawnMemberInto(copy.groupId, {
          profileId: member.profileId,
          name: member.name,
          displayRole: member.displayRole,
        })
      } catch {
        // a full roster copy is best-effort; per-profile duplicates are skipped
      }
    }
    await this.channel.post(copy.groupId, {
      senderId: 'system',
      senderName: 'System',
      kind: 'system',
      text: `Group duplicated from "${group.name}" via the Agent Groups page.`,
    })
    return copy
  }

  async userUpdateNotes(groupId: GroupId, notes: string): Promise<GroupRecord> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    return this.groups.updateNotes(group.groupId, notes, 'User')
  }

  async userUpdateSettings(groupId: GroupId, patch: { name?: string; maxMembers?: number }): Promise<GroupRecord> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    return this.groups.updateGroupSettings(group.groupId, patch, 'User')
  }

  /** V0.2: Agent Groups page task editing (leader/user console; 第 12 节). */
  async userEditTask(groupId: GroupId, taskId: string, patch: TaskUpdatePatch): Promise<GroupTask> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    return this.tasks.updateTask(group.groupId, taskId, 'user', patch)
  }

  /** V0.2: Agent Groups page hold/release (kanban Ready ↔ Blocked, 第 13 节). */
  async userHoldTask(groupId: GroupId, taskId: string, held: boolean): Promise<GroupTask> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    return this.tasks.setHeld(group.groupId, taskId, 'user', held)
  }

  /** V0.2: Agent Groups page pin/unpin (第 22 节). */
  async userPinMessage(groupId: GroupId, messageId: string, pinned: boolean): Promise<ChannelMessage> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    return this.channel.setPinned(group.groupId, messageId, 'user', pinned)
  }

  // ── V0.2: workspace (第 24–26 节) ─────────────────────────────────────────

  /** Derived workspace view: notes + artifacts from structured task results. */
  workspaceView(groupId: GroupId): { notes?: string; notesUpdatedAt?: number; artifacts: WorkspaceArtifact[] } {
    const group = this.groups.requireGroup(groupId)
    const artifacts: WorkspaceArtifact[] = []
    for (const task of this.tasks.listTasks(group.groupId)) {
      const result = task.result
      if (result === undefined) continue
      for (const path of result.artifacts ?? []) {
        artifacts.push({ path, source: 'artifact', taskId: task.taskId, taskSubject: task.subject, createdBy: result.submittedAt ? task.ownerId ?? group.leaderSessionId : group.leaderSessionId, createdAt: result.submittedAt })
      }
      for (const path of result.changedFiles ?? []) {
        artifacts.push({ path, source: 'changed', taskId: task.taskId, taskSubject: task.subject, createdBy: task.ownerId ?? group.leaderSessionId, createdAt: result.submittedAt })
      }
    }
    // de-duplicate by path+task (a changed file listed as artifact twice)
    const seen = new Set<string>()
    const unique = artifacts.filter((artifact) => {
      const key = `${artifact.taskId}:${artifact.path}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return { notes: group.notes, notesUpdatedAt: group.notesUpdatedAt, artifacts: unique }
  }

  /** V0.2: read a text preview of one artifact (contained under group cwd). */
  artifactPreview(groupId: GroupId, path: string): { ok: true; text: string } | { ok: false; error: string } {
    const group = this.groups.requireGroup(groupId)
    const cwd = group.cwd
    if (cwd === undefined) return { ok: false, error: 'group has no workspace root (leader session offline); cannot preview files' }
    const target = normalize(join(cwd, path))
    if (target !== cwd && !target.startsWith(`${normalize(cwd)}/`)) {
      return { ok: false, error: 'path escapes the group workspace' }
    }
    try {
      const buffer = readFileSync(target)
      const max = 16 * 1024
      const text = buffer.toString('utf8').slice(0, max)
      return { ok: true, text }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** V0.2: leader picker for Create Group UI. */
  listLeadersForWeb(): Array<KnownLeader & { hasActiveGroup: boolean; boundGroupId?: string }> {
    return this.leaders.list().map((leader) => {
      const group = this.groups.groupForActor(leader.sessionId)
      return {
        ...leader,
        hasActiveGroup: group !== undefined,
        boundGroupId: group?.groupId,
      }
    })
  }

  /** V0.2: templates exposed to the Agent Groups page (第 3/4 节). */
  templates(): readonly TeamTemplate[] {
    return listTemplates()
  }

  /** V0.2: agent profiles + deployment agent presets (第 7 节). */
  profilesViewWithPresets(): { profiles: AgentProfile[]; presets: Array<{ id: string; name?: string; description?: string }> } {
    return { profiles: this.profiles.list(), presets: readDeploymentPresets() }
  }

  snapshot(groupId: GroupId, compatibility: CompatibilityReport): GroupSnapshot {
    const group = this.groups.requireGroup(groupId)
    const members = this.groups.listMembers(groupId, (sessionId) => this.adapter.liveAgent(sessionId)?.status)
    const leaderLive = this.adapter.liveAgent(group.leaderSessionId) !== undefined
    return {
      group,
      members: members.map((member) => ({
        ...member,
        liveStatus: member.liveStatus,
        runtimeState: this.runtimeStateOf(member.sessionId),
        currentTurnId: this.activeTurnOf(member.sessionId)?.turnId,
        runtimeQueuedTurns: this.queuedTurnsOf(member.sessionId),
      })),
      tasks: this.tasks.listTasks(groupId),
      channel: this.channel.list(groupId),
      privateMessages: this.privateMessages.listForGroup(groupId, group.leaderSessionId),
      activity: this.activity.list(groupId),
      profiles: this.profiles.list(),
      leaderLive,
      compatibility,
      runtimeRequests: this.requestsForGroup(groupId),
    }
  }

  // ── V0.5: runtime request answering (approval / input / permission) ───────

  /**
   * Answer a pending provider request (approval / user input) surfaced by the
   * Team UI. The Host contract is policy, not prompts: membership/role checks
   * happen here; the provider never auto-approves.
   */
  async respondRuntimeRequest(groupId: GroupId, memberId: string, requestId: string, action: string, payload?: unknown): Promise<boolean> {
    const group = this.groups.requireGroup(groupId)
    this.groups.assertMutable(group)
    this.groups.requireMember(groupId, memberId)
    const entry = this.memberRuntimes.get(memberId)
    if (entry === undefined || entry.kind !== 'session') return false
    const request = entry.pendingRequests.get(requestId)
    if (request === undefined) return false
    const answered = await entry.session.respondToRequest?.(requestId, action, payload) ?? false
    if (answered) {
      entry.pendingRequests.delete(requestId)
      await this.activity.append({
        groupId,
        type: request.requestKind === 'input' ? 'runtime_request_answered' : 'runtime_approval_answered',
        actorName: 'User',
        refMemberId: memberId,
        refTaskId: request.taskId,
        payload: { requestId, action, requestKind: request.requestKind },
      })
      this.setRuntimeState(memberId, entry.activeTurn !== undefined ? 'working' : 'idle')
      this.notifier.emit(groupId, 'member', undefined)
    }
    return answered
  }

  /** V0.5: advanced/debug runtime view (thread/session ids belong HERE, not
   * in the primary UI). Never includes credentials. */
  runtimeSessionsView(groupId: GroupId): unknown[] {
    const out: unknown[] = []
    for (const entry of this.memberRuntimes.values()) {
      if (entry.groupId !== groupId) continue
      if (entry.kind === 'session') {
        out.push({ memberId: entry.memberId, ...entry.session.info() })
      } else {
        out.push({ memberId: entry.memberId, runtime: 'legacy-process', state: entry.state, external: true })
      }
    }
    return out
  }

  /** V0.5/V0.6: re-attach every durable member session after a host restart. */
  async resumeAllMemberRuntimes(): Promise<void> {
    for (const group of this.groups.listGroups()) {
      const members = this.groups.listMembers(group.groupId, () => undefined)
      for (const member of members) {
        if (member.role !== 'member' || member.status === 'left') continue
        const backoff = this.runtimeResumeBackoff.get(member.sessionId)
        if (backoff !== undefined && Date.now() < backoff.nextAt) continue
        try {
          await this.resumeMemberRuntime(group, member)
          const entry = this.memberRuntimes.get(member.sessionId)
          if (entry?.kind === 'session') {
            if (entry.session.status === 'starting' || entry.session.status === 'disconnected' || entry.session.status === 'reconnecting' || entry.session.status === 'failed') {
              await entry.session.start()
              this.persistRuntimeMetadata(group.groupId, member.sessionId)
            }
            if (group.status === 'active' && group.pausedAt === undefined) {
              await this.drainQueuedTurns(member.sessionId)
            }
          }
          this.runtimeResumeBackoff.delete(member.sessionId)
        } catch (error) {
          const failures = (backoff?.failures ?? 0) + 1
          this.runtimeResumeBackoff.set(member.sessionId, {
            failures,
            nextAt: Date.now() + Math.min(60_000, 1_000 * (2 ** Math.min(failures - 1, 6))),
          })
          // A member whose provider session cannot resume stays in the roster
          // with its durable metadata; the failure is recorded LOUDLY and the
          // next dispatch fails with SESSION_RESUME_FAILED instead of silently
          // creating a fresh conversation.
          await this.activity.append({
            groupId: group.groupId,
            type: 'runtime_session_failed',
            actorName: member.name,
            refMemberId: member.sessionId,
            payload: { reason: `resume failed: ${error instanceof Error ? error.message : String(error)}` },
          }).catch(() => undefined)
          await this.groups.patchMember(group.groupId, member.sessionId, {
            error: `runtime session resume failed: ${error instanceof Error ? error.message : String(error)}`,
          }).catch(() => undefined)
        }
      }
    }
    await this.reconcileTaskDispatches()
    await this.reconcileOrphanedAttempts()
  }

  /** Reconcile the durable task-delivery outbox without unsafe replay. */
  private async reconcileTaskDispatches(): Promise<void> {
    for (const group of this.groups.listGroups()) {
      if (group.status !== 'active' || group.pausedAt !== undefined) continue
      for (const task of this.tasks.listTasks(group.groupId)) {
        const dispatch = task.dispatch
        if (dispatch === undefined || dispatch.sequence !== task.attempt) continue
        if (dispatch.state === 'delivered' || dispatch.state === 'ambiguous') continue
        const runtime = this.memberRuntimes.get(dispatch.ownerId)
        const liveBinding = runtime?.activeTurn?.taskId === task.taskId
          || runtime?.queuedTurns.some((turn) => turn.kind === 'task' && turn.taskId === task.taskId) === true
        if (dispatch.state === 'dispatching') {
          if (liveBinding && dispatch.leaseId !== undefined) {
            await this.tasks.markDispatchDelivered(group.groupId, task.taskId, dispatch.leaseId).catch(() => undefined)
            continue
          }
          const reason = 'Host restart found an in-flight dispatch lease without a matching live or queued turn; refusing automatic replay'
          if (dispatch.leaseId !== undefined) {
            await this.tasks.markDispatchAmbiguous(group.groupId, task.taskId, dispatch.leaseId, reason).catch(() => undefined)
          }
          const latest = this.tasks.requireTask(group.groupId, task.taskId)
          if (latest.status !== 'completed' && latest.status !== 'review' && latest.status !== 'failed') {
            await this.tasks.markFailed(group.groupId, task.taskId, 'runtime-reconciler', reason).catch(() => undefined)
          }
          if (this.groups.getMembership(group.groupId, dispatch.ownerId)?.currentTaskId === task.taskId) {
            await this.groups.patchMember(group.groupId, dispatch.ownerId, { currentTaskId: undefined, error: reason }).catch(() => undefined)
          }
          continue
        }
        // `pending` means no external boundary was crossed, so replay is safe.
        if (task.status === 'pending') {
          await this.dispatchAssignedTask(group, task, dispatch.ownerId, dispatch.requestedBy).catch(() => undefined)
        }
      }
    }
  }

  /**
   * Reconcile durable work that was running before this Host process existed
   * but has no matching live turn after provider reattachment. The outcome is
   * deliberately `lost` + task failure, never an automatic redispatch: ACP v1
   * cannot universally prove that a remote provider did not finish the old
   * prompt, so replaying it could duplicate filesystem changes.
   */
  private async reconcileOrphanedAttempts(): Promise<void> {
    for (const group of this.groups.listGroups()) {
      for (const task of this.tasks.listTasks(group.groupId)) {
        const running = task.attempts?.filter((attempt) => attempt.status === 'running') ?? []
        for (const attempt of running) {
          const runtime = this.memberRuntimes.get(attempt.memberId)
          if (runtime?.kind === 'session' && runtime.activeTurn?.turnId === attempt.turnId) continue
          const reason = 'Host restart found no live provider turn for this durable attempt'
          await this.tasks.settleAttempt(group.groupId, task.taskId, attempt.turnId, 'lost', reason)
          const latest = this.tasks.requireTask(group.groupId, task.taskId)
          if (latest.status !== 'completed' && latest.status !== 'review' && latest.status !== 'failed') {
            await this.tasks.markFailed(group.groupId, task.taskId, 'runtime-reconciler', reason)
          }
          const member = this.groups.getMembership(group.groupId, attempt.memberId)
          if (member?.currentTaskId === task.taskId) {
            await this.groups.patchMember(group.groupId, attempt.memberId, {
              currentTaskId: undefined,
              error: reason,
            }).catch(() => undefined)
          }
        }
      }
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private actorDisplayName(actor: string): string {
    const membership = this.groups.getMembershipForAgent(actor)
    if (membership !== undefined) return membership.name
    return actor.slice(0, 8)
  }

  private taskBrief(group: GroupRecord, task: GroupTask): string {
    return [
      '[Agent Groups · Task Assignment]',
      `Group: ${group.name}`,
      `Task: ${task.subject}`,
      `Kind: ${task.kind}`,
      `Description: ${task.description}`,
      `Write scopes: ${task.writeScopes?.join(', ') || '(whole cwd — avoid other tasks)'}`,
      `Blocked by: ${task.blockedBy.join(', ') || 'none'}`,
      'Acceptance criteria:',
      ...task.acceptanceCriteria.map((c) => `  - ${c}`),
      `Task id: ${task.taskId}`,
      'After finishing, call group_complete_task with a structured result (summary, artifacts, changedFiles, tests, completionClaim=true when you believe the task is done).',
      'Use group_report_to_leader for private questions and group_post for group-visible updates.',
    ].join('\n')
  }
}

function resolveLiveStatus(durable: AgentMemberStatus, live: 'running' | 'idle' | undefined): AgentMemberStatus {
  if (durable === 'left' || durable === 'failed' || durable === 'provisioning') return durable
  if (live === 'running') return 'running'
  if (live === 'idle') return 'idle'
  return 'inactive'
}

/**
 * V0.6: one member's live runtime — a persistent provider session with an
 * active-turn cursor, the AUTHORITATIVE queue of future turns, and pending
 * provider requests. The session is created once per member and survives
 * across tasks; turn ids correlate events so a late event from an old turn
 * can never complete a newer turn. A turn's task binding is recorded at turn
 * creation and NEVER rebinds.
 */
type MemberRuntime = SessionMemberRuntime | LegacyMemberRuntime

interface SessionMemberRuntime {
  readonly kind: 'session'
  readonly groupId: GroupId
  readonly memberId: string
  readonly config: RuntimeAgentConfig
  readonly session: RuntimeSession
  state: MemberRuntimeState
  readonly pendingRequests: Map<string, RuntimePendingRequest>
  activeTurn: { turnId: string; taskId?: string } | undefined
  /**
   * V0.6: authoritative FIFO queue of future turns (new tasks AND queued
   * corrections). Fed by the normalized `turn.queued` event; drained by
   * GroupHost after the active turn reaches a terminal state. The UI reads
   * this, never the provider.
   */
  readonly queuedTurns: RuntimeQueuedTurn[]
  turnSeq: number
}

interface LegacyMemberRuntime {
  readonly kind: 'legacy'
  readonly groupId: GroupId
  readonly memberId: string
  readonly config: RuntimeAgentConfig
  readonly handle: RuntimeAgentHandle
  state: MemberRuntimeState
  readonly pendingRequests: Map<string, RuntimePendingRequest>
  activeTurn: { turnId: string; taskId?: string } | undefined
  readonly queuedTurns: RuntimeQueuedTurn[]
  turnSeq: number
}

const PRESET_METADATA_NAME = /^name:\s*(.+)$/m
const PRESET_METADATA_DESCRIPTION = /^description:\s*(.+)$/m

/** List deployment agent presets from the DSH home (第 7 节, read-only). */
function readDeploymentPresets(): Array<{ id: string; name?: string; description?: string }> {
  const roots = [process.env.DSH_HOME, join(process.env.HOME ?? '/', '.dsh')].filter((root): root is string => root !== undefined)
  for (const root of roots) {
    try {
      const presetRoot = join(root, '.agent-presets')
      const entries = readdirSync(presetRoot, { withFileTypes: true })
      const presets: Array<{ id: string; name?: string; description?: string }> = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const id = entry.name
        let name: string | undefined
        let description: string | undefined
        try {
          const text = readFileSync(join(presetRoot, id, 'preset.yml'), 'utf8')
          name = text.match(PRESET_METADATA_NAME)?.[1]?.replace(/^["']|["']$/g, '').trim()
          description = text.match(PRESET_METADATA_DESCRIPTION)?.[1]?.replace(/^["']|["']$/g, '').trim()
        } catch {
          // no metadata file — still list the preset by directory name
        }
        presets.push({ id, name, description })
      }
      return presets
    } catch {
      // no preset root — return nothing rather than failing the surface
    }
  }
  return []
}
