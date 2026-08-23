import { describe, expect, it } from 'vitest'
import { parseRecord } from '../src/persistence.js'
import type { ActivityEvent } from '../src/core-types.js'

const V06_RUNTIME_ACTIVITY_TYPES = [
  'runtime_turn_queued',
  'runtime_turn_steered',
  'runtime_steer_failed',
  'runtime_request_timed_out',
] as const

describe('V0.6 runtime activity persistence', () => {
  for (const type of V06_RUNTIME_ACTIVITY_TYPES) {
    it(`accepts ${type} at the durable read boundary`, () => {
      const event: ActivityEvent = {
        id: `activity-${type}`,
        groupId: 'group-1',
        timestamp: 1,
        type,
        actorName: 'Runtime Member',
        refMemberId: 'member-1',
        payload: { regression: true },
      }

      expect(parseRecord<ActivityEvent>('activity', event)).toEqual(event)
    })
  }
})
