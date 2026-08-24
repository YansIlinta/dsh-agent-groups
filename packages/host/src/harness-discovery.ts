/**
 * Host-side harness discovery (V0.4.1): wraps the LIVING DeepSeek Harness
 * services (`ctx.llm`, `ctx.credentials`, `ctx.settings`) that this plugin can
 * reach from the same Cordis process (optional-service precedent:
 * `ctx.get('agentDefaultModel')`, `index.ts`), and exposes the narrow
 * provider / model / reasoning / credential surface the Role Editor needs.
 *
 * Guarantees:
 *  - NO static provider or model arrays — every answer is read from the live
 *    harness at call time, so an `llm/adapters-updated` refresh is reflected
 *    on the next read;
 *  - NEVER returns credential values — only status facts and the credential
 *    REFERENCE NAME (`credentialRef`, an env-var id like `DEEPSEEK_API_KEY`),
 *    which the harness' own Models settings page already exposes as a label;
 *  - degrades gracefully: any absent service yields an empty-but-healthy
 *    surface, and the host keeps working (the runtime gates provider/effort
 *    at spawn/request time instead).
 *
 * @module @dsh-agent-groups/host
 */

import type { Context } from '@deepseek-ai/cordis'

// ── narrow gating surface (T2 seam, consumed by updateTeamConfig) ───────────

/**
 * The minimal discovery surface `GroupHost.updateTeamConfig` needs for
 * DSH-runtime capability gating. Optional constructor option: while no source
 * is mounted, team-config validation validates shape only.
 */
export interface RoleProviderDiscovery {
  /** Provider route ids currently known to the harness (`ctx.llm.listProviders()`). */
  listProviderIds(): Promise<readonly string[]>
  /**
   * Adapter-owned reasoning-effort ids for a provider/model, when the harness
   * can resolve them (`ctx.llm.resolveModelInfo(...).reasoning.efforts`).
   * `undefined` / `[]` → capabilities unknown → accept and let the runtime gate.
   */
  listReasoningEfforts(provider: string | undefined, model: string | undefined): Promise<readonly string[] | undefined>
}

// ── full discovery surface (discoveryView / Role Editor data) ───────────────

export interface DiscoveredProvider {
  readonly id: string
  readonly name: string
}

export interface DiscoveredModel {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface DiscoveredEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** Adapter-owned reasoning surface for one exact provider/model route. */
export interface ReasoningInfo {
  readonly efforts: readonly DiscoveredEffort[]
  readonly defaultEffort?: string
}

/** One configurable-provider settings entry point (per `ctx.llm`). */
export interface ConfigurableProviderInfo {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
  readonly declared?: boolean
}

/**
 * Credential status for one provider route — facts only, never the value.
 * `configured: undefined` means the harness cannot currently tell (the
 * credential or settings service is absent, or the route declares no settings
 * entry / credential reference).
 */
export interface ProviderCredentialStatus {
  readonly provider: string
  readonly configured?: boolean
  readonly source?: string
  readonly writable?: boolean
  /** Settings entry point that configures this provider (least-hardcoded seam). */
  readonly settingsNs?: string
  readonly settingsPath?: readonly string[]
  /** The credential REFERENCE NAME (env-var id), never its value. */
  readonly credentialRef?: string
}

/** The full discovery surface a GroupHost discovery source satisfies. */
export interface HostDiscoverySource extends RoleProviderDiscovery {
  listProviders(): readonly DiscoveredProvider[]
  listModels(provider: string): Promise<readonly DiscoveredModel[]>
  resolveReasoning(provider: string, model: string): Promise<ReasoningInfo | undefined>
  listConfigurableProviders(): readonly ConfigurableProviderInfo[]
  credentialStatus(provider: string): Promise<ProviderCredentialStatus>
  /**
   * True when the live harness services actually resolved (at least the llm
   * service). `undefined` (sources without the method) is treated as
   * available — this is an additive health signal for the web API's
   * degraded-mode note, not a capability gate.
   */
  available?(): boolean
}

// ── structural views of the harness services (duck-typed, no hard deps) ─────

/** Minimal view of `LlmRuntime` (`ctx.get('llm')`); see dsh-llm types. */
export interface LlmServiceLike {
  listProviders(): readonly { id: string; name: string }[]
  listModels(provider: string): Promise<readonly { provider: string; id: string; name: string; description?: string }[]>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
    id: string
    name: string
    description?: string
    reasoning?: { efforts: readonly { id: string; name: string; description?: string }[]; defaultEffort?: string }
  }>
  listConfigurableProviders(): readonly { provider: string; displayName: string; settingsNs: string; settingsPath: readonly string[]; declared?: boolean }[]
}

/** Minimal view of `CredentialProvider` (`ctx.get('credentials')`). */
export interface CredentialsServiceLike {
  /** Describe one reference; never exposes the value. */
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>
}

/** Minimal view of `SettingsProvider` (`ctx.get('settings')`). */
export interface SettingsServiceLike {
  describe(options?: { redactSecrets?: boolean }): readonly { ns: string; value: unknown }[]
}

export interface HarnessDiscoveryDeps {
  readonly llm?: LlmServiceLike
  readonly credentials?: CredentialsServiceLike
  readonly settings?: SettingsServiceLike
  /**
   * Optional live harness agent-default selection (provider/model), used to
   * gate reasoning efforts for roles that pin no provider/model.
   */
  readonly defaultSelection?: () => { provider?: string; model?: string }
}

/** Resolve the effective provider/model route for capability gating. */
function effectiveRoute(
  deps: HarnessDiscoveryDeps,
  provider: string | undefined,
  model: string | undefined,
): { provider: string; model: string } | undefined {
  const defaults = deps.defaultSelection?.() ?? {}
  const routeProvider = provider ?? defaults.provider
  const routeModel = model ?? defaults.model
  if (routeProvider === undefined || routeModel === undefined) return undefined
  return { provider: routeProvider, model: routeModel }
}

/** Path read over a settings descriptor value (see the Models settings page). */
function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/**
 * Live harness discovery. Construct with a deps OBJECT (tests) or a RESOLVER
 * function (production, so late-mounted services are picked up per call).
 */
export class HarnessDiscovery implements HostDiscoverySource {
  private readonly deps: () => HarnessDiscoveryDeps

  constructor(deps: HarnessDiscoveryDeps | (() => HarnessDiscoveryDeps)) {
    this.deps = typeof deps === 'function' ? deps : () => deps
  }

  listProviders(): readonly DiscoveredProvider[] {
    const llm = this.deps().llm
    if (llm === undefined) return []
    return llm.listProviders().map((p) => ({ id: p.id, name: p.name }))
  }

  async listModels(provider: string): Promise<readonly DiscoveredModel[]> {
    const llm = this.deps().llm
    if (llm === undefined) return []
    try {
      const models = await llm.listModels(provider)
      return models.map((m) => ({
        id: m.id,
        name: m.name,
        ...(m.description === undefined ? {} : { description: m.description }),
      }))
    } catch {
      // Unregistered provider or failing adapter → no catalog (advisory only).
      return []
    }
  }

  async resolveReasoning(provider: string, model: string): Promise<ReasoningInfo | undefined> {
    const llm = this.deps().llm
    if (llm === undefined) return undefined
    try {
      const resolved = await llm.resolveModelInfo(provider, model)
      const reasoning = resolved.reasoning
      if (reasoning === undefined) return undefined
      return {
        efforts: reasoning.efforts.map((e) => ({
          id: e.id,
          name: e.name,
          ...(e.description === undefined ? {} : { description: e.description }),
        })),
        ...(reasoning.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort }),
      }
    } catch {
      // Unknown route/model → capabilities unknown; the runtime gates at
      // request time (loud failure, never a silent fallback).
      return undefined
    }
  }

  listConfigurableProviders(): readonly ConfigurableProviderInfo[] {
    const llm = this.deps().llm
    if (llm === undefined) return []
    return llm.listConfigurableProviders().map((e) => ({
      provider: e.provider,
      displayName: e.displayName,
      settingsNs: e.settingsNs,
      settingsPath: [...e.settingsPath],
      ...(e.declared === undefined ? {} : { declared: e.declared }),
    }))
  }

  async credentialStatus(provider: string): Promise<ProviderCredentialStatus> {
    const entry = this.listConfigurableProviders().find((e) => e.provider === provider)
    if (entry === undefined) return { provider } // no settings entry → no credential surface
    const withEntry: ProviderCredentialStatus = {
      provider,
      settingsNs: entry.settingsNs,
      settingsPath: [...entry.settingsPath],
    }
    const dep = this.deps()
    const settings = dep.settings
    if (settings === undefined) return withEntry
    let descriptor: { ns: string; value: unknown } | undefined
    try {
      // Redacted: role('secret') values are stripped; the apiKeyEnv REFERENCE
      // NAME (role('credential-ref')) stays — exactly what the Models settings
      // page derives (ui-settings-models apiKeyEnvOf pattern).
      descriptor = settings.describe({ redactSecrets: true }).find((d) => d.ns === entry.settingsNs)
    } catch {
      return withEntry
    }
    if (descriptor === undefined) return withEntry
    const profile = getPath(descriptor.value, entry.settingsPath)
    if (typeof profile !== 'object' || profile === null) return withEntry
    const ref = (profile as Record<string, unknown>).apiKeyEnv
    if (typeof ref !== 'string' || ref === '') return withEntry
    const withRef: ProviderCredentialStatus = { ...withEntry, credentialRef: ref } // reference name only — the value never leaves CredentialProvider
    const credentials = dep.credentials
    if (credentials === undefined) return withRef
    try {
      const info = await credentials.describe(ref)
      return { ...withRef, configured: info.configured, source: info.source, writable: info.writable }
    } catch {
      // describe is total for unconfigured refs; keep the guard anyway so an
      // unavailable credential service degrades to "unknown" instead of
      // breaking the whole discovery view.
      return withRef
    }
  }

  // ── narrow gating surface (RoleProviderDiscovery) ──────────────────────────

  async listProviderIds(): Promise<readonly string[]> {
    return this.listProviders().map((p) => p.id)
  }

  /** True when the live harness llm service resolved in this process. */
  available(): boolean {
    return this.deps().llm !== undefined
  }

  async listReasoningEfforts(provider: string | undefined, model: string | undefined): Promise<readonly string[] | undefined> {
    const route = effectiveRoute(this.deps(), provider, model)
    if (route === undefined) return undefined
    const reasoning = await this.resolveReasoning(route.provider, route.model)
    if (reasoning === undefined || reasoning.efforts.length === 0) return undefined
    return reasoning.efforts.map((e) => e.id)
  }
}

/**
 * Mount discovery over the LIVE harness services from the same Cordis process.
 * Absent services (headless / tests / partial bundles) yield an empty but
 * healthy discovery — the host keeps working and the runtime gates at
 * spawn / request time.
 */
export function mountHarnessDiscovery(ctx: Context): HarnessDiscovery {
  return new HarnessDiscovery(() => ({
    llm: ctx.get('llm') as LlmServiceLike | undefined,
    credentials: ctx.get('credentials') as CredentialsServiceLike | undefined,
    settings: ctx.get('settings') as SettingsServiceLike | undefined,
    defaultSelection: () => {
      const source = ctx.get('agentDefaultModel') as { currentSelection(): { provider?: string; model?: string } } | undefined
      return source?.currentSelection() ?? {}
    },
  }))
}