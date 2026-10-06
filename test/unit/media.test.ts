import { describe, expect, it } from 'vitest'

import {
  InvalidMediaKindError,
  InvalidMediaPathError,
  mediaFileOf,
  mediaPath,
  parseMediaKind,
  parseMediaPath,
  UnsupportedMediaFileError,
} from '../../src/domain/media.js'

describe('parseMediaKind', () => {
  it('accepts image and audio', () => {
    expect(parseMediaKind('image')).toBe('image')
    expect(parseMediaKind('audio')).toBe('audio')
  })

  it('names a missing kind', () => {
    expect(() => parseMediaKind(undefined)).toThrow(
      new InvalidMediaKindError(undefined),
    )
    expect(new InvalidMediaKindError(undefined).message).toBe(
      'media kind is missing, expected "image" or "audio"',
    )
  })

  it('names an unknown kind', () => {
    const error = new InvalidMediaKindError('video')
    expect(() => parseMediaKind('video')).toThrow(error)
    expect(error.message).toBe(
      'media kind must be "image" or "audio", got "video"',
    )
    expect(error.name).toBe('InvalidMediaKindError')
    expect(error.value).toBe('video')
  })
})

describe('mediaPath', () => {
  it.each([
    ['image', 'Harbor Town.PNG', 'images/harbor-town-1a2b.png'],
    ['image', 'Café Müller.jpg', 'images/cafe-muller-1a2b.jpg'],
    ['image', '  --Lamp__Room--  .webp', 'images/lamp-room-1a2b.webp'],
    ['image', '.png', 'images/image-1a2b.png'],
    ['audio', 'gulls at dawn.mp3', 'audio/gulls-at-dawn-1a2b.mp3'],
    ['audio', '---.ogg', 'audio/audio-1a2b.ogg'],
  ] as const)('stores a %s named %j as %s', (kind, name, path) => {
    expect(mediaPath(kind, name, '1a2b')).toBe(path)
  })

  it('shortens long names to 40 characters without a trailing dash', () => {
    const name = `${'a'.repeat(39)} b c.png`
    expect(mediaPath('image', name, 'ff')).toBe(
      `images/${'a'.repeat(39)}-ff.png`,
    )
  })

  it.each([
    ['image', 'notes.txt'],
    ['image', 'photo'],
    ['image', 'song.mp3'],
    ['audio', 'cover.png'],
    ['image', 'x.constructor'],
  ] as const)('rejects a %s named %j', (kind, name) => {
    expect(() => mediaPath(kind, name, '1a2b')).toThrow(
      UnsupportedMediaFileError,
    )
  })

  it('lists the supported extensions in the error', () => {
    const error = new UnsupportedMediaFileError('image', 'notes.txt')
    expect(error.message).toBe(
      '"notes.txt" is not a supported image file, use one of: avif, bmp, gif, jpeg, jpg, png, svg, webp',
    )
    expect(error.name).toBe('UnsupportedMediaFileError')
    expect(error.kind).toBe('image')
    expect(error.fileName).toBe('notes.txt')
    expect(new UnsupportedMediaFileError('audio', 'a.png').message).toBe(
      '"a.png" is not a supported audio file, use one of: aac, flac, m4a, mp3, oga, ogg, opus, wav, webm',
    )
  })
})

describe('mediaFileOf', () => {
  it.each([
    ['images/a-1.avif', 'image', 'image/avif'],
    ['images/a-1.bmp', 'image', 'image/bmp'],
    ['images/a-1.gif', 'image', 'image/gif'],
    ['images/a-1.jpeg', 'image', 'image/jpeg'],
    ['images/a-1.jpg', 'image', 'image/jpeg'],
    ['images/a-1.png', 'image', 'image/png'],
    ['images/a-1.svg', 'image', 'image/svg+xml'],
    ['images/a-1.webp', 'image', 'image/webp'],
    ['audio/a-1.aac', 'audio', 'audio/aac'],
    ['audio/a-1.flac', 'audio', 'audio/flac'],
    ['audio/a-1.m4a', 'audio', 'audio/mp4'],
    ['audio/a-1.mp3', 'audio', 'audio/mpeg'],
    ['audio/a-1.oga', 'audio', 'audio/ogg'],
    ['audio/a-1.ogg', 'audio', 'audio/ogg'],
    ['audio/a-1.opus', 'audio', 'audio/ogg'],
    ['audio/a-1.wav', 'audio', 'audio/wav'],
    ['audio/a-1.webm', 'audio', 'audio/webm'],
  ])('serves %s as %s with %s', (path, kind, contentType) => {
    expect(mediaFileOf(path)).toEqual({ kind, contentType })
    expect(parseMediaPath(path)).toEqual({ kind, contentType })
  })

  it.each([
    'images/a-1.mp3',
    'audio/a-1.png',
    'images/a-1.txt',
    'videos/a-1.png',
    'images/Harbor-1.png',
    'images/a--1.png',
    'images/-a.png',
    'images/a-.png',
    'images/.png',
    'images/a.png/b',
    'images/../a.png',
    '../images/a.png',
    '/images/a.png',
    'images/a-1.png ',
    '',
  ])('refuses %j', (path) => {
    expect(mediaFileOf(path)).toBeUndefined()
    expect(() => parseMediaPath(path)).toThrow(new InvalidMediaPathError(path))
  })

  it('names the refused path', () => {
    const error = new InvalidMediaPathError('../a.png')
    expect(error.message).toBe('not a media file path: ../a.png')
    expect(error.name).toBe('InvalidMediaPathError')
    expect(error.path).toBe('../a.png')
  })
})
