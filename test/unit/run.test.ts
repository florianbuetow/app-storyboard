import { createServer } from 'node:net'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import {
  EXIT_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE,
  run,
  type CliIo,
} from '../../src/cli/run.js'
import { legacyProject, validChat } from '../fixtures/project.js'

interface Captured {
  readonly io: CliIo
  readonly stdout: () => string
  readonly stderr: () => string
  /** Simulates SIGINT/SIGTERM for a running `serve`. */
  readonly shutdown: () => void
}

function capture(stdinText: string): Captured {
  const out: string[] = []
  const err: string[] = []
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  stdout.on('data', (chunk: Buffer) => out.push(chunk.toString('utf8')))
  stderr.on('data', (chunk: Buffer) => err.push(chunk.toString('utf8')))
  let shutdown = (): void => {
    throw new Error('serve has not waited for shutdown yet')
  }
  return {
    io: {
      stdin: Readable.from([stdinText]),
      stdout,
      stderr,
      untilShutdown: () =>
        new Promise((resolve) => {
          shutdown = resolve
        }),
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    shutdown: () => {
      shutdown()
    },
  }
}

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition was never met')
}

describe('run', () => {
  it('prints usage and succeeds for --help', async () => {
    const captured = capture('')
    expect(await run(['--help'], captured.io)).toBe(EXIT_SUCCESS)
    expect(captured.stdout()).toContain('Usage:')
    expect(captured.stderr()).toBe('')
  })

  it('summarizes stdin as JSON', async () => {
    const captured = capture('1\n2\n3\n')
    expect(await run(['summarize', '-'], captured.io)).toBe(EXIT_SUCCESS)
    expect(JSON.parse(captured.stdout())).toEqual({
      count: 3,
      min: 1,
      max: 3,
      mean: 2,
    })
  })

  it('returns the usage exit code and prints usage to stderr for bad arguments', async () => {
    const captured = capture('')
    expect(await run(['frobnicate'], captured.io)).toBe(EXIT_USAGE)
    expect(captured.stdout()).toBe('')
    expect(captured.stderr()).toContain('error: unknown command: frobnicate')
    expect(captured.stderr()).toContain('Usage:')
  })

  it('returns the failure exit code for invalid input', async () => {
    const captured = capture('1\nnope\n')
    expect(await run(['summarize', '-'], captured.io)).toBe(EXIT_FAILURE)
    expect(captured.stderr()).toBe('error: line 2 is not a number: "nope"\n')
  })

  it('returns the failure exit code for an unreadable file', async () => {
    const captured = capture('')
    expect(
      await run(['summarize', 'data/input/does-not-exist.txt'], captured.io),
    ).toBe(EXIT_FAILURE)
    expect(captured.stderr()).toBe(
      'error: cannot read input from data/input/does-not-exist.txt\n',
    )
  })

  it('serves until shutdown, printing the URL and logging failures', async () => {
    const data = await mkdtemp(join(tmpdir(), 'run-serve-'))
    await mkdir(join(data, 'graphs', 'broken-0a1b2c3d', 'chat.json'), {
      recursive: true,
    })
    await writeFile(join(data, 'graphs', 'broken-0a1b2c3d', 'graph.json'), '{}')
    const captured = capture('')
    const exitCode = run(
      [
        'serve',
        '--port',
        '0',
        '--data',
        data,
        '--lmstudio',
        'http://127.0.0.1:1234',
      ],
      captured.io,
    )
    await eventually(() => captured.stdout().endsWith('\n'))
    const url = captured.stdout().trim()
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)

    const health = await fetch(new URL('health', url))
    expect(await health.json()).toEqual({
      app: 'app-storyboard',
      status: 'ok',
      pid: process.pid,
    })
    const chat = await fetch(new URL('api/graphs/broken-0a1b2c3d/chat', url))
    expect(chat.status).toBe(500)
    expect(captured.stderr()).toMatch(/^request failed: Error: EISDIR.*\n$/)

    captured.shutdown()
    expect(await exitCode).toBe(EXIT_SUCCESS)
    await expect(fetch(new URL('health', url))).rejects.toThrow()
  })

  it('moves the single-graph layout into a graph before it serves', async () => {
    const data = await mkdtemp(join(tmpdir(), 'run-serve-'))
    await writeFile(join(data, 'project.json'), JSON.stringify(legacyProject()))
    await writeFile(join(data, 'chat.json'), JSON.stringify(validChat))
    await mkdir(join(data, 'images'))
    const captured = capture('')
    const exitCode = run(
      [
        'serve',
        '--port',
        '0',
        '--data',
        data,
        '--lmstudio',
        'http://127.0.0.1:1234',
      ],
      captured.io,
    )
    await eventually(() => captured.stdout().endsWith('\n'))
    const url = captured.stdout().trim()

    const [id] = await readdir(join(data, 'graphs'))
    expect(id).toMatch(/^location-graph-[0-9a-f]{8}$/)
    expect(captured.stderr()).toBe(
      'moved the single-graph layout into the graph "Location graph":\n' +
        `  project.json -> graphs/${id}/graph.json\n` +
        `  chat.json -> graphs/${id}/chat.json\n` +
        `  images -> graphs/${id}/images\n`,
    )
    const graphs = await fetch(new URL('api/graphs', url))
    expect(await graphs.json()).toMatchObject([
      { id, title: 'Location graph', locations: 2 },
    ])

    captured.shutdown()
    expect(await exitCode).toBe(EXIT_SUCCESS)
  })

  it('fails without serving when the single-graph layout cannot be moved', async () => {
    const data = await mkdtemp(join(tmpdir(), 'run-serve-'))
    await writeFile(join(data, 'project.json'), '{"format":"location-graph"}')
    const captured = capture('')
    expect(
      await run(
        [
          'serve',
          '--port',
          '0',
          '--data',
          data,
          '--lmstudio',
          'http://127.0.0.1:1234',
        ],
        captured.io,
      ),
    ).toBe(EXIT_FAILURE)
    expect(captured.stdout()).toBe('')
    expect(captured.stderr()).toBe(
      'error: project.json is invalid: version must be 1\n',
    )
    expect(await readdir(data)).toEqual(['project.json'])
  })

  it('fails when the data folder is missing', async () => {
    const missing = join(tmpdir(), 'run-serve-missing-folder')
    const captured = capture('')
    expect(
      await run(
        [
          'serve',
          '--port',
          '0',
          '--data',
          missing,
          '--lmstudio',
          'http://127.0.0.1:1234',
        ],
        captured.io,
      ),
    ).toBe(EXIT_FAILURE)
    expect(captured.stdout()).toBe('')
    expect(captured.stderr()).toBe(
      `error: data folder does not exist or is not a directory: ${missing}\n`,
    )
  })

  it('fails when the port is taken', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => {
      blocker.listen(0, '127.0.0.1', resolve)
    })
    const address = blocker.address()
    const port =
      typeof address === 'object' && address !== null ? address.port : 0
    const data = await mkdtemp(join(tmpdir(), 'run-serve-'))
    const captured = capture('')
    try {
      expect(
        await run(
          [
            'serve',
            '--port',
            String(port),
            '--data',
            data,
            '--lmstudio',
            'http://127.0.0.1:1234',
          ],
          captured.io,
        ),
      ).toBe(EXIT_FAILURE)
    } finally {
      blocker.close()
    }
    expect(captured.stderr()).toBe(`error: port ${port} is already in use\n`)
  })
})
