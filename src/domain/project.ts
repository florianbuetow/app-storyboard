import { mediaFileOf, type MediaKind } from './media.js'

export const GRAPH_FILE = 'graph.json'
export const CHAT_FILE = 'chat.json'
/** The one project document of the data folder layout from before graph folders. */
export const LEGACY_PROJECT_FILE = 'project.json'

const PROJECT_FORMAT = 'location-graph'
const GRAPH_VERSION = 2
const LEGACY_VERSION = 1
const NEW_GRAPH = 'the new graph'
const ASSET_ID = /^x_[a-z0-9]+$/
const CHAT_ROLES: ReadonlySet<unknown> = new Set(['user', 'assistant', 'note'])

export class InvalidDocumentError extends Error {
  constructor(
    readonly document: string,
    readonly problem: string,
    options?: ErrorOptions,
  ) {
    super(`${document} is invalid: ${problem}`, options)
    this.name = 'InvalidDocumentError'
  }
}

/** What the list of graphs shows about a valid graph document. */
export interface GraphFacts {
  readonly title: string
  readonly locations: number
}

export type Fields = Readonly<Record<string, unknown>>

/** True for a JSON object: neither null nor a list. */
export function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Collects the checks shared by both documents and names the offending field on failure. */
class DocumentCheck {
  constructor(private readonly document: string) {}

  problem(path: string, message: string): InvalidDocumentError {
    return new InvalidDocumentError(this.document, `${path} ${message}`)
  }

  record(value: unknown, path: string): Fields {
    if (!isFields(value)) {
      throw this.problem(path, 'must be an object')
    }
    return value
  }

  list(fields: Fields, key: string, path: string): readonly unknown[] {
    const value = fields[key]
    if (!Array.isArray(value)) {
      throw this.problem(`${path}.${key}`, 'must be a list')
    }
    return value
  }

  text(fields: Fields, key: string, path: string): string {
    const value = fields[key]
    if (typeof value !== 'string') {
      throw this.problem(`${path}.${key}`, 'must be text')
    }
    return value
  }

  /** Reads the non-empty name of an item, such as a character. */
  name(fields: Fields, path: string): string {
    const value = fields['name']
    if (typeof value !== 'string' || value.trim() === '') {
      throw this.problem(`${path}.name`, 'must be non-empty text')
    }
    return value
  }

  /** Reads a count such as the recommended number of sprites: a whole number, 1 or more. */
  count(fields: Fields, key: string, path: string): number {
    const value = fields[key]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw this.problem(
        `${path}.${key}`,
        'must be a whole number of at least 1',
      )
    }
    return value
  }

  title(fields: Fields): string {
    const value = fields['title']
    if (typeof value !== 'string' || value.trim() === '') {
      throw this.problem('title', 'must be non-empty text')
    }
    return value
  }

  finite(fields: Fields, key: string, path: string): number {
    const value = fields[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw this.problem(`${path}.${key}`, 'must be a finite number')
    }
    return value
  }

  positive(fields: Fields, key: string, path: string): number {
    const value = this.finite(fields, key, path)
    if (value <= 0) {
      throw this.problem(`${path}.${key}`, 'must be greater than 0')
    }
    return value
  }

  /** Reads a unique id that starts with `prefix` and records it in `seen`. */
  id(fields: Fields, path: string, prefix: string, seen: Set<string>): string {
    const value = fields['id']
    if (
      typeof value !== 'string' ||
      !value.startsWith(prefix) ||
      value.length === prefix.length
    ) {
      throw this.problem(
        `${path}.id`,
        prefix === ''
          ? 'must be non-empty text'
          : `must be text starting with "${prefix}"`,
      )
    }
    if (seen.has(value)) {
      throw this.problem(`${path}.id`, `repeats the id "${value}"`)
    }
    seen.add(value)
    return value
  }

  asset(
    value: unknown,
    path: string,
    assets: ReadonlyMap<string, MediaKind>,
    kind: MediaKind,
  ): void {
    if (typeof value !== 'string' || assets.get(value) !== kind) {
      throw this.problem(path, `must name an ${kind} asset`)
    }
  }
}

export function parseJsonDocument(document: string, json: string): unknown {
  try {
    return JSON.parse(json) as unknown
  } catch (error: unknown) {
    throw new InvalidDocumentError(document, 'it is not valid JSON', {
      cause: error,
    })
  }
}

/** Checks a graph.json document, which `document` names in errors. */
export function validateGraph(value: unknown, document: string): GraphFacts {
  const check = new DocumentCheck(document)
  const graph = check.record(value, 'the graph')
  checkHeader(check, graph, GRAPH_VERSION)
  const title = check.title(graph)
  return { title, locations: validateBoard(check, graph) }
}

/** Checks a project.json of the single-graph layout and turns it into a graph document. */
export function upgradeLegacyProject(value: unknown, title: string): Fields {
  const check = new DocumentCheck(LEGACY_PROJECT_FILE)
  const project = check.record(value, 'the project')
  checkHeader(check, project, LEGACY_VERSION)
  validateBoard(check, project)
  return { ...project, version: GRAPH_VERSION, title }
}

/** Reads the title from a request to create a graph, such as {"title": "Harbor Town"}. */
export function newGraphTitle(json: string): string {
  const check = new DocumentCheck(NEW_GRAPH)
  return check.title(
    check.record(parseJsonDocument(NEW_GRAPH, json), 'the request'),
  )
}

/** The graph.json of a new graph: an empty board at 100 % zoom. */
export function emptyGraph(title: string): Fields {
  return {
    format: PROJECT_FORMAT,
    version: GRAPH_VERSION,
    title,
    view: { x: 0, y: 0, k: 1 },
    assets: {},
    board: { nodes: [], scenes: [], edges: [], floats: [] },
  }
}

function checkHeader(
  check: DocumentCheck,
  document: Fields,
  version: number,
): void {
  if (document['format'] !== PROJECT_FORMAT) {
    throw check.problem('format', `must be "${PROJECT_FORMAT}"`)
  }
  if (document['version'] !== version) {
    throw check.problem('version', `must be ${version}`)
  }
}

/**
 * Checks everything the board relies on: shapes, unique ids, and references between items.
 * Returns the number of locations.
 */
function validateBoard(check: DocumentCheck, project: Fields): number {
  const view = check.record(project['view'], 'view')
  check.finite(view, 'x', 'view')
  check.finite(view, 'y', 'view')
  check.positive(view, 'k', 'view')
  const assets = validateAssets(check, project['assets'])
  const board = check.record(project['board'], 'board')
  const ids = new Set<string>()
  const locations = new Set<string>()
  const scenes = new Set<string>()

  check.list(board, 'nodes', 'board').forEach((entry, index) => {
    const path = `board.nodes[${index}]`
    const node = check.record(entry, path)
    locations.add(check.id(node, path, 'n_', ids))
    check.finite(node, 'x', path)
    check.finite(node, 'y', path)
    check.positive(node, 'w', path)
    check.positive(node, 'aspect', path)
    if (node['img'] !== null) {
      check.asset(node['img'], `${path}.img`, assets, 'image')
    }
    check.list(node, 'audio', path).forEach((sound, soundIndex) => {
      const soundPath = `${path}.audio[${soundIndex}]`
      const fields = check.record(sound, soundPath)
      check.id(fields, soundPath, '', ids)
      check.asset(fields['asset'], `${soundPath}.asset`, assets, 'audio')
    })
  })

  check.list(board, 'scenes', 'board').forEach((entry, index) => {
    const path = `board.scenes[${index}]`
    const scene = check.record(entry, path)
    scenes.add(check.id(scene, path, 's_', ids))
    check.finite(scene, 'x', path)
    check.finite(scene, 'y', path)
    check.positive(scene, 'w', path)
    check.positive(scene, 'h', path)
  })

  // An arrow joins two locations or two scenes, never one of each.
  check.list(board, 'edges', 'board').forEach((entry, index) => {
    const path = `board.edges[${index}]`
    const edge = check.record(entry, path)
    check.id(edge, path, 'e_', ids)
    const from = String(edge['from'])
    const to = edge['to']
    if (locations.has(from)) {
      if (typeof to !== 'string' || !locations.has(to)) {
        throw check.problem(`${path}.to`, 'must name a location, like from')
      }
    } else if (scenes.has(from)) {
      if (typeof to !== 'string' || !scenes.has(to)) {
        throw check.problem(`${path}.to`, 'must name a scene, like from')
      }
    } else {
      throw check.problem(`${path}.from`, 'must name a location or a scene')
    }
  })

  check.list(board, 'floats', 'board').forEach((entry, index) => {
    const path = `board.floats[${index}]`
    const float = check.record(entry, path)
    check.id(float, path, 'f_', ids)
    check.finite(float, 'x', path)
    check.finite(float, 'y', path)
    check.asset(float['asset'], `${path}.asset`, assets, 'audio')
  })
  validateCast(check, board, assets, ids)
  validateMoods(check, board, assets, ids)
  return locations.size
}

/** The parts every mood describes its image in, each of which a prompt can ask a model for. */
const MOOD_FIELDS = ['colors', 'visual', 'elements', 'scene']

/**
 * Checks the mood deck: images with a subtitle, up to two more images of the same mood,
 * and a description in four parts, and the prompts that ask a model for those parts.
 * Boards from before the deck have neither, which means an empty deck and the prompts
 * of the page.
 */
function validateMoods(
  check: DocumentCheck,
  board: Fields,
  assets: ReadonlyMap<string, MediaKind>,
  ids: Set<string>,
): void {
  if (board['moods'] !== undefined) {
    check.list(board, 'moods', 'board').forEach((entry, index) => {
      const path = `board.moods[${index}]`
      const mood = check.record(entry, path)
      check.id(mood, path, 'm_', ids)
      check.asset(mood['img'], `${path}.img`, assets, 'image')
      check.text(mood, 'title', path)
      const refs = check.list(mood, 'refs', path)
      if (refs.length > 2) {
        throw check.problem(`${path}.refs`, 'must hold at most 2 images')
      }
      refs.forEach((ref, refIndex) => {
        check.asset(ref, `${path}.refs[${refIndex}]`, assets, 'image')
      })
      for (const field of MOOD_FIELDS) {
        check.text(mood, field, path)
      }
    })
  }
  if (board['moodPrompts'] !== undefined) {
    const prompts = check.record(board['moodPrompts'], 'board.moodPrompts')
    for (const field of MOOD_FIELDS) {
      check.text(prompts, field, 'board.moodPrompts')
    }
  }
}

/**
 * Checks the animation sequences and the characters, whose rows of sprites each follow
 * a sequence. Boards from before characters have neither, which means none.
 */
function validateCast(
  check: DocumentCheck,
  board: Fields,
  assets: ReadonlyMap<string, MediaKind>,
  ids: Set<string>,
): void {
  const sequences = new Set<unknown>()
  if (board['sequences'] !== undefined) {
    check.list(board, 'sequences', 'board').forEach((entry, index) => {
      const path = `board.sequences[${index}]`
      const sequence = check.record(entry, path)
      sequences.add(check.id(sequence, path, 'q_', ids))
      check.name(sequence, path)
      check.count(sequence, 'frames', path)
    })
  }
  if (board['characters'] === undefined) {
    return
  }
  check.list(board, 'characters', 'board').forEach((entry, index) => {
    const path = `board.characters[${index}]`
    const character = check.record(entry, path)
    check.id(character, path, 'c_', ids)
    check.name(character, path)
    check.text(character, 'bio', path)
    if (character['img'] !== null) {
      check.asset(character['img'], `${path}.img`, assets, 'image')
    }
    // The part of the picture its square shows, in percent of the square; without one,
    // the square shows the top of the picture.
    if (character['crop'] !== undefined) {
      const crop = check.record(character['crop'], `${path}.crop`)
      check.finite(crop, 'left', `${path}.crop`)
      check.finite(crop, 'top', `${path}.crop`)
      check.positive(crop, 'width', `${path}.crop`)
      check.positive(crop, 'height', `${path}.crop`)
    }
    check.list(character, 'rows', path).forEach((item, rowIndex) => {
      const rowPath = `${path}.rows[${rowIndex}]`
      const row = check.record(item, rowPath)
      check.id(row, rowPath, 'r_', ids)
      if (!sequences.has(row['sequence'])) {
        throw check.problem(
          `${rowPath}.sequence`,
          'must name an animation sequence',
        )
      }
      // A frame without an image is a placeholder.
      check.list(row, 'frames', rowPath).forEach((frame, frameIndex) => {
        if (frame !== null) {
          check.asset(
            frame,
            `${rowPath}.frames[${frameIndex}]`,
            assets,
            'image',
          )
        }
      })
    })
  })
}

function validateAssets(
  check: DocumentCheck,
  value: unknown,
): ReadonlyMap<string, MediaKind> {
  const assets = check.record(value, 'assets')
  const kinds = new Map<string, MediaKind>()
  for (const [id, entry] of Object.entries(assets)) {
    const path = `assets.${id}`
    if (!ASSET_ID.test(id)) {
      throw check.problem(path, 'must have an id like "x_1a2b3c"')
    }
    const asset = check.record(entry, path)
    check.text(asset, 'name', path)
    const file = mediaFileOf(check.text(asset, 'file', path))
    if (file === undefined || file.kind !== asset['kind']) {
      throw check.problem(
        path,
        'must be an image in images/ or a sound in audio/ with a matching kind',
      )
    }
    kinds.set(id, file.kind)
  }
  return kinds
}

/** Checks a chat.json document, which `document` names in errors. */
export function validateChat(value: unknown, document: string): void {
  const check = new DocumentCheck(document)
  if (!Array.isArray(value)) {
    throw check.problem('the chat', 'must be a list of messages')
  }
  value.forEach((entry: unknown, index) => {
    const path = `messages[${index}]`
    const message = check.record(entry, path)
    if (!CHAT_ROLES.has(message['role'])) {
      throw check.problem(
        `${path}.role`,
        'must be "user", "assistant", or "note"',
      )
    }
    check.text(message, 'text', path)
  })
}
