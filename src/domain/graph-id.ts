import { MAX_SLUG_LENGTH, slug } from './slug.js'

// A graph id names the graph's folder below <data>/graphs: a slug of the title, a dash, and 8
// hex characters, for example harbor-town-3f9a2c1d. Only lowercase letters, digits, and
// single inner dashes are allowed, so an id is always one folder name and never a path.
const GRAPH_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}$/
// The longest slug, the dash, and the 8 hex characters.
const MAX_GRAPH_ID_LENGTH = MAX_SLUG_LENGTH + 9

export class InvalidGraphIdError extends Error {
  constructor(readonly id: string) {
    super(`not a graph id: ${id}`)
    this.name = 'InvalidGraphIdError'
  }
}

export function isGraphId(value: string): boolean {
  return value.length <= MAX_GRAPH_ID_LENGTH && GRAPH_ID.test(value)
}

export function parseGraphId(value: string): string {
  if (!isGraphId(value)) {
    throw new InvalidGraphIdError(value)
  }
  return value
}

/** Names the folder of a new graph; `suffix` is 8 random hex characters that keep ids unique. */
export function graphId(title: string, suffix: string): string {
  const base = slug(title)
  return parseGraphId(`${base === '' ? 'graph' : base}-${suffix}`)
}
