/**
 * Deterministic fake `codex app-server` JSONL server (requirement §19).
 *
 * Implements just enough of the app-server protocol (codex-cli 0.147.0 wire
 * shape, see docs/CODEX_APP_SERVER_PROTOCOL.md) to drive the real transport
 * and provider code with zero processes and zero credentials:
 *
 * ```text
 * initialize ─ initialized ─ thread/start ─ turn/start
 *   ─ notifications (item/agentMessage/delta, turn/completed, …)
 *   ─ server requests (item/commandExecution/requestApproval, …)
 * ```
 *
 * The fake reads JSONL from `child.stdin` (what the transport writes) and the
 * test drives the server side by writing into `child.stdout`; `child` exposes
 * the same shape as a real child process.
 */

import { PassThrough } from 'node:stream'

export interface FakeChildOptions {
  readonly stderr?: boolean
}

export type FakeRequest = { readonly id: string | number; readonly method: string; readonly params: Record<string, unknown> }

/** Handler receives (params, requestId, server); return a result to respond.
 * Return undefined to silently ignore (test drives the response later). */
export type FakeHandler = (params: Record<string, unknown>, id: string | number, server: FakeCodexServer) => unknown | Promise<unknown> | undefined

export class FakeCodexServer {
  readonly child: FakeChild
  readonly received: FakeRequest[] = []
  readonly serverRequests: Array<{ id: string | number; method: string; params: Record<string, unknown> }> = []
  private readonly handlers = new Map<string, FakeHandler>()
  private autoRespond = true
  exitCode: number | null = null
  emittedExit = false

  constructor(bin: string, options: { autoRespond?: boolean } = {}) {
    this.autoRespond = options.autoRespond ?? true
    const stdout = new PassThrough()
    const stdin = new PassThrough()
    const stderr = new PassThrough()
    this.child = new FakeChild(bin, stdout, stdin, stderr)
    stdin.setEncoding('utf8')
    stdin.on('data', (chunk: string) => this.ingest(chunk))
    void this.setHandler('initialize', () => ({ userAgent: 'fake-codex', codexHome: '/tmp/codex-home', platformFamily: 'unix', platformOs: 'linux' }))
  }

  setHandler(method: string, handler: FakeHandler): this {
    this.handlers.set(method, handler)
    return this
  }

  /** Turn auto-responding off for a method (tests respond manually). */
  withoutAutoResponse(method: string): this {
    this.setHandler(method, () => undefined)
    return this
  }

  private ingest(line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const id = message.id as string | number | undefined
    const method = typeof message.method === 'string' ? message.method : undefined
    const hasResult = 'result' in message
    if (method === undefined && !hasResult) return
    const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>
    if (id !== undefined && (hasResult || typeof id === 'string' || typeof id === 'number')) {
      if (hasResult) {
        // client answering one of OUR server requests
        this.received.push({ id, method: 'client-response', params: (typeof message.result === 'object' && message.result !== null ? message.result : {}) as Record<string, unknown> })
        for (const pending of this.serverRequests) {
          if (pending.id === id) void this.onAnswer?.(pending, message.result)
        }
      } else {
        // client request
        this.received.push({ id, method: method as string, params })
        const handler = this.handlers.get(method as string)
        if (handler !== undefined && this.autoRespond) {
          try {
            const result = handler(params, id, this)
            if (result !== undefined) {
              void Promise.resolve(result).then((resolved) => this.respond(id, resolved))
            }
          } catch (error) {
            // Like the real app-server: a failed handler answers with a
            // JSON-RPC error instead of hanging the client request.
            this.respondError(id, -32000, error instanceof Error ? error.message : String(error))
          }
        }
      }
    } else {
      // client notification (initialized)
      this.received.push({ id: 'notification', method: method as string, params })
    }
  }

  /** Called when the client answers a server request we issued. */
  onAnswer: ((request: { id: string | number; method: string; params: Record<string, unknown> }, result: unknown) => void) | undefined

  /** Server → client: respond to a client request. */
  respond(id: string | number, result: unknown): void {
    this.writeToTransport({ id, result })
  }

  respondError(id: string | number, code: number, message: string): void {
    this.writeToTransport({ id, error: { code, message } })
  }

  /** Server → client: emit a typed notification. */
  emitNotification(method: string, params: unknown): void {
    this.writeToTransport({ method, params })
  }

  /** Server → client: issue a server-initiated request (approval/input). */
  requestFromServer(method: string, id: string | number, params: unknown): void {
    this.serverRequests.push({ id, method, params: (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown> })
    this.writeToTransport({ method, id, params })
  }

  private writeToTransport(payload: Record<string, unknown>): void {
    this.child.stdout.write(`${JSON.stringify(payload)}\n`)
  }

  /** Simulate process exit. */
  exit(code: number): void {
    this.exitCode = code
    if (this.emittedExit) return
    this.emittedExit = true
    this.child.emitExit(code)
  }

  // ── convenience scripting helpers for the standard thread/turn flow ──────

  /** Thread id of the most recent thread/start or thread/resume. */
  lastThreadId(): string | undefined {
    const request = [...this.received].reverse().find((r) => r.method === 'thread/start' || r.method === 'thread/resume')
    return request?.params?.threadId as string | undefined
  }

  /** Wire turn id the server knows (from turn/start requests). */
  lastTurnWireId(): string | undefined {
    const request = [...this.received].reverse().find((r) => r.method === 'turn/start')
    return request?.params?.clientUserMessageId as string | undefined
  }

  /** Finish the most recent turn with status completed/failed/interrupted. */
  finishTurn(wireId: string, status: 'completed' | 'failed' | 'interrupted', extra?: Record<string, unknown>): void {
    const threadId = this.lastThreadId() ?? 'thr-1'
    this.emitNotification('turn/completed', {
      threadId,
      turn: { id: wireId, status, items: status === 'completed' ? [{ type: 'agentMessage', id: 'msg-1', text: 'agent summary text' }] : [], error: status === 'failed' ? { message: extra?.error ?? 'turn failed (server error)' } : null, ...extra },
    })
  }
}

/** A child-process-shaped object backed by PassThrough streams. */
export class FakeChild {
  readonly stdout: PassThrough
  readonly stdin: PassThrough
  readonly stderr: PassThrough
  private readonly exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  private readonly errorListeners: Array<(error: Error) => void> = []
  killed: NodeJS.Signals | undefined
  endedStdin = false

  constructor(
    readonly binPath: string,
    stdout: PassThrough,
    stdin: PassThrough,
    stderr: PassThrough,
  ) {
    this.stdout = stdout
    this.stdin = stdin
    this.stderr = stderr
  }

  emitExit(code: number | null): void {
    for (const listener of [...this.exitListeners]) listener(code, null)
  }

  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit' | 'error', listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)): this {
    if (event === 'exit') this.exitListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void)
    else this.errorListeners.push(listener as (error: Error) => void)
    return this
  }

  kill(signal?: NodeJS.Signals): void {
    this.killed = signal
    this.emitExit(null)
  }
}

/** Build a process host over one fake server (for provider tests). */
export function fakeCodexHost(server: FakeCodexServer, bin = 'fake-codex') {
  return {
    label: `${bin} app-server (fake)`,
    spawn(): FakeChild {
      return server.child
    },
  }
}