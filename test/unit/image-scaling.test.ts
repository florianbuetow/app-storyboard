import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import {
  GraphFolder,
  ImageScaleError,
  MediaNotFoundError,
} from '../../src/application/graph-folder.js'
import { InvalidMediaPathError } from '../../src/domain/media.js'

const WIDE = 'images/wide-1a2b3c4d.png'

async function folderWith(
  files: Readonly<Record<string, Buffer | string>>,
): Promise<{ folder: GraphFolder; path: string }> {
  const path = await mkdtemp(join(tmpdir(), 'image-scaling-'))
  await mkdir(join(path, 'images'))
  await mkdir(join(path, 'audio'))
  for (const [name, data] of Object.entries(files)) {
    await writeFile(join(path, name), data)
  }
  return { folder: new GraphFolder(path, 'graphs/test'), path }
}

const picture = (width: number, height: number): Promise<Buffer> =>
  sharp({
    create: { width, height, channels: 3, background: '#3d6fb6' },
  })
    .png()
    .toBuffer()

async function size(data: Buffer): Promise<[number, number, string]> {
  const { width, height, format } = await sharp(data).metadata()
  return [width, height, format]
}

async function rejection(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation()
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error
    }
    throw error
  }
  throw new Error('expected the operation to reject')
}

describe('GraphFolder.readImage', () => {
  it('serves the stored file when no size is asked for', async () => {
    const png = await picture(1000, 500)
    const { folder } = await folderWith({ [WIDE]: png })
    expect(await folder.readImage(WIDE, null)).toEqual({
      data: png,
      contentType: 'image/png',
    })
  })

  it('scales an image to fit the size, as WebP, and keeps the result', async () => {
    const { folder, path } = await folderWith({
      [WIDE]: await picture(1000, 500),
    })
    for (const [requested, expected] of [
      [200, [200, 100]],
      [400, [400, 200]],
      [800, [800, 400]],
    ] as const) {
      const scaled = await folder.readImage(WIDE, requested)
      expect(scaled.contentType).toBe('image/webp')
      expect(await size(scaled.data)).toEqual([...expected, 'webp'])
      expect(
        await readFile(
          join(path, 'scaled', String(requested), 'wide-1a2b3c4d.png.webp'),
        ),
      ).toEqual(scaled.data)
    }
    expect(await readdir(join(path, 'scaled'))).toEqual(['200', '400', '800'])
  })

  it('never enlarges a small image', async () => {
    const { folder } = await folderWith({ [WIDE]: await picture(300, 150) })
    expect(await size((await folder.readImage(WIDE, 1600)).data)).toEqual([
      300,
      150,
      'webp',
    ])
  })

  it('turns a photo upright before scaling it', async () => {
    const turned = await sharp(await picture(1000, 500))
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer()
    const { folder } = await folderWith({ 'images/photo-1.jpg': turned })
    expect(
      await size((await folder.readImage('images/photo-1.jpg', 200)).data),
    ).toEqual([100, 200, 'webp'])
  })

  it('serves a kept version without reading the stored file again', async () => {
    const { folder, path } = await folderWith({
      [WIDE]: await picture(1000, 500),
    })
    const first = await folder.readImage(WIDE, 400)
    await writeFile(join(path, WIDE), 'replaced')
    expect(await folder.readImage(WIDE, 400)).toEqual(first)
  })

  it.each([
    [
      'images/plan-1.svg',
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      'image/svg+xml',
    ],
    ['images/loop-1.gif', 'GIF89a', 'image/gif'],
    ['images/old-1.bmp', 'BM', 'image/bmp'],
    ['audio/gulls-1.mp3', 'ID3', 'audio/mpeg'],
  ])('serves %s itself at any size', async (file, content, contentType) => {
    const { folder, path } = await folderWith({ [file]: content })
    expect(await folder.readImage(file, 200)).toEqual({
      data: Buffer.from(content),
      contentType,
    })
    expect(await readdir(path)).toEqual(['audio', 'images'])
  })

  it('names the image that cannot be scaled and keeps nothing', async () => {
    const { folder, path } = await folderWith({ [WIDE]: 'not a picture' })
    const error = await rejection(() => folder.readImage(WIDE, 200))
    expect(error).toBeInstanceOf(ImageScaleError)
    expect(error.name).toBe('ImageScaleError')
    expect(error.message).toBe(`cannot make a smaller version of ${WIDE}`)
    expect((error as ImageScaleError).path).toBe(WIDE)
    expect(error.cause).toBeInstanceOf(Error)
    expect(await readdir(path)).toEqual(['audio', 'images'])
  })

  it('reports a missing image and refuses paths outside the media folders', async () => {
    const { folder } = await folderWith({})
    expect(
      await rejection(() => folder.readImage('images/gone-1.png', 200)),
    ).toBeInstanceOf(MediaNotFoundError)
    expect(
      await rejection(() => folder.readImage('../graph.json', 200)),
    ).toEqual(new InvalidMediaPathError('../graph.json'))
  })

  it('passes on read failures of a kept version other than a missing file', async () => {
    const { folder, path } = await folderWith({
      [WIDE]: await picture(1000, 500),
    })
    await mkdir(join(path, 'scaled', '200', 'wide-1a2b3c4d.png.webp'), {
      recursive: true,
    })
    const error = await rejection(() => folder.readImage(WIDE, 200))
    expect(error).not.toBeInstanceOf(ImageScaleError)
    expect((error as NodeJS.ErrnoException).code).toBe('EISDIR')
  })
})
