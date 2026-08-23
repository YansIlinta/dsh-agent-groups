import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type WorkspaceMode = 'shared' | 'worktree'

export interface MemberWorkspaceRequest {
  readonly groupId: string
  readonly memberId: string
  readonly cwd?: string
  readonly mode?: WorkspaceMode
}

export interface WorkspaceManager {
  prepare(request: MemberWorkspaceRequest): Promise<string | undefined>
}

function safePart(value: string): string {
  const readable = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'item'
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 10)
  return `${readable}-${digest}`
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return result.stdout.trim()
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Workspace policy for local runtimes. Worktrees are persistent and detached:
 * retries and host restarts reuse the same member directory, while cleanup is
 * deliberately left to an explicit administrative action.
 */
export class GitWorktreeWorkspaceManager implements WorkspaceManager {
  async prepare(request: MemberWorkspaceRequest): Promise<string | undefined> {
    if (request.mode !== 'worktree') return request.cwd
    if (request.cwd === undefined) throw new Error('worktree mode requires a group working directory')

    const repoRoot = await git(request.cwd, ['rev-parse', '--show-toplevel']).catch(() => {
      throw new Error(`worktree mode requires a Git repository: ${request.cwd}`)
    })
    const canonicalRoot = await realpath(repoRoot)
    const container = join(dirname(canonicalRoot), '.dsh-agent-groups-worktrees', safePart(basename(canonicalRoot)), safePart(request.groupId))
    const target = join(container, safePart(request.memberId))

    const worktrees = await git(canonicalRoot, ['worktree', 'list', '--porcelain'])
    const registered = worktrees
      .split(/\r?\n/)
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))
    if (registered.includes(target)) return target
    if (await exists(target)) throw new Error(`refusing to overwrite an unregistered workspace: ${target}`)

    await mkdir(container, { recursive: true })
    await git(canonicalRoot, ['worktree', 'add', '--detach', target, 'HEAD'])
    return target
  }
}
