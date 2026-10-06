import { describe, expect, it } from 'vitest'

import {
  IMAGE_SIZES,
  InvalidImageSizeError,
  isScalable,
  parseImageSize,
  scaledImagePath,
} from '../../src/domain/image-size.js'
import { parseMediaPath } from '../../src/domain/media.js'

describe('parseImageSize', () => {
  it('reads no size as the stored file', () => {
    expect(parseImageSize(null)).toBeNull()
  })

  it('accepts each kept size', () => {
    expect(IMAGE_SIZES).toEqual([200, 400, 800, 1600])
    for (const size of IMAGE_SIZES) {
      expect(parseImageSize(String(size))).toBe(size)
    }
  })

  it.each(['', '0', '300', '400px', ' 400', '1600.0', '3200', 'original'])(
    'refuses %j',
    (value) => {
      const error = new InvalidImageSizeError(value)
      expect(() => parseImageSize(value)).toThrow(error)
      expect(error.message).toBe(
        `size must be one of 200, 400, 800, 1600, got "${value}"`,
      )
      expect(error.name).toBe('InvalidImageSizeError')
      expect(error.value).toBe(value)
    },
  )
})

describe('isScalable', () => {
  it.each([
    ['images/a-1.jpg', true],
    ['images/a-1.jpeg', true],
    ['images/a-1.png', true],
    ['images/a-1.webp', true],
    ['images/a-1.avif', true],
    ['images/a-1.svg', false],
    ['images/a-1.gif', false],
    ['images/a-1.bmp', false],
    ['audio/a-1.mp3', false],
  ])('%s gets smaller versions: %s', (path, expected) => {
    expect(isScalable(parseMediaPath(path))).toBe(expected)
  })
})

describe('scaledImagePath', () => {
  it('keeps each size in its own folder and keeps the full name', () => {
    expect(scaledImagePath('images/harbor-town-1a2b3c4d.png', 200)).toBe(
      'scaled/200/harbor-town-1a2b3c4d.png.webp',
    )
    expect(scaledImagePath('images/harbor-town-1a2b3c4d.jpg', 1600)).toBe(
      'scaled/1600/harbor-town-1a2b3c4d.jpg.webp',
    )
  })
})
