import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { GitWorktreeWorkspaceManager } from '../src/runtime/workspace.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-groups-workspace-'))
  roots.push(root)
  const repo = join(root, 'repo')
  await mkdir(repo)
  await execFileAsync('git', ['init'], { cwd: repo })
  await execFileAsync('git', ['config', 'user.email', 'tests@example.invalid'], { cwd: repo })
  await execFileAsync('git', ['config', 'user.name', 'Agent Groups Tests'], { cwd: repo })
  await writeFile(join(repo, 'tracked.txt'), 'base\n')
  await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repo })
  await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repo })
  return repo
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('GitWorktreeWorkspaceManager', () => {
  it('returns the group directory unchanged in shared mode', async () => {
    const manager = new GitWorktreeWorkspaceManager()
    await expect(manager.prepare({ groupId: 'g', memberId: 'm', cwd: '/workspace/project', mode: 'shared' }))
      .resolves.toBe('/workspace/project')
  })

  it('creates isolated persistent worktrees per member', async () => {
    const repo = await makeRepo()
    const manager = new GitWorktreeWorkspaceManager()
    const first = await manager.prepare({ groupId: 'group-a', memberId: 'member-a', cwd: repo, mode: 'worktree' })
    const second = await manager.prepare({ groupId: 'group-a', memberId: 'member-b', cwd: repo, mode: 'worktree' })
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first).not.toBe(second)
    await writeFile(join(first!, 'member-only.txt'), 'member a\n')
    await expect(readFile(join(second!, 'member-only.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(manager.prepare({ groupId: 'group-a', memberId: 'member-a', cwd: repo, mode: 'worktree' }))
      .resolves.toBe(first)
    const list = (await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repo })).stdout
    expect(list).toContain(`worktree ${first}`)
    expect(list).toContain(`worktree ${second}`)
  })

  it('rejects worktree mode outside a Git repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-groups-not-git-'))
    roots.push(root)
    const manager = new GitWorktreeWorkspaceManager()
    await expect(manager.prepare({ groupId: 'g', memberId: 'm', cwd: root, mode: 'worktree' }))
      .rejects.toThrow('requires a Git repository')
  })
})
