/**
 * Startup compatibility diagnostic (第 27 节): verify each DSH surface DSH
 * Agent Groups depends on, print the banner, and fail loud when a required
 * service is missing rather than silently degrading the product.
 * @module @dsh-agent-groups/host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CompatibilityReport } from './core-types.js'

export interface SurfacePresence {
  readonly storageDomain: boolean
  readonly webServer: boolean
  readonly agents: boolean
  readonly agentPresets: boolean
  readonly subagents: boolean
}

const REQUIRED: ReadonlyArray<keyof SurfacePresence> = ['storageDomain', 'webServer', 'agents', 'agentPresets']

export function detectSurfaces(ctx: Context): SurfacePresence {
  return {
    storageDomain: ctx.storageDomain !== undefined,
    webServer: ctx.webServer !== undefined,
    agents: ctx.agents !== undefined,
    agentPresets: ctx.agentPresets !== undefined,
    subagents: ctx.get('subagents') !== undefined,
  }
}

export function invokeVersion(): string {
  try {
    return (globalThis as Record<string, unknown>)['__DSH_VERSION__'] as string ?? '0.1.0-rc.6'
  } catch {
    return 'unknown'
  }
}

export function buildCompatibilityReport(ctx: Context, presence: SurfacePresence): CompatibilityReport {
  const checks: CompatibilityReport['checks'] = [
    { name: 'Storage domain', ok: presence.storageDomain },
    { name: 'Web server', ok: presence.webServer },
    { name: 'Agent factory', ok: presence.agents },
    { name: 'Agent presets', ok: presence.agentPresets },
    { name: 'Subagent registry (optional)', ok: presence.subagents },
  ]
  const fatal = REQUIRED.filter((key) => !presence[key])
  return {
    dshVersion: invokeVersion(),
    checks,
    fatal: fatal.map(
      (key) => `missing required DSH surface "${key}" — DeepSeek Harness does not provide it in this composition`,
    ),
  }
}

export function printCompatibility(report: CompatibilityReport): void {
  const lines = [
    '',
    'DSH Agent Groups',
    `Detected DeepSeek Harness: ${report.dshVersion}`,
    ...report.checks.map((check) => `${check.name}: ${check.ok ? 'compatible' : 'MISSING'}`),
  ]
  if (report.fatal.length > 0) {
    lines.push('FATAL:')
    lines.push(...report.fatal)
  }
  process.stderr.write(`${lines.join('\n')}\n`)
}
