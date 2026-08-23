import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface RuntimeProcessSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

/** Process placement boundary. Docker/SSH/remote executors implement this contract. */
export interface RuntimeExecutor {
  readonly id: string
  isAvailable(spec: RuntimeProcessSpec): boolean | Promise<boolean>
  spawn(spec: RuntimeProcessSpec): ChildProcessWithoutNullStreams
}

function executableExists(command: string): boolean {
  if (command.includes('/') || command.includes('\\')) return existsSync(command)
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  const names = process.platform === 'win32' ? [`${command}.cmd`, `${command}.exe`, command] : [command]
  return dirs.some((dir) => dir !== '' && names.some((name) => existsSync(join(dir, name))))
}

/** Default local no-shell executor. Credentials remain in the host process environment. */
export class LocalRuntimeExecutor implements RuntimeExecutor {
  readonly id = 'local'

  isAvailable(spec: RuntimeProcessSpec): boolean {
    return executableExists(spec.command)
  }

  spawn(spec: RuntimeProcessSpec): ChildProcessWithoutNullStreams {
    return spawn(spec.command, [...spec.args], {
      env: { ...process.env, ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    })
  }
}
