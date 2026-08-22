import { describe, expect, it } from 'vitest'
import { installMemberPeerContactPolicy, RAW_PEER_TOOLS } from '../src/policy.js'
import { makeHarness, seedGroup } from './helpers.js'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** Minimal Context capturing the pre-execute hook the policy registers. */
function captureContext(): { ctx: Context; hook: (exec: ToolExecution, next: () => Promise<unknown>) => Promise<unknown> } {
  let hook: (exec: ToolExecution, next: () => Promise<unknown>) => Promise<unknown> = async (_e, next) => next()
  const ctx = {
    on(_event: string, fn: (exec: ToolExecution, next: () => Promise<unknown>) => Promise<unknown>): unknown {
      hook = fn
      return () => undefined
    },
  } as unknown as Context
  return { ctx, hook: (exec, next) => hook(exec, next) }
}

function execFor(agentId: string | undefined, name: string): ToolExecution {
  return { agent: agentId === undefined ? undefined : { id: agentId }, name } as ToolExecution
}

const ALLOW: () => Promise<unknown> = async () => ({ kind: 'allow' })

describe('member peer-contact policy (defense in depth)', () => {
  it('denies every raw peer tool for a group member', async () => {
    const h = makeHarness()
    const group = await seedGroup(h)
    await h.groups.addMember(group.groupId, { sessionId: 'm-1', profileId: 'reviewer', name: 'Rv', role: 'member', status: 'idle' })
    const { hook } = captureContextAfterInstall(h)
    for (const tool of RAW_PEER_TOOLS) {
      const result = await hook(execFor('m-1', tool), ALLOW)
      expect(result).toMatchObject({ kind: 'deny', reason: expect.any(String) })
    }
  })

  it('allows non-peer tools, the leader, and non-group agents', async () => {
    const h = makeHarness()
    const group = await seedGroup(h)
    await h.groups.addMember(group.groupId, { sessionId: 'm-1', profileId: 'reviewer', name: 'Rv', role: 'member', status: 'idle' })
    const { hook } = captureContextAfterInstall(h)
    expect(await hook(execFor('m-1', 'group_claim_task'), ALLOW)).toEqual({ kind: 'allow' })
    expect(await hook(execFor(group.leaderSessionId, 'send_message'), ALLOW)).toEqual({ kind: 'allow' })
    expect(await hook(execFor('outsider', 'send_message'), ALLOW)).toEqual({ kind: 'allow' })
  })

  it('skips the gate when no agent identity is attached to the execution', async () => {
    const h = makeHarness()
    await seedGroup(h)
    const { hook } = captureContextAfterInstall(h)
    expect(await hook(execFor(undefined, 'send_message'), ALLOW)).toEqual({ kind: 'allow' })
  })
})

function captureContextAfterInstall(h: ReturnType<typeof makeHarness>): { hook: (exec: ToolExecution, next: () => Promise<unknown>) => Promise<unknown> } {
  const captured = captureContext()
  installMemberPeerContactPolicy(captured.ctx, h.groups)
  return { hook: captured.hook }
}
