import { MemoryStore } from '../src/store.js'
import { GroupNotifier } from '../src/notifier.js'
import { ActivityService } from '../src/activity-service.js'
import { GroupService, type MissionInput } from '../src/group-service.js'
import { TaskService } from '../src/task-service.js'
import { ChannelService, PrivateMessageService } from '../src/channel-service.js'
import { ProfileRegistry } from '../src/profile-registry.js'
import { GroupHost } from '../src/group-host.js'
import { createNoopAdapter } from '../src/dsh-adapter.js'
import { LeaderRegistry } from '../src/leader-registry.js'
import type { ActivityEvent, AgentProfile, ChannelMessage, GroupMember, GroupRecord, GroupTask, KnownLeader, PrivateMessage } from '../src/core-types.js'

export interface Stores {
  activity: MemoryStore<string, ActivityEvent>
  groups: MemoryStore<string, GroupRecord>
  members: MemoryStore<string, GroupMember>
  tasks: MemoryStore<string, GroupTask>
  channel: MemoryStore<string, ChannelMessage>
  private: MemoryStore<string, PrivateMessage>
  profiles: MemoryStore<string, AgentProfile>
  leaders: MemoryStore<string, KnownLeader>
}

export interface Harness {
  notifier: GroupNotifier
  activity: ActivityService
  groups: GroupService
  tasks: TaskService
  channel: ChannelService
  privateMessages: PrivateMessageService
  profiles: ProfileRegistry
  leaders: LeaderRegistry
}

export function makeStores(): Stores {
  return {
    activity: new MemoryStore<string, ActivityEvent>('activity'),
    groups: new MemoryStore<string, GroupRecord>('groups'),
    members: new MemoryStore<string, GroupMember>('members'),
    tasks: new MemoryStore<string, GroupTask>('tasks'),
    channel: new MemoryStore<string, ChannelMessage>('channel'),
    private: new MemoryStore<string, PrivateMessage>('private'),
    profiles: new MemoryStore<string, AgentProfile>('profiles'),
    leaders: new MemoryStore<string, KnownLeader>('leaders'),
  }
}

/**
 * Build a full service harness. Pass `stores` to create a SECOND harness over
 * the same durable tables (simulating a process reload).
 */
export function makeHarness(stores: Stores = makeStores()): Harness {
  const notifier = new GroupNotifier()
  const activity = new ActivityService(stores.activity, notifier)
  const groups = new GroupService(stores.groups, stores.members, activity)
  const tasks = new TaskService(stores.tasks, activity)
  const channel = new ChannelService(stores.channel, activity, notifier)
  const privateMessages = new PrivateMessageService(
    stores.private,
    activity,
    notifier,
    (groupId) => groups.getGroup(groupId)?.leaderSessionId,
  )
  const profiles = new ProfileRegistry(stores.profiles)
  const leaders = new LeaderRegistry(stores.leaders)
  return { notifier, activity, groups, tasks, channel, privateMessages, profiles, leaders }
}

/** A full GroupHost wired to the same stores but a no-op agent adapter. */
export function makeHost(stores: Stores = makeStores()): GroupHost {
  const h = makeHarness(stores)
  return new GroupHost({
    groups: h.groups,
    tasks: h.tasks,
    channel: h.channel,
    privateMessages: h.privateMessages,
    activity: h.activity,
    profiles: h.profiles,
    notifier: h.notifier,
    adapter: createNoopAdapter(),
    leaders: h.leaders,
  })
}

export const SAMPLE_MISSION: MissionInput = {
  objective: 'Add an Analytics Dashboard to the example web project',
  constraints: ['TypeScript', 'React'],
  deliverables: ['backend API', 'frontend dashboard'],
  acceptanceCriteria: ['tests pass'],
  risks: ['tight schedule'],
}

export async function seedGroup(h: Harness, leader = 'lead-1', name = 'Test Group'): Promise<GroupRecord> {
  return h.groups.initGroup(leader, 'Lead', name, SAMPLE_MISSION)
}
