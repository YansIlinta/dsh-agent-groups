/**
 * PromptCompiler (Phase 1).
 *
 * Composes the layered Agent prompt (Group Protocol → Runtime Instructions →
 * Role Preset → Leader Dynamic Instruction → Current Task → Relevant Context
 * Delta) deterministically and within a configurable context budget. Lower
 * priority layers are trimmed first; mandatory task/acceptance/leader layers
 * are never dropped.
 *
 * @module @dsh-agent-groups/host
 */

export interface PromptSection {
  readonly id: string
  readonly title?: string
  readonly content: string
  /** 1 = highest priority; larger numbers are lower priority. */
  readonly priority: number
  /** Required sections are never excluded, even when over budget. */
  readonly required?: boolean
  /** Optional per-section cap used before a section is dropped. */
  readonly maxTokens?: number
}

export interface PromptCompileOptions {
  /** Global context budget in approximate tokens. */
  readonly maxContextTokens?: number
  /** Render `## title` headers for sections that provide one. */
  readonly includeTitles?: boolean
}

export interface CompiledPromptSection {
  readonly id: string
  readonly title?: string
  readonly content: string
  readonly priority: number
  readonly required: boolean
  readonly tokens: number
  readonly included: boolean
  readonly trimmed: boolean
}

export interface CompiledPrompt {
  readonly text: string
  readonly sections: readonly CompiledPromptSection[]
  readonly totalTokens: number
  readonly maxContextTokens?: number
  /** Ids of sections that were trimmed or dropped due to the budget. */
  readonly trimmed: readonly string[]
}

export const DEFAULT_MAX_CONTEXT_TOKENS = 16_000

/** Very small token estimator: CJK ≈ 1 token/char, Latin ≈ 4 chars/token. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0xf900 && code <= 0xfaff)) {
      cjk += 1
    } else {
      other += 1
    }
  }
  return Math.ceil(cjk + other / 4)
}

function renderSection(section: PromptSection, includeTitle: boolean): string {
  const body = section.content.trim()
  if (body.length === 0) return ''
  if (includeTitle && section.title !== undefined && section.title.length > 0) {
    return `## ${section.title}\n${body}`
  }
  return body
}

function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0 || text.length === 0) return ''
  if (estimateTokens(text) <= maxTokens) return text
  // Binary search the longest prefix that fits the estimated budget.
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  const trimmed = text.slice(0, low).replace(/\s+$/, '')
  return trimmed.length === text.length ? trimmed : `${trimmed}\n…`
}

/**
 * Compile prompt sections in priority order and apply the context budget.
 * Required sections are always included; optional sections are included while
 * they fit, then trimmed to their remaining share, then dropped.
 */
export function compilePrompt(
  sections: readonly PromptSection[],
  options: PromptCompileOptions = {},
): CompiledPrompt {
  const max = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS
  const includeTitles = options.includeTitles ?? true
  const sorted = [...sections].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))

  const compiled: CompiledPromptSection[] = []
  const trimmedIds: string[] = []
  let used = 0

  const addRequired = (section: PromptSection): void => {
    const rendered = renderSection(section, includeTitles)
    const tokens = estimateTokens(rendered)
    // Required sections remain included even if the budget is exceeded.
    if (rendered.length > 0) {
      compiled.push({
        id: section.id,
        title: section.title,
        content: rendered,
        priority: section.priority,
        required: true,
        tokens,
        included: true,
        trimmed: false,
      })
      used += tokens
    }
  }

  // 1. Required / protected layers first (task, acceptance, leader explicit).
  for (const section of sorted) {
    if (section.required === true) addRequired(section)
  }

  // 2. Optional layers from highest to lowest priority.
  for (const section of sorted) {
    if (section.required === true) continue
    const rendered = renderSection(section, includeTitles)
    const fullTokens = estimateTokens(rendered)
    if (rendered.length === 0) {
      compiled.push({
        id: section.id,
        title: section.title,
        content: '',
        priority: section.priority,
        required: false,
        tokens: 0,
        included: false,
        trimmed: false,
      })
      continue
    }
    if (used + fullTokens <= max) {
      compiled.push({
        id: section.id,
        title: section.title,
        content: rendered,
        priority: section.priority,
        required: false,
        tokens: fullTokens,
        included: true,
        trimmed: false,
      })
      used += fullTokens
      continue
    }

    const remaining = max - used
    if (remaining > 0) {
      const sectionCap = Math.min(section.maxTokens ?? remaining, remaining)
      const trimmedRendered = truncateToTokens(rendered, sectionCap)
      const trimmedTokens = estimateTokens(trimmedRendered)
      if (trimmedRendered.length > 0 && trimmedTokens > 0) {
        compiled.push({
          id: section.id,
          title: section.title,
          content: trimmedRendered,
          priority: section.priority,
          required: false,
          tokens: trimmedTokens,
          included: true,
          trimmed: true,
        })
        used += trimmedTokens
        trimmedIds.push(section.id)
        continue
      }
    }

    compiled.push({
      id: section.id,
      title: section.title,
      content: '',
      priority: section.priority,
      required: false,
      tokens: 0,
      included: false,
      trimmed: false,
    })
    trimmedIds.push(section.id)
  }

  const text = compiled
    .filter((section) => section.included && section.content.length > 0)
    .map((section) => section.content)
    .join('\n\n')

  return {
    text: text.trim(),
    sections: compiled,
    totalTokens: estimateTokens(text.trim()),
    maxContextTokens: max,
    trimmed: trimmedIds,
  }
}

/** Convenience class matching the product vocabulary. */
export class PromptCompiler {
  constructor(private readonly defaultMaxContextTokens: number = DEFAULT_MAX_CONTEXT_TOKENS) {}

  compile(sections: readonly PromptSection[], options: PromptCompileOptions = {}): CompiledPrompt {
    return compilePrompt(sections, {
      ...options,
      maxContextTokens: options.maxContextTokens ?? this.defaultMaxContextTokens,
    })
  }
}

// ── High-level agent prompt builder ─────────────────────────────────────────

export interface AgentTaskPrompt {
  readonly subject: string
  readonly description?: string
  readonly kind?: string
  readonly acceptanceCriteria: readonly string[]
  readonly writeScopes?: readonly string[]
  readonly blockedBy?: readonly string[]
}

export interface AgentRelevantContext {
  readonly title?: string
  readonly content: string
  /** High-priority context can be marked required. Defaults to false. */
  readonly required?: boolean
}

export interface AgentPromptLayers {
  readonly groupProtocol: string
  readonly runtimeInstructions?: string
  readonly rolePreset?: string
  readonly leaderDynamicInstruction?: string
  readonly currentTask?: string | AgentTaskPrompt
  readonly relevantContext?: readonly AgentRelevantContext[]
  readonly historicalContext?: string
  readonly maxContextTokens?: number
}

function taskPromptText(task: AgentTaskPrompt): string {
  const lines: string[] = [`Subject: ${task.subject}`]
  if (task.description !== undefined && task.description.length > 0) lines.push(`Description: ${task.description}`)
  if (task.kind !== undefined) lines.push(`Kind: ${task.kind}`)
  if (task.acceptanceCriteria.length > 0) {
    lines.push('Acceptance criteria:')
    for (const item of task.acceptanceCriteria) lines.push(`  - ${item}`)
  }
  if (task.writeScopes !== undefined && task.writeScopes.length > 0) lines.push(`Write scopes: ${task.writeScopes.join(', ')}`)
  if (task.blockedBy !== undefined && task.blockedBy.length > 0) lines.push(`Blocked by: ${task.blockedBy.join(', ')}`)
  return lines.join('\n')
}

/**
 * Compile the canonical six-layer Agent prompt. Required layers (Group
 * Protocol, Leader Dynamic Instruction, Current Task) are never trimmed.
 */
export function compileAgentPrompt(input: AgentPromptLayers): CompiledPrompt {
  const sections: PromptSection[] = [
    { id: 'group-protocol', title: 'Group Protocol', content: input.groupProtocol, priority: 1, required: true },
  ]
  if (input.runtimeInstructions !== undefined && input.runtimeInstructions.length > 0) {
    sections.push({ id: 'runtime-instructions', title: 'Runtime Instructions', content: input.runtimeInstructions, priority: 2 })
  }
  if (input.rolePreset !== undefined && input.rolePreset.length > 0) {
    sections.push({ id: 'role-preset', title: 'Role Preset', content: input.rolePreset, priority: 3 })
  }
  if (input.leaderDynamicInstruction !== undefined && input.leaderDynamicInstruction.length > 0) {
    sections.push({ id: 'leader-instruction', title: 'Leader Dynamic Instruction', content: input.leaderDynamicInstruction, priority: 4, required: true })
  }
  if (input.currentTask !== undefined) {
    const content = typeof input.currentTask === 'string' ? input.currentTask : taskPromptText(input.currentTask)
    if (content.length > 0) sections.push({ id: 'current-task', title: 'Current Task', content, priority: 5, required: true })
  }
  if (input.relevantContext !== undefined) {
    for (const [index, context] of input.relevantContext.entries()) {
      sections.push({
        id: `relevant-context-${index}`,
        title: context.title ?? 'Relevant Context',
        content: context.content,
        priority: 6,
        required: context.required,
      })
    }
  }
  if (input.historicalContext !== undefined && input.historicalContext.length > 0) {
    sections.push({ id: 'historical-context', title: 'Historical Context', content: input.historicalContext, priority: 7 })
  }
  return compilePrompt(sections, { maxContextTokens: input.maxContextTokens })
}
