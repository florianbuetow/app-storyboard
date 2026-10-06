import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  GraphLibrary,
  MigrationTargetExistsError,
} from '../../src/application/graph-library.js'
import { legacyProject } from '../fixtures/project.js'

// Every random suffix is 3f9a2c1d in this file, so a test can take the next graph folder
// first, and the file system calls can be made to fail on purpose.
vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>()
  return { ...crypto, randomBytes: () => Buffer.from('3f9a2c1d', 'hex') }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, lstat: vi.fn(fs.lstat), mkdir: vi.fn(fs.mkdir) }
})

const TARGET = 'graphs/location-graph-3f9a2c1d'
const fs =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

afterEach(() => {
  vi.mocked(lstat).mockReset()
  vi.mocked(mkdir).mockReset()
})

const failure = (code: string): Error =>
  Object.assign(new Error(`${code}: on purpose`), { code })

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

async function legacyLayout(): Promise<string> {
  const data = await mkdtemp(join(tmpdir(), 'graph-faults-'))
  await writeFile(join(data, 'project.json'), JSON.stringify(legacyProject()))
  await writeFile(join(data, 'chat.json'), '[]')
  await mkdir(join(data, 'images'))
  return data
}

const entries = async (path: string): Promise<string[]> =>
  (await readdir(path)).sort()

describe('GraphLibrary when the next graph folder is taken', () => {
  it('refuses to migrate into an existing folder and moves nothing', async () => {
    const data = await legacyLayout()
    await mkdir(join(data, TARGET), { recursive: true })
    await writeFile(join(data, TARGET, 'graph.json'), 'keep')
    const library = await GraphLibrary.open(data)

    const error = await rejection(() => library.migrateLegacyLayout())
    expect(error).toBeInstanceOf(MigrationTargetExistsError)
    expect(error.name).toBe('MigrationTargetExistsError')
    expect(error.message).toBe(
      `cannot move the single-graph layout to ${TARGET}: it already exists`,
    )
    expect((error as MigrationTargetExistsError).path).toBe(TARGET)
    expect((error.cause as NodeJS.ErrnoException).code).toBe('EEXIST')
    expect(await entries(data)).toEqual([
      'chat.json',
      'graphs',
      'images',
      'project.json',
    ])
    expect(await readFile(join(data, TARGET, 'graph.json'), 'utf8')).toBe(
      'keep',
    )
  })

  it('refuses to migrate onto a file with the name of the folder', async () => {
    const data = await legacyLayout()
    await mkdir(join(data, 'graphs'))
    await writeFile(join(data, TARGET), 'keep')
    const error = await rejection(async () =>
      (await GraphLibrary.open(data)).migrateLegacyLayout(),
    )
    expect(error).toBeInstanceOf(MigrationTargetExistsError)
    expect(await readFile(join(data, TARGET), 'utf8')).toBe('keep')
    expect(await entries(data)).toEqual([
      'chat.json',
      'graphs',
      'images',
      'project.json',
    ])
  })

  it('refuses to create a graph in an existing folder', async () => {
    const data = await mkdtemp(join(tmpdir(), 'graph-faults-'))
    const taken = join(data, 'graphs', 'harbor-3f9a2c1d')
    await mkdir(taken, { recursive: true })
    await writeFile(join(taken, 'graph.json'), 'x')
    const library = await GraphLibrary.open(data)
    const error = await rejection(() => library.create('{"title":"Harbor"}'))
    expect((error as NodeJS.ErrnoException).code).toBe('EEXIST')
    expect(await readFile(join(taken, 'graph.json'), 'utf8')).toBe('x')
  })
})

describe('GraphLibrary when the file system fails', () => {
  it('passes on other failures to create the graph folder', async () => {
    const data = await legacyLayout()
    const denied = failure('EACCES')
    vi.mocked(mkdir).mockImplementation(async (path, options) => {
      if (String(path).endsWith('location-graph-3f9a2c1d')) {
        throw denied
      }
      return fs.mkdir(path, options)
    })
    const error = await rejection(async () =>
      (await GraphLibrary.open(data)).migrateLegacyLayout(),
    )
    expect(error).toBe(denied)
    expect(await entries(data)).toEqual([
      'chat.json',
      'graphs',
      'images',
      'project.json',
    ])
  })

  it('passes on failures to look for the media folders', async () => {
    const data = await legacyLayout()
    const denied = failure('EACCES')
    vi.mocked(lstat).mockImplementation(async (path, options) => {
      if (String(path).endsWith('images')) {
        throw denied
      }
      return fs.lstat(path, options)
    })
    const error = await rejection(async () =>
      (await GraphLibrary.open(data)).migrateLegacyLayout(),
    )
    expect(error).toBe(denied)
    expect(await entries(data)).toEqual(['chat.json', 'images', 'project.json'])
  })
})
