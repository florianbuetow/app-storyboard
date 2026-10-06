import { describe, expect, it } from 'vitest'

import {
  graphId,
  InvalidGraphIdError,
  isGraphId,
  parseGraphId,
} from '../../src/domain/graph-id.js'

describe('graphId', () => {
  it.each([
    ['Harbor Town', 'harbor-town-3f9a2c1d'],
    ['Café Müller', 'cafe-muller-3f9a2c1d'],
    ['  --The  Lighthouse__  ', 'the-lighthouse-3f9a2c1d'],
    ['Location graph', 'location-graph-3f9a2c1d'],
    ['!!!', 'graph-3f9a2c1d'],
    ['東京', 'graph-3f9a2c1d'],
  ])('names a graph titled %j %s', (title, id) => {
    expect(graphId(title, '3f9a2c1d')).toBe(id)
  })

  it('shortens long titles to 40 characters without a trailing dash', () => {
    const id = graphId(`${'a'.repeat(39)} b c`, '00000000')
    expect(id).toBe(`${'a'.repeat(39)}-00000000`)
    const longest = graphId('b'.repeat(60), 'ffffffff')
    expect(longest).toBe(`${'b'.repeat(40)}-ffffffff`)
    expect(longest).toHaveLength(49)
  })

  it('refuses a suffix that is not 8 lowercase hex characters', () => {
    expect(() => graphId('Harbor', '3F9A2C1D')).toThrow(
      new InvalidGraphIdError('harbor-3F9A2C1D'),
    )
    expect(() => graphId('Harbor', '3f9a2c1')).toThrow(InvalidGraphIdError)
    expect(() => graphId('Harbor', '../x')).toThrow(InvalidGraphIdError)
  })
})

describe('isGraphId and parseGraphId', () => {
  it.each([
    'harbor-town-3f9a2c1d',
    'a-00000000',
    '0-ffffffff',
    'graph-3f9a2c1d',
    'harbor-town-copy-2-0a1b2c3d',
    `${'a'.repeat(40)}-0a1b2c3d`,
    `${'a-'.repeat(19)}ab-0a1b2c3d`,
  ])('accepts %s', (id) => {
    expect(isGraphId(id)).toBe(true)
    expect(parseGraphId(id)).toBe(id)
  })

  it.each([
    '',
    '3f9a2c1d',
    '-3f9a2c1d',
    'a--3f9a2c1d',
    'a_b-3f9a2c1d',
    'Harbor-3f9a2c1d',
    'harbor-3F9A2C1D',
    'harbor-3f9a2c1',
    'harbor-3f9a2c1d0',
    'harbor-3f9a2c1g',
    'harbor-3f9a2c1d-',
    'harbor 3f9a2c1d',
    'harbor.town-3f9a2c1d',
    '..',
    '../harbor-3f9a2c1d',
    'harbor-3f9a2c1d/..',
    'graphs/harbor-3f9a2c1d',
    'harbor\\..-3f9a2c1d',
    'harbor-3f9a2c1d\n',
    ' harbor-3f9a2c1d',
    '%2e%2e-3f9a2c1d',
    `${'a'.repeat(41)}-0a1b2c3d`,
  ])('refuses %j', (id) => {
    expect(isGraphId(id)).toBe(false)
    expect(() => parseGraphId(id)).toThrow(new InvalidGraphIdError(id))
  })

  it('names the refused id', () => {
    const error = new InvalidGraphIdError('../x')
    expect(error.message).toBe('not a graph id: ../x')
    expect(error.name).toBe('InvalidGraphIdError')
    expect(error.id).toBe('../x')
  })
})
