/**
 * OPTIONAL real-runtime smoke test (requirement §19): credential-gated.
 *
 * Only runs when AGENT_GROUPS_CODEX_SMOKE=1 AND a codex login/API key is
 * present; otherwise it skips. Proves the true `codex app-server` binary
 * answers the initialize handshake and `model/list` (no thread/turn work —
 * that is fully covered by the deterministic fake-server suite).
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CodexAppServerConnection, CodexBinaryProcessHost } from '../src/runtime/codex-protocol.js'

function which(bin: string): string | null {
  const path = (process.env.PATH ?? '').split(process.platform === 'win32' ? /[;:]/ : ':')
  const candidates = process.platform === 'win32' ? [`${bin}.exe`, `${bin}.cmd`, bin] : [bin]
  for (const dir of path) {
    if (dir === '') continue
    for (const candidate of candidates) {
      const full = join(dir, candidate)
      try {
        if (existsSync(full)) return full
      } catch { /* keep scanning */ }
    }
  }
  return null
}

const enabled = process.env.AGENT_GROUPS_CODEX_SMOKE === '1'
const bin = which('codex')
const hasCreds = process.env.OPENAI_API_KEY !== undefined || process.env.CODEX_API_KEY !== undefined || existsSync(join(homedir(), '.codex', 'auth.json'))

describe.skipIf(!enabled || bin === null || !hasCreds)('codex app-server real-binary smoke (opt-in)', () => {
  it('initialize handshake + dynamic model discovery against the real binary', async () => {
    const connection = new CodexAppServerConnection(new CodexBinaryProcessHost(bin!), { requestTimeoutMs: 30_000, initializeTimeoutMs: 30_000 })
    await connection.connect()
    expect(connection.isInitialized).toBe(true)
    const result = await connection.request<{ data?: unknown }>('model/list', { includeHidden: false }, 30_000)
    expect(Array.isArray(result?.data)).toBe(true)
    expect((result.data as unknown[]).length).toBeGreaterThan(0)
    await connection.close(1_000)
  }, 60_000)
})