/**
 * Codex App Server JSONL transport (V0.5).
 *
 * Speaks the current `codex app-server` wire protocol (verified against
 * codex-cli 0.147.0 via `codex app-server generate-ts` + the upstream
 * `codex-rs/app-server` README): JSON-RPC 2.0 messages WITHOUT the `jsonrpc`
 * header, newline-delimited on stdio.
 *
 * Wire shapes:
 *   client → server  request:      { "method": "thread/start", "id": 1, "params": {...} }
 *   client → server  notification: { "method": "initialized" }
 *   server → client  response:     { "id": 1, "result": { ... } }
 *   server → client  error:        { "id": 1, "error": { "code": ..., "message": ... } }
 *   server → client  notification: { "method": "turn/started", "params": {...} }
 *   server → client  request:      { "method": "item/commandExecution/requestApproval", "id": 9, "params": {...} }
 *   client → server  request resp: { "id": 9, "result": { "decision": "accept" } }
 *
 * The transport owns: process spawn/monitoring, handshake sequencing,
 * request/response correlation with timeouts, a bounded JSONL parser with
 * malformed-message accounting, server request -> response routing, crash
 * propagation and graceful shutdown. It is transport-agnostic for tests: the
 * process host is injectable, so suites can drive a fake JSONL server with
 * zero real processes.
 *
 * @module @dsh-agent-groups/host
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

/** Resolve when the child process exits (works for real and fake children). */
function waitForExit(child: CodexChildLike): Promise<[number | null, NodeJS.Signals | null]> {
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve([code, signal]))
  })
}

export type RequestId = string | number

/** Inbound server message classified by the parser. */
export type CodexInboundMessage =
  | { readonly kind: 'response'; readonly id: RequestId; readonly result: unknown }
  | { readonly kind: 'error'; readonly id: RequestId; readonly code: number; readonly message: string; readonly data?: unknown }
  | { readonly kind: 'notification'; readonly method: string; readonly params: unknown }
  | { readonly kind: 'server_request'; readonly id: RequestId; readonly method: string; readonly params: unknown }

/** Shape of a child process the transport speaks to (real or fake). */
export interface CodexChildLike {
  readonly stdout: Readable
  readonly stderr?: Readable
  readonly stdin: Writable
  kill(signal?: NodeJS.Signals): void
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

/** Creates the app-server child process. Tests inject a fake host. */
export interface CodexProcessHost {
  spawn(): CodexChildLike
  /** Human label for diagnostics (binary path, fake name). */
  readonly label: string
}

/** Default host: spawns the real `codex app-server` binary. */
export class CodexBinaryProcessHost implements CodexProcessHost {
  readonly label: string
  constructor(
    private readonly bin: string,
    private readonly args: readonly string[] = ['app-server'],
  ) {
    this.label = `${bin} app-server`
  }

  spawn(): CodexChildLike {
    // On win32 the resolved bin is usually an npm `.cmd` shim that forwards to
    // the real binary — Node cannot exec those directly, so run them through
    // cmd.exe explicitly (our args are fixed protocol constants).
    const isCmdShim = process.platform === 'win32' && !/\.exe$/i.test(this.bin)
    const child = spawn(
      isCmdShim ? 'cmd.exe' : this.bin,
      isCmdShim ? ['/d', '/s', '/c', [this.bin, ...this.args].join(' ')] : [...this.args],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
        // Do not let a crashed app-server take the Agent Groups host down.
        detached: false,
      },
    ) as ChildProcessWithoutNullStreams
    return child
  }
}

/** Request timeout / disconnect / protocol errors. */
export class CodexProtocolError extends Error {
  readonly code: 'REQUEST_TIMEOUT' | 'RPC_DISCONNECTED' | 'NOT_INITIALIZED' | 'MALFORMED_RESPONSE' | 'RPC_ERROR' | 'WRITE_FAILED' | 'SPAWN_FAILED' | 'TURN_STEER_FAILED'
  readonly rpcCode?: number
  readonly rpcData?: unknown
  constructor(code: CodexProtocolError['code'], message: string, options?: { rpcCode?: number; rpcData?: unknown; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'CodexProtocolError'
    this.code = code
    this.rpcCode = options?.rpcCode
    this.rpcData = options?.rpcData
  }
}

/** One client <-> one app-server process connection, JSONL on stdio. */
export class CodexAppServerConnection {
  /** Max bytes buffered waiting for a newline before we drop and account. */
  static readonly MAX_PENDING_BYTES = 4 * 1024 * 1024

  private child: CodexChildLike | undefined
  private buffer = ''
  private malformed = 0
  private nextRequestId = 1

  private readonly pending = new Map<RequestId, { resolve: (result: unknown) => void; reject: (error: CodexProtocolError) => void; timer: NodeJS.Timeout; method: string }>()
  /** Server-initiated requests (approvals etc.) waiting for an answer. */
  private readonly serverRequests = new Map<RequestId, { method: string; params: unknown }>()

  private initialized = false
  private closed = false
  private readonly listeners = new Set<(message: CodexInboundMessage) => void>()
  private exitListeners = new Set<(code: number | null, error?: Error) => void>()
  private errorListeners = new Set<(error: Error) => void>()
  private spawnPromise: Promise<void> | undefined
  /** stderr tail for diagnostics (bounded). */
  private stderrTail = ''
  private writing = Promise.resolve()

  constructor(
    private readonly host: CodexProcessHost,
    private readonly options: { requestTimeoutMs?: number; initializeTimeoutMs?: number } = {},
  ) {}

  get isConnected(): boolean { return this.child !== undefined && !this.closed }
  get isInitialized(): boolean { return this.initialized }
  get malformedCount(): number { return this.malformed }
  get stderrTailText(): string { return this.stderrTail }

  /** Subscribe to classified inbound messages. Returns an unsubscribe fn. */
  onMessage(listener: (message: CodexInboundMessage) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  onExit(listener: (code: number | null, error?: Error) => void): () => void {
    this.exitListeners.add(listener)
    return () => { this.exitListeners.delete(listener) }
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener)
    return () => { this.errorListeners.delete(listener) }
  }

  /** Spawn (+ handshake) exactly once; safe to await concurrently. */
  async connect(): Promise<void> {
    if (this.spawnPromise !== undefined) {
      if (this.closed) {
        // closed → a future caller must reconnect explicitly; connect() after
        // close() fails loudly instead of silently re-spawning.
        throw new CodexProtocolError('RPC_DISCONNECTED', 'connection was closed; call reconnect() to respawn')
      }
      return this.spawnPromise
    }
    this.spawnPromise = this.spawnInternal()
    return this.spawnPromise
  }

  /** Respawn after a crash/close (used by session resume). */
  async reconnect(): Promise<void> {
    this.spawnPromise = undefined
    this.closed = false
    this.initialized = false
    this.buffer = ''
    return this.connect()
  }

  private async spawnInternal(): Promise<void> {
    let child: CodexChildLike
    try {
      child = this.host.spawn()
    } catch (error) {
      throw new CodexProtocolError('SPAWN_FAILED', `failed to spawn ${this.host.label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    this.child = child

    child.on('error', (error: Error) => {
      for (const listener of this.errorListeners) listener(error)
    })
    child.on('exit', (code: number | null) => {
      this.handleExit(code)
    })

    const exited = waitForExit(child)
    const stdout = child.stdout
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => this.ingest(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (this.stderrTail.length < 8_000) this.stderrTail += chunk
      else this.stderrTail = this.stderrTail.slice(-4_000) + chunk
    })

    // Initialize handshake: request -> response, then `initialized` notification.
    try {
      await this.request('initialize', {
        clientInfo: { name: 'dsh-agent-groups', title: 'DSH Agent Groups', version: '0.5.0' },
        capabilities: null,
      }, this.options.initializeTimeoutMs ?? 20_000)
      this.writeLine({ method: 'initialized' })
      this.initialized = true
    } catch (error) {
      const exitResult = await Promise.race([exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), 50))])
      if (exitResult !== null && exitResult !== undefined) {
        const [code] = exitResult as unknown as [number | null]
        throw new CodexProtocolError('SPAWN_FAILED', `${this.host.label} exited during initialization (code ${code}): ${this.stderrTail.trim().slice(-400) || '(no stderr)'}`)
      }
      throw error
    }
  }

  private handleExit(code: number | null): void {
    const wasConnected = this.child !== undefined
    this.child = undefined
    this.initialized = false
    const error = new CodexProtocolError('RPC_DISCONNECTED', `${this.host.label} exited unexpectedly (code ${code})${this.stderrTail.length > 0 ? `: ${this.stderrTail.trim().slice(-300)}` : ''}`)
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.reject(error)
    }
    for (const listener of this.exitListeners) listener(code)
    if (wasConnected) {
      for (const listener of this.errorListeners) listener(error)
    }
  }

  /** One JSON-RPC request; resolves with `result`, rejects on error/timeouts. */
  async request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.child === undefined || this.closed) {
      throw new CodexProtocolError('RPC_DISCONNECTED', `${this.host.label} is not connected`)
    }
    if (method !== 'initialize' && !this.initialized) {
      throw new CodexProtocolError('NOT_INITIALIZED', `cannot send "${method}" before initialize handshake`)
    }
    const id: RequestId = this.nextRequestId++
    const effectiveTimeout = timeoutMs ?? this.options.requestTimeoutMs ?? 60_000
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CodexProtocolError('REQUEST_TIMEOUT', `request "${method}" (id ${id}) timed out after ${effectiveTimeout}ms`))
      }, effectiveTimeout)
      this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject, timer, method })
      this.writeLine({ method, id, params })
    })
  }

  /** Answer a server-initiated request (approval / input). */
  respondToServerRequest(id: RequestId, result: unknown): boolean {
    if (!this.serverRequests.has(id)) return false
    this.serverRequests.delete(id)
    this.writeLine({ id, result })
    return true
  }

  /** Pending server requests (for diagnostics + close-time cancellation). */
  readonly pendingServerRequests = (): ReadonlyArray<{ id: RequestId; method: string; params: unknown }> =>
    [...this.serverRequests.entries()].map(([id, entry]) => ({ id, method: entry.method, params: entry.params }))

  /** Graceful shutdown: cancel server requests, flush writes, close stdin, kill the child. */
  async close(graceMs = 1_500): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const [id] of this.serverRequests) {
      // `cancel` is the universal negative answer for approval-style requests.
      this.writeLine({ id, result: { decision: 'cancel' } })
    }
    this.serverRequests.clear()
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.reject(new CodexProtocolError('RPC_DISCONNECTED', 'connection closed while request was in flight'))
    }
    const child = this.child
    this.child = undefined
    this.initialized = false
    if (child === undefined) return
    // Flush queued writes (cancels) BEFORE closing stdin so the server sees them.
    await this.writing.catch(() => undefined)
    try {
      child.stdin.end()
    } catch { /* already closed */ }
    const exited = waitForExit(child)
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, graceMs)
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, graceMs + 200))])
    clearTimeout(timer)
  }

  // ── JSONL ingest: bounded buffering + malformed accounting ──────────────

  private ingest(chunk: string): void {
    this.buffer += chunk
    // Bounded buffering: a single pathological line must not grow memory.
    if (this.buffer.length > CodexAppServerConnection.MAX_PENDING_BYTES) {
      const cut = this.buffer.indexOf('\n')
      if (cut === -1) {
        this.malformed += 1
        this.buffer = ''
        return
      }
      this.buffer = this.buffer.slice(cut + 1)
      this.malformed += 1
    }
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line === '') continue
      const message = this.parseLine(line)
      if (message === undefined) continue
      this.dispatch(message)
    }
  }

  private parseLine(line: string): CodexInboundMessage | undefined {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      this.malformed += 1
      for (const listener of this.errorListeners) {
        listener(new CodexProtocolError('MALFORMED_RESPONSE', `malformed JSON-L from ${this.host.label}: ${line.slice(0, 120)}`))
      }
      return undefined
    }
    if (typeof raw !== 'object' || raw === null) {
      this.malformed += 1
      return undefined
    }
    const message = raw as Record<string, unknown>
    if (typeof message.id !== 'undefined' && !('method' in message)) {
      // response or error for one of our requests
      if (typeof message.id === 'string' || typeof message.id === 'number') {
        if ('error' in message && typeof message.error === 'object' && message.error !== null) {
          const error = message.error as Record<string, unknown>
          return {
            kind: 'error',
            id: message.id,
            code: typeof error.code === 'number' ? error.code : -32603,
            message: typeof error.message === 'string' ? error.message : 'unknown RPC error',
            data: error.data,
          }
        }
        if ('result' in message) return { kind: 'response', id: message.id, result: message.result }
        this.malformed += 1
        return undefined
      }
    }
    if (typeof message.method === 'string') {
      if ('id' in message) {
        // server-initiated request
        if (typeof message.id === 'string' || typeof message.id === 'number') {
          return { kind: 'server_request', id: message.id, method: message.method, params: message.params }
        }
        this.malformed += 1
        return undefined
      }
      return { kind: 'notification', method: message.method, params: message.params }
    }
    this.malformed += 1
    return undefined
  }

  private dispatch(message: CodexInboundMessage): void {
    if (message.kind === 'response' || message.kind === 'error') {
      const entry = this.pending.get(message.id)
      if (entry === undefined) return // late response for an already-timed-out request
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.kind === 'response') entry.resolve(message.result)
      else entry.reject(new CodexProtocolError('RPC_ERROR', `request "${entry.method}" failed: ${message.message}`, { rpcCode: message.code, rpcData: message.data }))
      return
    }
    if (message.kind === 'server_request') {
      this.serverRequests.set(message.id, { method: message.method, params: message.params })
      for (const listener of this.listeners) listener(message)
      return
    }
    for (const listener of this.listeners) listener(message)
  }

  /** Serialize writes per connection; backpressure-aware. */
  private writeLine(payload: Record<string, unknown>): void {
    const child = this.child
    if (child === undefined) {
      throw new CodexProtocolError('RPC_DISCONNECTED', `${this.host.label} is not connected (write rejected)`)
    }
    const line = `${JSON.stringify(payload)}\n`
    this.writing = this.writing.then(async () => {
      const ok = child.stdin.write(line)
      if (!ok) {
        await new Promise<void>((resolve) => child.stdin.once('drain', () => resolve()))
      }
    })
    // surface write failures to listeners instead of silently dropping
    void this.writing.then(undefined, (error: unknown) => {
      for (const listener of this.errorListeners) listener(error instanceof Error ? error : new CodexProtocolError('WRITE_FAILED', String(error)))
    })
  }
}