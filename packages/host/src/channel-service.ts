/**
 * Group Channel and private Leader⇄Member messaging. The channel is a durable
 * shared timeline every member and the Leader can read; private messages are
 * durable but only visible to the Leader and the party involved. A private
 * exchange surfaces in the activity timeline as metadata only.
 * @module @dsh-agent-groups/host
 */

import { randomUUID } from 'node:crypto'
import type {
  ChannelMessage,
  ChannelMessageKind,
  GroupId,
  PrivateDirection,
  PrivateMessage,
} from './core-types.js'
import type { TableStore } from './store.js'
import { scopedKey } from './store.js'
import { ActivityService } from './activity-service.js'
import { GroupNotifier } from './notifier.js'

export interface ChannelPostInput {
  readonly senderId: string
  readonly senderName: string
  readonly kind?: ChannelMessageKind
  readonly text: string
  readonly refTaskId?: string
  /** V0.2: reply to an existing channel message (simple thread). */
  readonly replyToMessageId?: string
}

export class ChannelService {
  private readonly store: TableStore<string, ChannelMessage>
  private readonly activity: ActivityService
  private readonly notifier: GroupNotifier

  constructor(store: TableStore<string, ChannelMessage>, activity: ActivityService, notifier: GroupNotifier) {
    this.store = store
    this.activity = activity
    this.notifier = notifier
  }

  async post(groupId: GroupId, input: ChannelPostInput): Promise<ChannelMessage> {
    if (input.replyToMessageId !== undefined) {
      this.requireMessage(groupId, input.replyToMessageId)
    }
    const message: ChannelMessage = {
      id: randomUUID(),
      groupId,
      senderId: input.senderId,
      senderName: input.senderName,
      timestamp: Date.now(),
      kind: input.kind ?? 'message',
      text: input.text,
      ...(input.refTaskId !== undefined ? { refTaskId: input.refTaskId } : {}),
      ...(input.replyToMessageId !== undefined ? { replyToMessageId: input.replyToMessageId } : {}),
    }
    await this.store.put(scopedKey(groupId, message.id), message)
    await this.activity.append({
      groupId,
      type: 'group_message',
      actorId: message.senderId,
      actorName: message.senderName,
      refTaskId: message.refTaskId,
      payload: { kind: message.kind, replyToMessageId: message.replyToMessageId ?? null },
    })
    this.notifier.emit(groupId, 'channel', undefined)
    return message
  }

  /** V0.2: pin or unpin a channel message; pinned threads stay in place. */
  async setPinned(groupId: GroupId, messageId: string, by: string, pinned: boolean): Promise<ChannelMessage> {
    const message = await this.mutateMessage(groupId, messageId, (current) => ({
      ...current,
      ...(pinned ? { pinnedAt: Date.now(), pinnedBy: by } : { pinnedAt: undefined, pinnedBy: undefined }),
    }))
    await this.activity.append({
      groupId,
      type: 'message_pinned',
      actorId: by,
      refTaskId: undefined,
      payload: { messageId, pinned, kind: 'channel' },
    })
    this.notifier.emit(groupId, 'channel', undefined)
    return message
  }

  /** Pinned messages, newest pin first. */
  pinned(groupId: GroupId): ChannelMessage[] {
    return this.list(groupId).filter((message) => message.pinnedAt !== undefined).reverse()
  }

  requireMessage(groupId: GroupId, messageId: string): ChannelMessage {
    const message = this.store.get(scopedKey(groupId, messageId))
    if (message === undefined) throw new Error(`channel message not found: ${messageId}`)
    return message
  }

  private async mutateMessage(
    groupId: GroupId,
    messageId: string,
    fn: (current: ChannelMessage) => ChannelMessage,
  ): Promise<ChannelMessage> {
    const key = scopedKey(groupId, messageId)
    try {
      return (await this.store.update(key, fn)) as ChannelMessage
    } catch {
      throw new Error(`channel message not found: ${messageId}`)
    }
  }

  list(groupId: GroupId, limit = 500): ChannelMessage[] {
    const rows: ChannelMessage[] = []
    for (const [key, message] of this.store.entries()) {
      if (message.groupId === groupId) rows.push(message)
    }
    rows.sort((a, b) => a.timestamp - b.timestamp)
    return rows.slice(-limit)
  }
}

export interface PrivateSendInput {
  readonly senderId: string
  readonly senderName: string
  readonly recipientId: string
  readonly direction: PrivateDirection
  readonly text: string
}

/** The full inbox/outbox visible to one principal in one group. */
export class PrivateMessageService {
  private readonly store: TableStore<string, PrivateMessage>
  private readonly activity: ActivityService
  private readonly notifier: GroupNotifier
  /** Who is allowed to see every private message in a group (the Leader). */
  private readonly leaderOf: (groupId: GroupId) => string | undefined

  constructor(
    store: TableStore<string, PrivateMessage>,
    activity: ActivityService,
    notifier: GroupNotifier,
    leaderOf: (groupId: GroupId) => string | undefined,
  ) {
    this.store = store
    this.activity = activity
    this.notifier = notifier
    this.leaderOf = leaderOf
  }

  async send(groupId: GroupId, input: PrivateSendInput): Promise<PrivateMessage> {
    const message: PrivateMessage = {
      id: randomUUID(),
      groupId,
      senderId: input.senderId,
      senderName: input.senderName,
      recipientId: input.recipientId,
      direction: input.direction,
      timestamp: Date.now(),
      text: input.text,
    }
    await this.store.put(scopedKey(groupId, message.id), message)
    await this.activity.append({
      groupId,
      type: 'private_message',
      actorId: input.senderId,
      actorName: input.senderName,
      refMemberId: input.recipientId,
      payload: { direction: input.direction, kind: 'metadata-only' },
    })
    this.notifier.emit(groupId, 'activity', undefined)
    return message
  }

  /** Leader view: every private exchange in the group. */
  listForGroup(groupId: GroupId, viewerId: string): PrivateMessage[] {
    const leaderId = this.leaderOf(groupId)
    if (leaderId === undefined || leaderId !== viewerId) {
      throw new Error('private-messages: only the group leader may list all private messages')
    }
    return this.query(groupId, () => true)
  }

  /** Member view: only the messages this principal sent or received. */
  listForPrincipal(groupId: GroupId, principalId: string): PrivateMessage[] {
    return this.query(groupId, (m) => m.senderId === principalId || m.recipientId === principalId)
  }

  private query(groupId: GroupId, filter: (message: PrivateMessage) => boolean): PrivateMessage[] {
    const rows: PrivateMessage[] = []
    for (const [key, message] of this.store.entries()) {
      if (message.groupId === groupId && filter(message)) rows.push(message)
    }
    rows.sort((a, b) => a.timestamp - b.timestamp)
    return rows
  }
}
