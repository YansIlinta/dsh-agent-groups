/**
 * Model-facing tool registration. Every tool resolves the calling agent from
 * the execution context and delegates to `GroupHost`, which re-checks the
 * durable role — a prompt is never the enforcement boundary. Arguments are
 * coerced at the tool boundary so odd model input fails with a readable error.
 * @module @dsh-agent-groups/host
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type JsonValue, type ParameterPropertySpec, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { GroupHost } from './group-host.js'

export interface GroupToolDef {
  readonly name: string
  readonly description: string
  readonly parameters?: Record<string, ParameterPropertySpec>
  readonly run: (host: GroupHost, actor: string, args: Record<string, unknown>, exec: ToolRunContext) => unknown | Promise<unknown>
}

export function registerGroupTool(ctx: Context, host: GroupHost, spec: GroupToolDef): void {
  ctx.tools.register(defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters ?? {},
    output: {
      // Unconstrained lossless JSON: tools return rich objects.
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    async execute(args, exec) {
      const value = await spec.run(host, requireActor(exec), asRecord(args), exec)
      return value as JsonValue
    },
  }))
}

export function requireActor(exec: ToolRunContext): string {
  const agent = exec.agent
  if (agent === undefined) {
    throw new Error('Agent Groups tools can only be called inside an agent turn')
  }
  return agent.id
}

export function asRecord(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 0) ?? ''
}

// ── argument coercion helpers ───────────────────────────────────────────────

export function strArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`invalid argument "${key}": expected a non-empty string`)
  }
  return value.trim()
}

export function strOptArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`invalid argument "${key}": expected a string`)
  return value
}

export function numOptArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`invalid argument "${key}": expected a number`)
  return parsed
}

/** Parse a comma-separated string argument into a list. */
export function listOptArg(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = strOptArg(args, key)
  if (value === undefined) return undefined
  return value.split(',').map((part) => part.trim()).filter((part) => part.length > 0)
}

export function boolArg(args: Record<string, unknown>, key: string): boolean {
  const value = args[key]
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  throw new Error(`invalid argument "${key}": expected true or false`)
}
