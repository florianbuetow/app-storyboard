import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'

import {
  isScalable,
  scaledImagePath,
  type ImageSize,
} from '../domain/image-size.js'
import {
  InvalidMediaPathError,
  mediaPath,
  parseMediaPath,
  type MediaKind,
} from '../domain/media.js'
import {
  CHAT_FILE,
  GRAPH_FILE,
  parseJsonDocument,
  validateChat,
  validateGraph,
  type GraphFacts,
} from '../domain/project.js'

export class MediaNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`no such media file: ${path}`)
    this.name = 'MediaNotFoundError'
  }
}

export class ImageScaleError extends Error {
  constructor(
    readonly path: string,
    options?: ErrorOptions,
  ) {
    super(`cannot make a smaller version of ${path}`, options)
    this.name = 'ImageScaleError'
  }
}

export interface StoredMedia {
  readonly data: Buffer
  readonly contentType: string
}

const WEBP = 'image/webp'

/** Fits an image into `size` × `size` pixels, upright, as WebP; never enlarges it. */
async function scaleImage(
  data: Buffer,
  size: ImageSize,
  path: string,
): Promise<Buffer> {
  // Loaded on first use, so commands that never scale an image start without it.
  const { default: sharp } = await import('sharp')
  try {
    return await sharp(data)
      .rotate()
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer()
  } catch (error: unknown) {
    throw new ImageScaleError(path, { cause: error })
  }
}

export interface GraphDescription extends GraphFacts {
  /** When graph.json last changed, as an ISO 8601 time. */
  readonly updated: string
}

type Validate = (value: unknown, document: string) => unknown

/** Eight random hex characters that keep file and folder names unique. */
export const randomHex = (): string => randomBytes(4).toString('hex')

/** True for a file system error that says the path does not exist. */
export function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

/** Writes through a temporary sibling so readers never see a half-written file. */
async function replaceFile(
  target: string,
  write: (temporary: string) => Promise<void>,
): Promise<void> {
  const temporary = `${target}.${randomHex()}.tmp`
  try {
    await write(temporary)
    await rename(temporary, target)
  } catch (error: unknown) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** One graph's folder: graph.json, chat.json, and the images/ and audio/ media. */
export class GraphFolder {
  /**
   * `path` is the absolute folder; `relativePath` is its place in the data folder,
   * graphs/<id>, which names its documents in errors.
   */
  constructor(
    readonly path: string,
    readonly relativePath: string,
  ) {}

  async exists(): Promise<boolean> {
    return (await this.modified()) !== null
  }

  /** Resolves to null when the folder holds no graph.json. */
  async describe(): Promise<GraphDescription | null> {
    const modified = await this.modified()
    if (modified === null) {
      return null
    }
    const document = this.document(GRAPH_FILE)
    const json = await readFile(join(this.path, GRAPH_FILE), 'utf8')
    const facts = validateGraph(parseJsonDocument(document, json), document)
    return { ...facts, updated: modified.toISOString() }
  }

  async readGraph(): Promise<string> {
    const json = await readFile(join(this.path, GRAPH_FILE), 'utf8')
    this.parse(GRAPH_FILE, json, validateGraph)
    return json
  }

  /** Stores graph.json and returns its path in the data folder. */
  writeGraph(json: string): Promise<string> {
    return this.writeDocument(GRAPH_FILE, json, validateGraph)
  }

  /** Returns the stored chat JSON, or null when nothing has been saved yet. */
  async readChat(): Promise<string | null> {
    let json: string
    try {
      json = await readFile(join(this.path, CHAT_FILE), 'utf8')
    } catch (error: unknown) {
      if (isMissing(error)) {
        return null
      }
      throw error
    }
    this.parse(CHAT_FILE, json, validateChat)
    return json
  }

  /** Stores chat.json and returns its path in the data folder. */
  writeChat(json: string): Promise<string> {
    return this.writeDocument(CHAT_FILE, json, validateChat)
  }

  /** Stores an uploaded file and returns its path relative to the graph folder. */
  async saveMedia(
    kind: MediaKind,
    fileName: string,
    body: NodeJS.ReadableStream,
  ): Promise<string> {
    const relative = mediaPath(kind, fileName, randomHex())
    const target = this.inside(relative)
    await mkdir(dirname(target), { recursive: true })
    await replaceFile(target, (temporary) =>
      pipeline(body, createWriteStream(temporary, { flags: 'wx' })),
    )
    return relative
  }

  /**
   * An image scaled to fit `size` × `size` pixels, made on first request and kept in
   * scaled/<size>/. A null size, sounds, and images without smaller versions give the
   * stored file itself.
   */
  async readImage(
    relative: string,
    size: ImageSize | null,
  ): Promise<StoredMedia> {
    if (size === null || !isScalable(parseMediaPath(relative))) {
      return this.readMedia(relative)
    }
    const target = this.inside(scaledImagePath(relative, size))
    const kept = await readFile(target).catch((error: unknown) => {
      if (isMissing(error)) {
        return null
      }
      throw error
    })
    if (kept !== null) {
      return { data: kept, contentType: WEBP }
    }
    const original = await this.readMedia(relative)
    const data = await scaleImage(original.data, size, relative)
    await mkdir(dirname(target), { recursive: true })
    await replaceFile(target, (temporary) =>
      writeFile(temporary, data, { flag: 'wx' }),
    )
    return { data, contentType: WEBP }
  }

  async readMedia(relative: string): Promise<StoredMedia> {
    const { contentType } = parseMediaPath(relative)
    const data = await readFile(this.inside(relative)).catch(
      (error: unknown) => {
        throw isMissing(error) ? new MediaNotFoundError(relative) : error
      },
    )
    return { data, contentType }
  }

  private async modified(): Promise<Date | null> {
    try {
      return (await stat(join(this.path, GRAPH_FILE))).mtime
    } catch (error: unknown) {
      if (isMissing(error)) {
        return null
      }
      throw error
    }
  }

  private inside(relative: string): string {
    const target = resolve(this.path, relative)
    if (!target.startsWith(this.path + sep)) {
      throw new InvalidMediaPathError(relative)
    }
    return target
  }

  /** Names a document of this graph in errors and replies, such as graphs/<id>/chat.json. */
  private document(name: string): string {
    return `${this.relativePath}/${name}`
  }

  private parse(name: string, json: string, validate: Validate): unknown {
    const document = this.document(name)
    const value = parseJsonDocument(document, json)
    validate(value, document)
    return value
  }

  private async writeDocument(
    name: string,
    json: string,
    validate: Validate,
  ): Promise<string> {
    const value = this.parse(name, json, validate)
    await replaceFile(join(this.path, name), (temporary) =>
      writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        flag: 'wx',
      }),
    )
    return this.document(name)
  }
}
