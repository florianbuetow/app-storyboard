import { slug } from './slug.js'

export type MediaKind = 'image' | 'audio'

export interface MediaFile {
  readonly kind: MediaKind
  readonly contentType: string
}

const FOLDERS: Readonly<Record<MediaKind, string>> = {
  image: 'images',
  audio: 'audio',
}

const CONTENT_TYPES: Readonly<Record<MediaKind, ReadonlyMap<string, string>>> =
  {
    image: new Map([
      ['avif', 'image/avif'],
      ['bmp', 'image/bmp'],
      ['gif', 'image/gif'],
      ['jpeg', 'image/jpeg'],
      ['jpg', 'image/jpeg'],
      ['png', 'image/png'],
      ['svg', 'image/svg+xml'],
      ['webp', 'image/webp'],
    ]),
    audio: new Map([
      ['aac', 'audio/aac'],
      ['flac', 'audio/flac'],
      ['m4a', 'audio/mp4'],
      ['mp3', 'audio/mpeg'],
      ['oga', 'audio/ogg'],
      ['ogg', 'audio/ogg'],
      ['opus', 'audio/ogg'],
      ['wav', 'audio/wav'],
      ['webm', 'audio/webm'],
    ]),
  }

// A stored media file lives at images/<stem>.<ext> or audio/<stem>.<ext>, where the stem is
// lowercase words joined by single dashes, so a path can never leave its folder.
const MEDIA_PATH = /^(images|audio)\/[a-z0-9]+(?:-[a-z0-9]+)*\.([a-z0-9]+)$/

export class InvalidMediaKindError extends Error {
  constructor(readonly value: string | undefined) {
    super(
      value === undefined
        ? 'media kind is missing, expected "image" or "audio"'
        : `media kind must be "image" or "audio", got "${value}"`,
    )
    this.name = 'InvalidMediaKindError'
  }
}

export class UnsupportedMediaFileError extends Error {
  constructor(
    readonly kind: MediaKind,
    readonly fileName: string,
  ) {
    super(
      `"${fileName}" is not a supported ${kind} file, use one of: ${[...CONTENT_TYPES[kind].keys()].join(', ')}`,
    )
    this.name = 'UnsupportedMediaFileError'
  }
}

export class InvalidMediaPathError extends Error {
  constructor(readonly path: string) {
    super(`not a media file path: ${path}`)
    this.name = 'InvalidMediaPathError'
  }
}

export function parseMediaKind(value: string | undefined): MediaKind {
  if (value === 'image' || value === 'audio') {
    return value
  }
  throw new InvalidMediaKindError(value)
}

/** Turns an uploaded file name into its storage path; `id` keeps names unique. */
export function mediaPath(
  kind: MediaKind,
  fileName: string,
  id: string,
): string {
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  const extension = match?.[1]
  if (extension === undefined || !CONTENT_TYPES[kind].has(extension)) {
    throw new UnsupportedMediaFileError(kind, fileName)
  }
  const base = slug(fileName.slice(0, -(extension.length + 1)))
  return `${FOLDERS[kind]}/${base === '' ? kind : base}-${id}.${extension}`
}

export function mediaFileOf(path: string): MediaFile | undefined {
  const match = path.match(MEDIA_PATH)
  const kind: MediaKind = match?.[1] === 'images' ? 'image' : 'audio'
  const extension = match?.[2]
  const contentType =
    extension === undefined ? undefined : CONTENT_TYPES[kind].get(extension)
  return contentType === undefined ? undefined : { kind, contentType }
}

export function parseMediaPath(path: string): MediaFile {
  const file = mediaFileOf(path)
  if (file === undefined) {
    throw new InvalidMediaPathError(path)
  }
  return file
}
