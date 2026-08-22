/**
 * DSH Agent Groups — native client bundle (V0.3 migration).
 *
 * Runs inside the DSH web shell as a client plugin bundle
 * (`window.__ModuleLoader__.load` CJS factory, see
 * scripts/build-native-client.mjs). Registers:
 *   - `sidebar.footer.action`  → "Agent Groups" trigger beside Settings
 *   - `shell.overlay`          → the whole Agent Groups page (full-frame,
 *                                DSH layout/theme untouched)
 *
 * Data comes from the existing `/groups/api/*` endpoints + SSE stream
 * (`/groups/api/events`), same origin, no iframe, no second app shell.
 * All colors/spacing use `--dsw-alias-*` theme tokens; every custom class is
 * `ag-` prefixed and scoped to this bundle's own stylesheet.
 *
 * Environment provided by the bundle skeleton: require, module, exports,
 * React (react), primitives (@deepseek-ai/dsh-client-ui-primitives).
 */

// ── tiny module store (shared open state between the trigger and the page) ─

const listeners = new Set()
let open = false
let groupId = null
let tab = 'overview'

function setUi(patch) {
  if (patch.open !== undefined) open = patch.open
  if (patch.groupId !== undefined) groupId = patch.groupId
  if (patch.tab !== undefined) tab = patch.tab
  for (const fn of listeners) fn()
}

function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function useUi() {
  const [, force] = React.useState(0)
  React.useEffect(() => subscribe(() => force((n) => n + 1)), [])
  return { open, groupId, tab }
}

// last-view context survives a page refresh (best effort)
const KEY = 'dsh.agent-groups.last'
function remember(group, currentTab) {
  try {
    if (group === null) window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, JSON.stringify({ groupId: group, tab: currentTab }))
  } catch { /* storage unavailable — fine */ }
}
function remembered() {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return typeof parsed?.groupId === 'string' ? parsed : null
  } catch { return null }
}

// ── API: existing /groups/api/* (kept, never touched) ──────────────────────

async function api(path, init) {
  const res = await fetch(path, {
    headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
    ...init,
  })
  if (!res.ok) {
    let message = `${path}: HTTP ${res.status}`
    try { const body = await res.json(); if (body?.message) message = body.message } catch { /* keep default */ }
    throw new Error(message)
  }
  return res.json()
}

function errorOf(err) { return err instanceof Error ? err.message : String(err) }

// ── stylesheet: ag- prefixed, theme tokens only, inserted once ─────────────

let cssInjected = false
function injectCss() {
  if (cssInjected || typeof document === 'undefined') return
  cssInjected = true
  const style = document.createElement('style')
  style.textContent = `
.ag-root{position:absolute;inset:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45;min-width:0}
.ag-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.ag-title{font-size:14px;font-weight:600;flex:1;display:flex;align-items:center;gap:8px}
.ag-body{flex:1;overflow:auto;padding:14px}
.ag-row{display:flex;gap:8px;align-items:baseline;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);cursor:pointer}
.ag-row:hover{background:var(--dsw-alias-bg-layer-1)}
.ag-row .main{display:flex;flex-direction:column;gap:2px;min-width:0}
.ag-mission{color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:620px}
.ag-col{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.ag-meta{display:flex;gap:10px;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}
.ag-empty{padding:26px 14px;color:var(--dsw-alias-label-secondary);text-align:center}
.ag-error{padding:10px 14px;color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;margin-bottom:10px}
.ag-toolbar{display:flex;gap:8px;align-items:center;margin-bottom:10px}
.ag-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:12px}
.ag-tab{padding:6px 12px;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border-top:0;border-left:0;border-right:0;font-size:13px}
.ag-tab.on{border-bottom-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.ag-table{width:100%;border-collapse:collapse}
.ag-table th{text-align:left;font-weight:600;color:var(--dsw-alias-label-secondary);font-size:11px;text-transform:uppercase;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ag-table td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}
.ag-monoblock{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ag-msg{display:flex;gap:10px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);align-items:flex-start}
.ag-msg .when{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.ag-badge{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.ag-badge.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.ag-badge.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.ag-badge.err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.ag-legend{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:8px}
.ag-note{color:var(--dsw-alias-label-secondary);font-size:12px}
.ag-form{display:flex;flex-direction:column;gap:10px;padding:4px 0}
.ag-form label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ag-badge-rt{text-transform:none;cursor:default}
.ag-badge-rt.info{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.ag-requests{border:1px solid var(--dsw-alias-state-warn-primary);border-radius:8px;padding:8px 10px;margin-bottom:10px;display:flex;flex-direction:column;gap:8px;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent)}
.ag-request{display:flex;gap:10px;align-items:center}
.ag-row-actions{display:flex;gap:6px}
.ag-danger{color:var(--dsw-alias-state-error-primary)}
.ag-row-selected td{background:var(--dsw-alias-bg-layer-1)}
.ag-inspect-row td{background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.ag-inspect{padding:6px 8px;font-size:12px}
.ag-inspect-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:6px 16px}
.ag-kv{display:flex;flex-direction:column;gap:1px}
.ag-kv .ag-note{font-size:11px;text-transform:uppercase;letter-spacing:.03em}
.ag-turn-id{font-size:11px}
`
  document.head.appendChild(style)
}

const { Button, Input, Modal, Pill } = primitives

// ── shared small pieces ────────────────────────────────────────────────────

function Spinner() {
  return React.createElement('div', { className: 'ag-note' }, 'Loading…')
}

function EmptyLine({ children }) {
  return React.createElement('div', { className: 'ag-empty' }, children)
}

function ErrorLine({ message, onRetry }) {
  return React.createElement('div', { className: 'ag-error' },
    message,
    onRetry !== undefined && React.createElement(Button, { size: 'sm', onClick: onRetry, style: { marginLeft: 8 } }, 'Retry'),
  )
}

function fmtTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`
}

function statusBadge(status) {
  const kind = status === 'active' || status === 'completed' || status === 'idle' ? 'ok'
    : status === 'blocked' || status === 'failed' || status === 'left' ? 'err'
      : status === 'in_progress' || status === 'running' || status === 'provisioning' ? 'warn' : ''
  return React.createElement('span', { className: `ag-badge ${kind}` }, String(status))
}

/** V0.5: live runtime-session state chip (Idle/Working/Waiting…). */
const RUNTIME_STATE_LABELS = {
  starting: 'Starting',
  idle: 'Idle',
  working: 'Working',
  waiting_input: 'Waiting for input',
  needs_approval: 'Needs approval',
  interrupted: 'Interrupted',
  disconnected: 'Disconnected',
  failed: 'Failed',
  closed: 'Closed',
}

function runtimeStateChip(state) {
  if (!state) return null
  const label = RUNTIME_STATE_LABELS[state] ?? String(state)
  const kind = state === 'working' || state === 'starting' ? 'warn'
    : state === 'needs_approval' || state === 'waiting_input' ? 'info'
      : state === 'disconnected' || state === 'failed' ? 'err'
        : 'ok'
  return React.createElement('span', { className: `ag-badge ag-badge-rt ${kind}`, title: `Runtime session state: ${label}` }, label)
}

function shortId(id) {
  return typeof id === 'string' ? id.slice(0, 8) : String(id)
}

function kv(label, value) {
  return React.createElement('div', { className: 'ag-kv' },
    React.createElement('span', { className: 'ag-note' }, label),
    React.createElement('span', null, value),
  )
}

// ── sidebar trigger (sidebar.footer.action) ────────────────────────────────

function AgentGroupsTrigger({ wide }) {
  injectCss()
  const icon = React.createElement(primitives.IconGoalOutline16, {})
  return React.createElement(Button, {
    variant: 'toolbar',
    size: 'sm',
    icon,
    onClick: () => setUi({ open: true }),
    title: 'Agent Groups — team workspace',
    style: wide ? { width: '100%', justifyContent: 'flex-start' } : {},
    'aria-label': 'Agent Groups',
  }, wide ? 'Agent Groups' : null)
}

// ── full-frame page (shell.overlay) ────────────────────────────────────────

function AgentGroupsPage() {
  injectCss()
  const ui = useUi()
  if (!open) return null
  return React.createElement(AgentGroupsOverlay, { key: ui.groupId === null ? 'home' : String(ui.groupId) })
}

function AgentGroupsOverlay() {
  const ui = useUi()
  const [error, setError] = React.useState(null)
  const [groups, setGroups] = React.useState(null)

  const load = React.useCallback(() => {
    setError(null)
    api('/groups/api/groups').then(setGroups).catch((err) => setError(errorOf(err)))
  }, [])

  React.useEffect(() => { load(); return () => setGroups(null) }, [load])

  // restore last-view context on open (refresh survival)
  React.useEffect(() => {
    const last = remembered()
    if (last !== null && ui.groupId === null) {
      // verify the group still exists before deep-linking
      api(`/groups/api/group/${encodeURIComponent(last.groupId)}`).then(() => {
        setUi({ groupId: last.groupId, tab: last.tab ?? 'overview' })
      }).catch(() => { /* stale — stay on home */ })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.open])

  const close = () => { remember(null, 'overview'); setUi({ open: false, groupId: null, tab: 'overview' }) }

  React.useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return React.createElement('div', { className: 'ag-root' },
    React.createElement('div', { className: 'ag-head' },
      React.createElement('div', { className: 'ag-title' },
        React.createElement(primitives.IconGoalOutline16, {}),
        'Agent Groups',
      ),
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: close, title: 'Close (Esc)' },
        React.createElement(primitives.IconCloseOutline16, {}),
      ),
    ),
    React.createElement('div', { className: 'ag-body' },
      error !== null && React.createElement(ErrorLine, { message: error, onRetry: load }),
      groups === null ? React.createElement(Spinner)
        : ui.groupId === null
          ? React.createElement(GroupsHome, { groups, load, onOpen: (id) => { remember(id, 'overview'); setUi({ groupId: id, tab: 'overview' }) } })
          : React.createElement(GroupDetail, {
            groupId: ui.groupId,
            tab: ui.tab,
            onBack: () => { remember(null, 'overview'); setUi({ groupId: null }) },
            onTab: (next) => { remember(ui.groupId, next); setUi({ tab: next }) },
          }),
    ),
  )
}

// ── home: group list + create dialog ───────────────────────────────────────

function GroupsHome({ groups, load, onOpen }) {
  const [creating, setCreating] = React.useState(false)
  return React.createElement('div', { className: 'ag-col' },
    React.createElement('div', { className: 'ag-toolbar' },
      React.createElement(Button, { variant: 'primary', size: 'sm', icon: React.createElement(primitives.IconPlusOutline16, {}), onClick: () => setCreating(true) }, 'New Group'),
      React.createElement(Button, { variant: 'ghost', size: 'sm', icon: React.createElement(primitives.IconRefreshOutline14, {}), onClick: load }, 'Refresh'),
      React.createElement('span', { className: 'ag-note', style: { marginLeft: 'auto' } }, `${groups.length} group(s)`),
    ),
    groups.length === 0
      ? React.createElement(EmptyLine, null,
          'No agent groups yet. Create a group or start one from an Agent Group Leader session.')
      : React.createElement('div', { className: 'ag-col' }, groups.map((group) =>
          React.createElement('div', {
            key: group.groupId, className: 'ag-row', onClick: () => onOpen(group.groupId), role: 'button',
          },
            React.createElement('div', { className: 'main' },
              React.createElement('strong', null, group.name),
              React.createElement('div', { className: 'ag-mission' }, group.missionObjective),
              React.createElement('div', { className: 'ag-meta' },
                statusBadge(group.status),
                React.createElement('span', null, `${group.memberCount} members`),
                React.createElement('span', null, `${group.taskCount} tasks`),
                React.createElement('span', null, `updated ${fmtTime(group.updatedAt ?? group.createdAt)}`),
                React.createElement('span', { className: 'ag-monoblock' }, group.leaderSessionId.slice(0, 12)),
              ),
            ),
          ),
        )),
    creating && React.createElement(CreateGroupDialog, { onClose: () => setCreating(false), onCreated: (id) => { setCreating(false); onOpen(id) } }),
  )
}

function CreateGroupDialog({ onClose, onCreated }) {
  const [name, setName] = React.useState('')
  const [mission, setMission] = React.useState('')
  const [leader, setLeader] = React.useState('')
  const [leaders, setLeaders] = React.useState([])
  const [templateId, setTemplateId] = React.useState('')
  const [customCount, setCustomCount] = React.useState(2)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [templates, setTemplates] = React.useState([])

  React.useEffect(() => {
    api('/groups/api/sessions/leaders').then((rows) => {
      setLeaders(rows)
      const free = rows.find((row) => !row.hasActiveGroup)
      if (free !== undefined) setLeader(free.sessionId)
      else if (rows.length > 0) setLeader(rows[0].sessionId)
    }).catch(() => undefined)
    api('/groups/api/templates').then(setTemplates).catch(() => undefined)
  }, [])

  const submit = async () => {
    if (busy) return
    setError(null)
    if (name.trim() === '' || mission.trim() === '') { setError('Group name and mission are required.'); return }
    if (leader === '') { setError('Pick a Leader session — start one with the Team Lead preset if none is listed.'); return }
    setBusy(true)
    try {
      let members
      if (templateId !== '') {
        const template = templates.find((t) => t.id === templateId)
        members = []
        if (template !== undefined) {
          for (const slot of template.members) {
            const count = slot.count ?? 1
            for (let i = 0; i < count; i++) {
              members.push({ role: slot.role, profile: slot.profile, name: i === 0 ? slot.role : `${slot.role} ${i + 1}` })
            }
          }
        }
      } else {
        members = Array.from({ length: Math.max(0, customCount) }, (_, i) => ({
          role: 'Member', profile: 'implementation-engineer', name: `Member ${i + 1}`,
        }))
      }
      const group = await api('/groups/api/groups', {
        method: 'POST',
        body: JSON.stringify({ leaderSessionId: leader, name: name.trim(), objective: mission.trim(), templateId: templateId || undefined, members: members.length > 0 ? members : undefined }),
      })
      onCreated(group.groupId)
    } catch (cause) {
      setError(errorOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return React.createElement(Modal, {
    open: true, onClose, title: 'New Agent Group',
    footer: React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: onClose }, 'Cancel'),
      React.createElement(Button, { variant: 'primary', size: 'sm', onClick: () => void submit(), disabled: busy }, busy ? 'Creating…' : 'Create'),
    ),
  },
    React.createElement('div', { className: 'ag-form' },
      error !== null && React.createElement(ErrorLine, { message: error }),
      React.createElement('label', null, 'Group name',
        React.createElement(Input, { value: name, onChange: (e) => setName(e.target.value), placeholder: 'Software Dev Team' }),
      ),
      React.createElement('label', null, 'Mission',
        React.createElement(Input, { value: mission, onChange: (e) => setMission(e.target.value), placeholder: 'Build a small analytics dashboard…' }),
      ),
      React.createElement('label', null, 'Leader session',
        React.createElement('select', { value: leader, onChange: (e) => setLeader(e.target.value), style: { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, padding: '6px 8px' } },
          leaders.length === 0 && React.createElement('option', { value: '' }, '— no leader sessions yet —'),
          leaders.map((row) =>
            React.createElement('option', { key: row.sessionId, value: row.sessionId },
              `${row.sessionId.slice(0, 12)}…${row.hasActiveGroup ? ' (busy)' : ''}`,
            )),
        ),
      ),
      React.createElement('label', null, 'Team template',
        React.createElement('select', { value: templateId, onChange: (e) => setTemplateId(e.target.value), style: { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, padding: '6px 8px' } },
          React.createElement('option', { value: '' }, 'Custom team'),
          templates.map((t) => React.createElement('option', { key: t.id, value: t.id }, t.name)),
        ),
      ),
      templateId === '' && React.createElement('label', null, 'Custom member count',
        React.createElement(Input, { type: 'number', min: 0, max: 12, value: String(customCount), onChange: (e) => setCustomCount(Number(e.target.value)) }),
      ),
      React.createElement('div', { className: 'ag-note' }, 'Only sessions that acted as Leaders appear; one active group per Leader.'),
    ),
  )
}

// ── group detail: tabs ─────────────────────────────────────────────────────

const TABS = ['overview', 'tasks', 'team', 'channel', 'leader', 'workspace', 'activity', 'roles']

function GroupDetail({ groupId, tab, onBack, onTab }) {
  const [snap, setSnap] = React.useState(null)
  const [error, setError] = React.useState(null)

  const load = React.useCallback(() => {
    setError(null)
    api(`/groups/api/group/${encodeURIComponent(groupId)}`).then(setSnap).catch((err) => setError(errorOf(err)))
  }, [groupId])

  // initial + SSE-driven live reload; exactly one EventSource per open detail
  React.useEffect(() => {
    load()
    const source = new EventSource('/groups/api/events')
    let reloadTimer = null
    const onUpdate = (event) => {
      let update = null
      try { update = JSON.parse(event.data) } catch { return }
      if (update !== null && update.groupId !== groupId) return
      window.clearTimeout(reloadTimer)
      reloadTimer = window.setTimeout(() => load(), 250)
    }
    source.addEventListener('update', onUpdate)
    return () => { source.close(); if (reloadTimer !== null) window.clearTimeout(reloadTimer) }
  }, [load, groupId])

  if (error !== null && snap === null) {
    return React.createElement('div', null,
      React.createElement(ErrorLine, { message: error, onRetry: () => { setError(null); load() } }),
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: onBack }, '← Back to groups'),
    )
  }

  return React.createElement('div', { className: 'ag-col' },
    React.createElement('div', { className: 'ag-toolbar' },
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: onBack }, '← Groups'),
      snap === null
        ? React.createElement('span', { className: 'ag-note' }, 'Loading group…')
        : React.createElement('strong', null, snap.group.name),
      snap !== null && React.createElement('span', { className: 'ag-note' }, ` · ${snap.group.status}`),
    ),
    snap === null
      ? React.createElement(Spinner)
      : React.createElement(React.Fragment, null,
          React.createElement('div', { className: 'ag-tabs' },
            TABS.map((key) =>
              React.createElement('button', { key, className: `ag-tab ${tab === key ? 'on' : ''}`, onClick: () => onTab(key) },
                key.charAt(0).toUpperCase() + key.slice(1),
              )),
          ),
          tab === 'overview' && React.createElement(OverviewTab, { snap }),
          tab === 'tasks' && React.createElement(TasksTab, { snap }),
          tab === 'team' && React.createElement(TeamTab, { snap, onRefresh: () => load() }),
          tab === 'channel' && React.createElement(ChannelTab, { snap, onMessage: load }),
          tab === 'leader' && React.createElement(LeaderChatTab, { snap, onMessage: load }),
          tab === 'workspace' && React.createElement(WorkspaceTab, { snap, onMessage: load }),
          tab === 'activity' && React.createElement(ActivityTab, { snap }),
          tab === 'roles' && React.createElement(RolesTab, { snap }),
        ),
  )
}

function OverviewTab({ snap }) {
  const { group, members, tasks, activity, channel } = snap
  const running = tasks.filter((t) => t.status === 'in_progress').length
  const done = tasks.filter((t) => t.status === 'completed').length
  const leader = members.find((m) => m.role === 'leader')
  return React.createElement('div', { className: 'ag-col' },
    React.createElement('div', { className: 'ag-col' },
      React.createElement('div', { className: 'ag-note' }, 'Mission'),
      React.createElement('strong', null, group.mission.objective),
    ),
    React.createElement('table', { className: 'ag-table' },
      React.createElement('tbody', null,
        React.createElement('tr', null,
          React.createElement('td', null, 'Status'), React.createElement('td', null, statusBadge(group.status)),
        ),
        React.createElement('tr', null,
          React.createElement('td', null, 'Leader'), React.createElement('td', null, leader !== undefined ? leader.name : group.leaderSessionId.slice(0, 12)),
        ),
        React.createElement('tr', null,
          React.createElement('td', null, 'Members'),
          React.createElement('td', null, `${members.filter((m) => m.role === 'member' && m.status !== 'left').length} member(s)`),
        ),
        React.createElement('tr', null,
          React.createElement('td', null, 'Tasks'),
          React.createElement('td', null, `${tasks.length} total · ${running} running · ${done} done`),
        ),
        React.createElement('tr', null,
          React.createElement('td', null, 'Deliverables'),
          React.createElement('td', null, group.mission.deliverables.join(', ') || '—'),
        ),
        React.createElement('tr', null,
          React.createElement('td', null, 'Created'), React.createElement('td', null, fmtTime(group.createdAt)),
        ),
      ),
    ),
    React.createElement('div', { className: 'ag-note', style: { margin: '10px 0 4px' } }, 'Recent activity'),
    activity.slice(-5).reverse().map((event) =>
      React.createElement('div', { key: event.id, className: 'ag-msg' },
        React.createElement('span', { className: 'ag-monoblock' }, event.type),
        React.createElement('span', null, event.actorName ?? event.actorId?.slice(0, 10) ?? 'system'),
        React.createElement('span', { className: 'when' }, fmtTime(event.timestamp)),
      )),
    channel.length === 0 ? null : React.createElement('div', { className: 'ag-note', style: { margin: '10px 0 4px' } }, 'Latest message'),
  )
}

function TasksTab({ snap }) {
  const { tasks, members } = snap
  const nameOf = (id) => members.find((m) => m.sessionId === id)?.name ?? id.slice(0, 8)
  if (tasks.length === 0) {
    return React.createElement(EmptyLine, null, 'No tasks yet. Ask the Leader to break the mission into tasks.')
  }
  return React.createElement('table', { className: 'ag-table' },
    React.createElement('thead', null,
      React.createElement('tr', null,
        React.createElement('th', null, 'Title'),
        React.createElement('th', null, 'Status'),
        React.createElement('th', null, 'Assignee'),
        React.createElement('th', null, 'Dependencies'),
        React.createElement('th', null, 'Updated'),
      )),
    React.createElement('tbody', null,
      tasks.slice().sort((a, b) => b.updatedAt - a.updatedAt).map((task) =>
        React.createElement('tr', { key: task.taskId },
          React.createElement('td', null,
            React.createElement('div', null, task.subject),
            React.createElement('div', { className: 'ag-note' }, task.description.slice(0, 90)),
          ),
          React.createElement('td', null, statusBadge(task.status)),
          React.createElement('td', null, task.ownerId !== undefined ? nameOf(task.ownerId) : '—'),
          React.createElement('td', null,
            task.blockedBy.length === 0 ? '—'
              : task.blockedBy.map((id) => nameOf(id)).join(', '),
          ),
          React.createElement('td', { className: 'ag-monoblock' }, fmtTime(task.updatedAt)),
        )),
    ),
  )
}

function TeamTab({ snap, onRefresh }) {
  const { members, tasks, group } = snap
  const [addOpen, setAddOpen] = React.useState(false)
  const [inspected, setInspected] = React.useState(null)
  const [responding, setResponding] = React.useState(null)
  const live = members.filter((m) => m.status !== 'left')
  const taskTitle = (id) => tasks.find((t) => t.taskId === id)?.subject ?? '—'
  const requests = snap.runtimeRequests ?? []
  const answer = (request, action) => {
    if (responding !== null) return
    setResponding(request.requestId)
    api(`/groups/api/groups/${encodeURIComponent(group.groupId)}/members/${encodeURIComponent(request.memberId)}/runtime/respond`, {
      method: 'POST',
      body: JSON.stringify({ requestId: request.requestId, action, payload: action === 'answer' ? prompt(`${request.description}\n\nAnswer:`) ?? '' : undefined }),
    }).then(onRefresh).catch((err) => { window.alert(errorOf(err)) }).finally(() => setResponding(null))
  }
  return React.createElement('div', { className: 'ag-col' },
    requests.length > 0 && React.createElement('div', { className: 'ag-requests' },
      React.createElement('div', { className: 'ag-note', style: { fontWeight: 600 } }, 'Runtime requests — the agent is waiting for you'),
      requests.map((request) =>
        React.createElement('div', { key: request.requestId, className: 'ag-request' },
          React.createElement('div', { className: 'ag-col', style: { gap: 2, flex: 1 } },
            React.createElement('span', null,
              request.requestKind === 'input' ? '✎' : '⚠', ' ', request.description,
            ),
            React.createElement('span', { className: 'ag-note' }, `${request.memberName} · ${RUNTIME_STATE_LABELS[request.requestKind === 'input' ? 'waiting_input' : 'needs_approval']} · ${fmtTime(request.timestamp)}`),
          ),
          request.requestKind === 'input'
            ? React.createElement(Button, { variant: 'primary', size: 'sm', disabled: responding !== null, onClick: () => answer(request, 'answer') }, 'Answer')
            : React.createElement('div', { className: 'ag-row-actions' },
                React.createElement(Button, { variant: 'outline', size: 'sm', className: 'ag-danger', disabled: responding !== null, onClick: () => answer(request, 'decline') }, 'Decline'),
                React.createElement(Button, { variant: 'primary', size: 'sm', disabled: responding !== null, onClick: () => answer(request, 'accept') }, 'Accept'),
              ),
        )),
    ),
    React.createElement('div', { className: 'ag-toolbar' },
      React.createElement(Button, { variant: 'primary', size: 'sm', icon: React.createElement(primitives.IconPlusOutline16, {}), onClick: () => setAddOpen(true) }, 'Add Member'),
      React.createElement('span', { className: 'ag-note', style: { marginLeft: 'auto' } }, `${live.filter((m) => m.role === 'member').length} member(s)`),
    ),
    React.createElement('table', { className: 'ag-table' },
      React.createElement('thead', null,
        React.createElement('tr', null,
          React.createElement('th', null, 'Agent'),
          React.createElement('th', null, 'Role'),
          React.createElement('th', null, 'Runtime'),
          React.createElement('th', null, 'Model'),
          React.createElement('th', null, 'Reasoning'),
          React.createElement('th', null, 'Status'),
          React.createElement('th', null, 'Current task'),
        )),
      React.createElement('tbody', null,
        live.map((member) => {
          const selected = inspected === member.sessionId
          return React.createElement(React.Fragment, { key: member.sessionId },
            React.createElement('tr', {
              className: selected ? 'ag-row-selected' : undefined,
              onClick: () => setInspected(selected ? null : member.sessionId),
              style: { cursor: 'pointer' },
            },
              React.createElement('td', null, React.createElement('strong', null, member.name), member.role === 'leader' && React.createElement('span', { className: 'ag-badge', style: { marginLeft: 6 } }, 'leader')),
              React.createElement('td', null, member.roleId ?? member.displayRole ?? member.role),
              React.createElement('td', { className: 'ag-monoblock' }, member.runtime ?? '—'),
              React.createElement('td', { className: 'ag-monoblock' }, member.model ?? '—'),
              React.createElement('td', null, member.reasoningLevel ?? '—'),
              React.createElement('td', null,
                statusBadge(member.liveStatus ?? member.status),
                ' ',
                runtimeStateChip(member.runtimeState),
              ),
              React.createElement('td', { className: 'ag-note' },
                member.currentTaskId !== undefined ? taskTitle(member.currentTaskId) : member.role === 'leader' ? 'orchestrating' : 'idle',
                member.currentTurnId !== undefined && React.createElement('span', { className: 'ag-note ag-turn-id' }, ` · turn ${shortId(member.currentTurnId)}`),
              ),
            ),
            selected && React.createElement('tr', { className: 'ag-inspect-row' },
              React.createElement('td', { colSpan: 7 },
                React.createElement('div', { className: 'ag-inspect' },
                  React.createElement('div', { className: 'ag-inspect-grid' },
                    kv('Session state', runtimeStateChip(member.runtimeState) ?? member.status),
                    kv('Current task', member.currentTaskId !== undefined ? taskTitle(member.currentTaskId) : '—'),
                    kv('Current turn', member.currentTurnId ?? '—'),
                    kv('Role runtime', member.runtime ?? '—'),
                    kv('Model', member.model ?? '—'),
                    kv('Reasoning', member.reasoningLevel ?? '—'),
                    member.runtimeSession !== undefined && kv('Last activity', fmtTime(member.runtimeSession.updatedAt)),
                  ),
                  member.runtimeSession !== undefined && React.createElement('div', { className: 'ag-note', style: { marginTop: 8 } },
                    'Advanced (debug): ',
                    React.createElement('span', { className: 'ag-monoblock' },
                      [
                        member.runtimeSession.providerSessionId !== undefined ? `providerSession=${member.runtimeSession.providerSessionId}` : null,
                        member.runtimeSession.providerThreadId !== undefined ? `thread=${member.runtimeSession.providerThreadId}` : null,
                        member.runtimeSession.lastTurnId !== undefined ? `lastTurn=${member.runtimeSession.lastTurnId}` : null,
                      ].filter(Boolean).join(' · ') || '—',
                    ),
                  ),
                ),
              ),
            ),
          )
        }),
      ),
    ),
    addOpen && React.createElement(AddMemberModal, { groupId: group.groupId, onClose: () => setAddOpen(false) }),
  )
}

function AddMemberModal({ groupId, onClose }) {
  const [roles, setRoles] = React.useState([])
  const [role, setRole] = React.useState('')
  const [name, setName] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)

  React.useEffect(() => {
    api(`/groups/api/groups/${encodeURIComponent(groupId)}/team-config`).then((config) => {
      setRoles(config.memberRoles)
      if (config.memberRoles.length > 0) setRole(config.memberRoles[0].id)
    }).catch(() => undefined)
  }, [groupId])

  const add = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api(`/groups/api/groups/${encodeURIComponent(groupId)}/members`, {
        method: 'POST', body: JSON.stringify({ role, ...(name.trim() !== '' ? { name: name.trim() } : {}) }),
      })
      onClose()
    } catch (cause) {
      setError(errorOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return React.createElement(Modal, {
    open: true, onClose, title: 'Add Member (by team role)',
    footer: React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: onClose }, 'Cancel'),
      React.createElement(Button, { variant: 'primary', size: 'sm', onClick: () => void add(), disabled: busy || role === '' }, busy ? 'Joining…' : 'Join Team'),
    ),
  },
    React.createElement('div', { className: 'ag-form' },
      error !== null && React.createElement(ErrorLine, { message: error }),
      React.createElement('label', null, 'Team role (runtime/model/reasoning come from the configuration)',
        React.createElement('select', { value: role, onChange: (e) => setRole(e.target.value), style: { padding: 6, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' } },
          roles.map((r) => React.createElement('option', { key: r.id, value: r.id }, `${r.name} [${r.runtime}]`)),
        ),
      ),
      React.createElement('label', null, 'Display name (optional)',
        React.createElement(Input, { value: name, onChange: (e) => setName(e.target.value), placeholder: 'planner-1' }),
      ),
    ),
  )
}

function ChannelTab({ snap, onMessage }) {
  const { channel, group } = snap
  const [draft, setDraft] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const feedRef = React.useRef(null)

  const send = async () => {
    if (busy || draft.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      await api(`/groups/api/groups/${encodeURIComponent(group.groupId)}/broadcast`, {
        method: 'POST', body: JSON.stringify({ text: draft.trim() }),
      })
      setDraft('')
      onMessage()
    } catch (cause) {
      setError(errorOf(cause))
    } finally {
      setBusy(false)
    }
  }

  React.useEffect(() => {
    if (feedRef.current !== null) feedRef.current.scrollTop = feedRef.current.scrollHeight
  }, [channel.length])

  return React.createElement('div', { className: 'ag-col' },
    error !== null && React.createElement(ErrorLine, { message: error }),
    channel.length === 0
      ? React.createElement(EmptyLine, null, 'No team messages yet — post the first one below.')
      : React.createElement('div', { ref: feedRef, style: { maxHeight: '42vh', overflow: 'auto', marginBottom: 8 } },
          channel.map((message) =>
            React.createElement('div', { key: message.id, className: 'ag-msg' },
              React.createElement('div', { className: 'ag-col', style: { flex: 1 } },
                React.createElement('div', null,
                  React.createElement('strong', null, message.senderName),
                  message.senderId === 'user'
                    ? React.createElement('span', { className: 'ag-badge', style: { marginLeft: 6 } }, 'User')
                    : message.senderId === 'system'
                      ? React.createElement('span', { className: 'ag-badge', style: { marginLeft: 6 } }, 'System')
                      : null,
                ),
                React.createElement('div', null, message.text),
              ),
              React.createElement('span', { className: 'when' }, fmtTime(message.timestamp)),
            ),
          ),
        ),
    React.createElement('div', { className: 'ag-toolbar', style: { marginBottom: 0 } },
      React.createElement('div', { style: { flex: 1, minWidth: 0 } },
        React.createElement(Input, {
          value: draft,
          onChange: (e) => setDraft(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') void send() },
          placeholder: 'Post to the team (all agents can read)…',
          style: { width: '100%' },
        }),
      ),
      React.createElement(Button, { variant: 'primary', size: 'sm', onClick: () => void send(), disabled: busy || draft.trim() === '' },
        busy ? '…' : 'Send',
      ),
    ),
    React.createElement('div', { className: 'ag-legend' }, 'Live via SSE — new messages appear automatically.'),
  )
}


function LeaderChatTab({ snap, onMessage }) {
  const groupId = snap.group.groupId
  const [messages, setMessages] = React.useState([])
  const [draft, setDraft] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)

  const load = React.useCallback(() => {
    setError(null)
    api(`/groups/api/groups/${encodeURIComponent(groupId)}/leader-chat`).then(setMessages).catch((err) => setError(errorOf(err)))
  }, [groupId])

  React.useEffect(() => { load() }, [load])

  const send = async () => {
    if (busy || draft.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      await api(`/groups/api/groups/${encodeURIComponent(groupId)}/leader-chat`, {
        method: 'POST', body: JSON.stringify({ text: draft.trim() }),
      })
      setDraft('')
      load()
      onMessage()
    } catch (cause) {
      setError(errorOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return React.createElement('div', { className: 'ag-col' },
    error !== null && React.createElement(ErrorLine, { message: error }),
    messages.length === 0
      ? React.createElement(EmptyLine, null, 'No leader chat yet — send a direct instruction to the Leader.')
      : React.createElement('div', { style: { maxHeight: '42vh', overflow: 'auto', marginBottom: 8 } },
          messages.map((message) =>
            React.createElement('div', { key: message.id, className: 'ag-msg' },
              React.createElement('div', { className: 'ag-col', style: { flex: 1 } },
                React.createElement('div', null,
                  React.createElement('strong', null, message.senderName),
                  React.createElement('span', { className: 'ag-badge', style: { marginLeft: 6 } }, message.direction === 'user-to-leader' ? 'User' : 'Leader'),
                ),
                React.createElement('div', null, message.text),
              ),
              React.createElement('span', { className: 'when' }, fmtTime(message.timestamp)),
            ),
          ),
        ),
    React.createElement('div', { className: 'ag-toolbar', style: { marginBottom: 0 } },
      React.createElement('div', { style: { flex: 1, minWidth: 0 } },
        React.createElement(Input, {
          value: draft,
          onChange: (e) => setDraft(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') void send() },
          placeholder: 'Send a private instruction to the Leader…',
          style: { width: '100%' },
        }),
      ),
      React.createElement(Button, { variant: 'primary', size: 'sm', onClick: () => void send(), disabled: busy || draft.trim() === '' },
        busy ? '…' : 'Send',
      ),
    ),
  )
}

function WorkspaceTab({ snap, onMessage }) {
  const groupId = snap.group.groupId
  const [view, setView] = React.useState({ notes: '', notesUpdatedAt: null, artifacts: [] })
  const [draftNotes, setDraftNotes] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)

  const load = React.useCallback(() => {
    setError(null)
    api(`/groups/api/groups/${encodeURIComponent(groupId)}/workspace`).then((data) => {
      setView(data)
      setDraftNotes(data.notes ?? '')
    }).catch((err) => setError(errorOf(err)))
  }, [groupId])

  React.useEffect(() => { load() }, [load])

  const saveNotes = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api(`/groups/api/groups/${encodeURIComponent(groupId)}/notes`, {
        method: 'PUT', body: JSON.stringify({ notes: draftNotes }),
      })
      load()
      onMessage()
    } catch (cause) {
      setError(errorOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return React.createElement('div', { className: 'ag-col' },
    error !== null && React.createElement(ErrorLine, { message: error }),
    React.createElement('label', { style: { fontWeight: 600 } }, 'Shared Notes'),
    React.createElement('textarea', {
      rows: 5,
      value: draftNotes,
      onChange: (e) => setDraftNotes(e.target.value),
      style: { padding: 8, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit' },
    }),
    React.createElement('div', { className: 'ag-toolbar' },
      React.createElement(Button, { variant: 'primary', size: 'sm', onClick: () => void saveNotes(), disabled: busy }, busy ? 'Saving…' : 'Save Notes'),
    ),
    React.createElement('div', { style: { marginTop: 12, fontWeight: 600 } }, 'Artifacts'),
    (view.artifacts ?? []).length === 0
      ? React.createElement(EmptyLine, null, 'No artifacts yet — results will appear here as members complete tasks.')
      : React.createElement('table', { className: 'ag-table' },
          React.createElement('thead', null,
            React.createElement('tr', null,
              React.createElement('th', null, 'Path'),
              React.createElement('th', null, 'Source'),
              React.createElement('th', null, 'Task'),
            )),
          React.createElement('tbody', null,
            view.artifacts.map((artifact) =>
              React.createElement('tr', { key: artifact.taskId + ':' + artifact.path },
                React.createElement('td', { className: 'ag-monoblock' }, artifact.path),
                React.createElement('td', null, artifact.source),
                React.createElement('td', { className: 'ag-note' }, artifact.taskSubject),
              )),
          ),
        ),
  )
}

function ActivityTab({ snap }) {
  const { activity } = snap
  if (activity.length === 0) {
    return React.createElement(EmptyLine, null, 'No activity yet.')
  }
  return React.createElement('div', { className: 'ag-col' },
    activity.slice(-100).reverse().map((event) =>
      React.createElement('div', { key: event.id, className: 'ag-msg' },
        React.createElement('div', { className: 'ag-col', style: { flex: 1 } },
          React.createElement('div', null,
            React.createElement('span', { className: 'ag-monoblock' }, event.type),
            React.createElement('span', { style: { marginLeft: 8 } }, event.actorName ?? event.actorId?.slice(0, 10) ?? 'system'),
          ),
          Object.keys(event.payload ?? {}).length > 0
            ? React.createElement('div', { className: 'ag-note' },
                Object.entries(event.payload).slice(0, 3).map(([key, value]) => `${key}=${String(value).slice(0, 60)}`).join(' · '),
              )
            : null,
        ),
        React.createElement('span', { className: 'when' }, fmtTime(event.timestamp)),
      )),
  )
}


// ── Team Configuration (V0.4): roles + runtimes ────────────────────────────

function RolesTab({ snap }) {
  const groupId = snap.group.groupId
  const [config, setConfig] = React.useState(null)
  const [runtimes, setRuntimes] = React.useState([])
  const [error, setError] = React.useState(null)
  const [saved, setSaved] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [initialConfig, setInitialConfig] = React.useState(null)

  const load = React.useCallback(() => {
    setError(null)
    api(`/groups/api/groups/${encodeURIComponent(groupId)}/team-config`).then((data) => { setConfig(data); setInitialConfig(data) }).catch((err) => setError(errorOf(err)))
    api('/groups/api/runtimes').then(setRuntimes).catch(() => undefined)
  }, [groupId])

  React.useEffect(() => { load() }, [load])

  const save = async () => {
    if (busy || config === null) return
    setBusy(true)
    setError(null)
    try {
      const updated = await api(`/groups/api/groups/${encodeURIComponent(groupId)}/team-config`, {
        method: 'PUT', body: JSON.stringify(config),
      })
      setConfig(updated.teamConfig)
      setSaved('Team configuration saved.')
      window.setTimeout(() => setSaved(null), 2500)
    } catch (cause) {
      setError(errorOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const patchRole = (index, patch) => {
    setConfig((current) => {
      if (current === null) return current
      const roles = current.memberRoles.map((role, i) => (i === index ? { ...role, ...patch } : role))
      return { ...current, memberRoles: roles }
    })
  }
  const addRole = () => {
    setConfig((current) => (current === null ? current : {
      ...current,
      memberRoles: [...current.memberRoles, {
        id: `role-${Date.now().toString(36)}`, name: 'New Role', runtime: 'deepseek-harness',
        profile: 'group-member', reasoningLevel: 'medium', maxInstances: 2,
      }],
    }))
  }
  const removeRole = (index) => {
    setConfig((current) => (current === null ? current : {
      ...current,
      memberRoles: current.memberRoles.filter((_, i) => i !== index),
    }))
  }
  const duplicateRole = (role) => {
    setConfig((current) => (current === null ? current : {
      ...current,
      memberRoles: [...current.memberRoles, {
        ...role,
        id: `role-${Date.now().toString(36)}`,
        name: `${role.name} Copy`,
      }],
    }))
  }
  const exportConfig = () => {
    if (config === null) return
    const json = JSON.stringify(config, null, 2)
    try {
      if (navigator.clipboard?.writeText !== undefined) navigator.clipboard.writeText(json)
    } catch { /* clipboard unavailable */ }
    setSaved('Team configuration copied to clipboard.')
    window.setTimeout(() => setSaved(null), 2500)
  }
  const importConfig = () => {
    if (config === null) return
    const raw = window.prompt('Paste Team Configuration JSON')
    if (raw === null || raw.trim() === '') return
    try {
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.memberRoles)) throw new Error('invalid team config')
      setConfig(parsed)
      setSaved('Imported configuration — review and save.')
      window.setTimeout(() => setSaved(null), 2500)
    } catch (cause) {
      setError(errorOf(cause))
    }
  }
  const resetConfig = () => {
    if (initialConfig === null) return
    setConfig(initialConfig)
    setSaved('Reset to last saved configuration.')
    window.setTimeout(() => setSaved(null), 2500)
  }

  if (config === null) return React.createElement(Spinner)

  return React.createElement('div', { className: 'ag-col' },
    error !== null && React.createElement(ErrorLine, { message: error }),
    React.createElement('div', { className: 'ag-toolbar' },
      React.createElement(Button, { variant: 'primary', size: 'sm', onClick: () => void save(), disabled: busy }, busy ? 'Saving…' : 'Save Team Configuration'),
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: addRole, icon: React.createElement(primitives.IconPlusOutline16, {}) }, 'Add Role'),
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: exportConfig }, 'Export'),
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: importConfig }, 'Import'),
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: resetConfig, disabled: initialConfig === null }, 'Reset'),
      saved !== null && React.createElement('span', { className: 'ag-note' }, saved),
    ),
    React.createElement('div', { className: 'ag-note', style: { marginBottom: 8 } },
      'Configured Roles define HOW each kind of member spawns (runtime / model / reasoning / profile / max instances). Running instances appear on the Team tab.'),
    React.createElement('div', { className: 'ag-col' },
      React.createElement(RoleCard, {
        role: config.leaderRole, leader: true,
        runtimes, onPatch: () => undefined, onRemove: () => undefined,
      }),
      config.memberRoles.map((role, index) => React.createElement(RoleCard, {
        key: role.id, role, runtimes,
        onPatch: (patch) => patchRole(index, patch),
        onRemove: () => removeRole(index),
        onDuplicate: (role) => duplicateRole(role),
      })),
    ),
  )
}

function RoleCard({ role, leader, runtimes, onPatch, onRemove, onDuplicate }) {
  const runtime = runtimes.find((r) => r.id === role.runtime)
  const unavailable = runtime !== undefined && !runtime.available
  const models = runtime?.capabilities?.models === true ? (runtime.models ?? []) : []
  const levels = (runtime?.reasoningLevels?.length ?? 0) > 0 ? runtime.reasoningLevels : [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }]
  return React.createElement('div', { style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: 10, marginBottom: 10, background: 'var(--dsw-alias-bg-layer-1)' } },
    React.createElement('div', { className: 'ag-toolbar', style: { marginBottom: 6 } },
      React.createElement('strong', null, role.name),
      React.createElement('span', { className: 'ag-monoblock' }, role.id),
      leader && React.createElement('span', { className: 'ag-badge' }, 'leader'),
      runtime === undefined && React.createElement('span', { className: 'ag-badge err' }, `runtime "${role.runtime}" not registered`),
      unavailable && React.createElement('span', { className: 'ag-badge warn' }, 'Not configured'),
      runtime !== undefined && runtime.available && React.createElement('span', { className: 'ag-badge ok' }, 'Available'),
      !leader && React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => onDuplicate(role), style: { marginLeft: 'auto' } }, 'Duplicate'),
      !leader && React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: onRemove }, 'Remove'),
    ),
    React.createElement('div', { className: 'ag-form', style: { gap: 6 } },
      leader && React.createElement('label', null, 'Description', React.createElement('input', { className: 'ag-input', value: role.description ?? '', disabled: true, style: { padding: 4, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' } })),
      React.createElement('div', { className: 'ag-col', style: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' } },
        React.createElement('label', null, 'Runtime',
          React.createElement('select', { className: 'ag-input', value: role.runtime, disabled: leader, onChange: (e) => onPatch({ runtime: e.target.value }), style: { padding: 4, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' } },
            runtimes.length === 0 ? React.createElement('option', { value: role.runtime }, role.runtime)
              : runtimes.map((r) => React.createElement('option', { key: r.id, value: r.id }, r.name)),
          )),
        React.createElement('label', null, 'Model',
          React.createElement('select', { className: 'ag-input', value: role.model ?? '', disabled: leader, onChange: (e) => onPatch({ model: e.target.value === '' ? undefined : e.target.value }), style: { padding: 4, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' } },
            React.createElement('option', { value: '' }, '— default —'),
            models.map((m) => React.createElement('option', { key: m.id, value: m.id }, m.name ?? m.id)),
          )),
        React.createElement('label', null, 'Reasoning',
          React.createElement('select', { className: 'ag-input', value: role.reasoningLevel ?? '', disabled: leader, onChange: (e) => onPatch({ reasoningLevel: e.target.value === '' ? undefined : e.target.value }), style: { padding: 4, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' } },
            React.createElement('option', { value: '' }, '— default —'),
            levels.map((level) => React.createElement('option', { key: level.id, value: level.id }, level.label)),
          )),
        React.createElement('label', null, 'Profile',
          React.createElement('input', { className: 'ag-input', value: role.profile ?? '', disabled: leader, onChange: (e) => onPatch({ profile: e.target.value }), style: { padding: 4, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' } }),
        ),
        React.createElement('label', null, 'Max instances',
          React.createElement('input', { className: 'ag-input', type: 'number', min: 1, value: role.maxInstances ?? '', disabled: leader, onChange: (e) => onPatch({ maxInstances: e.target.value === '' ? undefined : Number(e.target.value) }), style: { width: 80, padding: 4, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' } }),
        ),
      ),
      !leader && React.createElement('label', null, 'Role instructions (system prompt)',
        React.createElement('textarea', { className: 'ag-input', rows: 2, value: role.systemPrompt ?? '', onChange: (e) => onPatch({ systemPrompt: e.target.value }), style: { padding: 4, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit' } }),
      ),
    ),
  )
}

// ── plugin ─────────────────────────────────────────────────────────────────

function apply(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  slots.inject('sidebar.footer.action', () => slots.register(
    { name: 'sidebar.footer.action', id: 'agent-groups', order: 10, label: () => 'Agent Groups' },
    (props) => React.createElement(AgentGroupsTrigger, props),
  ))
  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'agent-groups-page', order: 1000, label: () => 'Agent Groups page' },
    () => React.createElement(AgentGroupsPage),
  ))
}

module.exports = { apply }