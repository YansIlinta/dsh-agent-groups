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

// ── V0.4.1: harness discovery client (Create/Edit Role data surface) ────────
//
// Consumes the shared discovery contract (per the API contract, T4):
//   GET /groups/api/config/providers              → { providers: [...] }
//   GET /groups/api/config/providers/:id/models   → { models: [...] }   (404 = unknown provider)
//   GET /groups/api/config/providers/:id/credential → { credential: ..., note? } (404 = unknown provider)
// Every response is status facts only — the UI never receives or stores secrets.
// All reads are cached per provider/model for the session and degrade to an
// empty-but-healthy surface when the endpoints/services are absent.

const DSH_RUNTIME_ID = 'deepseek-harness'
const DISCOVERY_TTL = 30_000

const discoveryCache = {
  providers: null,
  models: new Map(),
  credential: new Map(),
}

function discoveryFresh(at) { return at !== undefined && Date.now() - at < DISCOVERY_TTL }

/** Provider entry id, across both view shapes (`id` / `provider` key). */
function providerIdOf(entry) { return typeof entry?.id === 'string' ? entry.id : entry?.provider }

/**
 * Normalize credential facts across the view shapes the contract carries:
 *  - provider-entry: {settingsNs?, settingsPath?, credentialRef?, credential: {configured?, source?, writable?}}
 *  - per-provider endpoint: { provider, credential: {configured?, source?, writable?} } (+ entry.kind === 'settings' legacy)
 * Returns facts only — never values.
 */
function credentialFacts(cred) {
  if (cred === undefined || cred === null) return {}
  const nested = cred.credential ?? {}
  const entry = cred.entry ?? cred
  return {
    configured: cred.configured ?? nested.configured,
    source: cred.source ?? nested.source,
    writable: cred.writable ?? nested.writable,
    settingsNs: entry?.settingsNs ?? cred.settingsNs ?? nested.settingsNs,
    settingsPath: entry?.settingsPath ?? cred.settingsPath ?? nested.settingsPath,
    credentialRef: entry?.credentialRef ?? cred.credentialRef ?? nested.credentialRef,
  }
}

async function discoveryProviders(force) {
  const hit = discoveryCache.providers
  if (!force && hit !== null && discoveryFresh(hit.at)) return hit
  let entry
  try {
    const data = await api('/groups/api/config/providers')
    const providers = Array.isArray(data?.providers) ? data.providers : []
    entry = { providers, note: data?.note, at: Date.now(), ok: true, error: null }
  } catch (error) {
    entry = { providers: [], at: Date.now(), ok: false, error: errorOf(error) }
  }
  discoveryCache.providers = entry
  return entry
}

async function discoveryModels(providerId, force) {
  const hit = discoveryCache.models.get(providerId)
  if (!force && hit !== undefined && discoveryFresh(hit.at)) return hit
  let entry
  try {
    const data = await api(`/groups/api/config/providers/${encodeURIComponent(providerId)}/models`)
    entry = { models: Array.isArray(data?.models) ? data.models : [], note: data?.note, at: Date.now(), ok: true, error: null }
  } catch (error) {
    // Endpoint absent (T4 not merged yet) → fall back to models embedded in
    // the providers list when present, else degraded empty.
    const providers = await discoveryProviders(true)
    const embedded = providers.providers.find((p) => providerIdOf(p) === providerId)?.models
    entry = { models: Array.isArray(embedded) ? embedded : [], at: Date.now(), ok: false, error: errorOf(error), embedded: Array.isArray(embedded) && embedded.length > 0 }
  }
  discoveryCache.models.set(providerId, entry)
  return entry
}

async function discoveryCredential(providerId, force) {
  const hit = discoveryCache.credential.get(providerId)
  if (!force && hit !== undefined && discoveryFresh(hit.at)) return hit
  let entry
  try {
    const data = await api(`/groups/api/config/providers/${encodeURIComponent(providerId)}/credential`)
    entry = { credential: data?.credential ?? {}, note: data?.note, at: Date.now(), ok: true, error: null }
  } catch (error) {
    // Endpoint absent → fall back to the providers-list credential facts.
    const providers = await discoveryProviders(true)
    const provider = providers.providers.find((p) => providerIdOf(p) === providerId)
    entry = { credential: provider?.credential ?? {}, at: Date.now(), ok: false, error: errorOf(error), embedded: provider !== undefined }
  }
  discoveryCache.credential.set(providerId, entry)
  return entry
}

/**
 * The wizard's exact step sequence per requirement: Name → Runtime → Provider
 * → Authentication → Model → Reasoning → Instructions → Create. Only the DSH
 * runtime carries Provider/Authentication/Model/Reasoning; ACP runtimes show
 * their existing readiness info and jump straight to Instructions. The
 * Reasoning step is gated by the SELECTED MODEL's capability: hidden entirely
 * when the model exposes no reasoning efforts (per requirement).
 */
function wizardSteps(runtime, reasoning) {
  const steps = [
    { id: 'name', label: 'Name' },
    { id: 'runtime', label: 'Runtime' },
  ]
  if (runtime === DSH_RUNTIME_ID) {
    steps.push({ id: 'provider', label: 'Provider' })
    steps.push({ id: 'auth', label: 'Authentication' })
    steps.push({ id: 'model', label: 'Model' })
    if (reasoning !== undefined && reasoning.efforts.length > 0) {
      steps.push({ id: 'reasoning', label: 'Reasoning' })
    }
  }
  steps.push({ id: 'instructions', label: 'Instructions' })
  steps.push({ id: 'create', label: 'Create' })
  return steps
}

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
.ag-select{padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ag-wiz-steps{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px}
.ag-wiz-step{padding:2px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;background:var(--dsw-alias-bg-layer-1);cursor:default}
.ag-wiz-step.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);font-weight:600}
.ag-wiz-step.done{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.ag-auth-box{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:6px}
.ag-wiz-summary{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:6px 16px}
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

/** V0.5/V0.6: live runtime-session state chip (Idle/Working/Waiting…). */
const RUNTIME_STATE_LABELS = {
  starting: 'Starting',
  idle: 'Idle',
  working: 'Working',
  waiting_input: 'Waiting for input',
  needs_approval: 'Needs approval',
  interrupted: 'Interrupted',
  disconnected: 'Disconnected',
  reconnecting: 'Reconnecting',
  failed: 'Failed',
  closed: 'Closed',
}

function runtimeStateChip(state) {
  if (!state) return null
  const label = RUNTIME_STATE_LABELS[state] ?? String(state)
  const kind = state === 'working' || state === 'starting' || state === 'reconnecting' ? 'warn'
    : state === 'needs_approval' || state === 'waiting_input' ? 'info'
      : state === 'disconnected' || state === 'failed' ? 'err'
        : 'ok'
  return React.createElement('span', { className: `ag-badge ag-badge-rt ${kind}`, title: `Runtime session state: ${label}` }, label)
}

function shortId(id) {
  return typeof id === 'string' ? id.slice(0, 8) : String(id)
}

function capabilitySummary(capabilities) {
  if (capabilities === undefined || capabilities === null) return '—'
  const labels = {
    resumeSession: 'resume', loadSession: 'load', listSessions: 'list', closeSession: 'close',
    steering: 'steering', images: 'images', embeddedContext: 'embedded context',
    mcpHttp: 'MCP HTTP', mcpSse: 'MCP SSE', mcpAcp: 'MCP ACP', goal: 'goal',
  }
  const enabled = Object.entries(labels).filter(([key]) => capabilities[key] === true).map(([, label]) => label)
  return enabled.length > 0 ? enabled.join(', ') : 'baseline ACP'
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
  const [workspaceMode, setWorkspaceMode] = React.useState('shared')
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
        body: JSON.stringify({ leaderSessionId: leader, name: name.trim(), objective: mission.trim(), workspaceMode, templateId: templateId || undefined, members: members.length > 0 ? members : undefined }),
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
      React.createElement('label', null, 'Member workspace',
        React.createElement('select', { value: workspaceMode, onChange: (e) => setWorkspaceMode(e.target.value), style: { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, padding: '6px 8px' } },
          React.createElement('option', { value: 'shared' }, 'Shared group directory'),
          React.createElement('option', { value: 'worktree' }, 'Isolated Git worktree per member'),
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
          tab === 'tasks' && React.createElement(TasksTab, { snap, onRefresh: () => load() }),
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

function TasksTab({ snap, onRefresh }) {
  const { tasks, members, group } = snap
  const nameOf = (id) => members.find((m) => m.sessionId === id)?.name ?? id.slice(0, 8)
  const [creating, setCreating] = React.useState(false)
  const [subject, setSubject] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [assignee, setAssignee] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const memberOptions = members.filter((m) => m.role === 'member' && m.status !== 'left')
  const create = async () => {
    if (busy || subject.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      await api(`/groups/api/groups/${encodeURIComponent(group.groupId)}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          subject: subject.trim(),
          description: description.trim() === '' ? undefined : description.trim(),
          ...(assignee !== '' ? { ownerId: assignee } : {}),
        }),
      })
      setCreating(false)
      setSubject('')
      setDescription('')
      setAssignee('')
      onRefresh()
    } catch (err) {
      setError(errorOf(err))
    } finally {
      setBusy(false)
    }
  }
  if (tasks.length === 0 && !creating) {
    return React.createElement('div', { className: 'ag-col' },
      React.createElement(EmptyLine, null, 'No tasks yet. Ask the Leader to break the mission into tasks, or create one below.'),
      React.createElement('div', { className: 'ag-toolbar' },
        React.createElement(Button, { variant: 'outline', size: 'sm', onClick: () => setCreating(true) }, 'New Task'),
      ),
    )
  }
  return React.createElement('div', { className: 'ag-col' },
    React.createElement('div', { className: 'ag-toolbar' },
      React.createElement(Button, { variant: 'outline', size: 'sm', onClick: () => setCreating((v) => !v) }, creating ? 'Cancel' : 'New Task'),
      React.createElement('span', { className: 'ag-note', style: { marginLeft: 'auto' } }, `${tasks.length} task(s)`),
    ),
    creating && React.createElement('div', { className: 'ag-col', style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: 10, marginBottom: 10, gap: 6 } },
      error !== null && React.createElement(ErrorLine, { message: error }),
      React.createElement('input', { className: 'ag-input', placeholder: 'Task subject', value: subject, onChange: (e) => setSubject(e.target.value), style: { padding: 6, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' } }),
      React.createElement('textarea', { className: 'ag-input', rows: 2, placeholder: 'Description (optional)', value: description, onChange: (e) => setDescription(e.target.value), style: { padding: 6, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit' } }),
      React.createElement('div', { className: 'ag-toolbar' },
        React.createElement('select', { className: 'ag-input', value: assignee, onChange: (e) => setAssignee(e.target.value), style: { padding: 6, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' } },
          React.createElement('option', { value: '' }, '— assign later —'),
          memberOptions.map((m) => React.createElement('option', { key: m.sessionId, value: m.sessionId }, m.name)),
        ),
        React.createElement(Button, { variant: 'primary', size: 'sm', disabled: busy || subject.trim() === '', onClick: () => void create() }, busy ? 'Creating…' : 'Create'),
      ),
      React.createElement('div', { className: 'ag-note' }, 'Assigning to a busy member queues the task as a future turn on that member’s session.'),
    ),
    React.createElement('table', { className: 'ag-table' },
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
            React.createElement('td', null,
              statusBadge(task.status),
              Array.isArray(task.attempts) && task.attempts.length > 0 && React.createElement('div', { className: 'ag-note' },
                `attempt ${task.attempts[task.attempts.length - 1].sequence}: ${task.attempts[task.attempts.length - 1].status}`,
              ),
              task.dispatch?.state === 'ambiguous' && React.createElement('div', { className: 'ag-note' },
                'delivery ambiguous · explicit retry required',
              ),
            ),
            React.createElement('td', null, task.ownerId !== undefined ? nameOf(task.ownerId) : '—'),
            React.createElement('td', null,
              task.blockedBy.length === 0 ? '—'
                : task.blockedBy.map((id) => nameOf(id)).join(', '),
            ),
            React.createElement('td', { className: 'ag-monoblock' }, fmtTime(task.updatedAt)),
          )),
      ),
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
  /** V0.6: user actions — correction into current work, or interrupt. */
  const sendCorrection = (member) => {
    const text = window.prompt(`Send a correction about ${member.name}'s current work`)
    if (text === null || text.trim() === '') return
    api(`/groups/api/groups/${encodeURIComponent(group.groupId)}/members/${encodeURIComponent(member.sessionId)}/correction`, {
      method: 'POST', body: JSON.stringify({ text: text.trim() }),
    }).then(onRefresh).catch((err) => { window.alert(errorOf(err)) })
  }
  const interrupt = (member) => {
    const reason = window.prompt(`Interrupt ${member.name}'s current turn`, 'leader interrupt')
    if (reason === null) return
    api(`/groups/api/groups/${encodeURIComponent(group.groupId)}/members/${encodeURIComponent(member.sessionId)}/interrupt`, {
      method: 'POST', body: JSON.stringify({ reason: reason.trim() === '' ? 'interrupted from the Agent Groups page' : reason.trim() }),
    }).then(onRefresh).catch((err) => { window.alert(errorOf(err)) })
  }
  /** V0.6: queued future turns (tasks + corrections) on the member's session. */
  const queuedChip = (member) => {
    const queued = member.runtimeQueuedTurns ?? []
    if (queued.length === 0) return null
    const tasksN = queued.filter((q) => q.kind === 'task').length
    const followsN = queued.filter((q) => q.kind === 'followup').length
    const label = tasksN > 0 && followsN > 0
      ? `queued: ${tasksN} task(s), ${followsN} correction(s)`
      : tasksN > 0 ? `queued: ${tasksN} task(s)` : `queued: ${followsN} correction(s)`
    return React.createElement('span', { className: 'ag-badge ag-badge-rt info', title: queued.map((q) => `${q.kind === 'task' ? 'task' : 'correction'}${q.taskId !== undefined ? ` (${q.taskId.slice(0, 8)})` : ''} — ${q.text.slice(0, 120)}`).join('\n') }, label)
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
                ' ',
                queuedChip(member),
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
                    member.runtimeSession?.providerCapabilities !== undefined && kv('Capabilities', capabilitySummary(member.runtimeSession.providerCapabilities)),
                    member.runtimeSession !== undefined && kv('Last activity', fmtTime(member.runtimeSession.updatedAt)),
                  ),
                  (member.runtimeQueuedTurns ?? []).length > 0 && React.createElement('div', { className: 'ag-col', style: { marginTop: 8, gap: 4 } },
                    React.createElement('span', { className: 'ag-note', style: { fontWeight: 600 } }, 'Queued future turns (same session, start after the current turn ends)'),
                    (member.runtimeQueuedTurns ?? []).map((q) =>
                      React.createElement('div', { key: q.seq, className: 'ag-note', style: { display: 'flex', gap: 6, alignItems: 'baseline' } },
                        React.createElement('span', { className: q.kind === 'task' ? 'ag-badge warn' : 'ag-badge info' }, q.kind === 'task' ? 'task' : 'correction'),
                        React.createElement('span', null, q.text.slice(0, 140)),
                        React.createElement('span', { className: 'ag-monoblock' }, q.taskId !== undefined ? q.taskId.slice(0, 8) : ''),
                      ),
                    ),
                  ),
                  member.role === 'member' && React.createElement('div', { className: 'ag-toolbar', style: { marginTop: 10 } },
                    React.createElement(Button, { variant: 'outline', size: 'sm', icon: React.createElement(primitives.IconEditOutline16, {}), onClick: () => sendCorrection(member) }, 'Send correction'),
                    React.createElement(Button, { variant: 'outline', size: 'sm', className: 'ag-danger', onClick: () => interrupt(member) }, 'Interrupt turn'),
                  ),
                  member.runtimeSession !== undefined && React.createElement('div', { className: 'ag-note', style: { marginTop: 8 } },
                    'Advanced (debug): ',
                    React.createElement('span', { className: 'ag-monoblock' },
                      [
                        member.runtimeSession.providerSessionId !== undefined ? `providerSession=${member.runtimeSession.providerSessionId}` : null,
                        member.runtimeSession.providerThreadId !== undefined ? `thread=${member.runtimeSession.providerThreadId}` : null,
                        member.runtimeSession.lastTurnId !== undefined ? `lastTurn=${member.runtimeSession.lastTurnId}` : null,
                        member.runtimeSession.providerCapabilities?.protocolVersion !== undefined ? `ACP v${member.runtimeSession.providerCapabilities.protocolVersion}` : null,
                        member.runtimeSession.providerCapabilities?.agentName !== undefined ? `agent=${member.runtimeSession.providerCapabilities.agentName}${member.runtimeSession.providerCapabilities.agentVersion ? `@${member.runtimeSession.providerCapabilities.agentVersion}` : ''}` : null,
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
  const [config, setConfig] = React.useState(null)
  const [creating, setCreating] = React.useState(false)

  React.useEffect(() => {
    api(`/groups/api/groups/${encodeURIComponent(groupId)}/team-config`).then((data) => {
      setConfig(data)
      setRoles(data.memberRoles)
      if (data.memberRoles.length > 0) setRole(data.memberRoles[0].id)
    }).catch(() => undefined)
  }, [groupId])

  /** V0.4.1: the Create Role wizard can surface from Add Member — a fabricated
   * role is appended to the team config through the same PUT path, then the
   * modal reloads and preselects it so the member can spawn immediately. */
  const created = async (createdRole) => {
    const current = config ?? { leaderRole: { id: 'leader', name: 'Leader', runtime: 'deepseek-harness' }, memberRoles: [] }
    const merged = { ...current, memberRoles: [...(current.memberRoles ?? []), createdRole] }
    const updated = await api(`/groups/api/groups/${encodeURIComponent(groupId)}/team-config`, {
      method: 'PUT', body: JSON.stringify(merged),
    })
    const nextRoles = updated.teamConfig?.memberRoles ?? merged.memberRoles
    setConfig(updated.teamConfig ?? merged)
    setRoles(nextRoles)
    setRole(createdRole.id)
    setCreating(false)
  }

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
      React.createElement('label', null, 'Team role (runtime/provider/model/reasoning come from the configuration)',
        React.createElement('select', { value: role, onChange: (e) => setRole(e.target.value), style: { padding: 6, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' } },
          roles.length === 0 && React.createElement('option', { value: '' }, '— no roles yet — create one below —'),
          roles.map((r) => React.createElement('option', { key: r.id, value: r.id }, `${r.name} [${r.runtime}]`)),
        ),
      ),
      React.createElement('div', { className: 'ag-toolbar', style: { marginBottom: 0 } },
        React.createElement(Button, { variant: 'ghost', size: 'sm', icon: React.createElement(primitives.IconPlusOutline16, {}), onClick: () => setCreating(true) }, 'New Role'),
        React.createElement('span', { className: 'ag-note' }, 'Create a role here before adding its first member.'),
      ),
      React.createElement('label', null, 'Display name (optional)',
        React.createElement(Input, { value: name, onChange: (e) => setName(e.target.value), placeholder: 'planner-1' }),
      ),
      creating && React.createElement(CreateRoleWizard, { onClose: () => setCreating(false), onCreated: created }),
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


// ── V0.4.1: Create Role wizard ──────────────────────────────────────────────

/** Per-provider on-demand models + credential status (session-cached). */
function useProviderData(providerId) {
  const [models, setModels] = React.useState(null)
  const [credential, setCredential] = React.useState(null)
  React.useEffect(() => {
    if (providerId === undefined) { setModels(null); setCredential(null); return }
    let cancelled = false
    setModels(null)
    setCredential(null)
    discoveryModels(providerId).then((entry) => { if (!cancelled) setModels(entry) })
    discoveryCredential(providerId).then((entry) => { if (!cancelled) setCredential(entry) })
    return () => { cancelled = true }
  }, [providerId])
  return { models, credential }
}

/** Read-only "configure" entry per T1 findings: no deep-linkable URL exists
 * in the shell today (settings open state is component-local), so we render
 * the configurable-provider settingsNs/settingsPath/credentialRef info. */
function authConfigInfo(auth) {
  if (auth.settingsNs === undefined) {
    return React.createElement('div', { className: 'ag-col', style: { gap: 4 } },
      React.createElement('div', { className: 'ag-note' }, 'Open Settings → Models in the sidebar to configure credentials for this provider. Agent Groups never stores or displays API keys.'),
      auth.credentialRef !== undefined && React.createElement('div', { className: 'ag-monoblock' }, `credential ref: ${auth.credentialRef}`),
    )
  }
  return React.createElement('div', { className: 'ag-col', style: { gap: 4 } },
    React.createElement('div', { className: 'ag-note' }, 'Open Settings → Models in the sidebar and edit this provider namespace (read-only reference):'),
    React.createElement('div', { className: 'ag-monoblock' },
      `settings: ${auth.settingsNs}${(auth.settingsPath ?? []).length > 0 ? ` / ${auth.settingsPath.join(' / ')}` : ''}`),
    auth.credentialRef !== undefined && React.createElement('div', { className: 'ag-monoblock' }, `credential ref: ${auth.credentialRef}`),
    React.createElement('div', { className: 'ag-note' }, 'No API keys are entered or stored in Agent Groups — authentication belongs to the Harness settings.'),
  )
}

function CreateRoleWizard({ runtimes: runtimesProp, onClose, onCreated }) {
  const [runtimes, setRuntimes] = React.useState(() => (Array.isArray(runtimesProp) ? runtimesProp : []))
  const [providers, setProviders] = React.useState(null)
  const [models, setModels] = React.useState(null)
  const [credential, setCredential] = React.useState(null)
  const [step, setStep] = React.useState('name')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [draft, setDraft] = React.useState(() => ({
    id: `role-${Date.now().toString(36)}`,
    name: '',
    description: '',
    runtime: DSH_RUNTIME_ID,
    profile: 'group-member',
    provider: undefined,
    model: undefined,
    reasoningEffort: undefined,
    systemPrompt: '',
    maxInstances: 2,
  }))

  React.useEffect(() => {
    if (!Array.isArray(runtimesProp)) {
      api('/groups/api/runtimes').then(setRuntimes).catch(() => setRuntimes([]))
    }
    discoveryProviders().then(setProviders)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runtime = runtimes.find((r) => r.id === draft.runtime)
  const isDsh = draft.runtime === DSH_RUNTIME_ID

  // Per-provider on-demand model/credential loads (cached module-wide).
  React.useEffect(() => {
    if (!isDsh || draft.provider === undefined) { setModels(null); setCredential(null); return }
    let cancelled = false
    setModels(null)
    setCredential(null)
    discoveryModels(draft.provider).then((entry) => { if (!cancelled) setModels(entry) })
    discoveryCredential(draft.provider).then((entry) => { if (!cancelled) setCredential(entry) })
    return () => { cancelled = true }
  }, [isDsh, draft.provider])

  const modelInfo = models?.models?.find((m) => m.id === draft.model)
  const reasoning = modelInfo?.reasoning
  // Merge the providers-list entry facts (settingsNs/path/ref) with the live
  // per-provider status (config/endpoint fresh wins).
  const providerEntry = (providers?.providers ?? []).find((p) => providerIdOf(p) === draft.provider)
  const auth = credentialFacts({ ...(providerEntry ?? {}), ...(credential?.credential ?? {}) })
  const [showConfigure, setShowConfigure] = React.useState(false)

  const steps = wizardSteps(draft.runtime, isDsh ? reasoning : undefined)
  const stepIndex = Math.max(0, steps.findIndex((s) => s.id === step))
  const current = steps[stepIndex] !== undefined ? steps[stepIndex] : steps[steps.length - 1]
  const isLast = current.id === 'create'

  const pickRuntime = (value) => {
    setDraft((d) => ({
      ...d,
      runtime: value,
      provider: value === DSH_RUNTIME_ID ? d.provider : undefined,
      model: value === DSH_RUNTIME_ID ? d.model : undefined,
      reasoningEffort: value === DSH_RUNTIME_ID ? d.reasoningEffort : undefined,
    }))
  }
  const pickProvider = (value) => {
    setDraft((d) => ({ ...d, provider: value === '' ? undefined : value, model: undefined, reasoningEffort: undefined }))
  }
  const pickModel = (value) => {
    const model = value === '' ? undefined : value
    setDraft((d) => {
      const info = models?.models?.find((m) => m.id === model)
      const next = { ...d, model, reasoningEffort: undefined }
      if (info?.reasoning !== undefined && info.reasoning.efforts.length > 0) {
        // Requirement: the model's defaultEffort is preselected when present.
        next.reasoningEffort = info.reasoning.defaultEffort
      }
      return next
    })
  }

  const canNext = current.id !== 'name' || draft.name.trim() !== ''

  const create = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onCreated({
        id: draft.id,
        name: draft.name.trim(),
        description: draft.description.trim() === '' ? undefined : draft.description.trim(),
        runtime: draft.runtime,
        profile: draft.profile.trim() === '' ? undefined : draft.profile.trim(),
        provider: draft.provider,
        model: draft.model,
        reasoningEffort: draft.reasoningEffort,
        systemPrompt: draft.systemPrompt.trim() === '' ? undefined : draft.systemPrompt,
        maxInstances: Number.isFinite(Number(draft.maxInstances)) ? Math.max(1, Number(draft.maxInstances)) : undefined,
      })
    } catch (cause) {
      setError(errorOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const stepBody = () => {
    if (current.id === 'name') {
      return React.createElement('div', { className: 'ag-form' },
        React.createElement('label', null, 'Role name (required)',
          React.createElement(Input, { value: draft.name, onChange: (e) => setDraft((d) => ({ ...d, name: e.target.value })), placeholder: 'e.g. Researcher' }),
        ),
        React.createElement('label', null, 'Description',
          React.createElement(Input, { value: draft.description, onChange: (e) => setDraft((d) => ({ ...d, description: e.target.value })), placeholder: 'What this role is for (shown in the Team Configuration)' }),
        ),
      )
    }
    if (current.id === 'runtime') {
      return React.createElement('div', { className: 'ag-form' },
        React.createElement('label', null, 'Agent runtime',
          React.createElement('select', { className: 'ag-select', value: draft.runtime, onChange: (e) => pickRuntime(e.target.value) },
            runtimes.length === 0 ? React.createElement('option', { value: draft.runtime }, draft.runtime)
              : runtimes.map((r) => React.createElement('option', { key: r.id, value: r.id }, r.name)),
          ),
        ),
        runtime === undefined
          ? React.createElement('div', { className: 'ag-note' }, 'Runtime not registered — members of this role will fail to spawn until a provider is configured.')
          : runtime.id === DSH_RUNTIME_ID
            ? React.createElement('div', { className: 'ag-note' }, 'DeepSeek Harness — members are durable DSH subagents in this shell. Provider, authentication, model and reasoning are configured in the next steps from the live harness catalog.')
            : React.createElement('div', { className: 'ag-auth-box' },
                React.createElement('span', null,
                  runtime.name,
                  runtime.available === false && React.createElement('span', { className: 'ag-badge warn', style: { marginLeft: 6 } }, 'Not configured'),
                  runtime.available !== false && runtime.readiness?.initialized === true && React.createElement('span', { className: 'ag-badge ok', style: { marginLeft: 6 } }, 'ACP initialized'),
                  runtime.available !== false && runtime.readiness?.initialized === false && React.createElement('span', { className: 'ag-badge', style: { marginLeft: 6 } }, `Launchable · ${runtime.readiness.executor ?? 'executor'}`),
                  runtime.available !== false && runtime.readiness === undefined && React.createElement('span', { className: 'ag-badge ok', style: { marginLeft: 6 } }, 'Available'),
                ),
                runtime.description !== undefined && React.createElement('div', { className: 'ag-note' }, runtime.description),
                React.createElement('div', { className: 'ag-note' }, 'External coding-agent runtime — provider/model/reasoning are managed by that runtime, not by Agent Groups discovery.'),
              ),
      )
    }
    if (current.id === 'provider') {
      const unavailable = providers !== null && (providers.ok === false || (providers.providers.length === 0 && providers.error !== undefined))
      const degradedNote = providers !== null && providers.providers.length === 0 && (providers.note !== undefined || unavailable)
      return React.createElement('div', { className: 'ag-form' },
        React.createElement('label', null, 'Model provider (DSH harness route)',
          React.createElement('select', { className: 'ag-select', value: draft.provider ?? '', onChange: (e) => pickProvider(e.target.value) },
            React.createElement('option', { value: '' }, '— harness default —'),
            (providers?.providers ?? []).map((p) => React.createElement('option', { key: providerIdOf(p), value: providerIdOf(p) }, p.name ?? providerIdOf(p))),
          ),
        ),
        providers === null
          ? React.createElement('div', { className: 'ag-note' }, 'Loading provider catalog…')
          : degradedNote
            ? React.createElement('div', { className: 'ag-note' }, `Harness discovery unavailable — ${providers.error ?? providers.note}. The harness default route will apply; you can pin a provider later in Edit Role once discovery is up.`)
            : draft.provider === undefined
              ? React.createElement('div', { className: 'ag-note' }, 'No provider pinned — the harness’ default provider route applies to this role. Pick a provider to configure authentication/model/reasoning explicitly.')
              : React.createElement('div', { className: 'ag-note' }, `Route pinned to ${draft.provider}. This is the model-provider id the harness adapter owns (never a secret).`),
      )
    }
    if (current.id === 'auth') {
      if (draft.provider === undefined) {
        return React.createElement('div', { className: 'ag-auth-box' },
          React.createElement('span', null, 'Authentication: ', React.createElement('span', { className: 'ag-note' }, 'no provider pinned — the harness default provider applies; credentials live in Settings → Models')),
        )
      }
      if (credential === null) {
        return React.createElement('div', { className: 'ag-auth-box' }, 'Loading credential status…')
      }
      if (auth.configured === true) {
        return React.createElement('div', { className: 'ag-auth-box' },
          React.createElement('span', null,
            'Authentication: ', React.createElement('span', { className: 'ag-badge ok' }, 'Configured'),
            auth.source !== undefined && React.createElement('span', { className: 'ag-note', style: { marginLeft: 6 } }, `· ${auth.source}`),
          ),
          auth.writable === false && React.createElement('div', { className: 'ag-note' }, 'Credential is read-only (managed outside this shell).'),
          React.createElement('div', { className: 'ag-note' }, 'This provider is ready for members. No secret is stored or shown here.'),
        )
      }
      if (auth.configured === false) {
        return React.createElement('div', { className: 'ag-auth-box' },
          React.createElement('span', null,
            'Authentication: ', React.createElement('span', { className: 'ag-badge warn' }, 'Not configured'),
          ),
          React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => setShowConfigure((v) => !v) }, showConfigure ? 'Hide configuration info' : 'Configure'),
          showConfigure && authConfigInfo(auth),
          React.createElement('div', { className: 'ag-note' }, 'Configure the credential in the Harness settings first, or members of this role may fail at request time.'),
        )
      }
      return React.createElement('div', { className: 'ag-auth-box' },
        React.createElement('span', null, 'Authentication: ', React.createElement('span', { className: 'ag-note' }, credential !== null && credential.error !== undefined ? `status unknown (${credential.error})` : 'status unknown (no settings/credential service)')),
        React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => setShowConfigure((v) => !v) }, showConfigure ? 'Hide configuration info' : 'Configure'),
        showConfigure && authConfigInfo(auth),
      )
    }
    if (current.id === 'model') {
      const modelsUnavailable = models !== null && models.ok === false && !(models.embedded === true)
      return React.createElement('div', { className: 'ag-form' },
        React.createElement('label', null, 'Model (per provider)',
          React.createElement('select', { className: 'ag-select', value: draft.model ?? '', onChange: (e) => pickModel(e.target.value) },
            React.createElement('option', { value: '' }, '— default —'),
            (models?.models ?? []).map((m) => React.createElement('option', { key: m.id, value: m.id, title: m.description ?? '' }, m.name ?? m.id)),
          ),
        ),
        models === null
          ? React.createElement('div', { className: 'ag-note' }, 'Loading model catalog…')
          : modelsUnavailable
            ? React.createElement('div', { className: 'ag-note' }, `Model catalog unavailable for ${draft.provider} (${models.error}) — the provider default model applies.`)
            : draft.model === undefined
              ? React.createElement('div', { className: 'ag-note' }, 'No model pinned — the provider’s default model applies to this role.')
              : React.createElement('div', { className: 'ag-note' }, `Model pinned to ${draft.model}.`),
      )
    }
    if (current.id === 'reasoning') {
      return React.createElement('div', { className: 'ag-form' },
        React.createElement('label', null, 'Reasoning effort (per selected model)',
          React.createElement('select', { className: 'ag-select', value: draft.reasoningEffort ?? '', onChange: (e) => setDraft((d) => ({ ...d, reasoningEffort: e.target.value === '' ? undefined : e.target.value })) },
            React.createElement('option', { value: '' }, '— default —'),
            (reasoning?.efforts ?? []).map((effort) => React.createElement('option', { key: effort.id, value: effort.id, title: effort.description ?? '' }, effort.name ?? effort.id)),
          ),
        ),
        reasoning?.defaultEffort !== undefined && React.createElement('div', { className: 'ag-note' }, `This model’s default effort is “${reasoning.defaultEffort}” (preselected). “— default —” leaves the provider’s configured default.`),
        React.createElement('div', { className: 'ag-note' }, 'Effort ids are adapter-owned and validated against the live catalog when saving.'),
      )
    }
    if (current.id === 'instructions') {
      return React.createElement('div', { className: 'ag-form' },
        React.createElement('label', null, 'Role instructions (system prompt)',
          React.createElement('textarea', { className: 'ag-input', rows: 5, value: draft.systemPrompt, onChange: (e) => setDraft((d) => ({ ...d, systemPrompt: e.target.value })), placeholder: 'Layered below the member protocol. e.g. “You research deeply and document sources.”', style: { padding: 8, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit' } }),
        ),
      )
    }
    // create
    return React.createElement('div', { className: 'ag-col', style: { gap: 10 } },
      React.createElement('div', { className: 'ag-wiz-summary' },
        React.createElement('span', { className: 'ag-note' }, 'Name'), React.createElement('span', { className: 'ag-monoblock' }, draft.name.trim() === '' ? '—' : draft.name.trim()),
        React.createElement('span', { className: 'ag-note' }, 'Role id'), React.createElement('span', { className: 'ag-monoblock' }, draft.id),
        React.createElement('span', { className: 'ag-note' }, 'Runtime'), React.createElement('span', null, runtime !== undefined ? runtime.name : draft.runtime),
        React.createElement('span', { className: 'ag-note' }, 'Provider'), React.createElement('span', { className: 'ag-monoblock' }, isDsh ? (draft.provider ?? 'harness default') : '—'),
        React.createElement('span', { className: 'ag-note' }, 'Model'), React.createElement('span', { className: 'ag-monoblock' }, isDsh ? (draft.model ?? 'provider default') : '—'),
        React.createElement('span', { className: 'ag-note' }, 'Reasoning'), React.createElement('span', { className: 'ag-monoblock' }, isDsh ? (draft.reasoningEffort ?? 'provider default') : '—'),
        React.createElement('span', { className: 'ag-note' }, 'Role profile'), React.createElement('span', { className: 'ag-monoblock' }, draft.profile.trim() === '' ? 'none' : draft.profile.trim()),
        React.createElement('span', { className: 'ag-note' }, 'System prompt'), React.createElement('span', { className: 'ag-note' }, draft.systemPrompt.trim() === '' ? '—' : `${draft.systemPrompt.trim().length} chars`),
      ),
      React.createElement('div', { className: 'ag-form', style: { gap: 6 } },
        React.createElement('div', { className: 'ag-col', style: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' } },
          React.createElement('label', null, 'Role profile',
            React.createElement('input', { className: 'ag-input', value: draft.profile, onChange: (e) => setDraft((d) => ({ ...d, profile: e.target.value })), style: { width: 150, padding: 4, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' } }),
          ),
          React.createElement('label', null, 'Max instances',
            React.createElement('input', { className: 'ag-input', type: 'number', min: 1, max: 12, value: String(draft.maxInstances), onChange: (e) => setDraft((d) => ({ ...d, maxInstances: e.target.value === '' ? 1 : Number(e.target.value) })), style: { width: 80, padding: 4, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' } }),
          ),
        ),
      ),
      React.createElement('div', { className: 'ag-note' }, 'Creating appends this role to the team configuration and saves via the same team-config API used by the Roles tab.'),
    )
  }

  return React.createElement(Modal, {
    open: true,
    onClose,
    title: 'Create Role',
    footer: React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: onClose }, 'Cancel'),
      stepIndex > 0 && React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => setStep(steps[Math.max(0, stepIndex - 1)].id) }, 'Back'),
      isLast
        ? React.createElement(Button, { variant: 'primary', size: 'sm', disabled: busy || draft.name.trim() === '', onClick: () => void create() }, busy ? 'Creating…' : 'Create Role')
        : React.createElement(Button, { variant: 'primary', size: 'sm', disabled: !canNext, onClick: () => setStep(steps[Math.min(steps.length - 1, stepIndex + 1)].id) }, 'Next'),
    ),
  },
    React.createElement('div', { className: 'ag-col', style: { gap: 8 } },
      React.createElement('div', { className: 'ag-wiz-steps' },
        steps.map((s, index) =>
          React.createElement('span', { key: s.id, className: `ag-wiz-step${s.id === current.id ? ' on' : ''}${index < stepIndex ? ' done' : ''}` }, `${index + 1}. ${s.label}`)),
      ),
      error !== null && React.createElement(ErrorLine, { message: error }),
      stepBody(),
    ),
  )
}

// ── Team Configuration (V0.4): roles + runtimes ────────────────────────────

function RolesTab({ snap }) {
  const groupId = snap.group.groupId
  const [config, setConfig] = React.useState(null)
  const [runtimes, setRuntimes] = React.useState([])
  const [discovery, setDiscovery] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [saved, setSaved] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [initialConfig, setInitialConfig] = React.useState(null)
  const [creating, setCreating] = React.useState(false)

  const load = React.useCallback(() => {
    setError(null)
    api(`/groups/api/groups/${encodeURIComponent(groupId)}/team-config`).then((data) => { setConfig(data); setInitialConfig(data) }).catch((err) => setError(errorOf(err)))
    api('/groups/api/runtimes').then(setRuntimes).catch(() => undefined)
    discoveryProviders().then(setDiscovery)
  }, [groupId])

  React.useEffect(() => { load() }, [load])

  /** V0.4.1: save accepts an explicit config (the wizard merges a new role
   * into the local state and saves through this same PUT path). */
  const save = async (next) => {
    const payload = next ?? config
    if (busy || payload === null) return
    setBusy(true)
    setError(null)
    try {
      const updated = await api(`/groups/api/groups/${encodeURIComponent(groupId)}/team-config`, {
        method: 'PUT', body: JSON.stringify(payload),
      })
      setConfig(updated.teamConfig)
      setInitialConfig(updated.teamConfig)
      setSaved('Team configuration saved.')
      window.setTimeout(() => setSaved(null), 2500)
    } catch (cause) {
      setError(errorOf(cause))
      throw cause
    } finally {
      setBusy(false)
    }
  }

  /** Wizard completion: insert the new role into team config state and save
   * via the same PUT path as the Save button. */
  const createRole = async (role) => {
    if (config === null) return
    const merged = { ...config, memberRoles: [...config.memberRoles, role] }
    setConfig(merged)
    await save(merged)
    setCreating(false)
  }

  const patchRole = (index, patch) => {
    setConfig((current) => {
      if (current === null) return current
      const roles = current.memberRoles.map((role, i) => (i === index ? { ...role, ...patch } : role))
      return { ...current, memberRoles: roles }
    })
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
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => setCreating(true), icon: React.createElement(primitives.IconPlusOutline16, {}) }, 'Add Role'),
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: exportConfig }, 'Export'),
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: importConfig }, 'Import'),
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: resetConfig, disabled: initialConfig === null }, 'Reset'),
      saved !== null && React.createElement('span', { className: 'ag-note' }, saved),
    ),
    React.createElement('div', { className: 'ag-note', style: { marginBottom: 8 } },
      'Configured Roles define HOW each kind of member spawns (runtime / provider / model / reasoning effort / profile / max instances). Running instances appear on the Team tab.'),
    React.createElement('div', { className: 'ag-col' },
      React.createElement(RoleCard, {
        role: config.leaderRole, leader: true,
        runtimes, discovery, onPatch: () => undefined, onRemove: () => undefined,
      }),
      config.memberRoles.map((role, index) => React.createElement(RoleCard, {
        key: role.id, role, runtimes, discovery,
        onPatch: (patch) => patchRole(index, patch),
        onRemove: () => removeRole(index),
        onDuplicate: (role) => duplicateRole(role),
      })),
    ),
    creating && React.createElement(CreateRoleWizard, {
      runtimes, onClose: () => setCreating(false), onCreated: createRole,
    }),
  )
}

function RoleCard({ role, leader, runtimes, onPatch, onRemove, onDuplicate, discovery }) {
  const runtime = runtimes.find((r) => r.id === role.runtime)
  const unavailable = runtime !== undefined && !runtime.available
  const legacyModels = runtime?.capabilities?.models === true ? (runtime.models ?? []) : []
  const legacyLevels = (runtime?.reasoningLevels?.length ?? 0) > 0 ? runtime.reasoningLevels : [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }]
  const isDsh = role.runtime === DSH_RUNTIME_ID
  const discoveryOk = discovery !== null && discovery !== undefined && discovery.ok === true && isDsh
  const providerOptions = discoveryOk ? (discovery.providers ?? []) : []
  const selectedProvider = role.provider
  const { models, credential } = useProviderData(discoveryOk ? selectedProvider : undefined)
  const [showConfigure, setShowConfigure] = React.useState(false)

  // V0.4.1: live model list per provider (fall back to the legacy runtime
  // models — the DSH runtime mirrors the harness default route — when no
  // provider is pinned or discovery is unavailable).
  const showDiscoveryModels = discoveryOk && selectedProvider !== undefined
  const modelOptions = showDiscoveryModels ? (models?.models ?? []) : legacyModels
  const modelInfo = modelOptions.find((m) => m.id === role.model)
  const reasoning = modelInfo?.reasoning
  // Merge the providers-list entry facts (settingsNs/path/ref) with the live
  // per-provider status (config/endpoint fresh wins).
  const providerEntry = (discovery?.providers ?? []).find((p) => providerIdOf(p) === selectedProvider)
  const auth = credentialFacts({ ...(providerEntry ?? {}), ...(credential?.credential ?? {}) })

  // Reasoning select gated by the SELECTED MODEL's capability: real effort ids
  // from the live catalog when known; hidden/disabled when the model exposes
  // no efforts; legacy low/medium/high fallback when the route is unresolved
  // or discovery is down (per requirement: keep legacy fields working).
  let reasoningControl
  if (!isDsh || !discoveryOk || selectedProvider === undefined || role.model === undefined) {
    reasoningControl = React.createElement(React.Fragment, null,
      React.createElement('select', { className: 'ag-input', value: role.reasoningLevel ?? '', disabled: leader, onChange: (e) => onPatch({ reasoningLevel: e.target.value === '' ? undefined : e.target.value, reasoningEffort: undefined }), style: { padding: 4, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' } },
        React.createElement('option', { value: '' }, '— default —'),
        legacyLevels.map((level) => React.createElement('option', { key: level.id, value: level.id }, level.label)),
      ),
      discoveryOk && React.createElement('span', { className: 'ag-note', style: { marginTop: 2 } }, 'abstract level — pin a provider + model to pick real effort ids from the live catalog'),
    )
  } else if (reasoning !== undefined && reasoning.efforts.length > 0) {
    reasoningControl = React.createElement(React.Fragment, null,
      React.createElement('select', { className: 'ag-input', value: role.reasoningEffort ?? '', disabled: leader, onChange: (e) => onPatch({ reasoningEffort: e.target.value === '' ? undefined : e.target.value, reasoningLevel: undefined }), style: { padding: 4, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' } },
        React.createElement('option', { value: '' }, '— default —'),
        reasoning.efforts.map((effort) => React.createElement('option', { key: effort.id, value: effort.id, title: effort.description ?? '' }, effort.name ?? effort.id)),
      ),
      role.reasoningLevel !== undefined && React.createElement('span', { className: 'ag-note', style: { marginTop: 2 } }, `legacy level "${role.reasoningLevel}" ignored — the selected effort takes precedence`),
      role.reasoningEffort !== undefined && !reasoning.efforts.some((e) => e.id === role.reasoningEffort) && React.createElement('span', { className: 'ag-note', style: { marginTop: 2 } }, `stored effort "${role.reasoningEffort}" is not offered by this model — pick an option below (save is otherwise rejected)`),
    )
  } else {
    reasoningControl = React.createElement(React.Fragment, null,
      React.createElement('select', { className: 'ag-input', disabled: true, value: '', style: { padding: 4, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' } },
        React.createElement('option', { value: '' }, '— none —'),
      ),
      React.createElement('span', { className: 'ag-note', style: { marginTop: 2 } },
        role.reasoningEffort !== undefined ? `effort "${role.reasoningEffort}" is not supported by this model — clear it or switch model` : 'this model exposes no reasoning efforts'),
    )
  }

  const authNode = () => {
    if (!discoveryOk) {
      return React.createElement('div', { className: 'ag-auth-box' },
        React.createElement('span', null, 'Authentication: ', React.createElement('span', { className: 'ag-note' }, 'harness discovery unavailable — credentials live in Settings → Models')),
      )
    }
    if (selectedProvider === undefined) {
      return React.createElement('div', { className: 'ag-auth-box' },
        React.createElement('span', null, 'Authentication: ', React.createElement('span', { className: 'ag-note' }, 'no provider pinned — harness default provider applies; credentials live in Settings → Models')),
      )
    }
    if (credential === null) {
      return React.createElement('div', { className: 'ag-auth-box' }, 'Authentication: loading…')
    }
    if (auth.configured === true) {
      return React.createElement('div', { className: 'ag-auth-box' },
        React.createElement('span', null,
          'Authentication: ', React.createElement('span', { className: 'ag-badge ok' }, 'Configured'),
          auth.source !== undefined && React.createElement('span', { className: 'ag-note', style: { marginLeft: 6 } }, `· ${auth.source}`),
        ),
        auth.writable === false && React.createElement('div', { className: 'ag-note' }, 'Credential is read-only (managed outside this shell).'),
      )
    }
    if (auth.configured === false) {
      return React.createElement('div', { className: 'ag-auth-box' },
        React.createElement('span', null, 'Authentication: ', React.createElement('span', { className: 'ag-badge warn' }, 'Not configured')),
        React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => setShowConfigure((v) => !v) }, showConfigure ? 'Hide configuration info' : 'Configure'),
        showConfigure && authConfigInfo(auth),
      )
    }
    return React.createElement('div', { className: 'ag-auth-box' },
      React.createElement('span', null, 'Authentication: ', React.createElement('span', { className: 'ag-note' }, credential !== null && credential.error !== undefined ? `status unknown (${credential.error})` : 'status unknown (no settings/credential service)')),
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => setShowConfigure((v) => !v) }, showConfigure ? 'Hide configuration info' : 'Configure'),
      showConfigure && authConfigInfo(auth),
    )
  }

  const inputStyle = { padding: 4, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' }
  return React.createElement('div', { style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: 10, marginBottom: 10, background: 'var(--dsw-alias-bg-layer-1)' } },
    React.createElement('div', { className: 'ag-toolbar', style: { marginBottom: 6 } },
      React.createElement('strong', null, role.name),
      React.createElement('span', { className: 'ag-monoblock' }, role.id),
      leader && React.createElement('span', { className: 'ag-badge' }, 'leader'),
      runtime === undefined && React.createElement('span', { className: 'ag-badge err' }, `runtime "${role.runtime}" not registered`),
      unavailable && React.createElement('span', { className: 'ag-badge warn' }, 'Not configured'),
      runtime !== undefined && runtime.available && runtime.readiness?.initialized === true && React.createElement('span', { className: 'ag-badge ok' }, 'ACP initialized'),
      runtime !== undefined && runtime.available && runtime.readiness?.initialized === false && React.createElement('span', { className: 'ag-badge' }, `Launchable · ${runtime.readiness.executor ?? 'executor'}`),
      runtime !== undefined && runtime.available && runtime.readiness === undefined && React.createElement('span', { className: 'ag-badge ok' }, 'Available'),
      selectedProvider !== undefined && React.createElement('span', { className: 'ag-badge ag-monoblock', title: 'Pinned model provider' }, selectedProvider),
      !leader && React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => onDuplicate(role), style: { marginLeft: 'auto' } }, 'Duplicate'),
      !leader && React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: onRemove }, 'Remove'),
    ),
    React.createElement('div', { className: 'ag-form', style: { gap: 6 } },
      leader && React.createElement('label', null, 'Description', React.createElement('input', { className: 'ag-input', value: role.description ?? '', disabled: true, style: inputStyle })),
      React.createElement('div', { className: 'ag-col', style: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' } },
        React.createElement('label', null, 'Runtime',
          React.createElement('select', { className: 'ag-input', value: role.runtime, disabled: leader, onChange: (e) => onPatch({ runtime: e.target.value }), style: inputStyle },
            runtimes.length === 0 ? React.createElement('option', { value: role.runtime }, role.runtime)
              : runtimes.map((r) => React.createElement('option', { key: r.id, value: r.id }, r.name)),
          )),
        isDsh && React.createElement('label', null, 'Provider',
          React.createElement('select', { className: 'ag-input', value: selectedProvider ?? '', disabled: leader, onChange: (e) => onPatch({ provider: e.target.value === '' ? undefined : e.target.value, model: undefined, reasoningEffort: undefined }), style: inputStyle },
            React.createElement('option', { value: '' }, '— default —'),
            discoveryOk
              ? providerOptions.map((p) => React.createElement('option', { key: providerIdOf(p), value: providerIdOf(p) }, p.name ?? providerIdOf(p)))
              : selectedProvider !== undefined && React.createElement('option', { value: selectedProvider }, selectedProvider),
          ),
          !discoveryOk && React.createElement('span', { className: 'ag-note', style: { marginTop: 2 } }, 'provider catalog unavailable'),
          discoveryOk && providerOptions.length === 0 && React.createElement('span', { className: 'ag-note', style: { marginTop: 2 } }, discovery.note ?? 'no providers listed — harness default applies'),
        ),
        React.createElement('label', null, 'Model',
          React.createElement('select', { className: 'ag-input', value: role.model ?? '', disabled: leader || (showDiscoveryModels && models === null), onChange: (e) => onPatch({ model: e.target.value === '' ? undefined : e.target.value, reasoningEffort: undefined }), style: inputStyle },
            React.createElement('option', { value: '' }, '— default —'),
            modelOptions.map((m) => React.createElement('option', { key: m.id, value: m.id, title: m.description ?? '' }, m.name ?? m.id)),
          ),
          showDiscoveryModels && models === null && React.createElement('span', { className: 'ag-note', style: { marginTop: 2 } }, 'loading catalog…'),
          showDiscoveryModels && models !== null && models.ok === false && !(models.embedded === true) && React.createElement('span', { className: 'ag-note', style: { marginTop: 2 } }, 'catalog unavailable — provider default model applies'),
        ),
        React.createElement('label', null, 'Reasoning', reasoningControl),
        React.createElement('label', null, 'Profile',
          React.createElement('input', { className: 'ag-input', value: role.profile ?? '', disabled: leader, onChange: (e) => onPatch({ profile: e.target.value }), style: inputStyle }),
        ),
        React.createElement('label', null, 'Max instances',
          React.createElement('input', { className: 'ag-input', type: 'number', min: 1, value: role.maxInstances ?? '', disabled: leader, onChange: (e) => onPatch({ maxInstances: e.target.value === '' ? undefined : Number(e.target.value) }), style: { ...inputStyle, width: 80 } }),
        ),
      ),
      isDsh && authNode(),
      !leader && React.createElement('label', null, 'Role instructions (system prompt)',
        React.createElement('textarea', { className: 'ag-input', rows: 2, value: role.systemPrompt ?? '', onChange: (e) => onPatch({ systemPrompt: e.target.value }), style: { ...inputStyle, fontFamily: 'inherit' } }),
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
