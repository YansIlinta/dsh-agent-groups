import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalMediaRuntime } from '../src/create-flow/media-runtime.js'

const WRITE_ARGV_SCRIPT = `
const fs = require('node:fs')
const output = process.argv[1]
fs.writeFileSync(output, JSON.stringify(process.argv.slice(2)))
`

const WRITE_EMPTY_SCRIPT = `
const fs = require('node:fs')
fs.writeFileSync(process.argv[1], '')
`

describe('Create Flow media runtime hardening', () => {
  it('preserves empty substituted argv values instead of shifting later flags', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'create-flow-runtime-'))
    const textPath = join(cwd, 'input.txt')
    const outputPath = join(cwd, 'argv.json')
    await writeFile(textPath, 'hello', 'utf8')

    const runtime = new LocalMediaRuntime({
      tts: {
        command: process.execPath,
        args: ['-e', WRITE_ARGV_SCRIPT, '{output}', '{voice}', '{language}'],
      },
    })

    await runtime.runTts({ cwd, textPath, outputPath, language: 'en' })

    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(['', 'en'])
  })

  it('fails fast on unknown command-template placeholders', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'create-flow-runtime-'))
    const textPath = join(cwd, 'input.txt')
    await writeFile(textPath, 'hello', 'utf8')

    const runtime = new LocalMediaRuntime({
      tts: {
        command: process.execPath,
        args: ['-e', WRITE_ARGV_SCRIPT, '{output}', '{vocie}'],
      },
    })

    await expect(runtime.runTts({
      cwd,
      textPath,
      outputPath: join(cwd, 'voice.wav'),
    })).rejects.toThrow('unknown media command template placeholder {vocie}')
  })

  it('does not report a successful command as successful production when no output was created', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'create-flow-runtime-'))
    const textPath = join(cwd, 'input.txt')
    await writeFile(textPath, 'hello', 'utf8')

    const runtime = new LocalMediaRuntime({
      tts: {
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
      },
    })

    await expect(runtime.runTts({
      cwd,
      textPath,
      outputPath: join(cwd, 'missing.wav'),
    })).rejects.toThrow('TTS output does not exist')
  })

  it('allows an empty ASR artifact for silent media as long as the output file exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'create-flow-runtime-'))
    const inputPath = join(cwd, 'silent.wav')
    const outputPath = join(cwd, 'captions.srt')
    await writeFile(inputPath, 'not-real-audio-but-present', 'utf8')

    const runtime = new LocalMediaRuntime({
      asr: {
        command: process.execPath,
        args: ['-e', WRITE_EMPTY_SCRIPT, '{output}'],
      },
    })

    await expect(runtime.runAsr({ cwd, inputPath, outputPath })).resolves.toMatchObject({ exitCode: 0 })
    expect(await readFile(outputPath, 'utf8')).toBe('')
  })

  it.skipIf(process.platform === 'win32')('rejects output paths redirected outside the workspace through a symlink', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'create-flow-runtime-'))
    const outside = await mkdtemp(join(tmpdir(), 'create-flow-outside-'))
    const textPath = join(cwd, 'input.txt')
    await writeFile(textPath, 'hello', 'utf8')
    await symlink(outside, join(cwd, 'escaped'))

    const runtime = new LocalMediaRuntime({
      tts: {
        command: process.execPath,
        args: ['-e', WRITE_ARGV_SCRIPT, '{output}'],
      },
    })

    await expect(runtime.runTts({
      cwd,
      textPath,
      outputPath: join(cwd, 'escaped', 'voice.wav'),
    })).rejects.toThrow('escapes the media workspace through a symlink')
  })
})
