import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { legacyProject } from '../fixtures/project.js'

const CLI = join(process.cwd(), 'dist', 'index.js')

interface Result {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

function runCli(args: readonly string[], stdin: string): Result {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    input: stdin,
    encoding: 'utf8',
  })
  if (result.error !== undefined) {
    throw result.error
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('built CLI', () => {
  it('prints usage and exits 0 for --help', () => {
    const result = runCli(['--help'], '')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Usage:')
    expect(result.stderr).toBe('')
  })

  it('summarizes a file argument', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-test-'))
    const file = join(dir, 'numbers.txt')
    writeFileSync(file, '10\n20\n30\n')
    const result = runCli(['summarize', file], '')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      count: 3,
      min: 10,
      max: 30,
      mean: 20,
    })
    expect(result.stderr).toBe('')
  })

  it('summarizes stdin when the source is -', () => {
    const result = runCli(['summarize', '-'], '2\n4\n')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      count: 2,
      min: 2,
      max: 4,
      mean: 3,
    })
  })

  it('exits 2 with usage on stderr when arguments are missing', () => {
    const result = runCli([], '')
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('error: missing command')
    expect(result.stderr).toContain('Usage:')
  })

  it('exits 1 and names the offending line for invalid input', () => {
    const result = runCli(['summarize', '-'], '1\nx\n')
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('error: line 2 is not a number: "x"\n')
  })

  it('serves /health until SIGTERM and then exits 0', async () => {
    const data = mkdtempSync(join(tmpdir(), 'cli-serve-'))
    const child = spawn(process.execPath, [
      CLI,
      'serve',
      '--port',
      '0',
      '--data',
      data,
      '--lmstudio',
      'http://127.0.0.1:1234',
    ])
    const stderr: string[] = []
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))
    const [firstLine] = (await once(child.stdout, 'data')) as [Buffer]
    const url = firstLine.toString('utf8').trim()
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)

    const health = (await (await fetch(new URL('health', url))).json()) as {
      app: string
      pid: number
    }
    expect(health.app).toBe('app-storyboard')
    expect(health.pid).toBe(child.pid)

    child.kill('SIGTERM')
    const [code] = (await once(child, 'exit')) as [number | null]
    expect(code).toBe(0)
    expect(stderr.join('')).toBe('')
  })

  it('moves the single-graph layout into a graph, reports it on stderr, and serves it', async () => {
    const data = mkdtempSync(join(tmpdir(), 'cli-serve-'))
    writeFileSync(join(data, 'project.json'), JSON.stringify(legacyProject()))
    mkdirSync(join(data, 'audio'))
    const child = spawn(process.execPath, [
      CLI,
      'serve',
      '--port',
      '0',
      '--data',
      data,
      '--lmstudio',
      'http://127.0.0.1:1234',
    ])
    const stderr: string[] = []
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))
    const [firstLine] = (await once(child.stdout, 'data')) as [Buffer]
    const url = firstLine.toString('utf8').trim()

    const [id] = readdirSync(join(data, 'graphs'))
    const graphs = (await (
      await fetch(new URL('api/graphs', url))
    ).json()) as unknown
    expect(graphs).toMatchObject([
      { id, title: 'Location graph', locations: 2 },
    ])
    expect(readdirSync(data)).toEqual(['graphs'])

    child.kill('SIGTERM')
    const [code] = (await once(child, 'exit')) as [number | null]
    expect(code).toBe(0)
    expect(stderr.join('')).toBe(
      'moved the single-graph layout into the graph "Location graph":\n' +
        `  project.json -> graphs/${String(id)}/graph.json\n` +
        `  audio -> graphs/${String(id)}/audio\n`,
    )
  })

  it('exits 1 without serving when the single-graph layout cannot be moved', () => {
    const data = mkdtempSync(join(tmpdir(), 'cli-serve-'))
    writeFileSync(join(data, 'project.json'), '[]')
    const result = runCli(
      [
        'serve',
        '--port',
        '0',
        '--data',
        data,
        '--lmstudio',
        'http://127.0.0.1:1234',
      ],
      '',
    )
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(
      'error: project.json is invalid: the project must be an object\n',
    )
    expect(readdirSync(data)).toEqual(['project.json'])
  })

  it('exits 2 with usage when serve options are missing', () => {
    const result = runCli(['serve'], '')
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('error: serve needs --port <port>')
    expect(result.stderr).toContain('Usage:')
  })

  it('exits 1 for a missing file', () => {
    const result = runCli(
      ['summarize', join(tmpdir(), 'missing-input-file.txt')],
      '',
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/^error: cannot read input from /)
  })
})
