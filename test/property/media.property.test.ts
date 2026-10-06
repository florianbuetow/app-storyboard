import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { mediaFileOf, mediaPath } from '../../src/domain/media.js'

const ids = fc.stringMatching(/^[0-9a-f]{8}$/)
const media = fc.oneof(
  fc.record({
    kind: fc.constant('image' as const),
    extension: fc.constantFrom('png', 'JPG', 'webp', 'svg'),
  }),
  fc.record({
    kind: fc.constant('audio' as const),
    extension: fc.constantFrom('mp3', 'WAV', 'ogg', 'm4a'),
  }),
)

describe('mediaPath properties', () => {
  it('always yields a path that stays in the folder of its kind', () => {
    fc.assert(
      fc.property(fc.string(), media, ids, (base, file, id) => {
        const path = mediaPath(file.kind, `${base}.${file.extension}`, id)
        expect(mediaFileOf(path)?.kind).toBe(file.kind)
        expect(
          path.startsWith(file.kind === 'image' ? 'images/' : 'audio/'),
        ).toBe(true)
        expect(path.endsWith(`-${id}.${file.extension.toLowerCase()}`)).toBe(
          true,
        )
        expect(path.split('/')).toHaveLength(2)
      }),
    )
  })

  it('gives different ids different paths for the same name', () => {
    fc.assert(
      fc.property(fc.string(), ids, ids, (base, first, second) => {
        fc.pre(first !== second)
        expect(mediaPath('image', `${base}.png`, first)).not.toBe(
          mediaPath('image', `${base}.png`, second),
        )
      }),
    )
  })
})
