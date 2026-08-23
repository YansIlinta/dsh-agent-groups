import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { LocalRuntimeExecutor } from '../src/runtime/executor.js'

describe('LocalRuntimeExecutor', () => {
  it('checks executables and launches an argument array without a shell', async () => {
    const executor = new LocalRuntimeExecutor()
    expect(executor.isAvailable({ command: process.execPath, args: [] })).toBe(true)
    expect(executor.isAvailable({ command: '/definitely/missing/agent-groups-runtime', args: [] })).toBe(false)

    const child = executor.spawn({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1])', 'literal;$(never-executed)'],
    })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { output += chunk })
    const [code] = await once(child, 'exit')
    expect(code).toBe(0)
    expect(output).toBe('literal;$(never-executed)')
  })
})
