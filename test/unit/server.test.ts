import { mkdir, mkdtemp, readdir, readFile, stat } from 'node:fs/promises'
import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'

import { GraphLibrary } from '../../src/application/graph-library.js'
import { LmStudio } from '../../src/application/lmstudio.js'
import {
  APP_NAME,
  PortInUseError,
  startServer,
  type RunningServer,
} from '../../src/cli/server.js'
import { emptyGraph } from '../../src/domain/project.js'
import {
  answerJson,
  answerNever,
  completion,
  MODEL_LIST,
  startFakeLmStudio,
  unusedUrl,
  type FakeLmStudio,
} from '../fixtures/lmstudio.js'
import {
  projectWithExtras,
  validChat,
  validProject,
} from '../fixtures/project.js'

interface Response {
  readonly status: number
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly body: Buffer
}

interface RequestOptions {
  readonly headers?: OutgoingHttpHeaders
  readonly body?: string | Buffer
}

const running: RunningServer[] = []
const fakes: FakeLmStudio[] = []
const logged: string[] = []

/** An LM Studio address for the tests that never reach it. */
const NO_LM_STUDIO = 'http://127.0.0.1:9'

/** A valid graph id that no test creates. */
const UNKNOWN = 'unknown-0a1b2c3d'

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()))
  await Promise.all(fakes.splice(0).map((fake) => fake.close()))
  logged.length = 0
})

async function serve(
  lmStudio: string = NO_LM_STUDIO,
): Promise<{ server: RunningServer; data: string }> {
  const data = await mkdtemp(join(tmpdir(), 'server-test-'))
  const library = await GraphLibrary.open(data)
  const server = await startServer(
    0,
    library,
    new LmStudio(lmStudio),
    (line) => {
      logged.push(line)
    },
  )
  running.push(server)
  return { server, data }
}

function send(
  server: RunningServer,
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  const url = new URL(path, server.url)
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      url,
      { method, headers: options.headers },
      (incoming) => {
        const chunks: Buffer[] = []
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
        incoming.on('end', () => {
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks),
          })
        })
      },
    )
    outgoing.on('error', reject)
    outgoing.end(options.body)
  })
}

/**
 * Sends raw bytes, for requests that the HTTP client cannot produce. The request must ask
 * the server to close the connection after its answer, which ends the exchange.
 */
function sendRaw(server: RunningServer, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const port = Number(new URL(server.url).port)
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(raw)
    })
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    socket.on('error', reject)
  })
}

const bodyJson = (response: Response): unknown =>
  JSON.parse(response.body.toString('utf8'))

const sendJson = (
  server: RunningServer,
  method: string,
  path: string,
  value: unknown,
): Promise<Response> =>
  send(server, method, path, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  })

async function createGraph(
  server: RunningServer,
  title = 'Harbor Town',
): Promise<string> {
  const response = await sendJson(server, 'POST', '/api/graphs', { title })
  expect(response.status).toBe(201)
  return (bodyJson(response) as { id: string }).id
}

const upload = (
  server: RunningServer,
  id: string,
  name: string,
  bytes: Buffer,
): Promise<Response> =>
  send(server, 'POST', `/api/graphs/${id}/media`, {
    headers: {
      'X-Media-Kind': 'image',
      'X-File-Name': encodeURIComponent(name),
      'Content-Type': 'image/svg+xml',
    },
    body: bytes,
  })

describe('startServer', () => {
  it('listens on 127.0.0.1 and reports the chosen port', async () => {
    const { server } = await serve()
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect(server.url).not.toBe('http://127.0.0.1:0/')
  })

  it('answers /health with the app name and process id', async () => {
    const { server } = await serve()
    const response = await send(server, 'GET', '/health')
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe(
      'application/json; charset=utf-8',
    )
    expect(response.headers['cache-control']).toBe('no-store')
    expect(bodyJson(response)).toEqual({
      app: APP_NAME,
      status: 'ok',
      pid: process.pid,
    })
    expect(APP_NAME).toBe('app-storyboard')
  })

  it('serves the location graph page', async () => {
    const { server } = await serve()
    const response = await send(server, 'GET', '/')
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['content-length']).toBe(
      String(response.body.length),
    )
    expect(response.body.toString('utf8')).toContain(
      '<title>Location Graph</title>',
    )
  })

  it('serves the browser bundle of d3 for the scene map', async () => {
    const { server } = await serve()
    const response = await send(server, 'GET', '/vendor/d3.min.js')
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe(
      'text/javascript; charset=utf-8',
    )
    expect(response.headers['cache-control']).toBe('no-cache')
    expect(response.body.toString('utf8')).toMatch(
      /^\/\/ https:\/\/d3js\.org v7\./,
    )
  })

  it.each([
    ['POST', '/vendor/d3.min.js', 'GET'],
    ['POST', '/health', 'GET'],
    ['DELETE', '/', 'GET'],
    ['PUT', '/api/graphs', 'GET, POST'],
    ['POST', `/api/graphs/${UNKNOWN}`, 'GET, PUT'],
    ['DELETE', `/api/graphs/${UNKNOWN}/chat`, 'GET, PUT'],
    ['GET', `/api/graphs/${UNKNOWN}/media`, 'POST'],
    ['PUT', `/api/graphs/${UNKNOWN}/media/images/a-1.png`, 'GET'],
    ['POST', '/api/lmstudio/models', 'GET'],
    ['GET', '/api/lmstudio/chat', 'POST'],
  ])(
    'refuses %s %s and names the allowed methods',
    async (method, path, allowed) => {
      const { server } = await serve()
      const response = await send(server, method, path)
      expect(response.status).toBe(405)
      expect(response.headers['allow']).toBe(allowed)
      expect(response.headers['content-type']).toBe(
        'application/json; charset=utf-8',
      )
      expect(bodyJson(response)).toEqual({ error: `use ${allowed} here` })
    },
  )

  it.each([
    ['/nope?x=1', '/nope'],
    ['/api/project', '/api/project'],
    ['/api/chat', '/api/chat'],
    ['/media/images/a-1.png', '/media/images/a-1.png'],
    ['/api/graphs/../../etc/passwd', '/etc/passwd'],
    [`/api/graphs/${UNKNOWN}/notes`, `/api/graphs/${UNKNOWN}/notes`],
    [`/api/graphs/${UNKNOWN}/chat/`, `/api/graphs/${UNKNOWN}/chat/`],
    [`/api/graphs/${UNKNOWN}/graph.json`, `/api/graphs/${UNKNOWN}/graph.json`],
  ])('reports the unknown endpoint %s', async (path, reported) => {
    const { server } = await serve()
    const response = await send(server, 'GET', path)
    expect(response.status).toBe(404)
    expect(bodyJson(response)).toEqual({
      error: `no such endpoint: ${reported}`,
    })
  })

  it('lists no graphs in a new data folder', async () => {
    const { server } = await serve()
    const response = await send(server, 'GET', '/api/graphs')
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe(
      'application/json; charset=utf-8',
    )
    expect(response.headers['cache-control']).toBe('no-store')
    expect(bodyJson(response)).toEqual([])
  })

  it('creates a graph in its own folder and lists it', async () => {
    const { server, data } = await serve()
    const response = await sendJson(server, 'POST', '/api/graphs', {
      title: 'Harbor Town',
    })
    expect(response.status).toBe(201)
    expect(response.headers['content-type']).toBe(
      'application/json; charset=utf-8',
    )
    const created = bodyJson(response) as { id: string; title: string }
    expect(created.id).toMatch(/^harbor-town-[0-9a-f]{8}$/)
    expect(created).toEqual({ id: created.id, title: 'Harbor Town' })
    const file = join(data, 'graphs', created.id, 'graph.json')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(
      emptyGraph('Harbor Town'),
    )

    const listed = await send(server, 'GET', '/api/graphs')
    expect(bodyJson(listed)).toEqual([
      {
        id: created.id,
        title: 'Harbor Town',
        updated: (await stat(file)).mtime.toISOString(),
        locations: 0,
      },
    ])
  })

  it.each<[string, OutgoingHttpHeaders, string, number, string]>([
    [
      'plain text',
      { 'Content-Type': 'text/plain' },
      '{"title":"x"}',
      415,
      'send the document as application/json',
    ],
    [
      'broken JSON',
      { 'Content-Type': 'application/json' },
      '{"title":',
      422,
      'the new graph is invalid: it is not valid JSON',
    ],
    [
      'a missing title',
      { 'Content-Type': 'application/json' },
      '{}',
      422,
      'the new graph is invalid: title must be non-empty text',
    ],
  ])(
    'refuses to create a graph from %s',
    async (_name, headers, body, status, error) => {
      const { server, data } = await serve()
      const response = await send(server, 'POST', '/api/graphs', {
        headers,
        body,
      })
      expect(response.status).toBe(status)
      expect(bodyJson(response)).toEqual({ error })
      expect(await readdir(data)).toEqual([])
    },
  )

  it('returns and saves the graph', async () => {
    const { server, data } = await serve()
    const id = await createGraph(server)
    const loaded = await send(server, 'GET', `/api/graphs/${id}`)
    expect(loaded.status).toBe(200)
    expect(loaded.headers['content-type']).toBe(
      'application/json; charset=utf-8',
    )
    expect(loaded.headers['cache-control']).toBe('no-store')
    expect(bodyJson(loaded)).toEqual(emptyGraph('Harbor Town'))

    const changed = { ...projectWithExtras(), title: 'Harbor at night' }
    const saved = await sendJson(server, 'PUT', `/api/graphs/${id}`, changed)
    expect(saved.status).toBe(200)
    expect(bodyJson(saved)).toEqual({ saved: `graphs/${id}/graph.json` })
    expect(bodyJson(await send(server, 'GET', `/api/graphs/${id}`))).toEqual(
      changed,
    )
    expect(await readFile(join(data, 'graphs', id, 'graph.json'), 'utf8')).toBe(
      `${JSON.stringify(changed, null, 2)}\n`,
    )
    const [listed] = bodyJson(await send(server, 'GET', '/api/graphs')) as {
      title: string
      locations: number
    }[]
    expect(listed).toMatchObject({ id, title: 'Harbor at night', locations: 2 })
  })

  it('keeps the graphs apart', async () => {
    const { server } = await serve()
    const first = await createGraph(server, 'First')
    const second = await createGraph(server, 'Second')
    await sendJson(server, 'PUT', `/api/graphs/${first}`, validProject())
    await sendJson(server, 'PUT', `/api/graphs/${first}/chat`, validChat)
    expect(
      bodyJson(await send(server, 'GET', `/api/graphs/${second}`)),
    ).toEqual(emptyGraph('Second'))
    expect(
      bodyJson(await send(server, 'GET', `/api/graphs/${second}/chat`)),
    ).toBeNull()
  })

  it('saves and returns the chat', async () => {
    const { server, data } = await serve()
    const id = await createGraph(server)
    const missing = await send(server, 'GET', `/api/graphs/${id}/chat`)
    expect(missing.status).toBe(200)
    expect(missing.headers['content-type']).toBe(
      'application/json; charset=utf-8',
    )
    expect(bodyJson(missing)).toBeNull()

    const saved = await sendJson(
      server,
      'PUT',
      `/api/graphs/${id}/chat`,
      validChat,
    )
    expect(saved.status).toBe(200)
    expect(bodyJson(saved)).toEqual({ saved: `graphs/${id}/chat.json` })
    expect(
      bodyJson(await send(server, 'GET', `/api/graphs/${id}/chat`)),
    ).toEqual(validChat)
    expect(
      JSON.parse(await readFile(join(data, 'graphs', id, 'chat.json'), 'utf8')),
    ).toEqual(validChat)
  })

  it('refuses invalid documents with the reason', async () => {
    const { server } = await serve()
    const id = await createGraph(server)
    const graph = await sendJson(server, 'PUT', `/api/graphs/${id}`, {
      ...validProject(),
      version: 1,
    })
    expect(graph.status).toBe(422)
    expect(bodyJson(graph)).toEqual({
      error: `graphs/${id}/graph.json is invalid: version must be 2`,
    })
    const chat = await sendJson(server, 'PUT', `/api/graphs/${id}/chat`, [
      { role: 'robot' },
    ])
    expect(chat.status).toBe(422)
    expect(bodyJson(chat)).toEqual({
      error: `graphs/${id}/chat.json is invalid: messages[0].role must be "user", "assistant", or "note"`,
    })
    expect(bodyJson(await send(server, 'GET', `/api/graphs/${id}`))).toEqual(
      emptyGraph('Harbor Town'),
    )
  })

  it('accepts JSON that names its character set', async () => {
    const { server } = await serve()
    const id = await createGraph(server)
    const response = await send(server, 'PUT', `/api/graphs/${id}/chat`, {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(validChat),
    })
    expect(response.status).toBe(200)
  })

  it.each([[undefined], ['text/plain']])(
    'refuses documents sent as %s',
    async (contentType) => {
      const { server } = await serve()
      const id = await createGraph(server)
      const headers: OutgoingHttpHeaders =
        contentType === undefined ? {} : { 'Content-Type': contentType }
      for (const path of [`/api/graphs/${id}`, `/api/graphs/${id}/chat`]) {
        const response = await send(server, 'PUT', path, {
          headers,
          body: JSON.stringify(validChat),
        })
        expect(response.status).toBe(415)
        expect(bodyJson(response)).toEqual({
          error: 'send the document as application/json',
        })
      }
    },
  )

  it('stores uploaded media in the folder of its graph and serves it back', async () => {
    const { server, data } = await serve()
    const id = await createGraph(server)
    const other = await createGraph(server, 'Other')
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
    const uploaded = await upload(server, id, 'Harbor Café.svg', bytes)
    expect(uploaded.status).toBe(201)
    const { file } = bodyJson(uploaded) as { file: string }
    expect(file).toMatch(/^images\/harbor-cafe-[0-9a-f]{8}\.svg$/)
    expect(await readFile(join(data, 'graphs', id, file))).toEqual(bytes)
    expect(await readdir(join(data, 'graphs', other))).toEqual(['graph.json'])

    const media = await send(server, 'GET', `/api/graphs/${id}/media/${file}`)
    expect(media.status).toBe(200)
    expect(media.headers['content-type']).toBe('image/svg+xml')
    expect(media.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(media.headers['x-content-type-options']).toBe('nosniff')
    expect(media.headers['content-security-policy']).toBe('sandbox')
    expect(media.body).toEqual(bytes)

    const elsewhere = await send(
      server,
      'GET',
      `/api/graphs/${other}/media/${file}`,
    )
    expect(elsewhere.status).toBe(404)
    expect(bodyJson(elsewhere)).toEqual({
      error: `no such media file: ${file}`,
    })
  })

  it('serves smaller versions of an image and refuses unknown sizes', async () => {
    const { server, data } = await serve()
    const id = await createGraph(server)
    const png = await sharp({
      create: { width: 1000, height: 500, channels: 3, background: '#3d6fb6' },
    })
      .png()
      .toBuffer()
    const { file } = bodyJson(
      await send(server, 'POST', `/api/graphs/${id}/media`, {
        headers: { 'X-Media-Kind': 'image', 'X-File-Name': 'wide.png' },
        body: png,
      }),
    ) as { file: string }

    const small = await send(
      server,
      'GET',
      `/api/graphs/${id}/media/${file}?size=200`,
    )
    expect(small.status).toBe(200)
    expect(small.headers['content-type']).toBe('image/webp')
    expect(small.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    )
    const { width, height } = await sharp(small.body).metadata()
    expect([width, height]).toEqual([200, 100])
    expect(
      await readFile(
        join(data, 'graphs', id, 'scaled', '200', `${file.slice(7)}.webp`),
      ),
    ).toEqual(small.body)

    const odd = await send(
      server,
      'GET',
      `/api/graphs/${id}/media/${file}?size=300`,
    )
    expect(odd.status).toBe(400)
    expect(bodyJson(odd)).toEqual({
      error: 'size must be one of 200, 400, 800, 1600, got "300"',
    })
  })

  it('answers 422 when an image cannot be scaled', async () => {
    const { server } = await serve()
    const id = await createGraph(server)
    const { file } = bodyJson(
      await send(server, 'POST', `/api/graphs/${id}/media`, {
        headers: { 'X-Media-Kind': 'image', 'X-File-Name': 'broken.png' },
        body: 'not a picture',
      }),
    ) as { file: string }
    const response = await send(
      server,
      'GET',
      `/api/graphs/${id}/media/${file}?size=400`,
    )
    expect(response.status).toBe(422)
    expect(bodyJson(response)).toEqual({
      error: `cannot make a smaller version of ${file}`,
    })
  })

  it.each<[string, OutgoingHttpHeaders, string]>([
    [
      'a missing kind',
      { 'X-File-Name': 'a.png' },
      'media kind is missing, expected "image" or "audio"',
    ],
    [
      'an unknown kind',
      { 'X-Media-Kind': 'video', 'X-File-Name': 'a.mp4' },
      'media kind must be "image" or "audio", got "video"',
    ],
    [
      'a missing name',
      { 'X-Media-Kind': 'image' },
      'the X-File-Name header is missing',
    ],
    [
      'a badly encoded name',
      { 'X-Media-Kind': 'image', 'X-File-Name': '%E0%A4%A.png' },
      'the X-File-Name header must be URI-encoded',
    ],
    [
      'an unsupported file',
      { 'X-Media-Kind': 'audio', 'X-File-Name': 'a.png' },
      '"a.png" is not a supported audio file, use one of: aac, flac, m4a, mp3, oga, ogg, opus, wav, webm',
    ],
  ])('refuses an upload with %s', async (_name, headers, error) => {
    const { server, data } = await serve()
    const id = await createGraph(server)
    const response = await send(server, 'POST', `/api/graphs/${id}/media`, {
      headers,
      body: 'x',
    })
    expect(response.status).toBe(400)
    expect(bodyJson(response)).toEqual({ error })
    expect(await readdir(join(data, 'graphs', id))).toEqual(['graph.json'])
  })

  it.each([
    ['images/gone-1.png', 'no such media file: images/gone-1.png'],
    ['images/Bad.png', 'not a media file path: images/Bad.png'],
    [
      'images%2F..%2F..%2Fgraph.json',
      'not a media file path: images%2F..%2F..%2Fgraph.json',
    ],
    ['', 'not a media file path: '],
  ])('answers GET media/%s with 404', async (file, error) => {
    const { server } = await serve()
    const id = await createGraph(server)
    const response = await send(
      server,
      'GET',
      `/api/graphs/${id}/media/${file}`,
    )
    expect(response.status).toBe(404)
    expect(bodyJson(response)).toEqual({ error })
  })

  it.each([
    ['GET', ''],
    ['PUT', ''],
    ['GET', '/chat'],
    ['PUT', '/chat'],
    ['POST', '/media'],
    ['GET', '/media/images/a-1.png'],
  ])('answers %s on an unknown graph%s with 404', async (method, rest) => {
    const { server, data } = await serve()
    const path = `/api/graphs/${UNKNOWN}${rest}`
    const response =
      method === 'GET'
        ? await send(server, method, path)
        : await sendJson(server, method, path, [])
    expect(response.status).toBe(404)
    expect(bodyJson(response)).toEqual({ error: `no such graph: ${UNKNOWN}` })
    expect(await readdir(data)).toEqual([])
  })

  it.each([
    ['Harbor-0a1b2c3d', 'Harbor-0a1b2c3d'],
    ['harbor', 'harbor'],
    ['..%2F..%2Fetc', '..%2F..%2Fetc'],
    ['..%2f-0a1b2c3d', '..%2f-0a1b2c3d'],
    ['a.b-0a1b2c3d', 'a.b-0a1b2c3d'],
    ['', ''],
  ])('answers an invalid graph id %j with 404', async (id, named) => {
    const { server, data } = await serve()
    for (const rest of ['', '/chat', '/media/images/a-1.png']) {
      const response = await send(server, 'GET', `/api/graphs/${id}${rest}`)
      expect(response.status).toBe(404)
      expect(bodyJson(response)).toEqual({ error: `not a graph id: ${named}` })
    }
    const written = await sendJson(server, 'PUT', `/api/graphs/${id}`, {})
    expect(written.status).toBe(404)
    expect(await readdir(data)).toEqual([])
  })

  it('resolves dot segments before it routes', async () => {
    const { server } = await serve()
    const id = await createGraph(server)
    const port = new URL(server.url).port
    const raw = await sendRaw(
      server,
      `GET /api/graphs/${id}/media/../../../graphs HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
    )
    expect(raw).toMatch(/^HTTP\/1\.1 200 /)
    expect(raw).toContain(`"id":"${id}"`)
    const encoded = await send(
      server,
      'GET',
      `/api/graphs/${id}/media/%2e%2e/%2e%2e/%2e%2e/graphs`,
    )
    expect(encoded.status).toBe(200)
  })

  it('accepts localhost as host and origin', async () => {
    const { server } = await serve()
    const id = await createGraph(server)
    const port = new URL(server.url).port
    const response = await send(server, 'PUT', `/api/graphs/${id}/chat`, {
      headers: {
        Host: `localhost:${port}`,
        Origin: `http://localhost:${port}`,
        'Content-Type': 'application/json',
      },
      body: '[]',
    })
    expect(response.status).toBe(200)
    const own = await send(server, 'GET', '/health', {
      headers: { Origin: `http://127.0.0.1:${port}` },
    })
    expect(own.status).toBe(200)
  })

  it.each<[string, RequestOptions, string]>([
    [
      'a foreign host',
      { headers: { Host: 'attacker.example' } },
      'requests must address this server directly',
    ],
    [
      'a host on another port',
      { headers: { Host: '127.0.0.1:1' } },
      'requests must address this server directly',
    ],
    [
      'a foreign origin',
      { headers: { Origin: 'http://attacker.example' } },
      'cross-origin requests are not allowed',
    ],
  ])('refuses requests with %s', async (_name, options, error) => {
    const { server } = await serve()
    for (const path of ['/health', '/api/graphs']) {
      const response = await send(server, 'GET', path, options)
      expect(response.status).toBe(403)
      expect(bodyJson(response)).toEqual({ error })
    }
  })

  it('refuses an HTTP/1.0 request without a host', async () => {
    const { server } = await serve()
    const raw = await sendRaw(server, 'GET /health HTTP/1.0\r\n\r\n')
    expect(raw).toMatch(/^HTTP\/1\.1 403 /)
    expect(raw).toContain(
      '{"error":"requests must address this server directly"}',
    )
  })

  it('logs unexpected failures and hides their details', async () => {
    const { server, data } = await serve()
    const id = await createGraph(server)
    await mkdir(join(data, 'graphs', id, 'chat.json'))
    const response = await send(server, 'GET', `/api/graphs/${id}/chat`)
    expect(response.status).toBe(500)
    expect(bodyJson(response)).toEqual({
      error: 'the server failed, see its log',
    })
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatch(/^request failed: Error: EISDIR/)
  })

  it('fails with PortInUseError when the port is taken', async () => {
    const { server, data } = await serve()
    const port = Number(new URL(server.url).port)
    const library = await GraphLibrary.open(data)
    let caught: unknown
    try {
      running.push(
        await startServer(
          port,
          library,
          new LmStudio(NO_LM_STUDIO),
          () => undefined,
        ),
      )
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PortInUseError)
    const error = caught as PortInUseError
    expect(error.name).toBe('PortInUseError')
    expect(error.message).toBe(`port ${port} is already in use`)
    expect(error.port).toBe(port)
    expect((error.cause as NodeJS.ErrnoException).code).toBe('EADDRINUSE')
  })

  it('stops listening when closed and refuses to close twice', async () => {
    const { server } = await serve()
    running.splice(0)
    await server.close()
    await expect(send(server, 'GET', '/health')).rejects.toThrow()
    await expect(server.close()).rejects.toThrow()
  })
})

describe('the LM Studio routes', () => {
  async function serveWithLmStudio(): Promise<{
    server: RunningServer
    lmStudio: FakeLmStudio
  }> {
    const lmStudio = await startFakeLmStudio()
    fakes.push(lmStudio)
    const { server } = await serve(lmStudio.url)
    return { server, lmStudio }
  }

  const CHAT = {
    model: 'qwen/qwen3.6-35b-a3b',
    messages: [{ role: 'user', content: 'Add a crypt' }],
    tools: [],
  }

  it('lists the loaded models that chat', async () => {
    const { server, lmStudio } = await serveWithLmStudio()
    lmStudio.answer('/api/v0/models', answerJson(200, MODEL_LIST))
    const response = await send(server, 'GET', '/api/lmstudio/models')
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe(
      'application/json; charset=utf-8',
    )
    expect(bodyJson(response)).toEqual({
      models: [
        { id: 'qwen/qwen3.6-35b-a3b', tools: true, vision: true },
        { id: 'minicpm5-2b', tools: false, vision: false },
      ],
    })
  })

  it('answers the next message of the model', async () => {
    const { server, lmStudio } = await serveWithLmStudio()
    lmStudio.answer(
      '/v1/chat/completions',
      answerJson(200, completion({ content: 'The crypt is there.' })),
    )
    const response = await sendJson(server, 'POST', '/api/lmstudio/chat', CHAT)
    expect(response.status).toBe(200)
    expect(bodyJson(response)).toEqual({
      message: { role: 'assistant', content: 'The crypt is there.' },
    })
    expect(JSON.parse(String(lmStudio.received[0]?.body))).toEqual({
      model: CHAT.model,
      messages: CHAT.messages,
      stream: false,
    })
  })

  it('refuses a chat request that is not JSON or not complete', async () => {
    const { server, lmStudio } = await serveWithLmStudio()
    const plain = await send(server, 'POST', '/api/lmstudio/chat', {
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello',
    })
    expect(plain.status).toBe(415)
    const incomplete = await sendJson(server, 'POST', '/api/lmstudio/chat', {
      model: 'm',
      messages: [],
      tools: [],
    })
    expect(incomplete.status).toBe(422)
    expect(bodyJson(incomplete)).toEqual({
      error: 'the chat request is invalid: messages must be a non-empty list',
    })
    expect(lmStudio.received).toEqual([])
  })

  it('answers 502 with the reason when LM Studio fails', async () => {
    const url = await unusedUrl()
    const { server } = await serve(url)
    const response = await send(server, 'GET', '/api/lmstudio/models')
    expect(response.status).toBe(502)
    expect(bodyJson(response)).toEqual({
      error: `LM Studio at ${url} did not answer /api/v0/models: connect ECONNREFUSED ${url.slice('http://'.length)}`,
    })
    expect(logged).toEqual([])
  })

  it('cancels the reply of LM Studio when the page goes away', async () => {
    const { server, lmStudio } = await serveWithLmStudio()
    lmStudio.answer('/v1/chat/completions', answerNever)
    const outgoing = httpRequest(new URL('/api/lmstudio/chat', server.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    outgoing.on('error', () => undefined)
    outgoing.end(JSON.stringify(CHAT))
    await expect.poll(() => lmStudio.received.length).toBe(1)
    outgoing.destroy()
    await lmStudio.abandoned
  })
})
