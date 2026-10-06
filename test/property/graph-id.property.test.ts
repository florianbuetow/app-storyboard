import { posix, win32 } from 'node:path'

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { graphId, isGraphId } from '../../src/domain/graph-id.js'

const suffixes = fc.stringMatching(/^[0-9a-f]{8}$/)
const titles = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme' }),
  fc.string({ unit: fc.constantFrom('a', 'Z', '0', ' ', '-', '.', '/', 'é') }),
)
// Strings made of the characters that matter for paths hit the interesting cases often.
const candidates = fc.oneof(
  fc.string(),
  fc.string({
    unit: fc.constantFrom('a', 'f', '0', '9', '-', '.', '/', '\\', '%', 'A'),
  }),
  suffixes.map((suffix) => `harbor-${suffix}`),
)

/** True when `id` names a direct child of a folder on POSIX and on Windows alike. */
function staysInside(id: string): boolean {
  return (
    posix.resolve('/data/graphs', id) === `/data/graphs/${id}` &&
    win32.resolve('C:\\data\\graphs', id) === `C:\\data\\graphs\\${id}`
  )
}

describe('graph id properties', () => {
  it('names every title with an id that stays inside the graphs folder', () => {
    fc.assert(
      fc.property(titles, suffixes, (title, suffix) => {
        const id = graphId(title, suffix)
        expect(isGraphId(id)).toBe(true)
        expect(id.endsWith(`-${suffix}`)).toBe(true)
        expect(id).toMatch(/^[a-z0-9-]+$/)
        expect(id.length).toBeLessThanOrEqual(49)
        expect(staysInside(id)).toBe(true)
      }),
    )
  })

  it('accepts only ids that stay inside the graphs folder', () => {
    fc.assert(
      fc.property(candidates, (candidate) => {
        if (isGraphId(candidate)) {
          expect(staysInside(candidate)).toBe(true)
          expect(candidate).not.toMatch(/[./\\%A-Z]/)
        }
      }),
    )
  })

  it('gives the same title different ids for different suffixes', () => {
    fc.assert(
      fc.property(titles, suffixes, suffixes, (title, first, second) => {
        fc.pre(first !== second)
        expect(graphId(title, first)).not.toBe(graphId(title, second))
      }),
    )
  })

  it('names a title the same way every time', () => {
    fc.assert(
      fc.property(titles, suffixes, (title, suffix) => {
        expect(graphId(title, suffix)).toBe(graphId(title, suffix))
      }),
    )
  })
})
