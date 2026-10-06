import { afterEach, describe, expect, it } from 'vitest'

import {
  LmStudio,
  LmStudioError,
  parseChatRequest,
  type ChatRequest,
} from '../../src/application/lmstudio.js'
import { InvalidDocumentError } from '../../src/domain/project.js'
import {
  answerJson,
  answerNever,
  answerText,
  completion,
  MODEL_LIST,
  startFakeLmStudio,
  unusedUrl,
  type FakeLmStudio,
} from '../fixtures/lmstudio.js'

const fakes: FakeLmStudio[] = []

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((started) => started.close()))
})

async function fake(): Promise<FakeLmStudio> {
  const started = await startFakeLmStudio()
  fakes.push(started)
  return started
}

const MODELS = '/api/v0/models'
const COMPLETIONS = '/v1/chat/completions'
const open = (): AbortSignal => new AbortController().signal

const REQUEST: ChatRequest = {
  model: 'qwen/qwen3.6-35b-a3b',
  messages: [{ role: 'user', content: 'Add a crypt' }],
  tools: [{ type: 'function', function: { name: 'get_graph' } }],
}

async function failure(promise: Promise<unknown>): Promise<LmStudioError> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(LmStudioError)
  expect((error as LmStudioError).name).toBe('LmStudioError')
  return error as LmStudioError
}

describe('LmStudio.models', () => {
  it('lists the loaded models that chat, in order, and whether they use tools', async () => {
    const lmStudio = await fake()
    lmStudio.answer(MODELS, answerJson(200, MODEL_LIST))
    const models = await new LmStudio(lmStudio.url).models(open())
    expect(models).toEqual([
      { id: 'qwen/qwen3.6-35b-a3b', tools: true, vision: true },
      { id: 'minicpm5-2b', tools: false, vision: false },
    ])
    expect(lmStudio.received).toEqual([
      { method: 'GET', path: MODELS, contentType: undefined, body: '' },
    ])
  })

  it('drops trailing slashes from its URL', async () => {
    const lmStudio = await fake()
    lmStudio.answer(MODELS, answerJson(200, { data: [] }))
    const client = new LmStudio(`${lmStudio.url}//`)
    expect(client.url).toBe(lmStudio.url)
    expect(await client.models(open())).toEqual([])
    expect(lmStudio.received.map((entry) => entry.path)).toEqual([MODELS])
  })

  it.each([
    [{ models: [] }, '{"models":[]}'],
    [[], '[]'],
    [null, 'null'],
  ])('refuses the answer %j without a data list', async (answer, quoted) => {
    const lmStudio = await fake()
    lmStudio.answer(MODELS, answerJson(200, answer))
    const error = await failure(new LmStudio(lmStudio.url).models(open()))
    expect(error.message).toBe(
      `LM Studio answered ${MODELS} without a data list: ${quoted}`,
    )
  })

  it.each([
    ['not an object', 'qwen'],
    ['null', null],
    ['without an id', { type: 'llm', state: 'loaded' }],
    ['without a state', { id: 'qwen', type: 'llm' }],
  ])('refuses a model %s', async (_problem, model) => {
    const lmStudio = await fake()
    lmStudio.answer(
      MODELS,
      answerJson(200, { data: [MODEL_LIST.data[0], model] }),
    )
    const error = await failure(new LmStudio(lmStudio.url).models(open()))
    expect(error.message).toBe(
      `LM Studio answered ${MODELS} with a malformed model #1: ${JSON.stringify(model)}`,
    )
  })

  it('quotes at most 300 characters of what it refuses', async () => {
    const lmStudio = await fake()
    const answer = { models: 'x'.repeat(400) }
    lmStudio.answer(MODELS, answerJson(200, answer))
    const error = await failure(new LmStudio(lmStudio.url).models(open()))
    expect(error.message).toBe(
      `LM Studio answered ${MODELS} without a data list: ${JSON.stringify(answer).slice(0, 300)}`,
    )
  })

  it.each([
    ['an error text', answerJson(500, { error: 'boom' }), 'boom'],
    [
      'an error object',
      answerJson(400, { error: { message: 'no such model', type: 'x' } }),
      'no such model',
    ],
    ['plain text', answerText(503, 'busy'), 'busy'],
    [
      'JSON without a message',
      answerJson(500, { error: { code: 7 } }),
      '{"error":{"code":7}}',
    ],
    ['a JSON list', answerJson(500, ['busy']), '["busy"]'],
    [
      'spaced JSON without a message',
      answerText(500, '{ "error": { "code": 7 } }'),
      '{"error":{"code":7}}',
    ],
  ])('reports an error answer with %s', async (_kind, answer, detail) => {
    const lmStudio = await fake()
    lmStudio.answer(MODELS, answer)
    const error = await failure(new LmStudio(lmStudio.url).models(open()))
    expect(error.message).toMatch(
      new RegExp(`^LM Studio answered ${MODELS} with (500|400|503): `),
    )
    expect(error.message.endsWith(`: ${detail}`)).toBe(true)
  })

  it('cuts a long error text to 300 characters', async () => {
    const lmStudio = await fake()
    lmStudio.answer(MODELS, answerText(500, 'y'.repeat(400)))
    const error = await failure(new LmStudio(lmStudio.url).models(open()))
    expect(error.message).toBe(
      `LM Studio answered ${MODELS} with 500: ${'y'.repeat(300)}`,
    )
  })

  it('reports an answer that is not JSON', async () => {
    const lmStudio = await fake()
    lmStudio.answer(MODELS, answerText(200, 'z'.repeat(400)))
    const error = await failure(new LmStudio(lmStudio.url).models(open()))
    expect(error.message).toBe(
      `LM Studio answered ${MODELS} with malformed JSON: ${'z'.repeat(300)}`,
    )
    expect(error.cause).toBeInstanceOf(SyntaxError)
  })

  it('reports that nothing answers at its URL', async () => {
    const url = await unusedUrl()
    const error = await failure(new LmStudio(url).models(open()))
    expect(error.message).toBe(
      `LM Studio at ${url} did not answer ${MODELS}: connect ECONNREFUSED ${url.slice('http://'.length)}`,
    )
    expect(error.cause).toBeInstanceOf(TypeError)
  })

  it('gives up when its signal aborts', async () => {
    const lmStudio = await fake()
    lmStudio.answer(MODELS, answerNever)
    const controller = new AbortController()
    const models = new LmStudio(lmStudio.url).models(controller.signal)
    await expect.poll(() => lmStudio.received.length).toBe(1)
    controller.abort('the page has gone')
    const error = await failure(models)
    expect(error.message).toBe(
      `LM Studio at ${lmStudio.url} did not answer ${MODELS}: the page has gone`,
    )
    await lmStudio.abandoned
  })
})

describe('LmStudio.reply', () => {
  it('sends the conversation and the tools, and answers the text without its reasoning', async () => {
    const lmStudio = await fake()
    lmStudio.answer(
      COMPLETIONS,
      answerJson(
        200,
        completion({
          content:
            '<think>The user wants a crypt.</think>\n\nDone: the crypt is there. ',
          reasoning_content: 'ignored',
        }),
      ),
    )
    const message = await new LmStudio(lmStudio.url).reply(REQUEST, open())
    expect(message).toEqual({
      role: 'assistant',
      content: 'Done: the crypt is there.',
    })
    expect(lmStudio.received).toHaveLength(1)
    const [sent] = lmStudio.received
    expect(sent?.method).toBe('POST')
    expect(sent?.path).toBe(COMPLETIONS)
    expect(sent?.contentType).toBe('application/json')
    expect(JSON.parse(String(sent?.body))).toEqual({
      model: REQUEST.model,
      messages: REQUEST.messages,
      tools: REQUEST.tools,
      stream: false,
    })
  })

  it('removes every reasoning block', async () => {
    const lmStudio = await fake()
    lmStudio.answer(
      COMPLETIONS,
      answerJson(
        200,
        completion({ content: '<think>a</think>One <think>b</think>two' }),
      ),
    )
    const message = await new LmStudio(lmStudio.url).reply(REQUEST, open())
    expect(message.content).toBe('One two')
  })

  it('sends no tools when there are none', async () => {
    const lmStudio = await fake()
    lmStudio.answer(COMPLETIONS, answerJson(200, completion({ content: 'Hi' })))
    await new LmStudio(lmStudio.url).reply({ ...REQUEST, tools: [] }, open())
    const sent = JSON.parse(String(lmStudio.received[0]?.body)) as object
    expect(sent).not.toHaveProperty('tools')
  })

  it('answers the tool calls in their order', async () => {
    const lmStudio = await fake()
    lmStudio.answer(
      COMPLETIONS,
      answerJson(
        200,
        completion({
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'get_graph', arguments: '{}' },
            },
            {
              id: 'call-2',
              type: 'function',
              function: {
                name: 'create_location',
                arguments: '{"name":"Crypt"}',
              },
            },
          ],
        }),
      ),
    )
    const message = await new LmStudio(lmStudio.url).reply(REQUEST, open())
    expect(message).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'get_graph', arguments: '{}' },
        },
        {
          id: 'call-2',
          type: 'function',
          function: { name: 'create_location', arguments: '{"name":"Crypt"}' },
        },
      ],
    })
  })

  it.each([
    ['no content and no tool calls', {}, ''],
    ['an empty list of tool calls', { content: 'Hi', tool_calls: [] }, 'Hi'],
    ['null tool calls', { content: 'Hi', tool_calls: null }, 'Hi'],
  ])('answers only the text for %s', async (_case, message, content) => {
    const lmStudio = await fake()
    lmStudio.answer(COMPLETIONS, answerJson(200, completion(message)))
    expect(await new LmStudio(lmStudio.url).reply(REQUEST, open())).toEqual({
      role: 'assistant',
      content,
    })
  })

  it.each([
    [{ choices: [] }, 'without a message: {"choices":[]}'],
    [{ choices: 'x' }, 'without a message: {"choices":"x"}'],
    [{ choices: [{}] }, 'without a message: {"choices":[{}]}'],
    [[], 'without a message: []'],
    [completion({ content: 7 }), 'with content that is not text: 7'],
    [
      completion({ content: '', tool_calls: {} }),
      'with tool_calls that are not a list: {}',
    ],
    [
      completion({ tool_calls: [{ id: 'a', function: { name: 'x' } }] }),
      'with a malformed tool call #0: {"id":"a","function":{"name":"x"}}',
    ],
    [
      completion({
        tool_calls: [
          { id: 'a', function: { name: 'x', arguments: '{}' } },
          { function: { name: 'x', arguments: '{}' } },
        ],
      }),
      'with a malformed tool call #1: {"function":{"name":"x","arguments":"{}"}}',
    ],
    [
      completion({ tool_calls: [{ id: 'a', function: { arguments: '{}' } }] }),
      'with a malformed tool call #0: {"id":"a","function":{"arguments":"{}"}}',
    ],
    [
      completion({ tool_calls: [{ id: 'a' }] }),
      'with a malformed tool call #0: {"id":"a"}',
    ],
    [
      completion({ tool_calls: ['call'] }),
      'with a malformed tool call #0: "call"',
    ],
  ])('refuses the answer %j', async (answer, problem) => {
    const lmStudio = await fake()
    lmStudio.answer(COMPLETIONS, answerJson(200, answer))
    const error = await failure(
      new LmStudio(lmStudio.url).reply(REQUEST, open()),
    )
    expect(error.message).toBe(`LM Studio answered ${COMPLETIONS} ${problem}`)
  })

  it('reports an error answer', async () => {
    const lmStudio = await fake()
    lmStudio.answer(
      COMPLETIONS,
      answerJson(404, { error: 'Model "x" not found' }),
    )
    const error = await failure(
      new LmStudio(lmStudio.url).reply(REQUEST, open()),
    )
    expect(error.message).toBe(
      `LM Studio answered ${COMPLETIONS} with 404: Model "x" not found`,
    )
  })

  it('cancels the request to LM Studio when its signal aborts', async () => {
    const lmStudio = await fake()
    lmStudio.answer(COMPLETIONS, answerNever)
    const controller = new AbortController()
    const reply = new LmStudio(lmStudio.url).reply(REQUEST, controller.signal)
    await expect.poll(() => lmStudio.received.length).toBe(1)
    controller.abort(new Error('the page has gone'))
    const error = await failure(reply)
    expect(error.message).toBe(
      `LM Studio at ${lmStudio.url} did not answer ${COMPLETIONS}: the page has gone`,
    )
    await lmStudio.abandoned
  })
})

describe('parseChatRequest', () => {
  it('reads the model, the messages, and the tools', () => {
    expect(parseChatRequest(JSON.stringify(REQUEST))).toEqual(REQUEST)
    expect(
      parseChatRequest(
        JSON.stringify({ model: 'm', messages: [{}], tools: [] }),
      ),
    ).toEqual({ model: 'm', messages: [{}], tools: [] })
  })

  it.each([
    ['{', 'it is not valid JSON'],
    ['[]', 'it must be an object'],
    ['null', 'it must be an object'],
    ['{"messages":[{}],"tools":[]}', 'model must be non-empty text'],
    [
      '{"model":" ","messages":[{}],"tools":[]}',
      'model must be non-empty text',
    ],
    ['{"model":7,"messages":[{}],"tools":[]}', 'model must be non-empty text'],
    [
      '{"model":"m","messages":[],"tools":[]}',
      'messages must be a non-empty list',
    ],
    [
      '{"model":"m","messages":{},"tools":[]}',
      'messages must be a non-empty list',
    ],
    ['{"model":"m","messages":[{}]}', 'tools must be a list'],
  ])('refuses %s', (json, problem) => {
    expect(() => parseChatRequest(json)).toThrow(
      new InvalidDocumentError('the chat request', problem),
    )
  })
})
