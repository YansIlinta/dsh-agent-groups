/**
 * Phase 1 tests: Runtime Message Abstraction and PromptCompiler.
 */
import { describe, expect, it } from 'vitest'
import {
  createRuntimeMessage,
  deliverRuntimeMessage,
  runtimeMessageText,
  type RuntimeMessage,
} from '../src/runtime/message.js'
import {
  PromptCompiler,
  compileAgentPrompt,
  compilePrompt,
  estimateTokens,
  type PromptSection,
} from '../src/prompt-compiler.js'

describe('Phase 1: runtime message abstraction', () => {
  it('creates structured messages with task/thread/priority metadata', () => {
    const message = createRuntimeMessage({
      type: 'task_assignment',
      groupId: 'g-1',
      senderId: 'lead-1',
      recipientId: 'member-1',
      taskId: 't-1',
      threadId: 'thread-1',
      priority: 'high',
      timestamp: 1234,
      payload: { subject: 'Implement parser', acceptanceCriteria: ['tests pass'] },
    })

    expect(message.type).toBe('task_assignment')
    expect(message.groupId).toBe('g-1')
    expect(message.senderId).toBe('lead-1')
    expect(message.recipientId).toBe('member-1')
    expect(message.taskId).toBe('t-1')
    expect(message.threadId).toBe('thread-1')
    expect(message.priority).toBe('high')
    expect(message.timestamp).toBe(1234)
    expect(message.payload).toMatchObject({ subject: 'Implement parser' })
  })

  it('renders a structured message into text for text-only runtimes', () => {
    const message = createRuntimeMessage({
      type: 'task_assignment',
      groupId: 'g-1',
      senderId: 'lead-1',
      taskId: 't-1',
      priority: 'high',
      payload: {
        subject: 'Add endpoint',
        description: 'Create a REST endpoint',
        acceptanceCriteria: ['returns 200'],
        writeScopes: ['src/'],
        blockedBy: [],
      },
    })

    const text = runtimeMessageText(message)
    expect(text).toContain('[Agent Groups · task_assignment]')
    expect(text).toContain('Task: t-1')
    expect(text).toContain('Priority: high')
    expect(text).toContain('Subject: Add endpoint')
    expect(text).toContain('Acceptance criteria:')
    expect(text).toContain('returns 200')
    expect(text).toContain('Write scopes: src/')
  })

  it('prefers structured deliver and falls back to sendInput for compatibility', async () => {
    const structured: RuntimeMessage<unknown>[] = []
    const textInputs: string[] = []

    const deliveree = {
      deliver: async (message: RuntimeMessage<unknown>) => { structured.push(message) },
      sendInput: async (text: string) => { textInputs.push(text) },
    }
    const fallback = {
      sendInput: async (text: string) => { textInputs.push(text) },
    }

    const message = createRuntimeMessage({
      type: 'system_event',
      groupId: 'g-1',
      senderId: 'system',
      payload: { text: 'hello' },
    })

    await expect(deliverRuntimeMessage(deliveree, message)).resolves.toBe(true)
    expect(structured).toHaveLength(1)
    expect(textInputs).toHaveLength(0)

    await expect(deliverRuntimeMessage(fallback, message)).resolves.toBe(true)
    expect(textInputs).toEqual(['[Agent Groups · system_event]\nhello'])
  })

  it('supports payload as text and taskBrief shortcuts', () => {
    const direct = createRuntimeMessage({
      type: 'leader_instruction',
      groupId: 'g-1',
      senderId: 'lead-1',
      payload: { text: 'Do not touch UI.' },
    })
    expect(runtimeMessageText(direct)).toContain('Do not touch UI.')

    const brief = createRuntimeMessage({
      type: 'task_assignment',
      groupId: 'g-1',
      senderId: 'lead-1',
      taskId: 't-9',
      payload: { taskBrief: 'Full brief here' },
    })
    expect(runtimeMessageText(brief)).toContain('Full brief here')
  })
})

describe('Phase 1: PromptCompiler', () => {
  const sections: readonly PromptSection[] = [
    { id: 'group-protocol', title: 'Group Protocol', content: 'You are a group member.', priority: 1, required: true },
    { id: 'runtime', title: 'Runtime Instructions', content: 'Use the provided tools carefully.', priority: 2 },
    { id: 'role', title: 'Role Preset', content: 'You are the Implementation Agent. Prefer minimal changes.', priority: 3 },
    { id: 'leader', title: 'Leader Instruction', content: 'For this task only: focus on runtime abstraction.', priority: 4, required: true },
    { id: 'task', title: 'Current Task', content: 'Implement the bridge.\nAcceptance criteria:\n- tests pass\nWrite scopes:\n- src/', priority: 5, required: true },
    { id: 'context', title: 'Relevant Context', content: 'Historical details that can be trimmed when the budget is tight.', priority: 6 },
  ]

  it('compiles layers in priority order with required sections preserved', () => {
    const compiled = compilePrompt(sections, { maxContextTokens: 10_000 })
    expect(compiled.sections.filter((s) => s.included).map((s) => s.id)).toEqual([
      'group-protocol',
      'leader',
      'task',
      'runtime',
      'role',
      'context',
    ])
    expect(compiled.text).toContain('Group Protocol')
    expect(compiled.text).toContain('Leader Instruction')
    expect(compiled.text).toContain('Current Task')
    expect(compiled.totalTokens).toBeGreaterThan(0)
  })

  it('trims low-priority context before task/leader sections when over budget', () => {
    const compiled = compilePrompt(sections, {
      maxContextTokens: estimateTokens('## Group Protocol\nYou are a group member.\n\n## Leader Instruction\nFor this task only: focus on runtime abstraction.\n\n## Current Task\nImplement the bridge.\nAcceptance criteria:\n- tests pass\nWrite scopes:\n- src/') + 4,
      includeTitles: true,
    })
    const included = compiled.sections.filter((s) => s.included)
    expect(included.some((s) => s.id === 'task' && s.required)).toBe(true)
    expect(included.some((s) => s.id === 'leader' && s.required)).toBe(true)
    expect(included.some((s) => s.id === 'group-protocol' && s.required)).toBe(true)
    // The lowest-priority optional context is dropped/trimmed when it does not fit.
    const context = compiled.sections.find((s) => s.id === 'context')
    expect(context?.included).toBe(false)
    expect(compiled.trimmed).toContain('context')
  })

  it('drops/trims only optional sections while keeping required over budget', () => {
    const compiled = new PromptCompiler(64).compile([
      { id: 'task', content: 'TASK_REQUIREMENT', priority: 1, required: true },
      { id: 'context-1', content: 'a'.repeat(200), priority: 2 },
      { id: 'context-2', content: 'b'.repeat(200), priority: 3 },
    ], { includeTitles: false })
    expect(compiled.text).toContain('TASK_REQUIREMENT')
    expect(compiled.sections.find((s) => s.id === 'task')?.included).toBe(true)
    // At least one low-priority section was trimmed or dropped.
    expect(compiled.trimmed.length).toBeGreaterThan(0)
  })

  it('estimateTokens is deterministic and positive', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('hello world')).toBeGreaterThan(0)
    expect(estimateTokens('实现增量上下文')).toBeGreaterThan(0)
  })

  it('compiles the canonical six-layer agent prompt via compileAgentPrompt', () => {
    const compiled = compileAgentPrompt({
      groupProtocol: 'You are a Group Member.',
      runtimeInstructions: 'Use the runtime tool bridge.',
      rolePreset: 'You are the Implementation Agent.',
      leaderDynamicInstruction: 'Act as a migration specialist. Do not modify UI.',
      currentTask: {
        subject: 'Add runtime bridge',
        description: 'Implement the bridge layer',
        acceptanceCriteria: ['tests pass'],
        writeScopes: ['src/runtime'],
        blockedBy: [],
      },
      relevantContext: [{ title: 'Recent channel', content: 'Channel context that can be trimmed.' }],
      historicalContext: 'Older history.',
      maxContextTokens: 512,
    })
    const ids = compiled.sections.filter((s) => s.included).map((s) => s.id)
    expect(ids[0]).toBe('group-protocol')
    expect(ids).toContain('runtime-instructions')
    expect(ids).toContain('role-preset')
    expect(ids).toContain('leader-instruction')
    expect(ids).toContain('current-task')
    expect(compiled.text).toContain('Acceptance criteria:')
    expect(compiled.text).toContain('tests pass')
    expect(compiled.text).toContain('Write scopes: src/runtime')
  })

})
