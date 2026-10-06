import { lstat, mkdir, readdir, readFile, rename, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import {
  graphId,
  InvalidGraphIdError,
  isGraphId,
  parseGraphId,
} from '../domain/graph-id.js'
import {
  CHAT_FILE,
  emptyGraph,
  GRAPH_FILE,
  LEGACY_PROJECT_FILE,
  newGraphTitle,
  parseJsonDocument,
  upgradeLegacyProject,
  validateChat,
} from '../domain/project.js'
import {
  GraphFolder,
  isMissing,
  randomHex,
  type GraphDescription,
} from './graph-folder.js'

const GRAPHS = 'graphs'
const MIGRATED_TITLE = 'Location graph'
const LEGACY_MEDIA = ['images', 'audio']

export class DataFolderNotFoundError extends Error {
  constructor(
    readonly path: string,
    options?: ErrorOptions,
  ) {
    super(`data folder does not exist or is not a directory: ${path}`, options)
    this.name = 'DataFolderNotFoundError'
  }
}

export class GraphNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`no such graph: ${id}`)
    this.name = 'GraphNotFoundError'
  }
}

export class MigrationTargetExistsError extends Error {
  constructor(
    readonly path: string,
    options?: ErrorOptions,
  ) {
    super(
      `cannot move the single-graph layout to ${path}: it already exists`,
      options,
    )
    this.name = 'MigrationTargetExistsError'
  }
}

export interface GraphSummary extends GraphDescription {
  readonly id: string
}

export interface CreatedGraph {
  readonly id: string
  readonly title: string
}

/** One moved file or folder, both paths relative to the data folder. */
interface MovedPath {
  readonly from: string
  readonly to: string
}

export interface Migration {
  readonly id: string
  readonly title: string
  readonly moved: readonly MovedPath[]
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error: unknown) {
    if (isMissing(error)) {
      return null
    }
    throw error
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error: unknown) {
    if (isMissing(error)) {
      return false
    }
    throw error
  }
}

function isExisting(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

function newestFirst(a: GraphSummary, b: GraphSummary): number {
  return b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id)
}

/** The data folder, which keeps every graph in its own folder graphs/<id>/. */
export class GraphLibrary {
  private readonly graphsPath: string

  private constructor(readonly path: string) {
    this.graphsPath = join(path, GRAPHS)
  }

  static async open(path: string): Promise<GraphLibrary> {
    const absolute = resolve(path)
    const info = await stat(absolute).catch((error: unknown) => {
      throw new DataFolderNotFoundError(absolute, { cause: error })
    })
    if (!info.isDirectory()) {
      throw new DataFolderNotFoundError(absolute)
    }
    return new GraphLibrary(absolute)
  }

  /** Lists every folder below graphs/ that holds a graph.json, the latest change first. */
  async list(): Promise<GraphSummary[]> {
    let names: string[]
    try {
      names = await readdir(this.graphsPath)
    } catch (error: unknown) {
      if (isMissing(error)) {
        return []
      }
      throw error
    }
    const graphs = await Promise.all(
      names.filter(isGraphId).map(async (id) => {
        const description = await this.folder(id).describe()
        return description === null ? [] : [{ id, ...description }]
      }),
    )
    return graphs.flat().sort(newestFirst)
  }

  /** Creates a graph with an empty board from a request like {"title": "Harbor Town"}. */
  async create(json: string): Promise<CreatedGraph> {
    const title = newGraphTitle(json)
    const id = graphId(title, randomHex())
    const folder = this.folder(id)
    await mkdir(this.graphsPath, { recursive: true })
    await mkdir(folder.path)
    await folder.writeGraph(JSON.stringify(emptyGraph(title)))
    return { id, title }
  }

  /** Opens an existing graph; fails for an id that is invalid or names no graph. */
  async graph(id: string): Promise<GraphFolder> {
    const folder = this.folder(parseGraphId(id))
    if (!(await folder.exists())) {
      throw new GraphNotFoundError(id)
    }
    return folder
  }

  /**
   * Moves the single-graph layout, with project.json, chat.json, images/, and audio/ directly
   * in the data folder, into a new graph folder. Everything is checked before the first move,
   * and nothing is copied or replaced. Resolves to null when there is no project.json.
   */
  async migrateLegacyLayout(): Promise<Migration | null> {
    const legacy = await readOptional(join(this.path, LEGACY_PROJECT_FILE))
    if (legacy === null) {
      return null
    }
    const graph = upgradeLegacyProject(
      parseJsonDocument(LEGACY_PROJECT_FILE, legacy),
      MIGRATED_TITLE,
    )
    const chat = await readOptional(join(this.path, CHAT_FILE))
    if (chat !== null) {
      validateChat(parseJsonDocument(CHAT_FILE, chat), CHAT_FILE)
    }
    const media: string[] = []
    for (const name of LEGACY_MEDIA) {
      if (await exists(join(this.path, name))) {
        media.push(name)
      }
    }
    const id = graphId(MIGRATED_TITLE, randomHex())
    const folder = this.folder(id)
    await mkdir(this.graphsPath, { recursive: true })
    await mkdir(folder.path).catch((error: unknown) => {
      throw isExisting(error)
        ? new MigrationTargetExistsError(folder.relativePath, { cause: error })
        : error
    })

    const moved: MovedPath[] = []
    const move = async (from: string, to: string): Promise<void> => {
      await rename(join(this.path, from), join(folder.path, to))
      moved.push({ from, to: `${folder.relativePath}/${to}` })
    }
    await move(LEGACY_PROJECT_FILE, GRAPH_FILE)
    await folder.writeGraph(JSON.stringify(graph))
    if (chat !== null) {
      await move(CHAT_FILE, CHAT_FILE)
    }
    for (const name of media) {
      await move(name, name)
    }
    return { id, title: MIGRATED_TITLE, moved }
  }

  private folder(id: string): GraphFolder {
    const path = resolve(this.graphsPath, id)
    if (!path.startsWith(this.graphsPath + sep)) {
      throw new InvalidGraphIdError(id)
    }
    return new GraphFolder(path, `${GRAPHS}/${id}`)
  }
}
