import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { GraphFolder } from '../../src/application/graph-folder.js'
import {
  DataFolderNotFoundError,
  GraphLibrary,
  GraphNotFoundError,
} from '../../src/application/graph-library.js'
import { InvalidGraphIdError } from '../../src/domain/graph-id.js'
import { emptyGraph, InvalidDocumentError } from '../../src/domain/project.js'
import { legacyProject, validChat, validProject } from '../fixtures/project.js'

const temporaryFolder = (): Promise<string> =>
  mkdtemp(join(tmpdir(), 'graph-library-'))

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

async function emptyLibrary(): Promise<{
  data: string
  library: GraphLibrary
}> {
  const data = await temporaryFolder()
  return { data, library: await GraphLibrary.open(data) }
}

/** Writes graphs/<id>/graph.json directly and dates its last change. */
async function storeGraph(
  data: string,
  id: string,
  document: unknown,
  updated: string,
): Promise<void> {
  const folder = join(data, 'graphs', id)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'graph.json'), JSON.stringify(document))
  await utimes(join(folder, 'graph.json'), new Date(updated), new Date(updated))
}

const titled = (title: string): Record<string, unknown> => ({
  ...validProject(),
  title,
})

describe('GraphLibrary.open', () => {
  it('opens an existing directory by its absolute path', async () => {
    const path = await temporaryFolder()
    expect((await GraphLibrary.open(path)).path).toBe(path)
    expect((await GraphLibrary.open('.')).path).toBe(process.cwd())
  })

  it('fails with the cause for a missing directory', async () => {
    const missing = join(await temporaryFolder(), 'missing')
    const error = await rejection(() => GraphLibrary.open(missing))
    expect(error).toBeInstanceOf(DataFolderNotFoundError)
    expect(error.name).toBe('DataFolderNotFoundError')
    expect(error.message).toBe(
      `data folder does not exist or is not a directory: ${missing}`,
    )
    expect(error.cause).toBeInstanceOf(Error)
  })

  it('fails for a file', async () => {
    const file = join(await temporaryFolder(), 'file.txt')
    await writeFile(file, 'x')
    const error = await rejection(() => GraphLibrary.open(file))
    expect(error).toBeInstanceOf(DataFolderNotFoundError)
    expect((error as DataFolderNotFoundError).path).toBe(file)
    expect(error.cause).toBeUndefined()
  })
})

describe('GraphLibrary.list', () => {
  it('is empty without a graphs folder', async () => {
    const { library } = await emptyLibrary()
    expect(await library.list()).toEqual([])
  })

  it('lists every graph with the latest change first', async () => {
    const { data, library } = await emptyLibrary()
    await storeGraph(
      data,
      'old-0a1b2c3d',
      titled('Old'),
      '2026-01-01T00:00:00Z',
    )
    await storeGraph(
      data,
      'new-0a1b2c3d',
      titled('New'),
      '2026-03-01T00:00:00Z',
    )
    await storeGraph(
      data,
      'mid-0a1b2c3d',
      emptyGraph('Middle'),
      '2026-02-01T10:20:30.400Z',
    )
    expect(await library.list()).toEqual([
      {
        id: 'new-0a1b2c3d',
        title: 'New',
        updated: '2026-03-01T00:00:00.000Z',
        locations: 2,
      },
      {
        id: 'mid-0a1b2c3d',
        title: 'Middle',
        updated: '2026-02-01T10:20:30.400Z',
        locations: 0,
      },
      {
        id: 'old-0a1b2c3d',
        title: 'Old',
        updated: '2026-01-01T00:00:00.000Z',
        locations: 2,
      },
    ])
  })

  it('orders graphs changed at the same time by id', async () => {
    const { data, library } = await emptyLibrary()
    const same = '2026-01-01T00:00:00.000Z'
    await storeGraph(data, 'beta-0a1b2c3d', titled('Beta'), same)
    await storeGraph(data, 'alpha-0a1b2c3d', titled('Alpha'), same)
    await storeGraph(data, 'gamma-0a1b2c3d', titled('Gamma'), same)
    await storeGraph(data, 'later-0a1b2c3d', titled('Later'), '2026-01-02')
    expect((await library.list()).map((graph) => graph.id)).toEqual([
      'later-0a1b2c3d',
      'alpha-0a1b2c3d',
      'beta-0a1b2c3d',
      'gamma-0a1b2c3d',
    ])
  })

  it('skips everything that is not a graph folder', async () => {
    const { data, library } = await emptyLibrary()
    await storeGraph(data, 'real-0a1b2c3d', titled('Real'), '2026-01-01')
    await writeFile(join(data, 'graphs', '.DS_Store'), 'x')
    await mkdir(join(data, 'graphs', 'Not a graph'))
    await writeFile(join(data, 'graphs', 'Not a graph', 'graph.json'), '{}')
    await mkdir(join(data, 'graphs', 'empty-0a1b2c3d'))
    await writeFile(join(data, 'graphs', 'loose-0a1b2c3d'), 'x')
    expect((await library.list()).map((graph) => graph.id)).toEqual([
      'real-0a1b2c3d',
    ])
  })

  it('names the graph whose graph.json is invalid', async () => {
    const { data, library } = await emptyLibrary()
    await storeGraph(data, 'real-0a1b2c3d', titled('Real'), '2026-01-01')
    await storeGraph(data, 'broken-0a1b2c3d', legacyProject(), '2026-01-01')
    const error = await rejection(() => library.list())
    expect(error).toBeInstanceOf(InvalidDocumentError)
    expect(error.message).toBe(
      'graphs/broken-0a1b2c3d/graph.json is invalid: version must be 2',
    )
  })

  it('passes on failures other than a missing graphs folder', async () => {
    const { data, library } = await emptyLibrary()
    await symlink('graphs', join(data, 'graphs'))
    const error = await rejection(() => library.list())
    expect((error as NodeJS.ErrnoException).code).toBe('ELOOP')
  })
})

describe('GraphLibrary.create', () => {
  it('creates a folder that holds an empty graph', async () => {
    const { data, library } = await emptyLibrary()
    const created = await library.create('{"title":"Harbor Town"}')
    expect(created.title).toBe('Harbor Town')
    expect(created.id).toMatch(/^harbor-town-[0-9a-f]{8}$/)
    expect(await readdir(data)).toEqual(['graphs'])
    expect(await readdir(join(data, 'graphs'))).toEqual([created.id])
    const folder = join(data, 'graphs', created.id)
    expect(await readdir(folder)).toEqual(['graph.json'])
    expect(await readFile(join(folder, 'graph.json'), 'utf8')).toBe(
      formatted(emptyGraph('Harbor Town')),
    )
    const { mtime } = await stat(join(folder, 'graph.json'))
    expect(await library.list()).toEqual([
      {
        id: created.id,
        title: 'Harbor Town',
        updated: mtime.toISOString(),
        locations: 0,
      },
    ])
  })

  it('gives graphs with the same title different ids', async () => {
    const { library } = await emptyLibrary()
    const first = await library.create('{"title":"Twin"}')
    const second = await library.create('{"title":"Twin"}')
    expect(first.id).not.toBe(second.id)
    expect((await library.list()).map((graph) => graph.title)).toEqual([
      'Twin',
      'Twin',
    ])
  })

  it('names a graph without letters or digits in its title "graph"', async () => {
    const { library } = await emptyLibrary()
    const created = await library.create('{"title":"???"}')
    expect(created.id).toMatch(/^graph-[0-9a-f]{8}$/)
    expect(created.title).toBe('???')
  })

  it('refuses an invalid request and creates nothing', async () => {
    const { data, library } = await emptyLibrary()
    const error = await rejection(() => library.create('{"title":" "}'))
    expect(error).toBeInstanceOf(InvalidDocumentError)
    expect(error.message).toBe(
      'the new graph is invalid: title must be non-empty text',
    )
    expect(await readdir(data)).toEqual([])
  })
})

describe('GraphLibrary.graph', () => {
  it('opens an existing graph', async () => {
    const { data, library } = await emptyLibrary()
    const { id } = await library.create('{"title":"Harbor Town"}')
    const folder = await library.graph(id)
    expect(folder).toBeInstanceOf(GraphFolder)
    expect(folder.path).toBe(join(data, 'graphs', id))
    expect(folder.relativePath).toBe(`graphs/${id}`)
    expect(JSON.parse(await folder.readGraph())).toEqual(
      emptyGraph('Harbor Town'),
    )
  })

  it.each(['../graphs', 'Harbor', 'graphs/x-0a1b2c3d', ''])(
    'refuses the invalid id %j',
    async (id) => {
      const { library } = await emptyLibrary()
      expect(await rejection(() => library.graph(id))).toEqual(
        new InvalidGraphIdError(id),
      )
    },
  )

  it('reports an id that names no graph', async () => {
    const { data, library } = await emptyLibrary()
    await mkdir(join(data, 'graphs', 'empty-0a1b2c3d'), { recursive: true })
    for (const id of ['missing-0a1b2c3d', 'empty-0a1b2c3d']) {
      const error = await rejection(() => library.graph(id))
      expect(error).toBeInstanceOf(GraphNotFoundError)
      expect(error.name).toBe('GraphNotFoundError')
      expect(error.message).toBe(`no such graph: ${id}`)
      expect((error as GraphNotFoundError).id).toBe(id)
    }
  })
})

describe('GraphLibrary.migrateLegacyLayout', () => {
  const PNG = Buffer.from([137, 80, 78, 71, 1, 2, 3])
  const MP3 = Buffer.from([73, 68, 51, 4])

  async function legacyLayout(): Promise<string> {
    const data = await temporaryFolder()
    await writeFile(join(data, 'project.json'), formatted(legacyProject()))
    await writeFile(join(data, 'chat.json'), JSON.stringify(validChat))
    await mkdir(join(data, 'images'))
    await writeFile(join(data, 'images', 'docks-0a1b2c3d.png'), PNG)
    await mkdir(join(data, 'audio'))
    await writeFile(join(data, 'audio', 'gulls-0a1b2c3d.mp3'), MP3)
    return data
  }

  it('leaves a data folder without project.json alone', async () => {
    const data = await temporaryFolder()
    await writeFile(join(data, 'chat.json'), '[]')
    await mkdir(join(data, 'images'))
    const library = await GraphLibrary.open(data)
    expect(await library.migrateLegacyLayout()).toBeNull()
    expect((await readdir(data)).sort()).toEqual(['chat.json', 'images'])
  })

  it('moves project.json, chat.json, images, and audio into a new graph', async () => {
    const data = await legacyLayout()
    const before = {
      chat: (await lstat(join(data, 'chat.json'))).ino,
      images: (await lstat(join(data, 'images'))).ino,
      audio: (await lstat(join(data, 'audio'))).ino,
    }
    const library = await GraphLibrary.open(data)
    const migration = await library.migrateLegacyLayout()

    const id = String(migration?.id)
    expect(id).toMatch(/^location-graph-[0-9a-f]{8}$/)
    expect(migration).toEqual({
      id,
      title: 'Location graph',
      moved: [
        { from: 'project.json', to: `graphs/${id}/graph.json` },
        { from: 'chat.json', to: `graphs/${id}/chat.json` },
        { from: 'images', to: `graphs/${id}/images` },
        { from: 'audio', to: `graphs/${id}/audio` },
      ],
    })
    const folder = join(data, 'graphs', id)
    expect(await readdir(data)).toEqual(['graphs'])
    expect(await readdir(join(data, 'graphs'))).toEqual([id])
    expect((await readdir(folder)).sort()).toEqual([
      'audio',
      'chat.json',
      'graph.json',
      'images',
    ])
    expect(await readFile(join(folder, 'graph.json'), 'utf8')).toBe(
      formatted({ ...legacyProject(), version: 2, title: 'Location graph' }),
    )
    expect(await readFile(join(folder, 'chat.json'), 'utf8')).toBe(
      JSON.stringify(validChat),
    )
    expect(
      await readFile(join(folder, 'images', 'docks-0a1b2c3d.png')),
    ).toEqual(PNG)
    expect(await readFile(join(folder, 'audio', 'gulls-0a1b2c3d.mp3'))).toEqual(
      MP3,
    )
    expect({
      chat: (await lstat(join(folder, 'chat.json'))).ino,
      images: (await lstat(join(folder, 'images'))).ino,
      audio: (await lstat(join(folder, 'audio'))).ino,
    }).toEqual(before)

    const [summary] = await library.list()
    expect(summary).toMatchObject({ id, title: 'Location graph', locations: 2 })
    const graph = await library.graph(id)
    expect((await graph.readMedia('images/docks-0a1b2c3d.png')).data).toEqual(
      PNG,
    )
    expect(await graph.readChat()).toBe(JSON.stringify(validChat))
    expect(await library.migrateLegacyLayout()).toBeNull()
  })

  it('moves only what exists', async () => {
    const data = await temporaryFolder()
    await writeFile(join(data, 'project.json'), JSON.stringify(legacyProject()))
    await mkdir(join(data, 'audio'))
    const migration = await (
      await GraphLibrary.open(data)
    ).migrateLegacyLayout()
    const id = String(migration?.id)
    expect(migration?.moved).toEqual([
      { from: 'project.json', to: `graphs/${id}/graph.json` },
      { from: 'audio', to: `graphs/${id}/audio` },
    ])
    expect((await readdir(join(data, 'graphs', id))).sort()).toEqual([
      'audio',
      'graph.json',
    ])
  })

  it.each([
    ['{', 'project.json is invalid: it is not valid JSON'],
    [
      JSON.stringify(validProject()),
      'project.json is invalid: version must be 1',
    ],
    [
      JSON.stringify({ ...legacyProject(), view: null }),
      'project.json is invalid: view must be an object',
    ],
  ])('refuses the project %s and moves nothing', async (json, message) => {
    const data = await legacyLayout()
    await writeFile(join(data, 'project.json'), json)
    const error = await rejection(async () =>
      (await GraphLibrary.open(data)).migrateLegacyLayout(),
    )
    expect(error).toBeInstanceOf(InvalidDocumentError)
    expect(error.message).toBe(message)
    expect((await readdir(data)).sort()).toEqual([
      'audio',
      'chat.json',
      'images',
      'project.json',
    ])
  })

  it('refuses an invalid chat.json and moves nothing', async () => {
    const data = await legacyLayout()
    await writeFile(join(data, 'chat.json'), '{"role":"user"}')
    const error = await rejection(async () =>
      (await GraphLibrary.open(data)).migrateLegacyLayout(),
    )
    expect(error.message).toBe(
      'chat.json is invalid: the chat must be a list of messages',
    )
    expect(await readFile(join(data, 'project.json'), 'utf8')).toBe(
      formatted(legacyProject()),
    )
    expect((await readdir(data)).sort()).toEqual([
      'audio',
      'chat.json',
      'images',
      'project.json',
    ])
  })

  it('passes on read failures other than a missing project.json', async () => {
    const data = await temporaryFolder()
    await mkdir(join(data, 'project.json'))
    const error = await rejection(async () =>
      (await GraphLibrary.open(data)).migrateLegacyLayout(),
    )
    expect((error as NodeJS.ErrnoException).code).toBe('EISDIR')
    expect(await readdir(data)).toEqual(['project.json'])
  })
})
