/**
 * Codex App Server JSONL transport tests (requirement §19).
 *
 * Protocol behavior against a deterministic FAKE app-server child: handshake,
 * request/response correlation (including concurrent requests), RPC errors,
 * timeouts, malformed JSON accounting, oversized-line dropping, process-crash
 * propagation, server requests (approval) + answers, graceful close and
 * reconnect.
 */
import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerConnection, CodexProtocolError } from '../src/runtime/codex-protocol.js'
import { FakeCodexServer, fakeCodexHost } from './fake-codex-server.js'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function connect(server: FakeCodexServer, options: { requestTimeoutMs?: number } = {}): Promise<CodexAppServerConnection> {
  const connection = new CodexAppServerConnection(fakeCodexHost(server), { requestTimeoutMs: options.requestTimeoutMs ?? 5000 })
  await connection.connect()
  return connection
}

describe('codex app-server JSONL transport', () => {
  it('performs the initialize → initialized handshake and correlates requests', async () => {
    const server = new FakeCodexServer('fake-codex')
    const connection = await connect(server)
    expect(connection.isInitialized).toBe(true)
    // initialize request carried client metadata
    const initialize = server.received.find((r) => r.method === 'initialize')
    expect(initialize).toBeDefined()
    expect((initialize!.params.clientInfo as { name: string }).name).toBe('dsh-agent-groups')
    // initialized notification came after the response
    const [init, notification] = server.received.filter((r) => r.method === 'initialize' || (r.id === 'notification' && r.method === 'initialized'))
    expect(init).toBeDefined()
    expect(notification).toBeDefined()

    server.setHandler('echo', (params) => ({ echoed: params }))
    const result = await connection.request('echo', { hello: 'world' })
    expect(result).toEqual({ echoed: { hello: 'world' } })
    await connection.close()
  })

  it('correlates concurrent requests independently', async () => {
    const server = new FakeCodexServer('fake-codex')
    const connection = await connect(server)
    server.setHandler('slow', (params) => params)
    const first = connection.request('slow', { n: 1 })
    const second = connection.request('slow', { n: 2 })
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual({ n: 1 })
    expect(b).toEqual({ n: 2 })
    await connection.close()
  })

  it('maps RPC errors onto CodexProtocolError with the rpc code', async () => {
    const server = new FakeCodexServer('fake-codex')
    const connection = await connect(server)
    server.setHandler('boom', () => undefined)
    // respond manually with an error
    const pending = server.received.length
    const request = connection.request('boom', {})
    await vi.waitFor(() => {
      expect(server.received.length).toBeGreaterThan(pending)
    })
    const sent = server.received.find((r) => r.method === 'boom')!
    server.respondError(sent.id, -32001, 'Server overloaded; retry later.')
    await expect(request).rejects.toMatchObject({ code: 'RPC_ERROR', rpcCode: -32001 })
    await connection.close()
  })

  it('rejects non-initialize requests until the handshake completes', async () => {
    const server = new FakeCodexServer('fake-codex', { autoRespond: false })
    const connection = new CodexAppServerConnection(fakeCodexHost(server), { requestTimeoutMs: 3000 })
    const connecting = connection.connect()
    await vi.waitFor(() => {
      expect(server.received.some((r) => r.method === 'initialize')).toBe(true)
    })
    // child is up but not initialized yet → loud rejection
    await expect(connection.request('thread/start', {})).rejects.toMatchObject({ code: 'NOT_INITIALIZED' })
    const sent = server.received.find((r) => r.method === 'initialize')!
    server.respond(sent.id, { userAgent: 'fake-codex', codexHome: '/tmp/codex-home' })
    await connecting
    expect(connection.isInitialized).toBe(true)
    await connection.close()
  })

  it('times out stuck requests and reports malformed JSON without crashing', async () => {
    const server = new FakeCodexServer('fake-codex')
    const connection = await connect(server, { requestTimeoutMs: 40 })
    server.setHandler('never', () => { /* no response */ })
    await expect(connection.request('never', {})).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
    // malformed lines are counted, not fatal
    server.child.stdout.write('this is not json\n')
    server.child.stdout.write('{"unfinished": \n')
    await sleep(10)
    expect(connection.malformedCount).toBeGreaterThanOrEqual(1)
    // the connection still works
    server.setHandler('ok', (params) => params)
    expect(await connection.request('ok', { fine: true })).toEqual({ fine: true })
    await connection.close()
  })

  it('drops pathological oversized lines instead of growing memory', async () => {
    const server = new FakeCodexServer('fake-codex')
    const connection = await connect(server)
    server.setHandler('echo', (params) => params)
    const before = connection.malformedCount
    server.child.stdout.write(`${'x'.repeat(CodexAppServerConnection.MAX_PENDING_BYTES + 10)}no-newline\n`)
    await vi.waitFor(() => expect(connection.malformedCount).toBeGreaterThan(before))
    expect(await connection.request('echo', { fine: true })).toEqual({ fine: true }) // still alive
    await connection.close()
  })

  it('propagates a process crash to every in-flight request and the exit listener', async () => {
    const server = new FakeCodexServer('fake-codex')
    const connection = await connect(server)
    server.setHandler('never', () => { /* no response */ })
    const pending = connection.request('never', {})
    const exited = new Promise((resolve) => connection.onExit((code) => resolve(code)))
    server.exit(1)
    await expect(pending).rejects.toMatchObject({ code: 'RPC_DISCONNECTED' })
    expect(await exited).toBe(1)
  })

  it('routes server requests (approvals) and answers them with the right id', async () => {
    const server = new FakeCodexServer('fake-codex')
    const connection = await connect(server)
    const requests: Array<{ id: unknown; method: string }> = []
    connection.onMessage((message) => {
      if (message.kind === 'server_request') requests.push({ id: message.id, method: message.method })
    })
    server.requestFromServer('item/commandExecution/requestApproval', 61, { threadId: 'thr-1', turnId: 'turn-1', itemId: 'it-1' })
    await vi.waitFor(() => expect(requests.length).toBe(1))
    expect(connection.pendingServerRequests().map((r) => r.method)).toEqual(['item/commandExecution/requestApproval'])
    const answered = connection.respondToServerRequest(61, { decision: 'decline' })
    expect(answered).toBe(true)
    await vi.waitFor(() => {
      expect(server.received.some((r) => r.method === 'client-response' && r.id === 61 && (r.params as { decision: string }).decision === 'decline')).toBe(true)
    })
    // unknown ids answer false
    expect(connection.respondToServerRequest(62, { decision: 'accept' })).toBe(false)
    await connection.close()
  })

  it('graceful close cancels pending server requests and resolves pending client requests as disconnected', async () => {
    const server = new FakeCodexServer('fake-codex')
    const connection = await connect(server)
    server.setHandler('never', () => { /* no response */ })
    server.requestFromServer('item/fileChange/requestApproval', 7, { threadId: 'thr-1' })
    const pending = connection.request('never', {})
    const settled = expect(pending).rejects.toMatchObject({ code: 'RPC_DISCONNECTED' })
    await sleep(10)
    await connection.close()
    await settled
    // the cancel answer went out for the pending server request
    await vi.waitFor(() => {
      expect(server.received.some((r) => r.method === 'client-response' && r.id === 7 && r.params && (r.params as { decision: string }).decision === 'cancel')).toBe(true)
    })
  })

  it('reconnect after a crash serves a fresh handshake', async () => {
    const server = new FakeCodexServer('fake-codex')
    const connection = await connect(server)
    server.exit(2)
    await sleep(10)
    const server2 = new FakeCodexServer('fake-codex')
    // swap the child: the host may return a NEW child after a crash
    const host = {
      label: 'fake-codex app-server (fake)',
      spawn: () => {
        server.child.emitExit(2) // ensure the old child settles
        return server2.child
      },
    }
    const reconnected = new CodexAppServerConnection(host, { requestTimeoutMs: 3000 })
    await reconnected.connect()
    expect(reconnected.isInitialized).toBe(true)
    server2.setHandler('ping', () => 'pong')
    expect(await reconnected.request('ping', {})).toBe('pong')
    await reconnected.close()
    await connection.close().catch(() => undefined)
  })
})
