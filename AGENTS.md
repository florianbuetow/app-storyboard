# AGENTS.md

Guidance for AI coding agents working on app-storyboard.

## Project

app-storyboard is a local storyboard editor for visual stories such as 2D games. A Node.js TypeScript CLI serves a browser UI and a JSON HTTP API on 127.0.0.1, stores each graph as a folder of files, and relays chat requests to LM Studio.

Terms:

- **graph**: one storyboard, stored in `<data>/graphs/<graph-id>/`. Its title shows at the left of the toolbar.
- **board**: the content of a graph: locations, scenes, transitions, loose sounds (sound cards), characters, and animation sequences.
- **location**: a card with an image, a name, and a subtitle.
- **scene**: a titled frame that groups the locations inside it.
- **transition** (arrow): joins two locations, for a way from one to the other, or two scenes, for a scene change. It points one way or both ways.
- **character**: a profile picture, a bio, and one row of sprites per animation sequence. A frame of a row is an image or a placeholder.
- **animation sequence**: a sequence of the graph, such as walking or standing still, with a recommended number of sprites.
- **mood**: a mood deck image with up to two more images of the same mood, described in four parts: Colors, Visual, Elements, and Scene.

## Core rules

1. Fail fast. Propagate errors as typed `Error` subclasses and map them to exit codes only in the CLI layer.
2. Never add silent defaults for missing arguments, files, or configuration. Required inputs stay required and produce a usage error.
3. Never suppress checks with `@ts-ignore`, `@ts-expect-error`, lint-disable comments, coverage ignores, Stryker or ts-archunit exclusion comments, or skipped tests.
4. Never run a shell from the CLI. Use `execFile`, `spawn`, or their sync variants with an argument array; `exec`, `execSync`, and `shell: true` are forbidden.
5. Use npm and the checked-in scripts exclusively. Do not introduce another package manager.
6. Preserve ES modules and `.js` extensions in relative TypeScript imports.
7. Add no dependency when Node.js, TypeScript, or an existing dependency already solves the problem.
8. Every check runs locally from the repository. Do not add containers, hosted services, or checks that need live network data.

## Commands

- `just init`: runs `just check`, installs npm dependencies, activates the pre-commit hook, creates `data/graphs`, `data/input`, and `data/output`, and creates `config/server.env` from `config/server.env.example` when it is missing.
- `just check`: fails unless Node.js 24+, npm, codespell, Semgrep, CodeQL, Gitleaks, ShellCheck, and shfmt are installed. `just init` and `just ci` run it first.
- `just start`: builds, stops an instance that answers on `/health`, serves `data/` on a random port from 10000 to 30000 in the background, and opens the UI. The server logs to `.app-storyboard.log`; `.app-storyboard.port` records the port.
- `just stop`: stops the instance found through `/health`.
- `just run`: runs the server from source in the foreground until Ctrl-C and opens the UI. When an instance is already running, it only opens that instance.
- `just run <args>`: runs the CLI from source, for example `just run --help`.
- `just build`: compiles to `dist/`.
- `just test`: builds, then runs the Vitest suites.
- `just ci`: runs every check verbosely. Its `code-format` step rewrites files with Prettier.
- `just ci-quiet`: runs the same checks fail-fast with compact output. It is the pre-commit hook.
- `just help`: lists every recipe, including each single check.

## Architecture

The dependency direction is:

```text
index.ts -> cli/* -> application/* -> domain/*
lib.ts   -> application/*, domain/*
```

- `index.ts` is the executable entrypoint: it wires process streams and sets the exit code, nothing else.
- `lib.ts` is the public programmatic API and the only module `exports` points at. It exports only the `summarize` example.
- `cli/` owns argument parsing and usage text (`arguments.ts`), input/output streams, exit codes, and the HTTP server (`server.ts`).
- `application/` owns use cases that turn raw input into domain calls: graph storage (`graph-library.ts`, `graph-folder.ts`), the LM Studio client (`lmstudio.ts`), and the `summarize` example.
- `domain/` owns pure business behavior: no file system, processes, environment, or network. It holds graph ids, slugs, media paths, image sizes, document checks, and the statistics example.
- `public/index.html` is the whole browser UI that `serve` delivers: plain HTML, CSS, and JavaScript in one file, outside the TypeScript checks. Search it by feature or identifier instead of reading it whole.
- `scripts/server.sh` backs `just start`, `just stop`, and `just run`.
- dependency-cruiser (`.dependency-cruiser.cjs`) enforces import direction; ts-archunit (`arch.rules.ts`) enforces what happens inside function bodies (typed errors only, no `process.env` in inner layers, no eval, no stubs).
- The `summarize` command over `domain/statistics.ts` is the template's example use case. When you replace it, keep the layer boundaries and update `test/package/artifact.test.ts`, which calls `summarizeText` from the shipped package.
- Do not add command frameworks, dependency-injection containers, base classes, or plugin registries without a demonstrated need.

## CLI behavior

- `app-storyboard serve --port <port> --data <dir> --lmstudio <url>` serves the UI and the HTTP API on `127.0.0.1:<port>`, prints the URL, and runs until SIGINT or SIGTERM. All three options are required; port `0` picks a free port.
- `app-storyboard summarize <file>` prints a JSON summary of the numbers in `<file>`, one per line; `summarize -` reads stdin.
- Exit `0` on success, `1` on runtime failure, `2` on usage errors. Usage errors print the usage text to stderr.
- Results go to stdout; diagnostics go to stderr. Keep stdout machine-readable.
- Read `-` as stdin. Never guess a source when none is given.

## Verification

- Test the domain and application layers directly with Vitest.
- Cover invariants with fast-check property tests, and the public TypeScript contract with `test/types/*.test-d.ts`.
- Test the built CLI as a black box through `child_process` (exit codes, stdout, stderr).
- Test the packed artifact (`npm pack`) so what ships is what was tested.
- Keep coverage at or above 80% and the mutation score at or above 80%.
- Run `just ci` before committing. Fix every finding instead of suppressing it.
- When a change alters behavior described in this file, update the description in the same change.

Test folders:

- `test/unit/`: each layer directly.
- `test/property/`: fast-check property tests.
- `test/types/`: the public TypeScript contract with `expectTypeOf`.
- `test/cli/`: the built CLI as a black box through `child_process`.
- `test/package/`: the artifact that `npm pack` builds.
- `test/fixtures/`: shared test data.

`just ci` runs these recipes in order. Run one alone to reproduce its failure.

1. `check`, `init`
2. `code-format`: Prettier, writes files
3. `code-style`: Prettier check and oxlint
4. `code-spell`: codespell
5. `code-shell`: shfmt and ShellCheck on `scripts/`
6. `code-semgrep`: the rules in `config/semgrep/`
7. `code-lspchecks`: strict `tsc`
8. `code-security`: oxlint security rules
9. `code-secrets`: Gitleaks
10. `code-deptry`: knip
11. `code-architecture`: dependency-cruiser
12. `code-architecture-deep`: ts-archunit
13. `code-package`: publint, arethetypeswrong, and `npm pack --dry-run`
14. `test`, `test-coverage`
15. `code-codeql`: local CodeQL data-flow analysis
16. `test-mutation`: StrykerJS

## Justfile conventions

- Use `printf` for colored or formatted output.
- Keep a blank output line before and after command blocks.
- Keep the dedicated, manually grouped `help` recipe current.
- Every recipe must fail fast and end with a clear status message.

## HTTP API

`src/cli/server.ts` answers on 127.0.0.1 only and refuses requests with a foreign `Host` or `Origin`. Errors are JSON `{ "error": "…" }`: `404` for an invalid or unknown graph id, `422` for an invalid document, and `502` for a failure of LM Studio.

| Method and path                                             | Answer                                                                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /health`                                               | `{ app, status, pid }`                                                                                     |
| `GET /vendor/d3.min.js`                                     | the browser bundle of d3, which draws the scene map                                                        |
| `GET /api/graphs`                                           | `[{ id, title, updated, locations }]`, the latest change first                                             |
| `POST /api/graphs` with `{ "title": "…" }`                  | `201 { id, title }` for a new graph with an empty board                                                    |
| `GET`, `PUT /api/graphs/<id>`                               | `graph.json`; `PUT` checks the document and replaces the file atomically                                   |
| `GET`, `PUT /api/graphs/<id>/chat`                          | `chat.json`; `GET` answers `null` before the first message                                                 |
| `POST /api/graphs/<id>/media`                               | `201 { file }`; send the raw file with `X-Media-Kind: image` or `audio` and a URI-encoded `X-File-Name`    |
| `GET /api/graphs/<id>/media/<images\|audio>/<name>`         | the stored file; `?size=200`, `400`, `800`, or `1600` gives a WebP that fits that many pixels              |
| `GET /api/lmstudio/models`                                  | `{ models: [{ id, tools, vision }] }`: the loaded models that chat, whether they use tools and read images |
| `POST /api/lmstudio/chat` with `{ model, messages, tools }` | `{ message }`: the next message of the model, without its reasoning, with the tools it calls               |

- JPEG, PNG, WebP, and AVIF images get smaller versions; SVG, GIF, BMP, and sounds are always served as stored.
- The UI loads, for each card, the smallest version that covers it on screen and drops the images of cards far outside the view.

## Data folder

`serve --data <dir>` (`data/` for `just start` and `just run`) stops with an error when `<dir>` does not exist. It keeps every graph in its own folder:

```text
<data>/graphs/<graph-id>/
  graph.json      the whole graph: title, view, media index, and board
                  (locations, scenes, transitions, loose sounds, characters,
                  animation sequences, every text)
  chat.json       assistant chat history (absent until the first message)
  images/         uploaded images
  audio/          uploaded sounds
  scaled/<size>/  smaller WebP versions of the images, made on first request
                  (safe to delete)
```

- `data/graphs/` is git-ignored and holds the user's real graphs.
- A graph folder is self-contained, so copying it copies the graph.
- The folder name is the graph id: a slug of the title at creation, a dash, and 8 random hex characters, for example `harbor-town-3f9a2c1d` (`src/domain/graph-id.ts`). Folders with other names are ignored.
- Renaming a graph changes its title, not its id.
- At startup, `serve` moves the single-graph layout of earlier versions (`project.json`, `chat.json`, `images/`, and `audio/` directly in the data folder) into a new graph titled "Location graph" and reports each move on stderr. It checks both documents first, never copies or replaces a file, and stops with an error when the target already exists.

## Chat and LM Studio

- The chat talks to LM Studio through the server; `serve --lmstudio <url>` names the LM Studio server. `just start` and `just run` take it from `LMSTUDIO_URL` in `config/server.env`, which git ignores and `just init` creates from `config/server.env.example` (`http://127.0.0.1:1234`).
- The system prompt (`CHAT_SYSTEM`) and the tool definitions live in `public/index.html`; the server passes them to LM Studio.
- The model list offers the models LM Studio has loaded and follows it while the chat is open. It keeps the model chosen there last while that model is loaded; otherwise it selects the first loaded model that uses tools.
- Read tools: `get_graph`, `get_location`, and `get_scene` answer ids, positions, and sizes; `get_viewport` answers the part of the board the user sees.
- Edit tools: `create_location`, `create_scene`, `connect`, `disconnect`, `update_location`, `update_scene`, `move`, `resize`, and `delete`.
- View tools: `focus` and `fit_view` move the view like the canvas menu.
- An edit that would put items on top of each other changes nothing and tells the model where the board has room.
- Every edit shows at once, and one Undo reverts all edits of a reply.
- While the model answers, the send button stops it. Messages sent meanwhile wait in a queue until the reply is done, and each can be removed from the queue. A stopped reply puts the queued messages back into the input.
- The copy and trash buttons in the chat header copy the conversation as text and clear it. Undo brings a cleared chat back until the next message.

## UI behavior

### Board and graphs

- Clicking or right-clicking the graph title at the left of the toolbar opens New graph, Load…, Rename, and Clear.
- The URL names the open graph (`?graph=<id>`), so a reload keeps it. Without one, the most recently changed graph opens; when there is none, a first graph is created.
- Right-clicking an arrow points it the other way or both ways.
- G opens the scene map: every scene as a node of a force-directed graph, linked where arrows lead from one scene to another. Clicking a scene zooms to it.
- Scenes and Locations in the toolbar list every scene and location; choosing one jumps to it.

### Characters

- Characters in the toolbar opens the characters overview over the dimmed board: a tile per character with its profile picture, its name, and how complete its sprites are. Completeness is the share of frames with an image.
- Animation sequences in the overview defines the sequences of the graph, each with a recommended number of sprites.
- Adding a row to a character offers only the sequences it has no row for yet. The new row starts with the recommended number of placeholders.
- Clicking a picture, a sprite, or a placeholder chooses an image; dropping images on them works too. Several images dropped on a row fill its placeholders in order and extend the row.
- Images dropped on the overview become new characters named after their files.
- A profile picture shows its top in its square until adjusted. Adjust lets the user drag and zoom the picture to choose what the square shows.
- Characters and sequences are saved with the board, so Undo and Redo cover them.

### Mood deck

- Mood deck in the toolbar collects images that set the look of the story. Dropped or added images become tiles with a subtitle; double-clicking a tile opens it.
- A mood shows its image and up to two more images of the same mood, and describes them in four parts that work as prompt snippets for images that look alike: Colors, Visual, Elements, and Scene.
- Each part can be edited and copied. A vision model loaded in LM Studio can write one part, or all four with Describe all.
- Prompts in the deck holds the prompt of each part, which the user can edit or reset to the defaults.
