import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import {
  GraphFolder,
  isMissing,
  MediaNotFoundError,
  randomHex,
} from '../../src/application/graph-folder.js'
import {
  InvalidMediaPathError,
  UnsupportedMediaFileError,
} from '../../src/domain/media.js'
import { InvalidDocumentError } from '../../src/domain/project.js'
import {
  projectWithExtras,
  validChat,
  validProject,
} from '../fixtures/project.js'

const NAME = 'graphs/harbor-town-0a1b2c3d'

async function graphFolder(): Promise<GraphFolder> {
  return new GraphFolder(await mkdtemp(join(tmpdir(), 'graph-folder-')), NAME)
}

const formatted = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`

async function rejection(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation()
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error
    }
    throw error
  }
  throw new Error('expected the operation to reject')
}

describe('randomHex', () => {
  it('returns 8 random hex characters', () => {
    const values = new Set(Array.from({ length: 20 }, randomHex))
    for (const value of values) {
      expect(value).toMatch(/^[0-9a-f]{8}$/)
    }
    expect(values.size).toBeGreaterThan(1)
  })
})

describe('isMissing', () => {
  it.each([
    ['ENOENT', true],
    ['ENOTDIR', true],
    ['EISDIR', false],
    ['EACCES', false],
  ])('treats %s as missing: %s', (code, missing) => {
    expect(isMissing(Object.assign(new Error(code), { code }))).toBe(missing)
  })

  it('needs an error with a code', () => {
    expect(isMissing(new Error('ENOENT'))).toBe(false)
    expect(isMissing({ code: 'ENOENT' })).toBe(false)
  })
})

describe('GraphFolder graph.json', () => {
  it('knows whether it holds a graph', async () => {
    const folder = await graphFolder()
    expect(await folder.exists()).toBe(false)
    expect(await folder.describe()).toBeNull()
    await writeFile(join(folder.path, 'graph.json'), '{}')
    expect(await folder.exists()).toBe(true)
  })

  it('describes the graph with its title, locations, and last change', async () => {
    const folder = await graphFolder()
    await folder.writeGraph(JSON.stringify(validProject()))
    const changed = new Date('2026-03-04T05:06:07.890Z')
    await utimes(join(folder.path, 'graph.json'), changed, changed)
    expect(await folder.describe()).toEqual({
      title: 'Harbor Town',
      locations: 2,
      updated: '2026-03-04T05:06:07.890Z',
    })
  })

  it('stores the graph as formatted JSON and reads it back', async () => {
    const folder = await graphFolder()
    expect(await folder.writeGraph(JSON.stringify(validProject()))).toBe(
      `${NAME}/graph.json`,
    )
    const stored = await readFile(join(folder.path, 'graph.json'), 'utf8')
    expect(stored).toBe(formatted(validProject()))
    expect(await folder.readGraph()).toBe(stored)
    expect(await readdir(folder.path)).toEqual(['graph.json'])
  })

  it('keeps fields it does not know untouched', async () => {
    const folder = await graphFolder()
    await folder.writeGraph(JSON.stringify(projectWithExtras()))
    expect(JSON.parse(await folder.readGraph())).toEqual(projectWithExtras())
  })

  it('refuses invalid documents, names them, and keeps what was stored', async () => {
    const folder = await graphFolder()
    await folder.writeGraph(JSON.stringify(validProject()))
    const before = await readFile(join(folder.path, 'graph.json'), 'utf8')

    const broken = await rejection(() => folder.writeGraph('{'))
    expect(broken).toBeInstanceOf(InvalidDocumentError)
    expect(broken.message).toBe(
      `${NAME}/graph.json is invalid: it is not valid JSON`,
    )
    const untitled = await rejection(() =>
      folder.writeGraph(JSON.stringify({ ...validProject(), title: ' ' })),
    )
    expect(untitled.message).toBe(
      `${NAME}/graph.json is invalid: title must be non-empty text`,
    )
    const chat = await rejection(() => folder.writeChat('{}'))
    expect(chat.message).toBe(
      `${NAME}/chat.json is invalid: the chat must be a list of messages`,
    )

    expect(await readFile(join(folder.path, 'graph.json'), 'utf8')).toBe(before)
    expect(await readdir(folder.path)).toEqual(['graph.json'])
  })

  it('refuses to read or describe a stored graph that is invalid', async () => {
    const folder = await graphFolder()
    await writeFile(join(folder.path, 'graph.json'), '[]')
    const message = `${NAME}/graph.json is invalid: the graph must be an object`
    expect((await rejection(() => folder.readGraph())).message).toBe(message)
    expect((await rejection(() => folder.describe())).message).toBe(message)
    await writeFile(join(folder.path, 'graph.json'), 'nope')
    expect((await rejection(() => folder.describe())).message).toBe(
      `${NAME}/graph.json is invalid: it is not valid JSON`,
    )
  })

  it('passes on failures other than a missing graph.json', async () => {
    const folder = await graphFolder()
    await mkdir(join(folder.path, 'graph.json'))
    expect(await folder.exists()).toBe(true)
    const read = await rejection(() => folder.readGraph())
    expect((read as NodeJS.ErrnoException).code).toBe('EISDIR')
    const described = await rejection(() => folder.describe())
    expect((described as NodeJS.ErrnoException).code).toBe('EISDIR')
  })

  it('passes on stat failures other than a missing graph.json', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'graph-folder-'))
    const folder = new GraphFolder(join(parent, 'x'.repeat(300)), NAME)
    const error = await rejection(() => folder.exists())
    expect((error as NodeJS.ErrnoException).code).toBe('ENAMETOOLONG')
  })
})

describe('GraphFolder chat.json', () => {
  it('reports a missing chat as null', async () => {
    const folder = await graphFolder()
    expect(await folder.readChat()).toBeNull()
  })

  it('stores the chat and reads it back', async () => {
    const folder = await graphFolder()
    expect(await folder.writeChat(JSON.stringify(validChat))).toBe(
      `${NAME}/chat.json`,
    )
    expect(await folder.readChat()).toBe(formatted(validChat))
    expect(await readdir(folder.path)).toEqual(['chat.json'])
  })

  it('refuses to read a stored chat that is invalid', async () => {
    const folder = await graphFolder()
    await writeFile(join(folder.path, 'chat.json'), 'nope')
    expect((await rejection(() => folder.readChat())).message).toBe(
      `${NAME}/chat.json is invalid: it is not valid JSON`,
    )
  })

  it('passes on read failures other than a missing file', async () => {
    const folder = await graphFolder()
    await mkdir(join(folder.path, 'chat.json'))
    const error = await rejection(() => folder.readChat())
    expect(error).not.toBeInstanceOf(InvalidDocumentError)
    expect((error as NodeJS.ErrnoException).code).toBe('EISDIR')
  })

  it('passes on the failure to write when the folder is gone', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'graph-folder-'))
    const folder = new GraphFolder(join(parent, 'gone'), NAME)
    const error = (await rejection(() =>
      folder.writeChat('[]'),
    )) as NodeJS.ErrnoException
    expect(error.code).toBe('ENOENT')
    expect(error.syscall).toBe('open')
    expect(await readdir(parent)).toEqual([])
  })

  it('removes its temporary file when the document cannot be replaced', async () => {
    const folder = await graphFolder()
    await mkdir(join(folder.path, 'chat.json'))
    await writeFile(join(folder.path, 'chat.json', 'keep'), 'x')
    const error = await rejection(() =>
      folder.writeChat(JSON.stringify(validChat)),
    )
    expect(error).not.toBeInstanceOf(InvalidDocumentError)
    expect(await readdir(folder.path)).toEqual(['chat.json'])
  })
})

describe('GraphFolder media', () => {
  it('stores an upload under a unique name and serves it back', async () => {
    const folder = await graphFolder()
    const bytes = Buffer.from([137, 80, 78, 71, 1, 2, 3])
    const stored = await folder.saveMedia(
      'image',
      'Harbor Town.png',
      Readable.from([bytes]),
    )
    expect(stored).toMatch(/^images\/harbor-town-[0-9a-f]{8}\.png$/)
    expect(await readFile(join(folder.path, stored))).toEqual(bytes)
    expect(await readdir(join(folder.path, 'images'))).toEqual([
      stored.slice('images/'.length),
    ])
    expect(await folder.readMedia(stored)).toEqual({
      data: bytes,
      contentType: 'image/png',
    })
  })

  it('keeps two uploads with the same name apart', async () => {
    const folder = await graphFolder()
    const first = await folder.saveMedia(
      'audio',
      'gulls.mp3',
      Readable.from(['a']),
    )
    const second = await folder.saveMedia(
      'audio',
      'gulls.mp3',
      Readable.from(['b']),
    )
    expect(first).not.toBe(second)
    expect((await folder.readMedia(first)).data.toString()).toBe('a')
    expect((await folder.readMedia(second)).data.toString()).toBe('b')
  })

  it('refuses unsupported files before writing anything', async () => {
    const folder = await graphFolder()
    const error = await rejection(() =>
      folder.saveMedia('image', 'notes.txt', Readable.from(['x'])),
    )
    expect(error).toBeInstanceOf(UnsupportedMediaFileError)
    expect(await readdir(folder.path)).toEqual([])
  })

  it('removes the partial file when the upload fails', async () => {
    const folder = await graphFolder()
    const failure = new Error('connection lost')
    const body = Readable.from(
      (async function* (): AsyncGenerator<Buffer> {
        yield Buffer.from('partial')
        throw failure
      })(),
    )
    expect(
      await rejection(() => folder.saveMedia('image', 'a.png', body)),
    ).toBe(failure)
    expect(await readdir(join(folder.path, 'images'))).toEqual([])
  })

  it('reports missing media and refuses paths outside the media folders', async () => {
    const folder = await graphFolder()
    const missing = await rejection(() => folder.readMedia('images/gone-1.png'))
    expect(missing).toBeInstanceOf(MediaNotFoundError)
    expect(missing.name).toBe('MediaNotFoundError')
    expect(missing.message).toBe('no such media file: images/gone-1.png')
    expect((missing as MediaNotFoundError).path).toBe('images/gone-1.png')
    expect(await rejection(() => folder.readMedia('../graph.json'))).toEqual(
      new InvalidMediaPathError('../graph.json'),
    )
  })

  it('reports media below a file instead of a folder as missing', async () => {
    const folder = await graphFolder()
    await writeFile(join(folder.path, 'images'), 'not a folder')
    expect(
      await rejection(() => folder.readMedia('images/odd-1.png')),
    ).toBeInstanceOf(MediaNotFoundError)
  })

  it('passes on media read failures other than a missing file', async () => {
    const folder = await graphFolder()
    await mkdir(join(folder.path, 'images', 'odd-1.png'), { recursive: true })
    const error = await rejection(() => folder.readMedia('images/odd-1.png'))
    expect(error).not.toBeInstanceOf(MediaNotFoundError)
    expect((error as NodeJS.ErrnoException).code).toBe('EISDIR')
  })
})
