# Role Editor — Investigation Report

Read-only investigation for the Agent Groups "Role Editor" feature (task
`80851222-f717-4a39-bf6f-7d3c07e08cd5`). Every claim below was verified
against the actual source files:

- REPO: `/home/ubuntu/dsh-agent-groups` (branch `main`, commit `1428f85`)
- HARNESS: `/home/ubuntu/DeepSeek-Harness` (the installed source of the running
  DeepSeek Harness)

All citations are `path:line`. Nothing in this report is inferred from
upstream docs. Where a fact could not be verified (e.g. runtime behavior that
needs a live API key), that is stated explicitly.

---

## Q1 — Existing Role / Profile / Member data structures

### Types (`packages/host/src/core-types.ts`)

| Concept | Type | Location | Fields today |
|---|---|---|---|
| Reusable role template | `AgentRoleDefinition` | `core-types.ts:536-557` | `id`, `name`, `description?`, **`runtime`** (required), `profile?`, `model?`, `reasoningLevel?` (`'low'|'medium'|'high'` abstract), `systemPrompt?`, `maxInstances?`, `defaultInstances?`, `tools?`, `metadata?`. **There is NO `provider` field on roles.** |
| Team composition | `TeamConfig` | `core-types.ts:560-562` | `leaderRole: AgentRoleDefinition`, `memberRoles: AgentRoleDefinition[]` |
| Member record | `GroupMember` | `core-types.ts:170-199` | `sessionId`, `groupId`, `profileId`, `name`, `status`, `role`, `joinedAt`, `currentTaskId?`, `error?`, `lastActiveAt?`, `displayRole?`, `roleId?`, `runtime?`, `model?`, `reasoningLevel?`, `runtimeSession?` (V0.5 durable metadata) |
| Durable runtime-session metadata | `RuntimeSessionDurable` | `core-types.ts:202-220` | `runtime`, `provider?`, `providerSessionId?`, `providerThreadId?`, `workspace?`, `model?`, `reasoningLevel?`, `providerCapabilities?`, `queuedTurns?`, `state?`, `lastTurnId?`, `lastTaskId?`, `createdAt?`, `updatedAt?` |
| Consumable profile (legacy spawn path) | `AgentProfile` | `core-types.ts:104-117` | `id`, `name`, `presetId?`, `description`, `capabilities`, `responsibilities?`, `preferredTaskTypes?`, **`model?`, `provider?`** (yes — profiles DO have provider/model today), `tags?`, `defaultWriteScopes?`, `metadata?` |
| Agent runtime config (internal, compiled) | `RuntimeAgentConfig` | `runtime/base.ts:89-105` | `groupId`, `agentId`, `role`, `profile?`, `model?`, `reasoningLevel?`, `systemPrompt?`, `workspace?`, `parentMemberId?`, `metadata?` — again **no first-class `provider`** |

### Durable zod schemas (`packages/host/src/persistence.ts`)

- `profileSchema` `persistence.ts:91-104` — `model`/`provider` optional (mirrors `AgentProfile`).
- `roleDefinitionSchema` `persistence.ts:121-134` — **no `provider` field**; `model`/`reasoningLevel`/`systemPrompt` optional.
- `teamConfigSchema` `persistence.ts:136-139` — `leaderRole` + `memberRoles`.
- `runtimeSessionSchema` `persistence.ts:162-184` — `provider`, `model`, `reasoningLevel` all optional (this is what is persisted per Member).
- `memberSchema` `persistence.ts:186-204` — direct `runtime`/`model`/`reasoningLevel` optional; `runtimeSession` optional (V0.5).
- Domain: `AGENT_GROUPS_DOMAIN` `persistence.ts:326-339` (tables `profiles`, `groups`, `members`, `tasks`, `channel`, `private`, `activity`, `leaders`); `openAgentGroupsDomain` `:344-346`; `parseRecord` back-compat validator `:369-371`.

### Registries / templates / presets

- `ProfileRegistry` + shipped `BUILTIN_PROFILES` (5 sample profiles, none set
  `provider`/`model`): `packages/host/src/profile-registry.ts:14-66` (registry
  class `:68-106`).
- `TEAM_TEMPLATES` (software-team / research-team / content-team / general-team):
  `packages/host/src/template-registry.ts:11-58`; slot flattening `:61-70`.
- Team-config derivation & built-in roles (`runtime/team-config.ts`):
  - `LEADER_ROLE` `:18-25` (reasoningLevel `high`, profile `group-leader`),
  - `GENERALIST_ROLE` `:27-34` (reasoningLevel `medium`),
  - `ROLE_TEMPLATES` `:37-78` (planner/researcher/architect/implementation/reviewer),
  - `templateTeamConfig` `:81-116`, migration `teamConfigFor` `:119-121`.
- Runtime/Role/Team presets (a parallel preset architecture, `runtime/presets.ts`):
  `RUNTIME_PRESETS` `:57-88`, `ROLE_PRESETS` `:90-145`, `TEAM_PRESETS` `:147-179`,
  `resolveRolePreset` `:195-220` (merges runtime preset model/reasoning into the
  role definition).
- Agent preset profiles (`packages/profiles`):
  - `agent-groups.cordis.yml` — web-profile patch fragment that mounts the host
    plugin (`- insert: - id: agent-groups name: '@dsh-agent-groups/host'`).
  - `presets/group-leader/agent.cordis.yml` + `preset.yml` (order 50) and
    `presets/group-member/agent.cordis.yml` + `preset.yml` (order 60). Both are
    agent-preset files with no provider/model/reasoning content — the preset
    defines tools + persona; model selection is injected per-session (see Q3).

### How is "provider" carried today?

Only two ways, neither is a role field:

1. `AgentProfile.provider` → legacy `spawnMember` path:
   `group-host.ts:1061-1067` passes `provider: profile.provider, model: profile.model`
   into `adapter.createMemberAgent`.
2. `role.metadata.provider` (opaque JSON) → read by the DSH runtime provider:
   - `runtime/deepseek-harness.ts:83` (session path): `existing?.provider ?? (typeof config.metadata?.provider === 'string' ? config.metadata.provider : undefined)`,
   - `runtime/deepseek-harness.ts:96` (legacy path): `typeof config.metadata?.provider === 'string' ? config.metadata.provider : selection.provider`,
   - resume: `group-host.ts:375` sets `metadata: { provider: member.runtimeSession.provider }`.

### What is persisted per Member (`runtimeSession`)

`GroupHost.runtimeMetadata()` builds it from the live session info:
`group-host.ts:390-410` (runtime, provider, providerSessionId, providerThreadId,
workspace, model, reasoningLevel, providerCapabilities, queuedTurns, state,
lastTurnId, lastTaskId, createdAt, updatedAt); persisted by
`persistRuntimeMetadata` `group-host.ts:412-416`. Never contains credentials
(no secret fields in `RuntimeSessionDurable`, `core-types.ts:202-220`).

---

## Q2 — Where is a DSH Member session created? (full trace)

| # | Hop | Location |
|---|---|---|
| 1 | `leader_spawn_role` tool schema → `host.spawnByRole(actor, {role, name})` | `leader-tools.ts:55-62` (run at `:61`) |
| 2 | `GroupHost.spawnByRole` → `spawnRoleInto(groupId, role, name, override, actor)` | `group-host.ts:174-178` (user console: `userSpawnByRole` `:181-186`) |
| 3 | `spawnRoleInto` — resolve role from `teamConfig` (migration-aware) | `group-host.ts:196-199` (`teamConfig` `:131-133` → `teamConfigFor` `runtime/team-config.ts:119-121`) |
| 4 | Instance-limit check + runtime resolution | `group-host.ts:201-213` → `RuntimeRegistry.assertUsable(role.runtime)` `runtime/registry.ts:46-59` (require `:34-40`, `isAvailable`, `validate`) |
| 5 | Model/reasoning pre-validation | `group-host.ts:215-229` (model against `provider.listModels()` `:218-223`; reasoning against `provider.listReasoningLevels?.()` `:224-229`) |
| 6 | Compile `RuntimeAgentConfig` (`roleConfig`) | `group-host.ts:256-267` — `model`/`reasoningLevel`/`systemPrompt`/`profile`/`workspace`/`metadata: role.metadata`; **no provider** |
| 7 | Session provider path: `provider.createSession(roleConfig)` → `session.start()` → `attachMemberRuntime` | `group-host.ts:269-277` (legacy: `spawnAgent` `:279-298`) |
| 8 | `DeepSeekHarnessRuntimeProvider.createSession` builds `MemberCreateSpec` | `runtime/deepseek-harness.ts:76-88` — `provider: existing?.provider ?? metadata.provider` (`:83`), `model: existing?.model ?? config.model` (`:84`), `reasoningLevel: existing?.reasoningLevel ?? config.reasoningLevel` (`:85`) |
| 9 | `DshMemberSession.start()` → `adapter.ensureAgent(this.memberId, this.spec)` | `runtime/deepseek-harness.ts:186-207` (ensureAgent call at `:193`; same durable session id always used, doc `:191-192`) |
| 10 | `DshAgentRuntimeAdapter.ensureAgent` — live → resume → create | `dsh-adapter.ts:215-223` |
| 11 | `resumeAgent` → `this.agents.resume({resumeSessionId, agentOptions:{provider, model}, setup})` | `dsh-adapter.ts:186-206` |
| 12 | `createMemberAgent` → `this.agents.create({sessionId, meta:{cwd, parentSession, origin:'subagent'}, agentOptions:{provider, model}, setup})` | `dsh-adapter.ts:159-178` (create call `:164-176`) |

Wiring at plugin start (`packages/host/src/index.ts`):

- `DshAgentRuntimeAdapter` constructed with `ctx.agents` / `ctx.agentPresets` /
  `ctx.get('agentDefaultModel')` — `index.ts:124-129`.
- `DeepSeekHarnessRuntimeProvider` registered with the adapter + a
  `DshDefaultModelSource` over `agentDefaultModel.currentSelection()` —
  `index.ts:139-143`.
- `inject = ['storageDomain', 'webServer', 'agents', 'agentPresets']` — `index.ts:88`.

`require`d citation notes: the `session.start()` handshake and the
`ensureAgent` resume path are what make a DSH member a durable continuation of
one DSH session (AGENTS.md runtime invariant: one member = one durable
conversation).

---

## Q3 — How provider/model/reasoning enter the DSH session

### `memberSetup` (dsh-adapter.ts:140-157)

Confirmed exactly as hypothesized:

```ts
await this.agentPresets.mount(agentCtx, MEMBER_PRESET_ID)          // :144
const provider = spec.provider ?? this.selection().provider        // :145
const model    = spec.model ?? this.selection().model              // :146
if (provider !== undefined && model !== undefined && spec.reasoningLevel !== undefined) {
  const effort = ReasoningEffortId(spec.reasoningLevel)            // :150
  agentCtx.effect(() => installModelSelection(agentCtx, {
    current: { provider, model, reasoningEffort: effort },
    assembled: undefined,
  }))                                                              // :151-154
}
```

Only installed when **all three** of provider/model/reasoningLevel are defined.

### Where `spec.provider` comes from at spawn

- Session path (`createSession`, `runtime/deepseek-harness.ts:83`):
  `existing?.provider` (a resume) **or** `config.metadata.provider` (an opaque
  role-metadata field). **Fresh spawns with no `metadata.provider` →
  `undefined`**, so `createMemberAgent` falls back to the global default at
  `dsh-adapter.ts:162` (`spec.provider ?? selection.provider`).
- Legacy path (`spawnAgent`, `runtime/deepseek-harness.ts:96`): falls back to
  `selection.provider` (the harness' current default).

### Where `reasoningLevel` comes from

`role.reasoningLevel` → `roleConfig.reasoningLevel` (`group-host.ts:262`) →
`config.reasoningLevel` → `spec.reasoningLevel`
(`runtime/deepseek-harness.ts:85`) → `memberSetup` installs it as the
`reasoningEffort`. `updateTeamConfig` validates it is one of
`low|medium|high` (`group-host.ts:147-148`); spawn additionally validates it
against the runtime's own `listReasoningLevels` (`group-host.ts:224-229`).

### Resume semantics — original config re-applied, global default NOT used

- Adapter: `resumeAgent(sessionId, spec)` calls `agents.resume` with
  `agentOptions: {provider, model}` from `spec` (original) and re-runs
  `memberSetup(spec)` which **re-installs** the reasoning selection
  (`dsh-adapter.ts:186-206`, esp. `:190-199`).
- Provider: `DshMemberSession` keeps the original `spec`; `start()` →
  `ensureAgent(memberId, spec)` (`runtime/deepseek-harness.ts:191-193`). On
  host restart, `resumeMemberRuntime` rebuilds the session from the durable
  `member.runtimeSession` with `metadata.provider = member.runtimeSession.provider`
  (`group-host.ts:362-387`, `:375`), and `createSession` prefers
  `existing?.provider` (`deepseek-harness.ts:83`).
- Doc-level contract: `AgentRuntimeAdapter.resumeAgent` JSDoc
  `dsh-adapter.ts:46-51` ("the global default model is NEVER used to resume a
  role-configured member"); module doc `runtime/deepseek-harness.ts:8-14`.
- **Confirmed: original config re-installed; global default never applied on
  resume.** Regression tests: `test/dsh-resume.test.ts` (three layers:
  adapter `:108-124`, provider, product; members spawn with model A/high →
  restart → still A/high).

### `DEFAULT_REASONING_LEVELS`

`runtime/base.ts:316-320`:

```ts
export const DEFAULT_REASONING_LEVELS: readonly ReasoningOption[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
]
```

Used by `DeepSeekHarnessRuntimeProvider.listReasoningLevels()`
(`runtime/deepseek-harness.ts:71-73`) and the ACP provider
(`runtime/acp.ts:642`); exported at `index.ts:67`.

### ⚠ Important finding — vocabulary mismatch

Agent Groups passes the abstract level string directly as the branded effort:
`ReasoningEffortId(spec.reasoningLevel)` (`dsh-adapter.ts:150`), and
`ReasoningEffortId` is a **cast-only brand with no validation**
(`DeepSeek-Harness/packages/llm/llm/src/brand.ts:54-63`). But the
`llm-deepseek` adapter only exposes efforts **`off` | `high` | `max`**
(`DeepSeek-Harness/packages/llm/llm-deepseek/src/adapter.ts:95-105`, resolved
at `:194-211`; default config effort `high`, `llm-deepseek/src/index.ts:70`).
The harness' request path validates the effort against the exact model and
rejects unknown ids:

- `LlmRuntime.resolveCallFor` throws `UNSUPPORTED_REASONING_EFFORT` when the
  requested effort is not in the model's list
  (`DeepSeek-Harness/packages/llm/llm/src/index.ts:753-760`),
- the agent loop calls `ctx.llm.prepareCall(proposedConfig, signal)` on every
  request (`DeepSeek-Harness/packages/core/agent-loop/src/agent.ts:449`).

Consequence: **a DSH member role with `reasoningLevel: 'low'` or `'medium'`
(the defaults for Generalist/Researcher/Writer, `runtime/team-config.ts:31,50,99,107`)
would currently be rejected at request time** on the DeepSeek adapter — the
abstract low/medium/high vocabulary is NOT the DeepSeek effort vocabulary. This
is a behavior we did not run live (no `DEEPSEEK_API_KEY`), but the static path
is unambiguous. The Role Editor must map (or surface the exact per-model
efforts from `resolveModelInfo`).

---

## Q4 — Harness discovery capabilities (installed source)

### a. `ctx.llm` (`LlmRuntime`, `packages/llm/llm/src/index.ts`)

- Context merged as `ctx.llm: LlmRuntime` — `index.ts:46-49`.
- `listProviders(): LlmProviderInfo[]` — `index.ts:419-421`; `LlmProviderInfo = {id, name}`
  (`types.ts:144-149`).
- `listModels(provider): Promise<LlmModelInfo[]>` — `index.ts:581-608`;
  `LlmModelInfo = {provider, id, name, description?, inputModalities?}`
  (`types.ts:233-244`). Catalog membership is advisory (`types.ts:232`).
- `resolveModelInfo(provider, model, signal?)` — `index.ts:619-625`, core
  validation `resolveModelInfoFor` `:627-718`; returns `LlmResolvedModelInfo`
  (`types.ts:274-281`) with optional `reasoning: { efforts: LlmReasoningEffortInfo[],
  defaultEffort? }` (`types.ts:263-271`; validation + rejection of empty/dup
  efforts `index.ts:675-717`).
- `listConfigurableProviders(): LlmConfigurableProvider[]` — `index.ts:490-492`;
  type `{ provider, displayName, settingsNs, settingsPath: string[], declared? }`
  (`types.ts:166-187`). Registry: `registerConfigurableProviders`
  `index.ts:431-484` (validates non-empty provider/displayName/settingsNs and
  non-empty settingsPath segments `:445-449`).
- `llm/adapters-updated` event — emitted at each registry commit
  (`index.ts:302`, `:352`, `:412`, `:460`, `:472`), declared payload-free (emit
  mode) at `types.ts:12-25`; consumers re-read `listProviders()/listModels()/
  listConfigurableProviders()`.
- `providerInfo(provider)` is an **adapter** method (`LlmAdapter`,
  `index.ts:186-188`), not a runtime API; the configurable-provider directory
  is the registration API (`registerConfigurableProviders`).
- Also present: `registerModelDiscovery`/`discoverModels` (`:504-521`, `:532-559`)
  for endpoint interrogation of still-drafted providers; `prepareCall`/`resolveCallConfig`
  (`:730-814`) validate call config against exact-model capability.

### b. `ctx.credentials` (`CredentialProvider`, `packages/credentials/credentials/src`)

- Context merged as `ctx.credentials: CredentialProvider` — `index.ts:48-52`.
- `credentialRef(value)` — `index.ts:23-28`; POSIX identifier pattern
  `^[A-Za-z_][A-Za-z0-9_]*$` (`index.ts:16`). `CredentialRef` brand `types.ts:13`.
- `describe(ref) → { configured, source?, writable }` — `index.ts:81`; type
  `CredentialInfo` `index.ts:39-46` (never the value).
- `resolve(ref)` `index.ts:73`, `set(ref, value)` `:91`, `unset(ref)` `:99`.
- `credentials/updated` event `types.ts:29`.
- **How providers declare their credential refs** — in their plugin config
  schema, NOT via `ctx.llm`:
  - `llm-deepseek`: `Config.apiKeyEnv` default `DEEPSEEK_API_KEY`
    (`packages/llm/llm-deepseek/src/index.ts:45`), schema `z.string().role('credential-ref').default(...)` (`:92`), resolved per request `credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)` (`:184`). Provider route `deepseek-official` (`:47`); declares configurable provider `{provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: settingsNamespace('llm-deepseek'), settingsPath: []}` (`:251-253`).
  - `llm-pi-ai` (multi-provider twin, dormant until configured): **per-provider
    profile** `apiKeyEnv` (examples `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
    `ACME_GATEWAY_API_KEY`, `packages/llm/llm-pi-ai/src/index.ts:19-32`);
    schema field `apiKeyEnv: z.string().role('credential-ref')`
    (`llm-pi-ai/src/config.ts:233`, type doc `:66-67`); declares one
    configurable-provider entry per profile with `settingsNs: 'llm-pi-ai'`,
    `settingsPath: ['providers', <provider>]` (`llm-pi-ai/src/index.ts:125-130`,
    registration `:220`).
- **The harness does NOT expose a provider→credentialRef mapping as an API.**
  `LlmConfigurableProvider` has no credential field (`llm/src/types.ts:166-187`),
  and the web credentials contract says so explicitly: *"There is no
  enumeration method by design: clients learn which references exist from
  settings schemas and values (`apiKeyEnv` fields)"*
  (`packages/host/apiproxy/src/api/credentials.ts:5-7`).

  **Least-hardcoded resolution (proposed):** do the same join the web Models
  page does — for each configurable provider take `settingsNs` + `settingsPath`
  (`ctx.llm.listConfigurableProviders()`), read the resolved value of that
  settings namespace (host-side: `ctx.get('settings')`; the seam exposes
  redacted namespace values + serialized schema, `packages/host/apiproxy/src/api/settings.ts:20-41,61-65`),
  pick the `apiKeyEnv` field at the path (`apiKeyEnvOf` pattern,
  `packages/client/ui-settings-models/src/client/store.ts:89-96`), then report
  `ctx.credentials.describe(ref)`. The only place a conventional ref is
  *derived* today is the Models page fallback
  `deriveKeyRef(provider) = ${PROVIDER.toUpperCase().replace(/[^A-Z0-9]+/g,'_')}_API_KEY`
  (`store.ts:69-71`) — a UI convention for custom providers, not an API; Agent
  Groups should not hardcode a provider→ref table either.

### c. Model catalog API surface & web client

- RPC domains: `packages/host/apiproxy/src/api/llm.ts` — `llm.providers` (`:42`,
  `ConfigurableProviderView` `:15-32`), `llm.models` (`:49`), `llm.discoverModels`
  (`:67-76`); `sessions.ts` — `ModelSelection` `:92-99`, `ModelReasoningEffort`
  `:101-109`, `ModelReasoning` `:111-117`, `ModelCatalogModel` `:120-129`,
  `ModelProviderGroup` `:131-139`, `ModelCatalogFailure` `:141-149`,
  `SessionModels` `:151-168`.
- RPC map / handler / client: `api/rpc-map.ts:74-76` (`llm.*`) and `:29`
  (`session.models`); `api/fetch/handler.ts:140-142`; `api/fetch/client.ts:160-162`,
  `:498-500`.
- **Implementation (same process → direct `ctx.llm` calls):**
  `api-proxy.ts` `buildModelCatalog` `:328-377` calls
  `ctx.llm.listProviders()` → `listModels(provider.id)` →
  `resolveModelInfo(provider.id, model.id)` and maps to `ModelProviderGroup`;
  `llm.providers` impl `:3371-3398` (directory ∪ registered routes, `active`
  flag); `llm.models` `:3400-3402`; `llm.discoverModels` `:3404-3426` (→
  `ctx.llm.discoverModels` `:3407`).
- Web client: `packages/client/ui-model-selection/src/client/`
  - `ModelDirectory` (`directory.ts:37-154`): `load()` → `api.sessions.models`
    (`:67`), `select()` → `api.sessions.selectModel` with optional
    `reasoningEffort` (`:94-105`).
  - `ModelDirectoryResolver` (`ctx.modelDirectories`, `service.ts:34-109`):
    refreshes every directory on `ctx.remote.$on('llm/adapters-updated')` and
    `'settings/document-updated'` (`service.ts:59-60`).
  - `ModelSelect.tsx` — composer model seat; two-level menu (model list +
    effort rows) with effort metadata coming from the exact-model reasoning
    (`ModelSelect.tsx:9-11` and `EffortChoice` rows).
  - The Models settings page joins `api.llm.providers` + `api.settings.describe`
    (`ui-settings-models/src/client/store.ts:126-134`).
- **Can the Agent Groups host call `ctx.llm` directly (same process)? Yes.**
  - The plugin entry `apply(ctx: Context)` (`index.ts:97`) receives the shared
    Cordis context. Precedent for optional services: `ctx.get('agentDefaultModel')`
    (`index.ts:124`) and `ctx.get('subagents')` (`compatibility.ts:27`).
  - The base bundle composes all needed services in the same process:
    `agent-default-model` (`packages/bundle/base/cordis.patch.yml:63-64`),
    `settings`/`dsh-settings-file` (`:79`), `credentials`/`dsh-credentials-local`
    (`:86`), `llm-deepseek` (`:450-451`), `llm-pi-ai` (`:89-93` block).
  - Therefore `ctx.get('llm')` / `ctx.get('credentials')` / `ctx.get('settings')`
    resolve at runtime; they are **not** declared injections of this plugin
    (`index.ts:88`), so the pattern is `ctx.get(...)` (per Harness convention:
    optional services use `ctx.get(name)` — `packages/AGENTS.md`).

### d. `ReasoningEffortId` and the DeepSeek efforts

- Brand: `packages/llm/llm/src/brand.ts:54-63` — `ReasoningEffortId(id)` is a
  **cast, no validation**.
- Agent Groups passes `role.reasoningLevel` directly as the branded id:
  `dsh-adapter.ts:150` (confirmed).
- `llm-deepseek` exposes **`off` / `high` / `max`** (`llm-deepseek/src/adapter.ts:95-105`);
  when `thinking: 'disabled'` only `off` (`:103-105`); `resolveModel` returns
  `reasoning: {efforts, defaultEffort}` for every catalog model (`:194-211`),
  default effort = config `reasoningEffort` (`index.ts:70` says default `high`).
- Per-model variation: **no** — the DeepSeek adapter applies the same
  reasoning metadata to every model of the route (branch is on the connection
  `thinking` config, not the model). Model-level reasoning *display* varies
  through `resolveModelInfo`; the web UI renders effort rows from that
  exact-model metadata (`ModelSelect.tsx`). Other adapters (pi-ai profiles)
  can differ per profile.
- **Consequence for the Role Editor:** the per-model effort list + default are
  available via `ctx.llm.resolveModelInfo(provider, model)`; the abstract
  low/medium/high level must be mapped to per-adapter effort ids (see Q3 ⚠).
  The runtime-level `DEFAULT_REASONING_LEVELS` (`runtime/base.ts:316-320`) is
  only used by Agent Groups' own runtimes view, not by the harness request path.

### e. Agent default model

- The agent-scoped installer: `installModelSelection(agentCtx, selection)`
  (`DeepSeek-Harness/packages/core/agent/src/model-selection.ts:39-75`) —
  listens `system-prompt/assemble` (injects provider/model into assembly
  variables `:40-53`) and `agent/request` (overrides provider/model and sets
  `reasoningEffort` on the `LlmCallConfig` `:54-70`).
- The global default service: `AgentDefaultModelConfig` (`ctx.agentDefaultModel`)
  — `packages/core/agent-default-model/src/index.ts:64-105`; settings namespace
  `agent-default-model` `:21`, schema `:34-38`, `currentSelection()` `:88-90`
  (provider+model+optional branded effort), `saveSelection()` `:98-104`.
- Who passes it into Agent Groups: `index.ts:124`
  `ctx.get('agentDefaultModel')` → `DshAgentRuntimeAdapter.agentDefaultModel`
  (`dsh-adapter.ts:107-133`, `selection()` `:129-133`) → falls back at
  `createMemberAgent` (`:162-163`) / `resumeAgent` (`:190-191`); and
  `DeepSeekHarnessRuntimeProvider.defaultModel` (`runtime/deepseek-harness.ts:52`,
  `:91`, `listModels()` `:65-69`, registered `index.ts:140-143`).
- Bundle default: `provider: deepseek-official, model: deepseek-v4-flash`
  (`bundle/base/cordis.patch.yml:64-67`).

### f. Settings ("设置入口")

- Seam: `packages/settings/settings/src/types.ts` — `SettingsNamespace` `:13`,
  `settings/updated` (`:35`), `settings/document-updated` (`:48`).
- Wire API (web): `packages/host/apiproxy/src/api/settings.ts` — `describe` `:61-65`
  (redacted layered values + **serialized schemastery schema** + `secrets`
  slot list), `openDocument` `:73-75`, `update` `:84`, `replace` `:93`,
  `mutate` `:103-105`.
- What the settings UI exposes for `llm-deepseek`: the Models page
  (`packages/client/ui-settings-models/src/client/`) renders provider rows from
  `llm.providers` ∪ `settings.describe`, each row editing the namespace form;
  per provider it shows the credential (`apiKeyEnv`), `baseURL`, catalog
  (`models`), `reasoningEffort`, `maxTokens`, `retryPolicy` etc. — everything
  the `Config` schema declares (`llm-deepseek/src/index.ts:62-101`), because
  the form is rendered **from the serialized schema** with `role('credential-ref')`
  fields handled as write-only secret slots (`SettingsSecretView`,
  `api/settings.ts:11-17`).
- **Is there a DSH-native route/URL to link to? No URL route.**
  - `apps/web` is a minimal SPA shell (`apps/web/src/main.ts`,
    `node-module-stub.ts`) — no path router found.
  - Settings is a slot-based in-app panel: `sidebar.settings` occupant
    registered by `ui-settings-general` (`packages/client/ui-settings-general/src/client/index.ts:142-171`)
    with `settings.trigger` / `settings.header` / `settings.section` /
    `settings.action` / `settings.close` children; the Models page is a
    `settings.section` registered by `ui-settings-models`
    (`ui-settings-models/src/client/index.ts` apply → `ModelsSection`).
  - Conclusion: Agent Groups can describe the "configured in 设置 → Models"
    state (configured/writable/source via `credentials.describe`) but cannot
    deep-link a URL. Facts only — how to "open" the panel from the Agent
    Groups overlay (e.g. a shell slot/callback) is design work, not a fact.

---

## Q5 — What can be reused directly (no new machinery)

1. **Role schema** — extend the existing `AgentRoleDefinition`
   (`core-types.ts:536-557`) with an **optional `provider`** (and optionally an
   explicit per-role `reasoningEffort`); `roleDefinitionSchema`
   (`persistence.ts:121-134`) + `normalizeTeamConfig` (`web/api.ts:423-448`)
   are the only other schema touch points. Back-compat is free because every
   new field is optional and `parseRecord` (`persistence.ts:369-371`) proves
   old records still parse.
2. **Team-config PUT API + TeamConfigView/RoleCard UI** — `GET/PUT
   /groups/api/groups/:id/team-config` (`web/api.ts:190-200`) →
   `updateTeamConfig` (`group-host.ts:135-162`); UI already edits
   runtime/model/reasoning/profile/maxInstances/systemPrompt per role
   (`native-client/index.js` TeamConfigPanel `:1078-1197`, RoleCard
   `:1199-1247`). Add a Provider select + per-model effort choice.
3. **runtimesView** — `group-host.ts:959-983` → `GET /groups/api/runtimes`
   (`web/api.ts:185-188`) gives id/name/available/readiness/capabilities/
   models/reasoningLevels; the deepseek-harness runtime's `listReasoningLevels`
   returns `DEFAULT_REASONING_LEVELS` (`runtime/deepseek-harness.ts:71-73`).
   A discovery view can be layered beside it (or extended) with the real
   per-provider catalog from `ctx.llm`.
4. **installModelSelection / ReasoningEffortId** — already wired
   (`dsh-adapter.ts:149-154`); no change needed beyond what enters `spec`.
5. **CredentialProvider.describe** — host-side
   `ctx.get('credentials')?.describe(credentialRef(ref))` for configured/source/
   writable badges (never the value); batch API shape: `api-proxy.ts:3321-3335`.
6. **ctx.llm discovery** — `listProviders()` / `listModels()` /
   `resolveModelInfo()` / `listConfigurableProviders()` directly in-process;
   the `llm/adapters-updated` event for live refresh (host-side:
   `ctx.on('llm/adapters-updated', ...)`).
7. **Resume semantics** — the whole live→resume→create + durable
   `runtimeSession` machinery (`dsh-adapter.ts:215-223`,
   `runtime/deepseek-harness.ts:186-207`, `group-host.ts:362-387,390-416`)
   already preserves provider/model/reasoningLevel; a role `provider` field
   flows through the same spec with zero resume rework.
8. **Role-level validation gates** — `updateTeamConfig` checks
   (`group-host.ts:147-148`) and spawn-time model/reasoning checks
   (`group-host.ts:215-229`) are the pattern for adding provider validation
   (e.g. provider exists among `ctx.llm.listProviders()`).

---

## Q6 — Minimal file-change list (keeps runtime architecture intact)

Files that must change in `dsh-agent-groups`:

| Area | Files | Change |
|---|---|---|
| (a) Role schema + normalization | `packages/host/src/core-types.ts` (`AgentRoleDefinition` `:536-557`); `packages/host/src/persistence.ts` (`roleDefinitionSchema` `:121-134`); `packages/host/src/web/api.ts` (`normalizeTeamConfig` `:423-448`); `packages/host/src/group-host.ts` (`updateTeamConfig` validation `:147-148`) | add optional `provider` (+ optional explicit `reasoningEffort`); passthrough in normalizer; validate provider when set (vs discovery catalog) |
| (b) Host discovery service (new module) | new `packages/host/src/runtime/dsh-discovery.ts` (or extend `runtimesView`) | wraps optional `ctx.get('llm')` / `ctx.get('credentials')` / `ctx.get('settings')`; returns per-provider catalog (providers, models, per-model reasoning efforts + default, configurable-provider settingsNs/settingsPath, credential ref derived from settings schema `apiKeyEnv` + `describe` state). Follow the `agentDefaultModel`/`subagents` optional-`ctx.get` precedent (`index.ts:124`, `compatibility.ts:27`). |
| (c) Spawn wiring | `packages/host/src/group-host.ts` (`spawnRoleInto` `:188-336`; `resumeMemberRuntime` `:362-387`); `packages/host/src/runtime/base.ts` (`RuntimeAgentConfig` `:89-105`); `packages/host/src/dsh-adapter.ts` (`MemberCreateSpec` `:27-36`); `runtime/deepseek-harness.ts` (pass provider through `:76-88`) | plumb `role.provider` into the spawn config → `MemberCreateSpec.provider` (prefer a first-class field over `metadata.provider`; keep the `metadata.provider` read for back-compat of stored roles). `memberSetup` already applies it — no change there. |
| (d) Web API endpoints | `packages/host/src/web/api.ts` | extend `GET /groups/api/runtimes` view or add `GET /groups/api/providers` (discovery catalog for the UI); team-config already round-trips provider once `normalizeTeamConfig` passes it |
| (e) Native client UI | `packages/host/src/native-client/index.js` (TeamConfigPanel `:1078-1197`, RoleCard `:1199-1247`) | Provider select in RoleCard (options from discovery view, "— default —" option), per-model reasoning-effort select from `resolveModelInfo`; rebuild `packages/host/lib/client.js` via `scripts/build-native-client.mjs` |
| (f) Tests | new files under `packages/host/test/` | spawn wiring (fake provider asserts provider in config), API route (fake req/res), resume re-apply (FakeAgentRegistry), discovery unit test (fake `ctx.llm`-like service), persistence back-compat (`parseRecord`) |

**Explicitly untouched:** ACP providers (`runtime/acp.ts`), task lifecycle
(`task-service.ts`, `group-host.ts` dispatch/queue/steer), turn semantics,
reconciler (`runtime/reconciler.ts`), recovery, workspace manager, legacy
Codex/Claude providers.

---

## Q7 — Test infrastructure

- Runner: **vitest** (`packages/host/vitest.config.ts` — node env,
  `include: ['test/**/*.test.ts']`); run via `npm test` (root
  `package.json` → `npm --prefix packages/host run test` → `vitest run`
  `packages/host/package.json:43`). `npm run typecheck`; `npm run build`; the
  repo's `verify` script = `typecheck && test && build && node --check
  packages/host/lib/client.js` (root `package.json`).
- Test files (`packages/host/test/`): `roles.test.ts` (296 lines — role
  templates, team-config validation/persistence, role-based spawn with
  **`FakeProvider`** recording every `RuntimeAgentConfig`, instance limits,
  MODEL_UNAVAILABLE / REASONING_UNAVAILABLE), `dsh-resume.test.ts` (282 — 3-layer
  resume regression with **`FakeAgentRegistry`** + `FakePresets` + a fake
  `agentDefaultModel`), `api-routes.test.ts` (fake `IncomingMessage`/`ServerResponse`
  against the **production** `createGroupWebApi` handler; team-config GET/PUT
  roundtrip `:114-143`), `persistence-runtime-events.test.ts`, `v02.test.ts`
  (durability/migration), `profiles.test.ts`, `presets.test.ts`,
  `reconciler.test.ts`, `recovery.test.ts`, `turns.test.ts` (931), and others
  — 18 `*.test.ts` files, ~4 163 lines total.
- Harness helpers: `test/helpers.ts` — `makeStores()` (per-table
  `MemoryStore`), `makeHarness()`, `makeHost()` (full `GroupHost` with
  `createNoopAdapter()`), `seedGroup()`.
- Persistence back-compat: `parseRecord(table, value)` exported
  (`persistence.ts:369-371`) — the pattern for proving old role records
  (without `provider`) still validate.
- Web API tests: no supertest — the route dispatcher `handleApi` is exported
  (`web/api.ts:63`) and exercised with minimal fakes (see `api-routes.test.ts:14-37`).
- Runtime wiring/resume tests: `FakeAgentRegistry` (dsh-resume.test.ts:38-91)
  models `create`/`resume` and the durable-persisted-session set.
- **Native client UI: no DOM tests exist** — `src/native-client/index.js` is
  plain CommonJS/React-createElement, validated only by `node --check` on the
  built bundle (root `verify` script). UI logic worth testing (e.g. the
  provider/effort mapping) should be extracted into a testable pure module
  under `packages/host/src` or kept to the API tests.
- `scripts/build-native-client.mjs` wraps `src/native-client/index.js` in
  `window.__ModuleLoader__.load({ id: pkg.name, factory: (require) => {...} })`
  (`:27-38`); the factory locally requires only `react` +
  `@deepseek-ai/dsh-client-ui-primitives` (`:32-33`). Output:
  `packages/host/lib/client.js`. The **factory's `require` can pull further
  modules** if the module loader can resolve them — the `dsh.client` manifest
  (`packages/host/package.json:28-36`,
  `{inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-locale'], platform: 'web'}`)
  is informational (dependency edges for preflight/HMR, not activation). So:
  yes it *can* require additional client modules, but the native UI gets its
  data through the `/groups/api/*` endpoints today, and that is the pattern to
  keep for the Role Editor; a hard client-side dependency on a Harness client
  package would couple the bundle to shell internals (avoid).
- New-test patterns to follow: API → `api-routes.test.ts` style; persistence
  back-compat → `parseRecord` + `v02.test.ts` style; UI → none today (pure
  module + API-level coverage); runtime wiring/resume → `roles.test.ts`
  (FakeProvider) + `dsh-resume.test.ts` (FakeAgentRegistry).

---

## What could NOT be verified

1. Live request behavior of `reasoningEffort` rejection (Q3 ⚠) — the static
   path (`prepareCall` → `UNSUPPORTED_REASONING_EFFORT`) is unambiguous in
   source, but no `DEEPSEEK_API_KEY` was available to run a real request.
2. Whether the deepseek-v4 model names (`deepseek-v4-flash`/`deepseek-v4-pro`,
   `llm-deepseek/src/index.ts:49-52`) actually resolve on the live API.
3. Behavior of the DSH member sessions under a real, restarted harness process
   (resume was verified in unit tests only).
4. Whether any deployed web profile differs from `bundle/base` +
   `bundle/web-app` composition (the plugin mounts through a user profile
   patch; the services are composed there per `agent-groups.cordis.yml`).

## Bottom line for the role editor

- Roles have **no provider field today**; provider rides only
  `metadata.provider` (opaque) or `AgentProfile.provider` (legacy path). Add an
  optional `provider` (+ optional effort) to `AgentRoleDefinition` and plumb it
  through `normalizeTeamConfig` → roleConfig → `MemberCreateSpec`; resume needs
  zero rework because the durable `runtimeSession.provider` machinery already
  wins on resume.
- Use `ctx.llm`/`ctx.credentials`/`ctx.settings` **directly in-process**
  (`ctx.get(...)`, same-process service, optional-service precedent at
  `index.ts:124`) for the provider/model/effort/credential surface; do not
  hardcode provider→credentialRef mappings (the harness deliberately exposes
  none; resolve `apiKeyEnv` from the provider's settings namespace).
- Map the abstract `low|medium|high` reasoning level to each adapter's real
  effort ids; the DeepSeek adapter accepts only `off|high|max` and rejects
  unknown ids at request time.