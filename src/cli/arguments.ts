export type Command =
  | { readonly kind: 'help' }
  | { readonly kind: 'summarize'; readonly source: string }
  | {
      readonly kind: 'serve'
      readonly port: number
      readonly data: string
      readonly lmstudio: string
    }

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export const USAGE = `Usage:
  app-storyboard serve --port <port> --data <dir> --lmstudio <url>
                                    Serve the location graph on 127.0.0.1:<port>,
                                    store its data in <dir>, and chat through the
                                    LM Studio server at <url> (port 0 picks a
                                    free port); prints the URL and runs until
                                    stopped with SIGINT or SIGTERM
  app-storyboard summarize <file>   Summarize the numbers in <file>, one per line
  app-storyboard summarize -        Summarize the numbers read from stdin
  app-storyboard --help             Show this help

Exit codes:
  0  success
  1  runtime failure (unreadable input, invalid number, port in use)
  2  usage error
`

const SERVE_OPTIONS: ReadonlySet<string> = new Set([
  '--port',
  '--data',
  '--lmstudio',
])

export function parseArguments(argv: readonly string[]): Command {
  if (argv.length === 0) {
    throw new UsageError('missing command')
  }
  const [command, ...rest] = argv
  if (command === '--help' || command === '-h') {
    return { kind: 'help' }
  }
  if (command === 'serve') {
    return parseServe(rest)
  }
  if (command !== 'summarize') {
    throw new UsageError(`unknown command: ${command}`)
  }
  if (rest.length !== 1) {
    throw new UsageError('summarize takes exactly one source: a file path or -')
  }
  const [source] = rest
  if (source === undefined || source.length === 0) {
    throw new UsageError('summarize source must not be empty')
  }
  return { kind: 'summarize', source }
}

function parseServe(rest: readonly string[]): Command {
  const options = new Map<string, string>()
  for (let index = 0; index < rest.length; index += 2) {
    const name = String(rest[index])
    const value = rest[index + 1]
    if (!SERVE_OPTIONS.has(name)) {
      throw new UsageError(`unknown serve option: ${name}`)
    }
    if (value === undefined || value.length === 0) {
      throw new UsageError(`${name} needs a value`)
    }
    if (options.has(name)) {
      throw new UsageError(`${name} is given more than once`)
    }
    options.set(name, value)
  }
  const port = options.get('--port')
  const data = options.get('--data')
  if (port === undefined) {
    throw new UsageError('serve needs --port <port>')
  }
  if (data === undefined) {
    throw new UsageError('serve needs --data <dir>')
  }
  const lmstudio = options.get('--lmstudio')
  if (lmstudio === undefined) {
    throw new UsageError('serve needs --lmstudio <url>')
  }
  return {
    kind: 'serve',
    port: parsePort(port),
    data,
    lmstudio: parseHttpUrl(lmstudio),
  }
}

function parseHttpUrl(value: string): string {
  const protocol = URL.parse(value)?.protocol
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new UsageError(`--lmstudio must be an http or https URL: ${value}`)
  }
  return value
}

function parsePort(value: string): number {
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65535) {
    throw new UsageError(
      `--port must be a whole number from 0 to 65535: ${value}`,
    )
  }
  return Number(value)
}
