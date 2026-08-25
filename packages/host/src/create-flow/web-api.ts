import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { GroupHost } from '../group-host.js'
import { GroupError } from '../group-service.js'
import type { CreateFlowArtifactKind, CreateFlowService, CreateFlowStage } from './service.js'

/**
 * Create Flow workspace API. Registered before the broad /groups/api route so
 * the media surface remains a small independent slice of Agent Groups.
 */
export function createCreateFlowWebApi(options: { host: GroupHost; createFlow: CreateFlowService }): WebRoute[] {
  const { host, createFlow } = options
  const handler: WebRoute['handler'] = async (req, res) => {
    try {
      await handleCreateFlowApi(req, res, host, createFlow)
    } catch (error) {
      if (res.writableEnded) return
      if (error instanceof GroupError) {
        sendJson(res, error.code === 'NOT_FOUND' ? 404 : 409, { error: 'group_error', code: error.code, message: error.message })
        return
      }
      sendJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  return [{ kind: 'prefix', path: '/groups/api/create-flow', handler }]
}

export async function handleCreateFlowApi(
  req: IncomingMessage,
  res: ServerResponse,
  host: GroupHost,
  createFlow: CreateFlowService,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const segments = url.pathname.split('/').filter(Boolean)
  const rest = decodePath(segments.slice(3)) // /groups/api/create-flow/:groupId/...
  const method = req.method ?? 'GET'

  if (rest.length === 0 && method === 'GET') {
    sendJson(res, 200, {
      name: 'create-flow',
      paths: [':groupId', ':groupId/artifacts', ':groupId/tts', ':groupId/asr', ':groupId/render'],
      capabilities: createFlow.capabilities(),
    })
    return
  }

  const groupId = rest[0]
  if (!groupId) {
    sendJson(res, 404, { error: 'group id required' })
    return
  }
  host.groups.requireGroup(groupId)

  if (rest.length === 1 && method === 'GET') {
    sendJson(res, 200, await createFlow.status(groupId))
    return
  }

  if (rest.length === 2 && rest[1] === 'artifacts' && method === 'POST') {
    const body = (await readJsonBody(req)) ?? {}
    sendJson(res, 200, await createFlow.addArtifact(groupId, 'User', {
      kind: enumString(body.kind, 'kind', ARTIFACT_KINDS),
      stage: enumString(body.stage, 'stage', STAGES),
      title: stringOf(body.title, 'title'),
      path: optionalString(body.path),
      sourceUrl: optionalString(body.sourceUrl),
      mimeType: optionalString(body.mimeType),
      metadata: recordOf(body.metadata),
    }))
    return
  }

  if (rest.length === 2 && rest[1] === 'tts' && method === 'POST') {
    const body = (await readJsonBody(req)) ?? {}
    sendJson(res, 200, await createFlow.runTts(groupId, 'User', {
      text: stringOf(body.text, 'text'),
      outputPath: optionalString(body.outputPath),
      voice: optionalString(body.voice),
      language: optionalString(body.language),
      title: optionalString(body.title),
    }))
    return
  }

  if (rest.length === 2 && rest[1] === 'asr' && method === 'POST') {
    const body = (await readJsonBody(req)) ?? {}
    sendJson(res, 200, await createFlow.runAsr(groupId, 'User', {
      inputPath: stringOf(body.inputPath, 'inputPath'),
      outputPath: optionalString(body.outputPath),
      language: optionalString(body.language),
      title: optionalString(body.title),
    }))
    return
  }

  if (rest.length === 2 && rest[1] === 'render' && method === 'POST') {
    const body = (await readJsonBody(req)) ?? {}
    sendJson(res, 200, await createFlow.renderVideo(groupId, 'User', {
      visualPath: stringOf(body.visualPath, 'visualPath'),
      audioPath: stringOf(body.audioPath, 'audioPath'),
      subtitlePath: optionalString(body.subtitlePath),
      outputPath: optionalString(body.outputPath),
      fps: optionalNumber(body.fps),
      title: optionalString(body.title),
    }))
    return
  }

  sendJson(res, 404, { error: 'not found', path: rest.join('/') })
}

const STAGES = ['topic', 'research', 'materials', 'script', 'voice', 'captions', 'render'] as const satisfies readonly CreateFlowStage[]
const ARTIFACT_KINDS = ['topic', 'source', 'material', 'script', 'audio', 'captions', 'video', 'other'] as const satisfies readonly CreateFlowArtifactKind[]
const MAX_BODY = 1024 * 1024

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function stringOf(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`invalid argument "${name}"`)
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return String(value)
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error('invalid numeric value')
  return parsed
}

function enumString<T extends string>(value: unknown, name: string, values: readonly T[]): T {
  const parsed = stringOf(value, name) as T
  if (!values.includes(parsed)) throw new Error(`invalid argument "${name}": ${parsed}`)
  return parsed
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function decodePath(parts: string[]): string[] {
  return parts.map((part) => {
    try { return decodeURIComponent(part) } catch { return part }
  })
}
