import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { text } from 'node:stream/consumers'

/** A request the fake LM Studio received. */
interface Received {
  readonly method: string
  readonly path: string
  readonly contentType: string | undefined
  readonly body: string
}

/** Answers one request; `response` stays open until the answer ends it. */
export type Answer = (response: ServerResponse) => void

/** A local stand-in for the LM Studio server that answers each path as a test sets it up. */
export interface FakeLmStudio {
  readonly url: string
  readonly received: Received[]
  answer(path: string, answer: Answer): void
  /** Resolves once the client of a request the fake never answers has gone. */
  readonly abandoned: Promise<void>
  close(): Promise<void>
}

export const answerJson =
  (status: number, value: unknown): Answer =>
  (response) => {
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(value))
  }

export const answerText =
  (status: number, body: string): Answer =>
  (response) => {
    response.writeHead(status, { 'Content-Type': 'text/plain' })
    response.end(body)
  }

/** Never answers, like LM Studio while a model thinks. */
export const answerNever: Answer = () => undefined

/** The model list as LM Studio 0.3 answers /api/v0/models. */
export const MODEL_LIST = {
  object: 'list',
  data: [
    {
      id: 'qwen/qwen3.6-35b-a3b',
      object: 'model',
      type: 'vlm',
      state: 'loaded',
      max_context_length: 262144,
      loaded_context_length: 32768,
      capabilities: ['tool_use'],
    },
    {
      id: 'qwen3-0.6b',
      object: 'model',
      type: 'llm',
      state: 'not-loaded',
      max_context_length: 40960,
      capabilities: ['tool_use'],
    },
    {
      id: 'text-embedding-nomic-embed-text-v1.5',
      object: 'model',
      type: 'embeddings',
      state: 'loaded',
      max_context_length: 2048,
    },
    {
      id: 'minicpm5-2b',
      object: 'model',
      type: 'llm',
      state: 'loaded',
      max_context_length: 131072,
    },
  ],
}

/** A completion as LM Studio answers /v1/chat/completions without streaming. */
export function completion(message: Record<string, unknown>): unknown {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    model: 'qwen/qwen3.6-35b-a3b',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', ...message },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }
}

export async function startFakeLmStudio(): Promise<FakeLmStudio> {
  const answers = new Map<string, Answer>()
  const received: Received[] = []
  let gone = (): void => undefined
  const abandoned = new Promise<void>((resolve) => {
    gone = resolve
  })
  const server = createServer((request, response) => {
    void text(request).then((body) => {
      const path = String(request.url)
      received.push({
        method: String(request.method),
        path,
        contentType: request.headers['content-type'],
        body,
      })
      response.once('close', () => {
        if (!response.writableEnded) {
          gone()
        }
      })
      const answer = answers.get(path)
      if (answer === undefined) {
        answerJson(404, { error: `Unexpected endpoint ${path}` })(response)
      } else {
        answer(response)
      }
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    answer: (path, answer) => {
      answers.set(path, answer)
    },
    abandoned,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          resolve()
        })
      }),
  }
}

/** The URL of a port on 127.0.0.1 that nothing listens on. */
export async function unusedUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve()
    })
  })
  return `http://127.0.0.1:${port}`
}
