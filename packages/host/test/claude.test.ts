/**
 * Claude Agent SDK provider tests (requirements §7, §12, §13).
 *
 * The provider runs against a deterministic FAKE query factory — no real
 * Claude CLI and no credentials. Covers: persistent multi-turn sessions
 * (resume by session id), streaming output, interrupt, permission policy,
 * failure mapping, per-query config stability between fresh and resumed
 * sessions.
 */
import { describe, expect, it, vi } from 'vitest'
import { ClaudeRuntimeProvider } from '../src/runtime/claude.js'
import type { ClaudeQueryFactory, ClaudeQueryLike, ClaudeQueryParams } from '../src/runtime/claude.js'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { RuntimeEvent } from '../src/runtime/events.js'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function fakeQuery(messages: SDKMessage[], options?: { halt?: boolean; onHalt?: (signal: AbortSignal) => void }): ClaudeQueryLike {
  const generator = (async function* () {
    for (const message of messages) yield message
    if (options?.halt === true) {
      await new Promise<void>((resolve) => {
        options.onHalt?.(resolve as unknown as AbortSignal)
      })
    }
  })() as unknown as ClaudeQueryLike
  return generator
}

function assistant(text: string, sessionId = 'ses-1'): SDKMessage {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    uuid: `u-${Math.random()}`,
    session_id: sessionId,
  } as unknown as SDKMessage
}

function result(subtype: 'success' | 'error_during_execution', text: string, sessionId = 'ses-1', isError = false): SDKMessage {
  return {
    type: 'result',
    subtype,
    duration_ms: 10,
    is_error: isError,
    num_turns: 1,
    stop_reason: null,
    result: text,
    session_id: sessionId,
  } as unknown as SDKMessage
}

/** Record every query invocation (prompt + options) of the fake SDK. */
function recordingFactory(script: (params: ClaudeQueryParams, index: number) => ClaudeQueryLike): { factory: ClaudeQueryFactory; calls: ClaudeQueryParams[] } {
  const calls: ClaudeQueryParams[] = []
  const factory: ClaudeQueryFactory = (params) => {
    calls.push({ prompt: params.prompt, options: { ...params.options } })
    return script(params, calls.length - 1)
  }
  return { factory, calls }
}

function collectEvents(session: { subscribe(listener: (event: RuntimeEvent) => void): () => void }): RuntimeEvent[] {
  const events: RuntimeEvent[] = []
  session.subscribe((event) => events.push(event))
  return events
}

const BASE_CONFIG = { groupId: 'g-1', agentId: 'm-1', role: 'implementation', workspace: '/ws', model: 'claude-sonnet-4-5', reasoningLevel: 'high' }

describe('claude runtime provider (agent SDK)', () => {
  it('keeps ONE persistent session across sequential turns (resume by session id)', async () => {
    const { factory, calls } = recordingFactory((params, index) => {
      const messages = index === 0 ? [assistant('step one done'), result('success', 'task a done')] : [assistant('step two done'), result('success', 'task b done')]
      return fakeQuery(messages)
    })
    const provider = new ClaudeRuntimeProvider({ binPath: '/fake/claude', queryFactory: factory })
    const session = await provider.createSession(BASE_CONFIG)
    const events = collectEvents(session)

    const turn1 = await session.runTurn({ taskId: 'task-a', text: 'implement auth' })
    const r1 = await turn1.waitForCompletion()
    expect(r1.status).toBe('completed')
    expect(r1.summary).toContain('task a done')
    expect(r1.output).toContain('step one done')

    // turn 2: the SAME provider session, now resumed
    const turn2 = await session.runTurn({ taskId: 'task-b', text: 'reviewer pass' })
    const r2 = await turn2.waitForCompletion()
    expect(r2.status).toBe('completed')

    expect(calls).toHaveLength(2)
    expect(calls[0]!.options.resume).toBeUndefined()
    expect(calls[1]!.options.resume).toBe('ses-1')
    expect(session.info().providerSessionId).toBe('ses-1')
    expect(events.filter((e) => e.type === 'turn.completed')).toHaveLength(2)
    await session.close(50)
  })

  it('fresh and resumed sessions receive the SAME configuration (no drift)', async () => {
    const { factory, calls } = recordingFactory((_params) => fakeQuery([assistant('ok'), result('success', 'done')]))
    const provider = new ClaudeRuntimeProvider({ binPath: '/fake/claude', queryFactory: factory })
    const session = await provider.createSession(BASE_CONFIG)
    const first = await session.runTurn({ taskId: 't1', text: 'a' })
    await first.waitForCompletion()
    const second = await session.runTurn({ taskId: 't2', text: 'b' })
    await second.waitForCompletion()
    for (const call of calls) {
      expect(call.options.cwd).toBe('/ws')
      expect(call.options.model).toBe('claude-sonnet-4-5')
      expect(call.options.permissionMode).toBe('acceptEdits')
      expect(call.options.thinking).toEqual({ type: 'adaptive' })
    }
    // only the resume field differs (per-call closures like canUseTool and
    // abortController are inherently call-scoped)
    const comparable = (options: Record<string, unknown>): Record<string, unknown> => {
      const { resume: _r, canUseTool: _t, abortController: _a, ...rest } = options
      void _r; void _t; void _a
      return rest
    }
    expect(comparable(calls[0]!.options as Record<string, unknown>)).toEqual(comparable(calls[1]!.options as Record<string, unknown>))
    await session.close(50)
  })

  it('maps reasoning levels onto the SDK thinking vocabulary', async () => {
    const seen: Record<string, unknown>[] = []
    const provider = new ClaudeRuntimeProvider({
      binPath: '/fake/claude',
      queryFactory: (params) => {
        seen.push({ ...params.options })
        return fakeQuery([assistant('ok'), result('success', 'done')])
      },
    })
    for (const level of ['low', 'medium', 'high'] as const) {
      const session = await provider.createSession({ ...BASE_CONFIG, reasoningLevel: level })
      const turn = await session.runTurn({ taskId: 't', text: 'go' })
      await turn.waitForCompletion()
      await session.close(50)
    }
    expect(seen[0]!.thinking).toEqual({ type: 'disabled' })
    expect(seen[1]!.thinking).toBeUndefined() // medium → SDK default
    expect(seen[2]!.thinking).toEqual({ type: 'adaptive' })
  })

  it('interrupt aborts the running query and yields a cancelled turn', async () => {
    let release!: () => void
    const { factory } = recordingFactory((_params) => {
      const signalBox: AbortSignal[] = []
      const generator = (async function* () {
        await new Promise<void>((resolve) => {
          release = resolve
          void release
        })
        // hold until aborted
        yield* waitForAbort(signalBox[0])
      })() as unknown as ClaudeQueryLike
      return generator
    })
    // simpler: halt generator until the abort signal fires
    void factory
    let halted = true
    const provider = new ClaudeRuntimeProvider({
      binPath: '/fake/claude',
      queryFactory: (params) => {
        halted = true
        const generator = (async function* () {
          await new Promise<void>((resolve) => {
            ;(params.options.abortController as AbortController).signal.addEventListener('abort', () => resolve())
          })
          halted = false
        })() as unknown as ClaudeQueryLike
        return generator
      },
    })
    const session = await provider.createSession(BASE_CONFIG)
    const turn = await session.runTurn({ taskId: 'task-a', text: 'long' })
    await vi.waitFor(() => expect(halted).toBe(true))
    await session.interrupt('leader stop')
    const result = await turn.waitForCompletion()
    expect(result.status).toBe('cancelled')
    await session.close(50)
  })

  it('permission policy: disallowed tools are denied LOUDLY, allowed tools pass', async () => {
    const { factory, calls } = recordingFactory((_params) => fakeQuery([assistant('ok'), result('success', 'done')]))
    const provider = new ClaudeRuntimeProvider({ binPath: '/fake/claude', queryFactory: factory })
    const session = await provider.createSession({
      ...BASE_CONFIG,
      metadata: { allowedTools: ['Read', 'Edit', 'Write'] },
    })
    const events = collectEvents(session)
    const turn = await session.runTurn({ taskId: 't1', text: 'work' })
    const canUseTool = calls[0]!.options.canUseTool as (tool: string, input: unknown, opts: Record<string, unknown>) => Promise<{ behavior: string; message?: string }>
    const denied = await canUseTool('Bash', { command: 'rm' }, { decisionReason: 'dangerous command' })
    expect(denied.behavior).toBe('deny')
    const allowed = await canUseTool('Read', { path: '/ws/x' }, {})
    expect(allowed.behavior).toBe('allow')
    await vi.waitFor(() => expect(events.some((e) => e.type === 'turn.permission.denied')).toBe(true))
    const deniedEvent = events.find((e) => e.type === 'turn.permission.denied')!
    if (deniedEvent.type !== 'turn.permission.denied') throw new Error('unreachable')
    expect(deniedEvent.tool).toBe('Bash')
    expect(deniedEvent.decisionReason).toBe('dangerous command')
    // finish the turn normally afterwards
    const finish = turn.waitForCompletion()
    await sleep(10)
    // the emaitting turn completes when its query finishes — release it:
    // (the fake already completed; waitForCompletion resolves on result)
    void finish
    expect((await Promise.race([finish, sleep(100).then(() => 'timeout')]))).not.toBe('timeout')
    await session.close(50)
  })

  it('failure results map onto failed turns; late/queued follow-ups keep the session', async () => {
    const { factory, calls } = recordingFactory((_params, index) => {
      if (index === 0) return fakeQuery([assistant('boom'), result('error_during_execution', 'git merge failed', 'ses-1', true)])
      return fakeQuery([assistant('fixed'), result('success', 'retry done')])
    })
    const provider = new ClaudeRuntimeProvider({ binPath: '/fake/claude', queryFactory: factory })
    const session = await provider.createSession(BASE_CONFIG)
    const turn1 = await session.runTurn({ taskId: 'task-a', text: 'work' })
    const r1 = await turn1.waitForCompletion()
    expect(r1.status).toBe('failed')
    expect(r1.summary).toContain('git merge failed')
    // same provider session continues
    const turn2 = await session.runTurn({ taskId: 'task-b', text: 'retry' })
    const r2 = await turn2.waitForCompletion()
    expect(r2.status).toBe('completed')
    expect(calls[1]!.options.resume).toBe('ses-1')
    await session.close(50)
  })
})

function waitForAbort(signal: AbortSignal | undefined): AsyncGenerator<SDKMessage> {
  return (async function* () {
    await new Promise<void>((resolve) => {
      signal?.addEventListener('abort', () => resolve())
    })
  })() as AsyncGenerator<SDKMessage>
}