import type { MediaFile } from './media.js'

/** The longest side, in pixels, of each smaller version kept for an image. */
export const IMAGE_SIZES = [200, 400, 800, 1600] as const

export type ImageSize = (typeof IMAGE_SIZES)[number]

// Formats that get smaller versions; vector images already scale for free and resizing
// an animation would drop its frames.
const SCALABLE: ReadonlySet<string> = new Set([
  'image/avif',
  'image/jpeg',
  'image/png',
  'image/webp',
])

export class InvalidImageSizeError extends Error {
  constructor(readonly value: string) {
    super(`size must be one of ${IMAGE_SIZES.join(', ')}, got "${value}"`)
    this.name = 'InvalidImageSizeError'
  }
}

/** Reads the `size` query parameter; null asks for the stored file itself. */
export function parseImageSize(value: string | null): ImageSize | null {
  if (value === null) {
    return null
  }
  const size = IMAGE_SIZES.find((candidate) => String(candidate) === value)
  if (size === undefined) {
    throw new InvalidImageSizeError(value)
  }
  return size
}

export function isScalable(file: MediaFile): boolean {
  return SCALABLE.has(file.contentType)
}

/** Where the version of a stored image that fits `size` × `size` pixels is kept. */
export function scaledImagePath(path: string, size: ImageSize): string {
  return `scaled/${size}/${path.slice(path.lastIndexOf('/') + 1)}.webp`
}
