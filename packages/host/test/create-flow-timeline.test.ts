import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CreateFlowService } from '../src/create-flow/service.js'
import { LocalMediaRuntime, type MediaCommandResult, type TimelineRenderScene } from '../src/create-flow/media-runtime.js'
import { makeHarness } from './helpers.js'

class FakeTimelineRuntime extends LocalMediaRuntime {
  renderedScenes: readonly TimelineRenderScene[] = []

  constructor() {
    super({ ffmpegCommand: 'fake-ffmpeg' })
  }

  override async renderTimeline(input: {
    cwd: string
    scenes: readonly TimelineRenderScene[]
    outputPath: string
    fps?: number
    width?: number
    height?: number
  }): Promise<MediaCommandResult> {
    this.renderedScenes = input.scenes
    await writeFile(input.outputPath, `timeline:${input.scenes.map((scene) => scene.sceneId).join(',')}`, 'utf8')
    return {
      command: 'fake-ffmpeg',
      args: [`<timeline:${input.scenes.length}-scenes>`],
      exitCode: 0,
      stdout: '',
      stderr: '',
    }
  }
}

describe('Create Flow scene timeline', () => {
  it('persists ordered scenes, updates them, and renders one final timeline artifact', async () => {
    const h = makeHarness()
    const cwd = await mkdtemp(join(tmpdir(), 'create-flow-timeline-'))
    const group = await h.groups.initGroup('lead-1', 'Lead', 'Video', { objective: 'make a multi-scene video' }, { cwd, templateId: 'content-team' })
    const media = new FakeTimelineRuntime()
    const flow = new CreateFlowService({ groups: h.groups, activity: h.activity, notifier: h.notifier, media })

    await writeFile(join(cwd, 'opening.png'), 'image', 'utf8')
    await writeFile(join(cwd, 'detail.png'), 'image', 'utf8')
    await writeFile(join(cwd, 'opening.wav'), 'audio', 'utf8')

    const detail = await flow.upsertScene(group.groupId, 'lead-1', {
      order: 1,
      title: 'Detail',
      visualPath: 'detail.png',
      narration: 'Second scene',
      durationSec: 2.5,
    })
    const opening = await flow.upsertScene(group.groupId, 'lead-1', {
      order: 0,
      title: 'Opening',
      visualPath: 'opening.png',
      audioPath: 'opening.wav',
      narration: 'First scene',
    })
    await flow.upsertScene(group.groupId, 'lead-1', {
      sceneId: detail.sceneId,
      title: 'Detail revised',
      visualPath: 'detail.png',
      durationSec: 3,
    })

    let status = await flow.status(group.groupId)
    expect(status.state.scenes.map((scene) => scene.sceneId)).toEqual([opening.sceneId, detail.sceneId])
    expect(status.state.scenes[1]).toMatchObject({ title: 'Detail revised', durationSec: 3, narration: 'Second scene' })

    const rendered = await flow.renderTimeline(group.groupId, 'lead-1', {
      outputPath: 'final-timeline.mp4',
      fps: 24,
      width: 1920,
      height: 1080,
    })

    expect(rendered.job.kind).toBe('timeline_render')
    expect(rendered.job.status).toBe('completed')
    expect(rendered.artifact).toMatchObject({ kind: 'video', stage: 'render', path: 'final-timeline.mp4' })
    expect(rendered.artifact.metadata).toMatchObject({ sceneCount: 2, fps: 24, width: 1920, height: 1080 })
    expect(media.renderedScenes.map((scene) => scene.sceneId)).toEqual([opening.sceneId, detail.sceneId])
    expect(await readFile(join(cwd, 'final-timeline.mp4'), 'utf8')).toContain(opening.sceneId)

    status = await flow.status(group.groupId)
    expect(status.state.jobs.at(-1)?.kind).toBe('timeline_render')
    expect(status.state.artifacts.at(-1)?.path).toBe('final-timeline.mp4')

    const persisted = JSON.parse(await readFile(join(cwd, '.create-flow', 'state.json'), 'utf8'))
    expect(persisted.scenes).toHaveLength(2)
    expect(persisted.scenes.map((scene: { order: number }) => scene.order)).toEqual([0, 1])

    expect(await flow.removeScene(group.groupId, 'lead-1', detail.sceneId)).toEqual({ removed: true, sceneId: detail.sceneId })
    expect((await flow.status(group.groupId)).state.scenes).toHaveLength(1)
  })

  it('rejects scene material paths outside the group workspace', async () => {
    const h = makeHarness()
    const cwd = await mkdtemp(join(tmpdir(), 'create-flow-timeline-'))
    const group = await h.groups.initGroup('lead-1', 'Lead', 'Video', { objective: 'safe video' }, { cwd })
    const flow = new CreateFlowService({ groups: h.groups, activity: h.activity, notifier: h.notifier, media: new FakeTimelineRuntime() })

    await expect(flow.upsertScene(group.groupId, 'lead-1', {
      visualPath: '../outside.png',
      durationSec: 1,
    })).rejects.toThrow('escapes the group workspace')
  })
})
