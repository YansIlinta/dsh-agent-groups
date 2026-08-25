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
  const headers = {
    accept: 'application/json',
    ...(init?.body ? { 'content-type': 'application/json' } : {}),
    ...(init?.headers ?? {}),
  }
  const response = await fetch(path, { ...init, headers })
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
.ag-cf-root{position:absolute;inset:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45;min-width:0}
.ag-cf-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.ag-cf-title{font-size:14px;font-weight:600;flex:1;display:flex;align-items:center;gap:8px}
.ag-cf-body{flex:1;overflow:auto;padding:14px}
.ag-cf-col{display:flex;flex-direction:column;gap:10px;min-width:0}
.ag-cf-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ag-cf-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px}
.ag-cf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.ag-cf-stage{min-height:120px}
.ag-cf-stage-title{font-weight:600;margin-bottom:7px;display:flex;justify-content:space-between;gap:8px}
.ag-cf-note{color:var(--dsw-alias-label-secondary);font-size:12px}
.ag-cf-badge{display:inline-flex;align-items:center;padding:1px 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ag-cf-badge.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.ag-cf-badge.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.ag-cf-badge.err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.ag-cf-input{width:100%;box-sizing:border-box;padding:7px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit}
.ag-cf-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}
.ag-cf-wide{grid-column:1/-1}
.ag-cf-table{width:100%;border-collapse:collapse}
.ag-cf-table th{text-align:left;font-size:11px;text-transform:uppercase;color:var(--dsw-alias-label-secondary);padding:5px 7px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ag-cf-table td{padding:7px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}
.ag-cf-artifact{padding:6px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.ag-cf-artifact:first-of-type{border-top:0}
.ag-cf-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.ag-cf-error{padding:8px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;color:var(--dsw-alias-state-error-primary)}
.ag-cf-groups{display:flex;flex-direction:column;gap:6px}
.ag-cf-group{padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;cursor:pointer;background:var(--dsw-alias-bg-layer-1)}
.ag-cf-group:hover{background:var(--dsw-alias-bg-layer-2)}
.ag-cf-scene{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;padding:9px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.ag-cf-scene:first-of-type{border-top:0}
.ag-cf-scene-main{min-width:0}
.ag-cf-scene-actions{display:flex;align-items:flex-start;gap:6px}
.ag-cf-scene-paths{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.ag-cf-scene-paths>span{min-width:0}
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
  return React.createElement('div', { className: 'ag-cf-root' },
    React.createElement('div', { className: 'ag-cf-head' },
      React.createElement('div', { className: 'ag-cf-title' }, '🎬 Create Flow'),
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: close }, 'Close'),
    ),
    React.createElement('div', { className: 'ag-cf-body' },
      ui.groupId === null
        ? React.createElement(CfGroupPicker)
        : React.createElement(CfWorkspace, { groupId: ui.groupId, onBack: () => cfSetUi({ groupId: null }) }),
    ),
  )
}

function CfGroupPicker() {
  const [groups, setGroups] = React.useState(null)
  const [error, setError] = React.useState(null)

  const load = React.useCallback(async () => {
    setError(null)
    try {
      setGroups(await cfApi('/groups/api/groups'))
    } catch (err) {
      setError(err.message)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  return React.createElement('div', { className: 'ag-cf-col' },
    React.createElement('div', { className: 'ag-cf-row' },
      React.createElement('strong', null, 'Production groups'),
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => void load() }, 'Refresh'),
      React.createElement('span', { className: 'ag-cf-note' }, 'Create a “Create Flow” group from Agent Groups, then open it here.'),
    ),
    error && React.createElement('div', { className: 'ag-cf-error' }, error),
    groups === null
      ? React.createElement('div', { className: 'ag-cf-note' }, 'Loading…')
      : React.createElement('div', { className: 'ag-cf-groups' },
          groups.map((group) => React.createElement('div', {
            key: group.groupId,
            className: 'ag-cf-group',
            onClick: () => cfSetUi({ groupId: group.groupId }),
          },
            React.createElement('strong', null, group.name),
            React.createElement('div', { className: 'ag-cf-note' }, group.missionObjective),
            React.createElement('div', { className: 'ag-cf-row', style: { marginTop: 4 } },
              React.createElement('span', { className: 'ag-cf-badge' }, group.status),
              React.createElement('span', { className: 'ag-cf-note' }, `${group.memberCount} members · ${group.taskCount} tasks`),
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

  const load = React.useCallback(async () => {
    setError(null)
    try {
      const [nextSnap, nextFlow] = await Promise.all([
        cfApi(`/groups/api/group/${encodeURIComponent(groupId)}`),
        cfApi(`/groups/api/create-flow/${encodeURIComponent(groupId)}`),
      ])
      setSnap(nextSnap)
      setFlow(nextFlow)
      return nextFlow
    } catch (err) {
      setError(err.message)
      return null
    }
  }, [groupId])

  React.useEffect(() => { void load() }, [load])

  const request = async (busyKey, path, payload, method = 'POST') => {
    if (busy !== null) return null
    setBusy(busyKey)
    setError(null)
    try {
      const result = await cfApi(`/groups/api/create-flow/${encodeURIComponent(groupId)}/${path}`, {
        method,
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      })
      await load()
      return result
    } catch (err) {
      setError(err.message)
      return null
    } finally {
      setBusy(null)
    }
  }

  if (snap === null || flow === null) {
    return React.createElement('div', { className: 'ag-cf-col' },
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: onBack }, '← Groups'),
      error
        ? React.createElement('div', { className: 'ag-cf-error' }, error)
        : React.createElement('div', { className: 'ag-cf-note' }, 'Loading workspace…'),
    )
  }

  const artifacts = flow.state?.artifacts ?? []
  const scenes = flow.state?.scenes ?? []
  const jobs = flow.state?.jobs ?? []
  const caps = flow.capabilities ?? {}

  return React.createElement('div', { className: 'ag-cf-col' },
    React.createElement('div', { className: 'ag-cf-row' },
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: onBack }, '← Groups'),
      React.createElement('strong', null, snap.group.name),
      snap.group.templateId !== 'content-team' && React.createElement('span', { className: 'ag-cf-badge warn' }, 'not Create Flow template'),
      React.createElement('span', { className: 'ag-cf-note' }, snap.group.mission.objective),
      React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => void load(), style: { marginLeft: 'auto' } }, 'Refresh'),
    ),
    error && React.createElement('div', { className: 'ag-cf-error' }, error),
    React.createElement('div', { className: 'ag-cf-card' },
      React.createElement('div', { className: 'ag-cf-row' },
        React.createElement('strong', null, 'Local media runtime'),
        cfCapability('TTS', caps.tts),
        cfCapability('ASR', caps.asr),
        cfCapability('FFmpeg', caps.render),
        React.createElement('span', { className: 'ag-cf-mono' }, flow.workspaceRoot),
      ),
    ),
    React.createElement('div', { className: 'ag-cf-grid' },
      CF_STAGES.map(([stage, label]) => React.createElement(CfStageCard, {
        key: stage,
        stage,
        label,
        artifacts: artifacts.filter((artifact) => artifact.stage === stage),
      })),
    ),
    React.createElement(CfSceneTimeline, {
      scenes,
      disabled: busy !== null,
      busy,
      onSave: (payload) => request('scene', 'scenes', payload),
      onRemove: (sceneId) => request('scene', `scenes/${encodeURIComponent(sceneId)}`, undefined, 'DELETE'),
      onRender: (payload) => request('timeline/render', 'timeline/render', payload),
    }),
    React.createElement(CfTtsCard, {
      disabled: busy !== null,
      busy: busy === 'tts',
      onRun: (payload) => request('tts', 'tts', payload),
    }),
    React.createElement(CfAsrCard, {
      disabled: busy !== null,
      busy: busy === 'asr',
      onRun: (payload) => request('asr', 'asr', payload),
    }),
    React.createElement(CfRenderCard, {
      disabled: busy !== null,
      busy: busy === 'render',
      onRun: (payload) => request('render', 'render', payload),
    }),
    React.createElement(CfJobs, { jobs }),
  )
}

function cfCapability(label, capability) {
  const configured = capability?.configured === true
  return React.createElement('span', {
    className: `ag-cf-badge ${configured ? 'ok' : 'warn'}`,
    title: capability?.command ?? '',
  }, `${label}: ${configured ? 'ready' : 'not configured'}`)
}

function CfStageCard({ stage, label, artifacts }) {
  return React.createElement('div', { className: 'ag-cf-card ag-cf-stage' },
    React.createElement('div', { className: 'ag-cf-stage-title' },
      React.createElement('span', null, label),
      React.createElement('span', { className: 'ag-cf-badge' }, String(artifacts.length)),
    ),
    artifacts.length === 0
      ? React.createElement('div', { className: 'ag-cf-note' }, 'No artifact yet')
      : artifacts.slice().reverse().map((artifact) => React.createElement('div', { key: artifact.artifactId, className: 'ag-cf-artifact' },
          React.createElement('div', null, artifact.title),
          React.createElement('div', { className: 'ag-cf-row' },
            React.createElement('span', { className: 'ag-cf-badge' }, artifact.kind),
            artifact.path && React.createElement('span', { className: 'ag-cf-mono' }, artifact.path),
            artifact.sourceUrl && React.createElement('span', { className: 'ag-cf-note' }, artifact.sourceUrl),
          ),
        )),
  )
}

function CfSceneTimeline({ scenes, disabled, busy, onSave, onRemove, onRender }) {
  const [editing, setEditing] = React.useState(null)
  const [title, setTitle] = React.useState('')
  const [visualPath, setVisualPath] = React.useState('')
  const [audioPath, setAudioPath] = React.useState('')
  const [subtitlePath, setSubtitlePath] = React.useState('')
  const [narration, setNarration] = React.useState('')
  const [durationSec, setDurationSec] = React.useState('')
  const [order, setOrder] = React.useState('')
  const [outputPath, setOutputPath] = React.useState('')
  const [fps, setFps] = React.useState('')
  const [width, setWidth] = React.useState('')
  const [height, setHeight] = React.useState('')

  const reset = () => {
    setEditing(null)
    setTitle('')
    setVisualPath('')
    setAudioPath('')
    setSubtitlePath('')
    setNarration('')
    setDurationSec('')
    setOrder('')
  }

  const edit = (scene) => {
    setEditing(scene.sceneId)
    setTitle(scene.title ?? '')
    setVisualPath(scene.visualPath ?? '')
    setAudioPath(scene.audioPath ?? '')
    setSubtitlePath(scene.subtitlePath ?? '')
    setNarration(scene.narration ?? '')
    setDurationSec(scene.durationSec === undefined ? '' : String(scene.durationSec))
    setOrder(scene.order === undefined ? '' : String(scene.order))
  }

  const save = async () => {
    const payload = {
      ...(editing ? { sceneId: editing } : {}),
      ...(title.trim() ? { title: title.trim() } : {}),
      visualPath: visualPath.trim(),
      ...(audioPath.trim() ? { audioPath: audioPath.trim() } : {}),
      ...(subtitlePath.trim() ? { subtitlePath: subtitlePath.trim() } : {}),
      ...(narration !== '' ? { narration } : {}),
      ...(durationSec !== '' ? { durationSec: Number(durationSec) } : {}),
      ...(order !== '' ? { order: Number(order) } : {}),
    }
    const result = await onSave(payload)
    if (result !== null) reset()
  }

  const renderable = scenes.length > 0 && scenes.every((scene) =>
    Boolean(scene.visualPath) && (Boolean(scene.audioPath) || (Number.isFinite(scene.durationSec) && scene.durationSec > 0)),
  )

  const renderTimeline = () => onRender({
    ...(outputPath.trim() ? { outputPath: outputPath.trim() } : {}),
    ...(fps !== '' ? { fps: Number(fps) } : {}),
    ...(width !== '' ? { width: Number(width) } : {}),
    ...(height !== '' ? { height: Number(height) } : {}),
  })

  return React.createElement('div', { className: 'ag-cf-card ag-cf-col' },
    React.createElement('div', { className: 'ag-cf-row' },
      React.createElement('strong', null, 'Scene timeline'),
      React.createElement('span', { className: `ag-cf-badge ${renderable ? 'ok' : scenes.length ? 'warn' : ''}` }, `${scenes.length} scenes`),
      React.createElement('span', { className: 'ag-cf-note' }, 'Scenes are production state; task completion still uses Agent Groups verification.'),
    ),
    scenes.length === 0
      ? React.createElement('div', { className: 'ag-cf-note' }, 'No scenes yet. Add a visual plus audio or an explicit duration.')
      : React.createElement('div', null,
          scenes.map((scene) => {
            const sceneRenderable = Boolean(scene.visualPath) && (Boolean(scene.audioPath) || (Number.isFinite(scene.durationSec) && scene.durationSec > 0))
            return React.createElement('div', { className: 'ag-cf-scene', key: scene.sceneId },
              React.createElement('div', { className: 'ag-cf-scene-main' },
                React.createElement('div', { className: 'ag-cf-row' },
                  React.createElement('strong', null, `${scene.order + 1}. ${scene.title}`),
                  React.createElement('span', { className: `ag-cf-badge ${sceneRenderable ? 'ok' : 'warn'}` }, sceneRenderable ? 'renderable' : 'needs audio/duration'),
                  scene.durationSec !== undefined && React.createElement('span', { className: 'ag-cf-note' }, `${scene.durationSec}s`),
                ),
                React.createElement('div', { className: 'ag-cf-scene-paths' },
                  React.createElement('span', { className: 'ag-cf-mono' }, `visual: ${scene.visualPath}`),
                  scene.audioPath && React.createElement('span', { className: 'ag-cf-mono' }, `audio: ${scene.audioPath}`),
                  scene.subtitlePath && React.createElement('span', { className: 'ag-cf-mono' }, `captions: ${scene.subtitlePath}`),
                ),
                scene.narration && React.createElement('div', { className: 'ag-cf-note', style: { marginTop: 4 } }, scene.narration),
              ),
              React.createElement('div', { className: 'ag-cf-scene-actions' },
                React.createElement(Button, { variant: 'ghost', size: 'sm', disabled, onClick: () => edit(scene) }, 'Edit'),
                React.createElement(Button, {
                  variant: 'ghost',
                  size: 'sm',
                  disabled,
                  onClick: async () => {
                    const result = await onRemove(scene.sceneId)
                    if (result !== null && editing === scene.sceneId) reset()
                  },
                }, 'Remove'),
              ),
            )
          }),
        ),
    React.createElement('div', { className: 'ag-cf-form' },
      React.createElement('input', { className: 'ag-cf-input', placeholder: 'scene title (optional)', value: title, onChange: (e) => setTitle(e.target.value) }),
      React.createElement('input', { className: 'ag-cf-input', placeholder: 'visual path', value: visualPath, onChange: (e) => setVisualPath(e.target.value) }),
      React.createElement('input', { className: 'ag-cf-input', placeholder: 'audio path (optional)', value: audioPath, onChange: (e) => setAudioPath(e.target.value) }),
      React.createElement('input', { className: 'ag-cf-input', placeholder: 'captions path (optional)', value: subtitlePath, onChange: (e) => setSubtitlePath(e.target.value) }),
      React.createElement('input', { className: 'ag-cf-input', type: 'number', min: '0', step: '0.1', placeholder: 'duration seconds (if no audio)', value: durationSec, onChange: (e) => setDurationSec(e.target.value) }),
      React.createElement('input', { className: 'ag-cf-input', type: 'number', min: '0', step: '1', placeholder: 'order (0-based, optional)', value: order, onChange: (e) => setOrder(e.target.value) }),
      React.createElement('textarea', { className: 'ag-cf-input ag-cf-wide', rows: 3, placeholder: 'narration (optional)', value: narration, onChange: (e) => setNarration(e.target.value) }),
    ),
    React.createElement('div', { className: 'ag-cf-row' },
      React.createElement(Button, {
        variant: 'primary',
        size: 'sm',
        disabled: disabled || visualPath.trim() === '',
        onClick: () => void save(),
      }, busy === 'scene' ? 'Saving…' : editing ? 'Update scene' : 'Add scene'),
      editing && React.createElement(Button, { variant: 'ghost', size: 'sm', disabled, onClick: reset }, 'Cancel edit'),
    ),
    React.createElement('div', { className: 'ag-cf-form' },
      React.createElement('input', { className: 'ag-cf-input', placeholder: 'timeline MP4 output path (optional)', value: outputPath, onChange: (e) => setOutputPath(e.target.value) }),
      React.createElement('input', { className: 'ag-cf-input', type: 'number', min: '1', step: '1', placeholder: 'fps (default 30)', value: fps, onChange: (e) => setFps(e.target.value) }),
      React.createElement('input', { className: 'ag-cf-input', type: 'number', min: '1', step: '1', placeholder: 'width (default 1280)', value: width, onChange: (e) => setWidth(e.target.value) }),
      React.createElement('input', { className: 'ag-cf-input', type: 'number', min: '1', step: '1', placeholder: 'height (default 720)', value: height, onChange: (e) => setHeight(e.target.value) }),
    ),
    React.createElement('div', { className: 'ag-cf-row' },
      React.createElement(Button, {
        variant: 'primary',
        size: 'sm',
        disabled: disabled || !renderable,
        onClick: () => void renderTimeline(),
      }, busy === 'timeline/render' ? 'Rendering timeline…' : 'Render timeline'),
      !renderable && scenes.length > 0 && React.createElement('span', { className: 'ag-cf-note' }, 'Every scene needs a visual and either audio or a positive duration.'),
    ),
  )
}

function CfTtsCard({ disabled, busy, onRun }) {
  const [text, setText] = React.useState('')
  const [outputPath, setOutputPath] = React.useState('')
  const [voice, setVoice] = React.useState('')
  const [language, setLanguage] = React.useState('')
  return React.createElement('div', { className: 'ag-cf-card ag-cf-col' },
    React.createElement('strong', null, 'TTS · Script → Voice'),
    React.createElement('textarea', { className: 'ag-cf-input', rows: 5, placeholder: 'Narration/script text', value: text, onChange: (e) => setText(e.target.value) }),
    React.createElement('div', { className: 'ag-cf-form' },
      React.createElement('input', { className: 'ag-cf-input', placeholder: 'output path (optional)', value: outputPath, onChange: (e) => setOutputPath(e.target.value) }),
      React.createElement('input', { className: 'ag-cf-input', placeholder: 'voice (optional)', value: voice, onChange: (e) => setVoice(e.target.value) }),
      React.createElement('input', { className: 'ag-cf-input', placeholder: 'language (optional)', value: language, onChange: (e) => setLanguage(e.target.value) }),
    ),
    React.createElement('div', { className: 'ag-cf-row' },
      React.createElement(Button, {
        variant: 'primary',
        size: 'sm',
        disabled: disabled || text.trim() === '',
        onClick: () => void onRun({
          text,
          outputPath: outputPath || undefined,
          voice: voice || undefined,
          language: language || undefined,
        }),
      }, busy ? 'Generating…' : 'Generate voice'),
      React.createElement('span', { className: 'ag-cf-note' }, 'Runs the configured local TTS executable.'),
    ),
  )
}

function CfAsrCard({ disabled, busy, onRun }) {
  const [inputPath, setInputPath] = React.useState('')
  const [outputPath, setOutputPath] = React.useState('')
  const [language, setLanguage] = React.useState('')
  return React.createElement('div', { className: 'ag-cf-card ag-cf-col' },
    React.createElement('strong', null, 'ASR · Audio/Video → Captions'),
    React.createElement('div', { className: 'ag-cf-form' },
      React.createElement('input', { className: 'ag-cf-input', placeholder: 'input path', value: inputPath, onChange: (e) => setInputPath(e.target.value) }),
      React.createElement('input', { className: 'ag-cf-input', placeholder: 'SRT output path (optional)', value: outputPath, onChange: (e) => setOutputPath(e.target.value) }),
      React.createElement('input', { className: 'ag-cf-input', placeholder: 'language (optional)', value: language, onChange: (e) => setLanguage(e.target.value) }),
    ),
    React.createElement(Button, {
      variant: 'primary',
      size: 'sm',
      disabled: disabled || inputPath.trim() === '',
      onClick: () => void onRun({
        inputPath,
        outputPath: outputPath || undefined,
        language: language || undefined,
      }),
    }, busy ? 'Transcribing…' : 'Generate captions'),
  )
}

function CfRenderCard({ disabled, busy, onRun }) {
  const [visualPath, setVisualPath] = React.useState('')
  const [audioPath, setAudioPath] = React.useState('')
  const [subtitlePath, setSubtitlePath] = React.useState('')
  const [outputPath, setOutputPath] = React.useState('')
  return React.createElement('div', { className: 'ag-cf-card ag-cf-col' },
    React.createElement('strong', null, 'Render · Material + Voice + Captions → MP4'),
    React.createElement('div', { className: 'ag-cf-form' },
      React.createElement('input', { className: 'ag-cf-input', placeholder: 'visual image/video path', value: visualPath, onChange: (e) => setVisualPath(e.target.value) }),
      React.createElement('input', { className: 'ag-cf-input', placeholder: 'audio path', value: audioPath, onChange: (e) => setAudioPath(e.target.value) }),
      React.createElement('input', { className: 'ag-cf-input', placeholder: 'captions path (optional)', value: subtitlePath, onChange: (e) => setSubtitlePath(e.target.value) }),
      React.createElement('input', { className: 'ag-cf-input', placeholder: 'MP4 output path (optional)', value: outputPath, onChange: (e) => setOutputPath(e.target.value) }),
    ),
    React.createElement(Button, {
      variant: 'primary',
      size: 'sm',
      disabled: disabled || visualPath.trim() === '' || audioPath.trim() === '',
      onClick: () => void onRun({
        visualPath,
        audioPath,
        subtitlePath: subtitlePath || undefined,
        outputPath: outputPath || undefined,
      }),
    }, busy ? 'Rendering…' : 'Render video'),
  )
}

function CfJobs({ jobs }) {
  return React.createElement('div', { className: 'ag-cf-card ag-cf-col' },
    React.createElement('strong', null, 'Media jobs'),
    jobs.length === 0
      ? React.createElement('div', { className: 'ag-cf-note' }, 'No media jobs yet')
      : React.createElement('table', { className: 'ag-cf-table' },
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
              React.createElement('td', null, React.createElement('span', {
                className: `ag-cf-badge ${job.status === 'completed' ? 'ok' : job.status === 'failed' ? 'err' : 'warn'}`,
              }, job.status)),
              React.createElement('td', { className: 'ag-cf-mono' }, job.outputPath ?? '—'),
              React.createElement('td', { className: 'ag-cf-mono' }, job.command ?? '—'),
              React.createElement('td', { className: 'ag-cf-note' }, new Date(job.updatedAt).toLocaleTimeString()),
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
