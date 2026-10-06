import { describe, expect, it } from 'vitest'

import { parseArguments, USAGE, UsageError } from '../../src/cli/arguments.js'

describe('parseArguments', () => {
  it('recognizes both help flags', () => {
    expect(parseArguments(['--help'])).toEqual({ kind: 'help' })
    expect(parseArguments(['-h'])).toEqual({ kind: 'help' })
  })

  it('parses a summarize command with a file source', () => {
    expect(parseArguments(['summarize', 'data/input/numbers.txt'])).toEqual({
      kind: 'summarize',
      source: 'data/input/numbers.txt',
    })
  })

  it('parses a summarize command that reads stdin', () => {
    expect(parseArguments(['summarize', '-'])).toEqual({
      kind: 'summarize',
      source: '-',
    })
  })

  it('rejects a missing command', () => {
    expect(() => parseArguments([])).toThrow(UsageError)
    expect(() => parseArguments([])).toThrow('missing command')
  })

  it('rejects an unknown command', () => {
    expect(() => parseArguments(['frobnicate'])).toThrow(
      'unknown command: frobnicate',
    )
  })

  it('rejects a missing or surplus source', () => {
    expect(() => parseArguments(['summarize'])).toThrow(
      'summarize takes exactly one source: a file path or -',
    )
    expect(() => parseArguments(['summarize', 'a', 'b'])).toThrow(
      'summarize takes exactly one source: a file path or -',
    )
  })

  it('rejects an empty source', () => {
    expect(() => parseArguments(['summarize', ''])).toThrow(
      'summarize source must not be empty',
    )
  })

  const LMSTUDIO = ['--lmstudio', 'http://127.0.0.1:1234']

  it('parses a serve command with its options in any order', () => {
    expect(
      parseArguments([
        'serve',
        '--port',
        '8080',
        '--data',
        'data',
        '--lmstudio',
        'http://127.0.0.1:1234',
      ]),
    ).toEqual({
      kind: 'serve',
      port: 8080,
      data: 'data',
      lmstudio: 'http://127.0.0.1:1234',
    })
    expect(
      parseArguments([
        'serve',
        '--lmstudio',
        'https://lm.example:8443/',
        '--data',
        'd',
        '--port',
        '0',
      ]),
    ).toEqual({
      kind: 'serve',
      port: 0,
      data: 'd',
      lmstudio: 'https://lm.example:8443/',
    })
    expect(
      parseArguments(['serve', '--port', '65535', '--data', 'd', ...LMSTUDIO]),
    ).toEqual({
      kind: 'serve',
      port: 65535,
      data: 'd',
      lmstudio: 'http://127.0.0.1:1234',
    })
  })

  it.each([
    [['serve'], 'serve needs --port <port>'],
    [['serve', '--data', 'd'], 'serve needs --port <port>'],
    [['serve', '--port', '1'], 'serve needs --data <dir>'],
    [['serve', '--port', '1', '--data', 'd'], 'serve needs --lmstudio <url>'],
    [
      ['serve', '--port', '1', '--data', 'd', '--lmstudio', '127.0.0.1:1234'],
      '--lmstudio must be an http or https URL: 127.0.0.1:1234',
    ],
    [
      ['serve', '--port', '1', '--data', 'd', '--lmstudio', 'ftp://host/'],
      '--lmstudio must be an http or https URL: ftp://host/',
    ],
    [
      ['serve', '--port', '1', '--data', 'd', '--lmstudio', 'not a url'],
      '--lmstudio must be an http or https URL: not a url',
    ],
    [['serve', '--port'], '--port needs a value'],
    [['serve', '--data', ''], '--data needs a value'],
    [['serve', '--host', 'x'], 'unknown serve option: --host'],
    [['serve', 'data'], 'unknown serve option: data'],
    [
      ['serve', '--port', '1', '--port', '2', '--data', 'd'],
      '--port is given more than once',
    ],
  ])('rejects serve arguments %j', (argv, message) => {
    expect(() => parseArguments(argv)).toThrow(new UsageError(message))
  })

  it.each(['abc', '-1', '1.5', '65536', '99999', '123456', ' 80', ''])(
    'rejects the port %j',
    (port) => {
      const argv = ['serve', '--data', 'd', ...LMSTUDIO, '--port', port]
      const message =
        port === ''
          ? '--port needs a value'
          : `--port must be a whole number from 0 to 65535: ${port}`
      expect(() => parseArguments(argv)).toThrow(new UsageError(message))
    },
  )

  it('documents the serve command in the usage text', () => {
    expect(USAGE).toContain(
      'app-storyboard serve --port <port> --data <dir> --lmstudio <url>',
    )
  })
})
