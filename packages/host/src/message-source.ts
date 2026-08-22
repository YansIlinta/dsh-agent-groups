/**
 * Group message sources: durable attribution for agent-group deliveries.
 * Declared by augmentation so model-visible input is reconstructable from the
 * session log with a stable vendor kind.
 * @module @dsh-agent-groups/host
 */

import type { GroupId } from './core-types.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    agentGroup: {
      kind: 'agent-group'
      /** One group member addressed another in this group. */
      readonly form: 'relay'
      /** Group this delivery belongs to. */
      readonly groupId: GroupId
      /** Direction of the private channel ('leader-to-member' or 'member-to-leader'). */
      readonly direction?: 'leader-to-member' | 'member-to-leader'
      /** Natural-language one-line provenance for the transcript. */
      readonly label?: string
    }
  }
}

export interface GroupMessageSourceData {
  readonly form: 'relay'
  readonly groupId: GroupId
  readonly direction?: 'leader-to-member' | 'member-to-leader'
  readonly label?: string
}

/** Build the durable source object for one agent-group delivery. */
export function groupMessageSource(groupId: GroupId, data: Omit<GroupMessageSourceData, 'groupId' | 'form'> = {}): GroupMessageSourceData & { readonly kind: 'agent-group' } {
  return { kind: 'agent-group', form: 'relay', groupId, ...data }
}
