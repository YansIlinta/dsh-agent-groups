import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CreateFlowService } from '../src/create-flow/service.js'
import { LocalMediaRuntime, type MediaCommandResult } from '../src/create-flow/media-runtime.js'
import { makeHarness } from './helpers.js'

class FakeMediaRuntime extends LocalMediaRuntime {
  constructor() {
    super({ asr: { command: 'fake-asr', args: [] }, tts: { command: 'fake-tts', args: [] }, ffmpegCommand: 'fake-ffmpeg' })
  }

  override async runTts(input: { cwd: string; textPath: string; outputPath: string; voice?: string; language?: string }): Promise<MediaCommandResult> {
    const text = await readFile(input.textPath, 'utf8')
    await writeFile(input.outputPath, `VOICE:${text}`, 'utf8')
    return { command: 'fake-tts', args: [], exitCode: 0, stdout: '', stderr: '' }
  }

  override async runAsr(input: { cwd: string; inputPath: string; outputPath: string; language?: string }): Promise<MediaCommandResult> {
    await writeFile(input.outputPath, '1\n00:00:00,000 --> 00:00:01,000\nhello\n', 'utf8')
    return { command: 'fake-asr', args: [], exitCode: 0, stdout: '', stderr: '' }
  }

  override async renderVideo(input: { cwd: string; visualPath: string; audioPath: string; subtitlePath?: string; outputPath: string; fps?: number }): Promise<MediaCommandResult> {
    await writeFile(input.outputPath, 'video', 'utf8')
    return { command: 'fake-ffmpeg', args: [], exitCode: 0, stdout: '', stderr: '' }
  }
}

describe('Create Flow local media service', () => {
  it('persists TTS, ASR and render jobs/artifacts in the group workspace', async () => {
    const h = makeHarness()
    const cwd = await mkdtemp(join(tmpdir(), 'create-flow-'))
    const group = await h.groups.initGroup('lead-1', 'Lead', 'Video', { objective: 'make a video' }, { cwd, templateId: 'content-team' })
    const flow = new CreateFlowService({ groups: h.groups, activity: h.activity, notifier: h.notifier, media: new FakeMediaRuntime() })

    await writeFile(join(cwd, 'visual.png'), 'image', 'utf8')
    const tts = await flow.runTts(group.groupId, 'lead-1', { text: 'hello', outputPath: 'voice.wav' })
    const asr = await flow.runAsr(group.groupId, 'lead-1', { inputPath: 'voice.wav', outputPath: 'captions.srt' })
    const render = await flow.renderVideo(group.groupId, 'lead-1', {
      visualPath: 'visual.png',
      audioPath: 'voice.wav',
      subtitlePath: 'captions.srt',
      outputPath: 'final.mp4',
    })

    expect(tts.job.status).toBe('completed')
    expect(asr.artifact.kind).toBe('captions')
    expect(render.artifact.path).toBe('final.mp4')

    const status = await flow.status(group.groupId)
    expect(status.state.jobs.map((job) => job.kind)).toEqual(['tts', 'asr', 'render'])
    expect(status.state.jobs.every((job) => job.status === 'completed')).toBe(true)
    expect(status.state.artifacts.map((artifact) => artifact.kind)).toEqual(['audio', 'captions', 'video'])

    const persisted = JSON.parse(await readFile(join(cwd, '.create-flow', 'state.json'), 'utf8'))
    expect(persisted.groupId).toBe(group.groupId)
    expect(persisted.artifacts).toHaveLength(3)
  })

  it('rejects paths that escape the group workspace', async () => {
    const h = makeHarness()
    const cwd = await mkdtemp(join(tmpdir(), 'create-flow-'))
    const group = await h.groups.initGroup('lead-1', 'Lead', 'Video', { objective: 'make a video' }, { cwd })
    const flow = new CreateFlowService({ groups: h.groups, activity: h.activity, notifier: h.notifier, media: new FakeMediaRuntime() })

    await expect(flow.runAsr(group.groupId, 'lead-1', { inputPath: '../outside.wav' })).rejects.toThrow('escapes the group workspace')
  })
})
