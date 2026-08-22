import { describe, expect, it } from 'vitest'
import { makeHarness, makeStores, seedGroup } from './helpers.js'

describe('group channel', () => {
  it('posts durable messages in order with no duplication', async () => {
    const h = makeHarness()
    const group = await seedGroup(h)
    for (let i = 0; i < 5; i++) {
      await h.channel.post(group.groupId, { senderId: 'm1', senderName: 'Fe', text: `msg ${i}` })
    }
    const feed = h.channel.list(group.groupId)
    expect(feed).toHaveLength(5)
    expect(feed.map((m) => m.text)).toEqual(['msg 0', 'msg 1', 'msg 2', 'msg 3', 'msg 4'])
    expect(new Set(feed.map((m) => m.id)).size).toBe(5)
  })

  it('channel survives a service reload over shared stores', async () => {
    const stores = makeStores()
    const h = makeHarness(stores)
    const group = await seedGroup(h)
    await h.channel.post(group.groupId, { senderId: 'm1', senderName: 'Fe', text: 'hello durable channel' })
    const reloaded = makeHarness(stores)
    const feed = reloaded.channel.list(group.groupId)
    expect(feed).toHaveLength(1)
    expect(feed[0]?.text).toBe('hello durable channel')
  })

  it('each post fans out exactly one channel notification with increasing seq', async () => {
    const h = makeHarness()
    const group = await seedGroup(h)
    const seen: Array<{ seq: number; kind: string }> = []
    h.notifier.subscribe((update) => {
      if (update.groupId === group.groupId) seen.push({ seq: update.seq, kind: update.kind })
    })
    await h.channel.post(group.groupId, { senderId: 'm1', senderName: 'Fe', text: 'one' })
    await h.channel.post(group.groupId, { senderId: 'm2', senderName: 'Rv', text: 'two' })
    const channelKinds = seen.filter((s) => s.kind === 'channel')
    expect(channelKinds).toHaveLength(2) // exactly one per post, no duplicates
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!.seq).toBeGreaterThan(seen[i - 1]!.seq)
    }
  })

  it('private messages are scoped and one-way between member and leader', async () => {
    const h = makeHarness()
    const group = await seedGroup(h)
    const lead = group.leaderSessionId
    await h.privateMessages.send(group.groupId, { senderId: lead, senderName: 'Lead', recipientId: 'm1', direction: 'leader-to-member', text: 'to member' })
    await h.privateMessages.send(group.groupId, { senderId: 'm1', senderName: 'Fe', recipientId: lead, direction: 'member-to-leader', text: 'to leader' })
    const leaderView = h.privateMessages.listForGroup(group.groupId, lead)
    expect(leaderView).toHaveLength(2)
    const memberView = h.privateMessages.listForPrincipal(group.groupId, 'm1')
    expect(memberView).toHaveLength(2)
    expect(leaderView[0]?.direction).toBe('leader-to-member')
    expect(leaderView[1]?.direction).toBe('member-to-leader')
  })
})
