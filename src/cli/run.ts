import { GraphLibrary, type Migration } from '../application/graph-library.js'
import { LmStudio } from '../application/lmstudio.js'
import { summarizeText } from '../application/summarize-text.js'
import { parseArguments, USAGE, UsageError, type Command } from './arguments.js'
import { readInput } from './input.js'
import { startServer } from './server.js'

export interface CliIo {
  readonly stdin: NodeJS.ReadableStream
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  /** Resolves when the process is asked to stop; `serve` runs until then. */
  readonly untilShutdown: () => Promise<void>
}

export const EXIT_SUCCESS = 0
export const EXIT_FAILURE = 1
export const EXIT_USAGE = 2

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const command = parseArguments(argv)
    if (command.kind === 'help') {
      io.stdout.write(USAGE)
      return EXIT_SUCCESS
    }
    if (command.kind === 'serve') {
      return await serve(command, io)
    }
    const input = await readInput(command.source, io.stdin)
    const summary = summarizeText(input)
    io.stdout.write(`${JSON.stringify(summary)}\n`)
    return EXIT_SUCCESS
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    io.stderr.write(`error: ${message}\n`)
    if (error instanceof UsageError) {
      io.stderr.write(USAGE)
      return EXIT_USAGE
    }
    return EXIT_FAILURE
  }
}

async function serve(
  command: Extract<Command, { kind: 'serve' }>,
  io: CliIo,
): Promise<number> {
  const library = await GraphLibrary.open(command.data)
  const migration = await library.migrateLegacyLayout()
  if (migration !== null) {
    io.stderr.write(migrationReport(migration))
  }
  const lmStudio = new LmStudio(command.lmstudio)
  const server = await startServer(command.port, library, lmStudio, (line) => {
    io.stderr.write(`${line}\n`)
  })
  io.stdout.write(`${server.url}\n`)
  await io.untilShutdown()
  await server.close()
  return EXIT_SUCCESS
}

function migrationReport(migration: Migration): string {
  const moves = migration.moved.map(({ from, to }) => `  ${from} -> ${to}\n`)
  return `moved the single-graph layout into the graph "${migration.title}":\n${moves.join('')}`
}
