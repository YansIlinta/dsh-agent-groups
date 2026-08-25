// Create Flow native workspace extension. This file is concatenated after the
// Agent Groups native client source by scripts/build-native-client.mjs and
// wraps the existing module.exports.apply without changing the large base UI.

let cfOpen = false
let cfGroupId = null
const cfListeners = new Set()

function cfSetUi(patch) {
  if (patch.open !== undefined) cfOpen = patch.open
  if (patch.groupId !== undefined) cfGroupId = patch.groupId
  for (const listener of cfListeners) listener()
}

function cfUseUi() {
  const [, force] = React.useState(0)
  React.useEffect(() => {
    const listener = () => force((n) => n + 1)
    cfListeners.add(listener)
    return () => cfListeners.delete(listener)
  }, [])
  return { open: cfOpen, groupId: cfGroupId }
}

async function cfApi(path, init) {
  const response = await fetch(path, {
    headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
    ...init,
  })
  if (!response.ok) {
    let message = `${path}: HTTP ${response.status}`
    try {
      const body = await response.json()
      if (body?.message) message = body.message
      else if (body?.error) message = String(body.error)
    } catch { /* keep default */ }
    throw new Error(message)
  }
  return response.json()
}

let cfCssInjected = false
function cfInjectCss() {
  if (cfCssInjected || typeof document === 'undefined') return
  cfCssInjected = true
  const style = document.createElement('style')
  style.textContent = `
.cf-root{position:absolute;inset:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45;min-width:0}
.cf-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.cf-title{font-size:14px;font-weight:600;flex:1;display:flex;align-items:center;gap:8px}
.cf-body{flex:1;overflow:auto;padding:14px}
.cf-col{display:flex;flex-direction:column;gap:10px;min-width:0}
.cf-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cf-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px}
.cf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.cf-stage{min-height:120px}
.cf-stage-title{font-weight:600;margin-bottom:7px;display:flex;justify-content:space-between;gap:8px}
.cf-note{color:var(--dsw-alias-label-secondary);font-size:12px}
.cf-badge{display:inline-flex;align-items:center;padding:1px 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.cf-badge.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.cf-badge.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.cf-badge.err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.cf-input{width:100%;box-sizing:border-box;padding:7px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit}
.cf-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}
.cf-form .wide{grid-column:1/-1}
.cf-table{width:100%;border-collapse:collapse}
.cf-table th{text-align:left;font-size:11px;text-transform:uppercase;color:var(--dsw-alias-label-secondary);padding:5px 7px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.cf-table td{padding:7px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}
.cf-artifact{padding:6px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.cf-artifact:first-of-type{border-top:0}
.cf-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary)}
.cf-error{padding:8px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;color:var(--dsw-alias-state-error-primary)}
.cf-groups{display:flex;flex-direction:column;gap:6px}
.cf-group{padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;cursor:pointer;background:var(--dsw-alias-bg-layer-1)}
.cf-group:hover{background:var(--dsw-alias-bg-layer-2)}
`
  document.head.appendChild(style)
}

const CF_STAGES = [
  ['topic', 'Topic'],
  ['research', 'Research'],
  ['materials', 'Materials'],
  ['script', 'Script'],
  ['voice', 'Voice'],
  ['captions', 'Captions'],
  ['render', 'Render'],
]

function CfTrigger({ wide }) {
  cfInjectCss()
  return React.createElement(Button, {
    variant: 'toolbar',
    size: 'sm',
    onClick: () => cfSetUi({ open: true }),
    title: 'Create Flow — video production workspace',
    style: wide ? { width: '100%', justifyContent: 'flex-start' } : {},
    'aria-label': 'Create Flow',
  }, wide ? 'Create Flow' : '🎬')
}

function CfPage() {
  cfInjectCss()
  const ui = cfUseUi()
  if (!ui.open) return null
  return React.createElement(CfOverlay, { key: ui.groupId ?? 'home' })
}

function CfOverlay() {
  const ui = cfUseUi()
  const close = () => cfSetUi({ open: false, groupId: null })
  React.useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return React.createElement('div', { className: 'cf-root' },
    React.createElement('div', { className: 'cf-head' },
      React.createElement('div', { className: 'cf-title' }, '🎬 Create Flow'),
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: close }, 'Close'),
    ),
    React.createElement('div', { className: 'cf-body' },
      ui.groupId === null
        ? React.createElement(CfGroupPicker)
        : React.createElement(CfWorkspace, { groupId: ui.groupId, onBack: () => cfSetUi({ groupId: null }) }),
    ),
  )
}

function CfGroupPicker() {
  const [groups, setGroups] = React.useState(null)
  const [error, setError] = React.useState(null)
  const load = () => {
    setError(null)
    cfApi('/groups/api/groups').then(setGroups).catch((err) => setError(err.message))
  }
  React.useEffect(load, [])
  return React.createElement('div', { className: 'cf-col' },
    React.createElement('div', { className: 'cf-row' },
      React.createElement('strong', null, 'Production groups'),
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: load }, 'Refresh'),
      React.createElement('span', { className: 'cf-note' }, 'Create a “Create Flow” group from Agent Groups, then open it here.'),
    ),
    error && React.createElement('div', { className: 'cf-error' }, error),
    groups === null
      ? React.createElement('div', { className: 'cf-note' }, 'Loading…')
      : React.createElement('div', { className: 'cf-groups' },
          groups.map((group) => React.createElement('div', {
            key: group.groupId,
            className: 'cf-group',
            onClick: () => cfSetUi({ groupId: group.groupId }),
          },
            React.createElement('strong', null, group.name),
            React.createElement('div', { className: 'cf-note' }, group.missionObjective),
            React.createElement('div', { className: 'cf-row', style: { marginTop: 4 } },
              React.createElement('span', { className: 'cf-badge' }, group.status),
              React.createElement('span', { className: 'cf-note' }, `${group.memberCount} members · ${group.taskCount} tasks`),
            ),
          )),
        ),
  )
}

function CfWorkspace({ groupId, onBack }) {
  const [snap, setSnap] = React.useState(null)
  const [flow, setFlow] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [busy, setBusy] = React.useState(null)

  const load = React.useCallback(() => {
    setError(null)
    Promise.all([
      cfApi(`/groups/api/group/${encodeURIComponent(groupId)}`),
      cfApi(`/groups/api/create-flow/${encodeURIComponent(groupId)}`),
    ]).then(([nextSnap, nextFlow]) => {
      setSnap(nextSnap)
      setFlow(nextFlow)
    }).catch((err) => setError(err.message))
  }, [groupId])

  React.useEffect(load, [load])

  const run = async (kind, payload) => {
    if (busy !== null) return
    setBusy(kind)
    setError(null)
    try {
      await cfApi(`/groups/api/create-flow/${encodeURIComponent(groupId)}/${kind}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  if (snap === null || flow === null) {
    return React.createElement('div', { className: 'cf-col' },
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: onBack }, '← Groups'),
      error ? React.createElement('div', { className: 'cf-error' }, error) : React.createElement('div', { className: 'cf-note' }, 'Loading workspace…'),
    )
  }

  const artifacts = flow.state?.artifacts ?? []
  const jobs = flow.state?.jobs ?? []
  const caps = flow.capabilities ?? {}

  return React.createElement('div', { className: 'cf-col' },
    React.createElement('div', { className: 'cf-row' },
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: onBack }, '← Groups'),
      React.createElement('strong', null, snap.group.name),
      snap.group.templateId !== 'content-team' && React.createElement('span', { className: 'cf-badge warn' }, 'not Create Flow template'),
      React.createElement('span', { className: 'cf-note' }, snap.group.mission.objective),
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: load, style: { marginLeft: 'auto' } }, 'Refresh'),
    ),
    error && React.createElement('div', { className: 'cf-error' }, error),
    React.createElement('div', { className: 'cf-card' },
      React.createElement('div', { className: 'cf-row' },
        React.createElement('strong', null, 'Local media runtime'),
        cfCapability('TTS', caps.tts),
        cfCapability('ASR', caps.asr),
        cfCapability('FFmpeg', caps.render),
        React.createElement('span', { className: 'cf-mono' }, flow.workspaceRoot),
      ),
    ),
    React.createElement('div', { className: 'cf-grid' },
      CF_STAGES.map(([stage, label]) => React.createElement(CfStageCard, {
        key: stage,
        stage,
        label,
        artifacts: artifacts.filter((artifact) => artifact.stage === stage),
      })),
    ),
    React.createElement(CfTtsCard, { disabled: busy !== null, busy: busy === 'tts', onRun: (payload) => run('tts', payload) }),
    React.createElement(CfAsrCard, { disabled: busy !== null, busy: busy === 'asr', onRun: (payload) => run('asr', payload) }),
    React.createElement(CfRenderCard, { disabled: busy !== null, busy: busy === 'render', onRun: (payload) => run('render', payload) }),
    React.createElement(CfJobs, { jobs }),
  )
}

function cfCapability(label, capability) {
  const configured = capability?.configured === true
  return React.createElement('span', {
    className: `cf-badge ${configured ? 'ok' : 'warn'}`,
    title: capability?.command ?? '',
  }, `${label}: ${configured ? 'ready' : 'not configured'}`)
}

function CfStageCard({ stage, label, artifacts }) {
  return React.createElement('div', { className: 'cf-card cf-stage' },
    React.createElement('div', { className: 'cf-stage-title' },
      React.createElement('span', null, label),
      React.createElement('span', { className: 'cf-badge' }, String(artifacts.length)),
    ),
    artifacts.length === 0
      ? React.createElement('div', { className: 'cf-note' }, 'No artifact yet')
      : artifacts.slice().reverse().map((artifact) => React.createElement('div', { key: artifact.artifactId, className: 'cf-artifact' },
          React.createElement('div', null, artifact.title),
          React.createElement('div', { className: 'cf-row' },
            React.createElement('span', { className: 'cf-badge' }, artifact.kind),
            artifact.path && React.createElement('span', { className: 'cf-mono' }, artifact.path),
            artifact.sourceUrl && React.createElement('span', { className: 'cf-note' }, artifact.sourceUrl),
          ),
        )),
  )
}

function CfTtsCard({ disabled, busy, onRun }) {
  const [text, setText] = React.useState('')
  const [outputPath, setOutputPath] = React.useState('')
  const [voice, setVoice] = React.useState('')
  const [language, setLanguage] = React.useState('')
  return React.createElement('div', { className: 'cf-card cf-col' },
    React.createElement('strong', null, 'TTS · Script → Voice'),
    React.createElement('textarea', { className: 'cf-input wide', rows: 5, placeholder: 'Narration/script text', value: text, onChange: (e) => setText(e.target.value) }),
    React.createElement('div', { className: 'cf-form' },
      React.createElement('input', { className: 'cf-input', placeholder: 'output path (optional)', value: outputPath, onChange: (e) => setOutputPath(e.target.value) }),
      React.createElement('input', { className: 'cf-input', placeholder: 'voice (optional)', value: voice, onChange: (e) => setVoice(e.target.value) }),
      React.createElement('input', { className: 'cf-input', placeholder: 'language (optional)', value: language, onChange: (e) => setLanguage(e.target.value) }),
    ),
    React.createElement('div', { className: 'cf-row' },
      React.createElement(Button, { variant: 'primary', size: 'sm', disabled: disabled || text.trim() === '', onClick: () => onRun({ text, outputPath: outputPath || undefined, voice: voice || undefined, language: language || undefined }) }, busy ? 'Generating…' : 'Generate voice'),
      React.createElement('span', { className: 'cf-note' }, 'Runs the configured local TTS executable.'),
    ),
  )
}

function CfAsrCard({ disabled, busy, onRun }) {
  const [inputPath, setInputPath] = React.useState('')
  const [outputPath, setOutputPath] = React.useState('')
  const [language, setLanguage] = React.useState('')
  return React.createElement('div', { className: 'cf-card cf-col' },
    React.createElement('strong', null, 'ASR · Audio/Video → Captions'),
    React.createElement('div', { className: 'cf-form' },
      React.createElement('input', { className: 'cf-input', placeholder: 'input path', value: inputPath, onChange: (e) => setInputPath(e.target.value) }),
      React.createElement('input', { className: 'cf-input', placeholder: 'SRT output path (optional)', value: outputPath, onChange: (e) => setOutputPath(e.target.value) }),
      React.createElement('input', { className: 'cf-input', placeholder: 'language (optional)', value: language, onChange: (e) => setLanguage(e.target.value) }),
    ),
    React.createElement(Button, { variant: 'primary', size: 'sm', disabled: disabled || inputPath.trim() === '', onClick: () => onRun({ inputPath, outputPath: outputPath || undefined, language: language || undefined }) }, busy ? 'Transcribing…' : 'Generate captions'),
  )
}

function CfRenderCard({ disabled, busy, onRun }) {
  const [visualPath, setVisualPath] = React.useState('')
  const [audioPath, setAudioPath] = React.useState('')
  const [subtitlePath, setSubtitlePath] = React.useState('')
  const [outputPath, setOutputPath] = React.useState('')
  return React.createElement('div', { className: 'cf-card cf-col' },
    React.createElement('strong', null, 'Render · Material + Voice + Captions → MP4'),
    React.createElement('div', { className: 'cf-form' },
      React.createElement('input', { className: 'cf-input', placeholder: 'visual image/video path', value: visualPath, onChange: (e) => setVisualPath(e.target.value) }),
      React.createElement('input', { className: 'cf-input', placeholder: 'audio path', value: audioPath, onChange: (e) => setAudioPath(e.target.value) }),
      React.createElement('input', { className: 'cf-input', placeholder: 'captions path (optional)', value: subtitlePath, onChange: (e) => setSubtitlePath(e.target.value) }),
      React.createElement('input', { className: 'cf-input', placeholder: 'MP4 output path (optional)', value: outputPath, onChange: (e) => setOutputPath(e.target.value) }),
    ),
    React.createElement(Button, { variant: 'primary', size: 'sm', disabled: disabled || visualPath.trim() === '' || audioPath.trim() === '', onClick: () => onRun({ visualPath, audioPath, subtitlePath: subtitlePath || undefined, outputPath: outputPath || undefined }) }, busy ? 'Rendering…' : 'Render video'),
  )
}

function CfJobs({ jobs }) {
  return React.createElement('div', { className: 'cf-card cf-col' },
    React.createElement('strong', null, 'Media jobs'),
    jobs.length === 0
      ? React.createElement('div', { className: 'cf-note' }, 'No media jobs yet')
      : React.createElement('table', { className: 'cf-table' },
          React.createElement('thead', null, React.createElement('tr', null,
            React.createElement('th', null, 'Kind'),
            React.createElement('th', null, 'Status'),
            React.createElement('th', null, 'Output'),
            React.createElement('th', null, 'Command'),
            React.createElement('th', null, 'Updated'),
          )),
          React.createElement('tbody', null,
            jobs.slice().reverse().map((job) => React.createElement('tr', { key: job.jobId },
              React.createElement('td', null, job.kind),
              React.createElement('td', null, React.createElement('span', { className: `cf-badge ${job.status === 'completed' ? 'ok' : job.status === 'failed' ? 'err' : 'warn'}` }, job.status)),
              React.createElement('td', { className: 'cf-mono' }, job.outputPath ?? '—'),
              React.createElement('td', { className: 'cf-mono' }, job.command ?? '—'),
              React.createElement('td', { className: 'cf-note' }, new Date(job.updatedAt).toLocaleTimeString()),
            )),
          ),
        ),
  )
}

const cfBaseApply = module.exports.apply
function cfExtendedApply(ctx) {
  cfBaseApply(ctx)
  const slots = ctx.get('slots')
  if (slots === undefined) return
  slots.inject('sidebar.footer.action', () => slots.register(
    { name: 'sidebar.footer.action', id: 'create-flow', order: 11, label: () => 'Create Flow' },
    (props) => React.createElement(CfTrigger, props),
  ))
  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'create-flow-page', order: 1001, label: () => 'Create Flow page' },
    () => React.createElement(CfPage),
  ))
}
module.exports = { ...module.exports, apply: cfExtendedApply }
