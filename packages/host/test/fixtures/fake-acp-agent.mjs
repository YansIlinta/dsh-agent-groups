import readline from 'node:readline'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const statePath = process.argv[2]
const state = statePath && existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : { nextSession: 1, sessions: {} }
const pendingPrompts = new Map()
const pendingClientRequests = new Map()
let nextClientRequest = 1000

function persist() {
  if (statePath) writeFileSync(statePath, JSON.stringify(state))
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value = {}) { send({ jsonrpc: '2.0', id, result: value }) }
function error(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }) }
function update(sessionId, value) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } })
}

async function prompt(message) {
  const { id, params } = message
  const session = state.sessions[params.sessionId]
  if (!session) return error(id, -32602, 'unknown session')
  const text = params.prompt.find((block) => block.type === 'text')?.text ?? ''
  session.prompts.push(text)
  persist()
  if (text.includes('crash-process')) {
    process.stdout.write('{malformed json\n')
    process.exit(23)
  }
  update(params.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } })
  update(params.sessionId, { sessionUpdate: 'tool_call', toolCallId: `tool-${session.prompts.length}`, title: 'Fake edit', kind: 'edit', status: 'in_progress', content: [], locations: [] })
  if (text.includes('permission')) {
    const requestId = nextClientRequest++
    pendingClientRequests.set(requestId, { promptId: id, sessionId: params.sessionId, text })
    send({
      jsonrpc: '2.0',
      id: requestId,
      method: 'session/request_permission',
      params: {
        sessionId: params.sessionId,
        toolCall: { toolCallId: `tool-${session.prompts.length}`, title: 'Allow fake edit?', kind: 'edit', status: 'pending', content: [], locations: [] },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
        ],
      },
    })
    return
  }
  if (text.includes('wait-for-cancel')) {
    pendingPrompts.set(params.sessionId, id)
    return
  }
  update(params.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: `tool-${session.prompts.length}`, status: 'completed' })
  update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `reply:${text}:count=${session.prompts.length}` } })
  result(id, { stopReason: 'end_turn' })
}

function handle(message) {
  if (message.method === undefined && pendingClientRequests.has(message.id)) {
    const pending = pendingClientRequests.get(message.id)
    pendingClientRequests.delete(message.id)
    const selected = message.result?.outcome?.optionId ?? 'cancelled'
    update(pending.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `permission:${selected}` } })
    result(pending.promptId, { stopReason: 'end_turn' })
    return
  }
  if (message.method === 'initialize') {
    result(message.id, {
      protocolVersion: 1,
      agentInfo: { name: 'fake-acp-agent', version: '1.0.0' },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: { resume: {}, list: {}, close: {}, additionalDirectories: {} },
      },
      _meta: { steering: { supported: true } },
    })
  } else if (message.method === 'session/new') {
    const sessionId = `fake-${state.nextSession++}`
    state.sessions[sessionId] = { prompts: [], cwd: message.params.cwd }
    persist()
    result(message.id, {
      sessionId,
      configOptions: [
        { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: 'fake-default', options: [{ value: 'fake-default', name: 'Default' }, { value: 'fake-pro', name: 'Pro' }] },
        { type: 'select', id: 'effort', name: 'Effort', category: 'thought_level', currentValue: 'medium', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
      ],
    })
  } else if (message.method === 'session/resume' || message.method === 'session/load') {
    if (!state.sessions[message.params.sessionId]) return error(message.id, -32602, 'resume failed')
    result(message.id, {})
  } else if (message.method === 'session/set_config_option') {
    result(message.id, { configOptions: [] })
  } else if (message.method === 'session/prompt') {
    void prompt(message)
  } else if (message.method === '_session/steering') {
    const text = message.params.prompt.find((block) => block.type === 'text')?.text ?? ''
    update(message.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `steered:${text}` } })
    result(message.id, { outcome: 'injected' })
  } else if (message.method === 'session/cancel') {
    const promptId = pendingPrompts.get(message.params.sessionId)
    if (promptId !== undefined) {
      pendingPrompts.delete(message.params.sessionId)
      result(promptId, { stopReason: 'cancelled' })
    }
  } else if (message.method === 'session/close') {
    result(message.id, {})
  } else if (message.id !== undefined) {
    error(message.id, -32601, `unknown method ${message.method}`)
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  try { handle(JSON.parse(line)) } catch (cause) { process.stderr.write(`${cause?.stack ?? cause}\n`) }
})
