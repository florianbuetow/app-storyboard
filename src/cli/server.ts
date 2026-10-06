import { readFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { text } from 'node:stream/consumers'

import {
  ImageScaleError,
  MediaNotFoundError,
} from '../application/graph-folder.js'
import {
  GraphNotFoundError,
  type GraphLibrary,
} from '../application/graph-library.js'
import {
  LmStudioError,
  parseChatRequest,
  type LmStudio,
} from '../application/lmstudio.js'
import { InvalidGraphIdError } from '../domain/graph-id.js'
import { InvalidImageSizeError, parseImageSize } from '../domain/image-size.js'
import {
  InvalidMediaKindError,
  InvalidMediaPathError,
  parseMediaKind,
  UnsupportedMediaFileError,
} from '../domain/media.js'
import { InvalidDocumentError } from '../domain/project.js'

export const APP_NAME = 'app-storyboard'

const HOST = '127.0.0.1'
const PAGE = new URL('../../public/index.html', import.meta.url)
const GRAPHS = '/api/graphs'
const LMSTUDIO = '/api/lmstudio'

export interface RunningServer {
  readonly url: string
  close(): Promise<void>
}

export class PortInUseError extends Error {
  constructor(
    readonly port: number,
    options?: ErrorOptions,
  ) {
    super(`port ${port} is already in use`, options)
    this.name = 'PortInUseError'
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

interface Reply {
  readonly status: number
  readonly headers: OutgoingHttpHeaders
  readonly body: string | Buffer
}

interface Origins {
  readonly hosts: ReadonlySet<string>
  readonly origins: ReadonlySet<string>
}

/** What the routes answer from: the graphs of the data folder and LM Studio for the chat. */
interface Services {
  readonly library: GraphLibrary
  readonly lmStudio: LmStudio
}

const JSON_HEADERS: OutgoingHttpHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

const json = (status: number, value: unknown): Reply => ({
  status,
  headers: JSON_HEADERS,
  body: JSON.stringify(value),
})

/** A document that was never saved is answered with JSON null, not an error. */
const storedJson = (stored: string | null): Reply => ({
  status: 200,
  headers: JSON_HEADERS,
  body: stored === null ? 'null' : stored,
})

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

async function documentBody(request: IncomingMessage): Promise<string> {
  if (!header(request, 'content-type')?.startsWith('application/json')) {
    throw new HttpError(415, 'send the document as application/json')
  }
  return text(request)
}

function fileName(request: IncomingMessage): string {
  const encoded = header(request, 'x-file-name')
  if (encoded === undefined) {
    throw new HttpError(400, 'the X-File-Name header is missing')
  }
  try {
    return decodeURIComponent(encoded)
  } catch {
    throw new HttpError(400, 'the X-File-Name header must be URI-encoded')
  }
}

const notAllowed = (allowed: string): Reply => ({
  status: 405,
  headers: { ...JSON_HEADERS, Allow: allowed },
  body: JSON.stringify({ error: `use ${allowed} here` }),
})

/** `closed` aborts when the client goes away before its answer, which cancels a pending reply of LM Studio. */
async function route(
  request: IncomingMessage,
  services: Services,
  allowed: Origins,
  closed: AbortSignal,
): Promise<Reply> {
  const { library, lmStudio } = services
  const host = request.headers.host
  if (host === undefined || !allowed.hosts.has(host)) {
    return json(403, { error: 'requests must address this server directly' })
  }
  const origin = request.headers.origin
  if (origin !== undefined && !allowed.origins.has(origin)) {
    return json(403, { error: 'cross-origin requests are not allowed' })
  }
  const method = request.method
  const path = new URL(String(request.url), `http://${host}`).pathname

  if (path === '/health') {
    return method === 'GET'
      ? json(200, { app: APP_NAME, status: 'ok', pid: process.pid })
      : notAllowed('GET')
  }
  if (path === '/') {
    if (method !== 'GET') {
      return notAllowed('GET')
    }
    return {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
      body: await readFile(PAGE),
    }
  }
  // The browser bundle of d3, which draws the scene map of the page.
  if (path === '/vendor/d3.min.js') {
    if (method !== 'GET') {
      return notAllowed('GET')
    }
    return {
      status: 200,
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
      // Resolved on request, so commands that never serve the page start without d3.
      body: await readFile(
        new URL('../dist/d3.min.js', import.meta.resolve('d3')),
      ),
    }
  }
  if (path === GRAPHS) {
    if (method === 'GET') {
      return json(200, await library.list())
    }
    if (method === 'POST') {
      return json(201, await library.create(await documentBody(request)))
    }
    return notAllowed('GET, POST')
  }
  if (path.startsWith(`${GRAPHS}/`)) {
    return graphRoute(request, library, path)
  }
  if (path === `${LMSTUDIO}/models`) {
    return method === 'GET'
      ? json(200, { models: await lmStudio.models(closed) })
      : notAllowed('GET')
  }
  if (path === `${LMSTUDIO}/chat`) {
    if (method !== 'POST') {
      return notAllowed('POST')
    }
    const chat = parseChatRequest(await documentBody(request))
    return json(200, { message: await lmStudio.reply(chat, closed) })
  }
  return json(404, { error: `no such endpoint: ${path}` })
}

/** Splits /api/graphs/<id><rest> into the id and the rest, such as /chat. */
function graphTarget(path: string): readonly [string, string] {
  const target = path.slice(`${GRAPHS}/`.length)
  const slash = target.indexOf('/')
  return slash === -1
    ? [target, '']
    : [target.slice(0, slash), target.slice(slash)]
}

/** Serves one graph: its document, /chat, /media uploads, and /media/<images|audio>/<name>. */
async function graphRoute(
  request: IncomingMessage,
  library: GraphLibrary,
  path: string,
): Promise<Reply> {
  const method = request.method
  const [id, rest] = graphTarget(path)
  if (rest === '') {
    if (method === 'GET') {
      const folder = await library.graph(id)
      return storedJson(await folder.readGraph())
    }
    if (method === 'PUT') {
      const folder = await library.graph(id)
      const saved = await folder.writeGraph(await documentBody(request))
      return json(200, { saved })
    }
    return notAllowed('GET, PUT')
  }
  if (rest === '/chat') {
    if (method === 'GET') {
      const folder = await library.graph(id)
      return storedJson(await folder.readChat())
    }
    if (method === 'PUT') {
      const folder = await library.graph(id)
      const saved = await folder.writeChat(await documentBody(request))
      return json(200, { saved })
    }
    return notAllowed('GET, PUT')
  }
  if (rest === '/media') {
    if (method !== 'POST') {
      return notAllowed('POST')
    }
    const folder = await library.graph(id)
    const kind = parseMediaKind(header(request, 'x-media-kind'))
    return json(201, {
      file: await folder.saveMedia(kind, fileName(request), request),
    })
  }
  if (rest.startsWith('/media/')) {
    if (method !== 'GET') {
      return notAllowed('GET')
    }
    const folder = await library.graph(id)
    const size = parseImageSize(
      new URL(String(request.url), 'http://localhost').searchParams.get('size'),
    )
    const media = await folder.readImage(rest.slice('/media/'.length), size)
    return {
      status: 200,
      headers: {
        'Content-Type': media.contentType,
        // Stored names never change content, so a version can be cached for good.
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': 'sandbox',
      },
      body: media.data,
    }
  }
  return json(404, { error: `no such endpoint: ${path}` })
}

function failure(error: unknown, log: (line: string) => void): Reply {
  if (error instanceof HttpError) {
    return json(error.status, { error: error.message })
  }
  if (
    error instanceof InvalidMediaKindError ||
    error instanceof UnsupportedMediaFileError ||
    error instanceof InvalidImageSizeError
  ) {
    return json(400, { error: error.message })
  }
  if (
    error instanceof InvalidGraphIdError ||
    error instanceof GraphNotFoundError ||
    error instanceof InvalidMediaPathError ||
    error instanceof MediaNotFoundError
  ) {
    return json(404, { error: error.message })
  }
  if (
    error instanceof InvalidDocumentError ||
    error instanceof ImageScaleError
  ) {
    return json(422, { error: error.message })
  }
  if (error instanceof LmStudioError) {
    return json(502, { error: error.message })
  }
  log(`request failed: ${String(error)}`)
  return json(500, { error: 'the server failed, see its log' })
}

function send(response: ServerResponse, reply: Reply): void {
  response.writeHead(reply.status, {
    ...reply.headers,
    'Content-Length': Buffer.byteLength(reply.body),
  })
  response.end(reply.body)
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new PortInUseError(port, { cause: error })
          : error,
      )
    })
    server.listen(port, HOST, () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
}

/**
 * Serves the location graph page, the API over the graphs in the data folder, the chat
 * through LM Studio, and /health on 127.0.0.1. Port 0 lets the operating system pick a
 * free port; `url` reports the real one.
 */
export async function startServer(
  port: number,
  library: GraphLibrary,
  lmStudio: LmStudio,
  log: (line: string) => void,
): Promise<RunningServer> {
  let allowed: Origins = { hosts: new Set(), origins: new Set() }
  const server = createServer((request, response) => {
    const closed = new AbortController()
    response.once('close', () => {
      closed.abort()
    })
    void route(request, { library, lmStudio }, allowed, closed.signal)
      .catch((error: unknown) => failure(error, log))
      .then((reply) => {
        send(response, reply)
      })
  })
  const actual = await listen(server, port)
  const hosts = [`${HOST}:${actual}`, `localhost:${actual}`]
  allowed = {
    hosts: new Set(hosts),
    origins: new Set(hosts.map((entry) => `http://${entry}`)),
  }
  return {
    url: `http://${HOST}:${actual}/`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve()
          } else {
            reject(error)
          }
        })
      }),
  }
}
