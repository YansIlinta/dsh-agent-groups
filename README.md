# DSH Agent Groups

A **long-running multi-agent group product layer** for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (DSH). It is a **completely independent plugin/package** — it does not modify, patch, or copy any DSH source. It composes only public Cordis services (`ctx.storageDomain`, `ctx.webServer`, `ctx.agents`, `ctx.agentPresets`, `ctx.tools`, `ctx.systemPrompt`), owns its own durable store, and renders as a **DSH-native page** (client bundle injected into the shell — the “Agent Groups” trigger in the sidebar, full-frame page in the shell overlay, DSH layout/theme/components reused).

```
User ──► Leader (one orchestrator, DAG, no hardcoded roles)
           │  private      ┌──► Member (finder)      ── tee ──┐
           ├───────────────┼──► Member (engineer)    ── tee ──┼──► ── shared workspace
           └─► channel ────┤                              *no member⇄member DM*
                           └──► Member (reviewer)     ───────────────────┘
Duurable: group/mission/workstreams/tasks/channel/private/timeline (DSH storage domain)
```

## What it delivers (MVP scope + V0.2)

- **Leader** — a single orchestrating session composed from the `group-leader` preset. It materializes the Mission, spawns Members from Agent Profiles, decomposes into workstreams + a DAG of tasks, assigns, waits, creates reviewer/verifier tasks, verifies, replans, and alone declares Mission completion. No hardcoded planner→coder→reviewer pipeline.
- **Members** — 0–N teammates created at runtime by the Leader (durable agents with the `group-member` preset). They claim their assigned task, work it with normal shell/fs tools, and report through the chain.
- **Communication policy** — enforced in the **host service layer**, not prompts:
  - Leader⇄Member private messages only; **Member⇄Member private messaging is forbidden**.
  - A global `tools/pre-execute` gate denies raw peer tools (`send_message`, `subagent*`, `workflow`, `ralph`, …) to any group member (defense in depth on top of tool-set scoping).
  - Group Channel = durable public feed; members use `group_post` / `group_report_to_leader`.
- **Two-level task model** — `GroupTaskMetadata` (kind, acceptance criteria, capabilities, priority, tags, write scopes, retry-of, verifier ids) over the DAG node, plus an `AgentTaskResult` (summary, artifacts, changed files, tests, risks, unresolved, `completionClaim`). A member claiming completion is **not** verification.
- **Write-scope overlap warnings** — prefix-based detection between non-terminal tasks, surfaced to the Leader and dashboard.
- **Activity Timeline** — durable event stream (`mission_created` … `verification_failed`), streamed live to the dashboard via SSE.
- **Native page** — the UI is a DSH client bundle (`dsh.client` declaration, `/plugins/@dsh-agent-groups/host/client.js`): an “Agent Groups” entry in the sidebar footer and a full-frame page on the shell overlay. Group list → group detail tabs (Overview/Tasks/Team/Channel/Activity) → create-group dialog, live through `/groups/api/*` + SSE. No iframe, no second app shell, no `/groups/` site.
- **Compatibility diagnostic at boot** — prints the DSH Agent Groups banner and **fails loud** if a required DSH surface is missing.

### V0.2 — the team workspace

| Area | What was added |
| --- | --- |
| Team Management | 4 built-in **Team Templates** (Software/Research/Content/General), Create Group UI with template picker, **Custom Team Builder**, add/remove/rename members with display roles, **Team Graph**, member inspector (task history, posts, private messages, activity), **Pause/Resume** (dispatch gate), **Archive/Restore**, **Duplicate** (mission/template copied; members re-materialized; history never copied), group **settings** (name, max members), known-leader registry for safe dashboard-side creation |
| Task Management | Kanban board (Ready/Blocked/Running/Review/Done/Failed) with **drag Quick-ready ⇄ Blocked via user “hold”**, task **editing** (title/description/priority/tags/dependencies), **priority urgent**, **tags**, search/filter by member/priority/tag, dependency graph (depends on / blocks), write-scope hints, per-task activity & related messages |
| Messaging | **User ↔ Leader chat** (durable, separate from the team channel), **user broadcast** to the channel, channel **replies** (threads), **pins**, **search + sender filter**, @mention highlighting |
| Workspace | **Shared Notes** (leader/user editable, durable, member-readable), **Artifact browser** derived from structured results (open text preview, copy path), workspace view |
| Dashboard UX | Full navigation (Overview/Tasks/Channel/Leader Chat/Workspace/Activity/Team/Profiles/Settings), **⌘K command palette**, in-app **notifications**, **unread badges**, **Live/Reconnecting status**, group home with search + recent groups, profile & preset browser, empty/loading/error states, responsive layout (inspector becomes an overlay drawer) |

## Layout

```
packages/
  host/        @dsh-agent-groups/host  — services, leader/member tools, data API + SSE, native client bundle
    src/
      core-types.ts        data vocabulary (ids, statuses, profiles, mission, tasks, channel, timeline)
      persistence.ts       zod domain spec (durable; V0.2 fields are optional → old records keep loading)
      store.ts             TableStore / MemoryStore / DomainStore
      notifier.ts          live update hub
      activity-service.ts  durable timeline
      group-service.ts     group/mission/member lifecycle + role checks + pause/archive/notes/settings/duplicate
      task-service.ts      two-level task model + CAS revisioning + edit/hold/tags
      channel-service.ts   group channel + private messages (+ replies/pins, user↔leader directions)
      profile-registry.ts  5 built-in Agent Profiles
      template-registry.ts 4 built-in Team Templates      leader-registry.ts  known leader sessions
      conflicts.ts         write-scope overlap detection
      policy.ts            member peer-contact gate
      group-host.ts        the product facade (agent tools + user console operations)
      tools.ts             tool registration + argument coercion
      leader-tools.ts      leader_* tool set        member-tools.ts  group_* tool set
      leader.ts / member.ts   preset addon plugins  leader-prompt.ts / member-prompt.ts
      compatibility.ts     boot diagnostic          web/api.ts  data API + SSE + /groups → / redirect
      native-client/       DSH-native page source (plain CommonJS; built by scripts/build-native-client.mjs)
  profiles/     presets (group-leader, group-member) + web-profile patch fragment
scripts/        install-web-profile.sh, relaunch-web.sh, patch-profile.mjs, verify-durability.mjs, demo-v02.mjs, build-native-client.mjs
```

The native client bundle is CommonJS on purpose: `scripts/build-native-client.mjs` wraps
`src/native-client/index.js` into the DSH `window.__ModuleLoader__.load({id, factory})`
format and writes `lib/client.js`. The package declares `"dsh": {"client": …}` and
`exports["./client"]`, so dsh-client-modules serves it at
`/plugins/@dsh-agent-groups/host/client.js` and the shell materializes the plugin.

DSH Agent Groups uses the **DSH subagent seam** (agent creation/resume via `ctx.agents.create`) plus a **plugin-owned durable store** (spec §6 fallback) — it does not require the experimental Agent Teams package. The leader's "subagents" *are* the group Members.

## Building

Requires Node ≥ 20 and a local `dsh` install (the host package links its dev deps to the exact runtime packages).

```bash
npm install                     # inside packages/host (links @deepseek-ai/* + zod to the dsh install)
cd packages/host && npm install && npm run build && npm run typecheck && npm test
```

From the repo root:

```bash
npm run build          # host + native client bundle
npm run typecheck      # host (src + tests)
npm test               # vitest suite
```

## Installing into a running dsh web profile

```bash
npm run install-web-profile   # builds, copies the host package + presets, appends the patch row
npm run relaunch-web          # restarts 127.0.0.1:8080 with the plugin mounted
```

Watch the boot log for the banner:

```
DSH Agent Groups
Detected DeepSeek Harness: 0.1.0-rc.6
Storage domain: compatible
Web server: compatible
…
```

What the installer does (all reversible):

1. Builds the native client bundle and copies `@dsh-agent-groups/host` (lib, incl. `client.js`) into `~/.dsh/profiles/node_modules/@dsh-agent-groups/host` and `~/.dsh/profiles/web/node_modules/…` .
2. Copies `presets/group-leader` and `presets/group-member` into `~/.dsh/.agent-presets/`.
3. Appends one `- insert:` row to `~/.dsh/profiles/web/cordis.patch.yml` (idempotent; remove it to uninstall).

## Using it (native page)

The Agent Groups page lives **inside the normal DSH web UI** — there is no separate
dashboard URL anymore.

### V0.1 flow (complete control from the Leader)

1. Open `http://127.0.0.1:8080` and start a session with the **`Agent Group · Team Lead`** preset.
2. Tell the Leader your Mission (e.g. *“Add an Analytics Dashboard to the example project — analyze, design, then build frontend+backend, then integration verification”*).
3. The Leader calls `leader_init_group`, materializes Members from profiles (`leader_spawn_member`), adds workstreams and tasks (`leader_create_task`), assigns them, and waits (`leader_wait`).
4. In the DSH sidebar foot click **Agent Groups** to open the native page; push Leader instructions from the channel / leader chat as before.
5. Members claim (`group_claim_task`) and submit (`group_complete_task`); the Leader verifies (`leader_verify_task`) and eventually completes the Mission (`leader_complete_mission`).

### V0.2 flow (Software Team demo)

1. **Start a Leader session** (`Agent Group · Team Lead` preset) and chat with it briefly (any message registers the session as a known Leader).
2. In the DSH sidebar foot click **Agent Groups** → **New Group** → pick the **Software Team** template → name + mission (“Build a small analytics dashboard”) → the picker shows the free Leader session → **Create**. The group and its 5 members materialize immediately; the Leader sees everything via its tools.
3. Watch **Team**: leader + members with role/profile/status/current task.
4. On **Tasks**: the list fills as the Leader decomposes (title/status/assignee/dependencies/updated).
5. On **Channel**: read agent chatter and post a team-wide instruction (e.g., “Please avoid changing the database schema.”) — new messages appear live via SSE.
6. On **Activity**: the durable event feed (member joined, task created/assigned/claimed/completed, message posted, group status changed…) updates live.
7. Re-open the page after a refresh → the last group/tab is restored.

Durable state lives in the DSH storage domain (`~/.dsh/storages`) and survives web restarts. `node scripts/verify-durability.mjs` proves it end-to-end: it boots the same cordis storage stack the web profile mounts, writes a group record, simulates a full process reload, and reads it back.

### Scripted V0.2 demo (no GUI needed)

```bash
node scripts/demo-v02.mjs            # full V0.2 narrative, throwaway storage root
node scripts/demo-v02.mjs --keep     # keep the storage root for inspection
```

It boots the **same cordis storage stack** over a throwaway root and drives the real product facade through the whole V0.2 flow: team templates → dashboard group creation (Software Team) → leader decomposition (DAG/priority/tags) → assignments → members claim/complete → verification → task edit + hold → channel posts/reply/pin/broadcast → leader chat → shared notes → workspace artifacts → activity feed → pause gate → completion + duplicate → archive/restore → **durability across a simulated process reload**. Agent sessions are simulated with the no-op adapter — the live agent demo still needs one real Team Lead session in the DSH GUI (demo steps above).

## Tests (§26 + V0.2 + V0.3)

- **Policy** — the raw peer-tool deny matrix for group members (leader/non-members unaffected).
- **Tasks** — creation, dependency→blocked derivation, assign/claim/complete/verify, reopen(+attempt), CAS stale-revision rejection, durability across a store reload.
- **Missions & members** — one-active-group per leader, roster patch/remove semantics, duplicate-profile spawn rejection, live-status merging.
- **Channel** — durable ordered feed with no duplicates, one notification per post, private one-way scoping, durability across a reload.
- **Conflicts** — nested/identical/disjoint write scopes, non-terminal-only reporting.
- **Profiles** — built-ins present, register/get/remove over the durable table.
- **V0.2** — team templates (slots + valid profiles); task editing (fields/CAS/guards + `task_updated`); user hold → board blocked without DAG changes; channel reply + pin/unpin with history kept; mission notes durable; pause gate blocks dispatch but keeps messaging; archive hides/restores and blocks mutations; duplicate copies mission/workstreams and re-materializes members (completion/archive required); known-leader registry + dashboard group creation with template members; user↔leader private directions; **backward compatibility** — V0.1 group/task/channel/private records still parse with the extended schema.
- **V0.3 API routes** — the `/groups/api/*` dispatcher is now covered with fake request/response harnesses: broadcast and members POSTs are no longer shadowed by the group-action branch, group actions still dispatch, unknown sub-paths 404 cleanly, collections return JSON.

## Design notes & constraints honored

- Zero modification of the DSH checkout; no `send_message`/`subagent` shape assumptions (verified against the running rc.6 packages, not outdated docs).
- Role authorization lives in `GroupHost` (durable membership + caller identity from `exec.agent`); prompts are never the enforcement boundary.
- V0.2 is strictly additive: new durable fields are optional, old `agent_groups.json` records load unchanged (a V0.1 `writeScopes`-stripped task was previously unparsable — fixed), and the member policy is untouched.
- V0.3 renders inside DSH itself: a client bundle registered through the standard `dsh.client` seam (`sidebar.footer.action` entry + `shell.overlay` page), reusing DSH components (`dsh-client-ui-primitives`) and `--dsw-alias-*` theme tokens with `ag-` prefixed local CSS only. The standalone dashboard (`packages/client`, `web-static`, `/groups/` static hosting) was removed; `/groups/` now redirects to the shell and only `/groups/api/*` remains.
