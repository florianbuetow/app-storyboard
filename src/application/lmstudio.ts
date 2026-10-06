import {
  InvalidDocumentError,
  isFields,
  parseJsonDocument,
} from '../domain/project.js'

/** LM Studio did not answer, answered with an error, or answered something malformed. */
export class LmStudioError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LmStudioError'
  }
}

/** A model that LM Studio has loaded and that can chat. */
export interface ChatModel {
  readonly id: string
  /** Whether LM Studio lists tool use among the capabilities of the model. */
  readonly tools: boolean
  /** Whether the model also reads images: LM Studio calls it a vlm. */
  readonly vision: boolean
}

/** A tool the model wants to call, with its arguments as JSON text. */
interface ToolCall {
  readonly id: string
  readonly type: 'function'
  readonly function: { readonly name: string; readonly arguments: string }
}

/** A reply of the model, in the shape the conversation takes it back. */
export interface AssistantMessage {
  readonly role: 'assistant'
  readonly content: string
  readonly tool_calls?: readonly ToolCall[]
}

/** One step of a chat: the model, the conversation so far, and the tools it may call. */
export interface ChatRequest {
  readonly model: string
  readonly messages: readonly unknown[]
  readonly tools: readonly unknown[]
}

const CHAT_REQUEST = 'the chat request'
const MODELS = '/api/v0/models'
const COMPLETIONS = '/v1/chat/completions'
/** The model types of LM Studio that chat; embedding models do not. */
const CHAT_TYPES: ReadonlySet<unknown> = new Set(['llm', 'vlm'])
/** The model list comes quickly or not at all, unlike a reply, which may take minutes. */
const MODELS_TIMEOUT_MS = 5000
/** Thinking models may put their reasoning into the content between these tags. */
const REASONING = /<think>[\s\S]*?<\/think>/g
/** Error messages quote LM Studio's answers up to this many characters. */
const QUOTED = 300

const quote = (value: unknown): string =>
  String(JSON.stringify(value)).slice(0, QUOTED)

/** Reads a request of the page, such as {"model": "…", "messages": […], "tools": […]}. */
export function parseChatRequest(json: string): ChatRequest {
  const request = parseJsonDocument(CHAT_REQUEST, json)
  if (!isFields(request)) {
    throw new InvalidDocumentError(CHAT_REQUEST, 'it must be an object')
  }
  const { model, messages, tools } = request
  if (typeof model !== 'string' || model.trim() === '') {
    throw new InvalidDocumentError(CHAT_REQUEST, 'model must be non-empty text')
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new InvalidDocumentError(
      CHAT_REQUEST,
      'messages must be a non-empty list',
    )
  }
  if (!Array.isArray(tools)) {
    throw new InvalidDocumentError(CHAT_REQUEST, 'tools must be a list')
  }
  return { model, messages, tools }
}

/**
 * Talks to the LM Studio server at `url`: its REST API lists the models, its
 * OpenAI-compatible API answers the chat.
 */
export class LmStudio {
  /** The base URL, such as http://127.0.0.1:1234, without a trailing slash. */
  readonly url: string

  constructor(url: string) {
    this.url = url.replace(/\/+$/, '')
  }

  /** The loaded models that can chat, in LM Studio's order. `signal` cancels the request. */
  async models(signal: AbortSignal): Promise<ChatModel[]> {
    const answer = await this.call(MODELS, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(MODELS_TIMEOUT_MS)]),
    })
    const data = isFields(answer) ? answer['data'] : undefined
    if (!Array.isArray(data)) {
      throw new LmStudioError(
        `LM Studio answered ${MODELS} without a data list: ${quote(answer)}`,
      )
    }
    return data.flatMap(chatModel)
  }

  /** The next reply of the model to the conversation: text, tool calls, or both. */
  async reply(
    request: ChatRequest,
    signal: AbortSignal,
  ): Promise<AssistantMessage> {
    const { model, messages, tools } = request
    const answer = await this.call(COMPLETIONS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        ...(tools.length === 0 ? {} : { tools }),
        stream: false,
      }),
      signal,
    })
    return assistantMessage(answer)
  }

  /** Sends one request and reads its JSON answer; every failure is an LmStudioError. */
  private async call(path: string, init: RequestInit): Promise<unknown> {
    let response: Response
    let text: string
    try {
      response = await fetch(`${this.url}${path}`, init)
      text = await response.text()
    } catch (error: unknown) {
      throw new LmStudioError(
        `LM Studio at ${this.url} did not answer ${path}: ${reason(error)}`,
        { cause: error },
      )
    }
    if (!response.ok) {
      throw new LmStudioError(
        `LM Studio answered ${path} with ${response.status}: ${errorDetail(text)}`,
      )
    }
    try {
      return JSON.parse(text) as unknown
    } catch (error: unknown) {
      throw new LmStudioError(
        `LM Studio answered ${path} with malformed JSON: ${text.slice(0, QUOTED)}`,
        { cause: error },
      )
    }
  }
}

/** Why a request failed: the network error behind fetch's "fetch failed", if there is one. */
function reason(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }
  return error.cause instanceof Error ? error.cause.message : error.message
}

/** LM Studio's words in an error answer, {"error": "…"} or {"error": {"message": "…"}}, else the answer. */
function errorDetail(text: string): string {
  let answer: unknown
  try {
    answer = JSON.parse(text)
  } catch {
    return text.slice(0, QUOTED)
  }
  const error = isFields(answer) ? answer['error'] : undefined
  const message = isFields(error) ? error['message'] : error
  return typeof message === 'string' ? message : quote(answer)
}

/** An entry of the model list as the chat offers it: nothing unless the model is loaded and chats. */
function chatModel(entry: unknown, index: number): ChatModel[] {
  if (!isFields(entry)) {
    throw malformedModel(entry, index)
  }
  const { id, type, state, capabilities } = entry
  if (typeof id !== 'string' || typeof state !== 'string') {
    throw malformedModel(entry, index)
  }
  if (state !== 'loaded' || !CHAT_TYPES.has(type)) {
    return []
  }
  return [
    {
      id,
      tools: Array.isArray(capabilities) && capabilities.includes('tool_use'),
      vision: type === 'vlm',
    },
  ]
}

const malformedModel = (entry: unknown, index: number): LmStudioError =>
  new LmStudioError(
    `LM Studio answered ${MODELS} with a malformed model #${index}: ${quote(entry)}`,
  )

/** The message of the first choice, without the reasoning a thinking model put into its content. */
function assistantMessage(answer: unknown): AssistantMessage {
  const choices = isFields(answer) ? answer['choices'] : undefined
  const choice: unknown = Array.isArray(choices) ? choices[0] : undefined
  const message = isFields(choice) ? choice['message'] : undefined
  if (!isFields(message)) {
    throw new LmStudioError(
      `LM Studio answered ${COMPLETIONS} without a message: ${quote(answer)}`,
    )
  }
  const { content, tool_calls: calls } = message
  if (
    content !== null &&
    content !== undefined &&
    typeof content !== 'string'
  ) {
    throw new LmStudioError(
      `LM Studio answered ${COMPLETIONS} with content that is not text: ${quote(content)}`,
    )
  }
  const text = (content ?? '').replace(REASONING, '').trim()
  const toolCalls: unknown = calls ?? []
  if (!Array.isArray(toolCalls)) {
    throw new LmStudioError(
      `LM Studio answered ${COMPLETIONS} with tool_calls that are not a list: ${quote(calls)}`,
    )
  }
  return toolCalls.length === 0
    ? { role: 'assistant', content: text }
    : { role: 'assistant', content: text, tool_calls: toolCalls.map(toolCall) }
}

function toolCall(value: unknown, index: number): ToolCall {
  const called = isFields(value) ? value['function'] : undefined
  const id = isFields(value) ? value['id'] : undefined
  if (
    typeof id !== 'string' ||
    !isFields(called) ||
    typeof called['name'] !== 'string' ||
    typeof called['arguments'] !== 'string'
  ) {
    throw new LmStudioError(
      `LM Studio answered ${COMPLETIONS} with a malformed tool call #${index}: ${quote(value)}`,
    )
  }
  return {
    id,
    type: 'function',
    function: { name: called['name'], arguments: called['arguments'] },
  }
}
