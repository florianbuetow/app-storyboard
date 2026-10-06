# app-storyboard

A Node.js TypeScript CLI application

This is a Node.js command-line tool written in TypeScript. It ships as an npm package with an executable `bin` and a typed programmatic API, and every guardrail runs locally from the repository — no containers, hosted services, or live vulnerability feeds.

## Requirements

- Node.js 24.0.0+
- npm
- [just](https://github.com/casey/just)
- [Semgrep](https://semgrep.dev/)
- [codespell](https://github.com/codespell-project/codespell)
- [CodeQL CLI](https://codeql.github.com/)
- [Gitleaks](https://github.com/gitleaks/gitleaks)
- [ShellCheck](https://www.shellcheck.net/) and [shfmt](https://github.com/mvdan/sh)

## Start

```bash
just init
just test
just run --help
```

`just start` builds the CLI, stops a running server that answers on its `/health` endpoint, serves the location graph on a random port between 10000 and 30000, and opens it in the browser. `just stop` finds the server through `/health` the same way and stops it. `just run` runs it from source in the foreground until Ctrl-C and opens it the same way; when it is already running, `just run` only opens it.

Click or right-click the graph title at the left of the toolbar for New graph, Load…, Rename, and Clear. The URL names the open graph (`?graph=<id>`), so a reload keeps it; without one, the most recently changed graph opens, and a first graph is created when there is none. Right-click an arrow to point it the other way or both ways. Press G for the scene map: every scene as a node of a force-directed graph, linked where arrows lead from one scene to another; click a scene to zoom to it. Scenes and Locations in the toolbar list every scene and location; choose one to jump to it.

`just run summarize <file>` summarizes the numbers in a file (one per line); `just run summarize -` reads stdin. Results are written to stdout as JSON, diagnostics to stderr.

Exit codes: `0` success, `1` runtime failure, `2` usage error.

## Characters

Characters in the toolbar opens the characters of the graph over the dimmed board: a tile per character with its profile picture, its name, and how complete its sprites are. A character has a profile picture, a bio, and one row of sprites per animation sequence, such as walking or standing still. A frame of a row is an image or a placeholder, and the share of frames with an image is how complete the character is.

Animation sequences in the characters overview defines the sequences of the graph with a recommended number of sprites each. Adding a row to a character offers only the sequences it has no row for yet, and the new row starts with the recommended number of placeholders. Click a picture, a sprite, or a placeholder to choose an image, or drop images on them; several images dropped on a row fill its placeholders in order and extend it. Images dropped on the overview become new characters named after their files. A profile picture shows its top in its square until you adjust it: Adjust lets you drag the picture and zoom it to choose what the square shows. Characters and sequences are saved with the board, so Undo and Redo work for them too.

## Mood deck

Mood deck in the toolbar collects images that set the look of the story. Drop images on the deck, or add them, and each becomes a tile with a subtitle; double-click one to open it. A mood shows its image and up to two more images of the same mood, and describes them in four parts that work as prompt snippets for images that look alike: Colors, Visual, Elements, and Scene. Each part can be edited and copied, and a vision model loaded in LM Studio can write it, or all four with Describe all. Prompts in the deck holds the prompt of each part, which you can edit or reset to the defaults.

## Data folder

`serve --data <dir>` (`data/` for `just start` and `just run`) keeps every graph in its own folder:

```text
<data>/graphs/<graph-id>/
  graph.json      the whole graph: title, view, media index, and board
                  (locations, scenes, transitions, loose sounds, characters,
                  animation sequences, every text)
  chat.json       assistant chat history (absent until the first message)
  images/         uploaded images
  audio/          uploaded sounds
  scaled/<size>/  smaller WebP versions of the images, made on first request
                  (safe to delete; ignored by git)
```

A graph folder is self-contained, so copying it copies the graph. Its name, the graph id, is a slug of the title at creation, a dash, and 8 random hex characters, for example `harbor-town-3f9a2c1d`; folders with other names are ignored. Renaming a graph changes its title, not its id.

At startup, `serve` moves the single-graph layout of earlier versions (`project.json`, `chat.json`, `images/`, and `audio/` directly in the data folder) into a new graph titled "Location graph" and reports each move on stderr. It checks both documents first, never copies or replaces a file, and stops with an error when the target already exists.

## Chat

The chat talks to [LM Studio](https://lmstudio.ai/) through the server: `serve --lmstudio <url>` names the LM Studio server. `just start` and `just run` take it from `LMSTUDIO_URL` in `config/server.env` (`http://127.0.0.1:1234`); change the address or port there. `just init` creates that file from `config/server.env.example` when it is missing, and git ignores it. The model list of the chat offers the models LM Studio has loaded and follows it while the chat is open. It keeps the model chosen there last while that model is loaded, and otherwise selects the first loaded model that uses tools.

The model reads and edits the open graph with tools. `get_graph`, `get_location`, and `get_scene` answer ids, positions, and sizes, and `get_viewport` the part of the board the user sees; `create_location`, `create_scene`, `connect`, `disconnect`, `update_location`, `update_scene`, `move`, `resize`, and `delete` change the board; `focus` and `fit_view` move the view like the canvas menu. An edit that would put items on top of each other changes nothing and tells the model where the board has room. Every edit shows at once, and one Undo reverts all edits of a reply.

While the model answers, the send button stops it, and messages sent meanwhile wait in a queue until the reply is done; each can be removed from the queue. A stopped reply puts the queued messages back into the input. The copy and trash buttons in the chat header copy the conversation as text and clear it; Undo brings a cleared chat back until the next message.

## HTTP API

The server answers on 127.0.0.1 only and refuses requests with a foreign `Host` or `Origin`. Errors are JSON `{ "error": "…" }`.

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

An invalid or unknown graph id is answered with `404`, an invalid document with `422`, and a failure of LM Studio with `502`. JPEG, PNG, WebP, and AVIF images get smaller versions; SVG, GIF, BMP, and sounds are always served as stored. The UI loads, for each card, the smallest version that covers it on screen and drops the images of cards far outside the view.

## Architecture

```text
src/index.ts      executable entrypoint (bin)
src/lib.ts        public programmatic API (exports)
      │
      ▼
src/cli/          arguments, streams, usage, exit codes
      │
      ▼
src/application/  use cases over raw input
      │
      ▼
src/domain/       pure business behavior
```

- `test/unit/` tests each layer directly.
- `test/property/` holds fast-check property tests.
- `test/types/` asserts the public TypeScript contract with `expectTypeOf`.
- `test/cli/` runs the built CLI as a black box through `child_process`.
- `test/package/` packs the project with `npm pack` and tests the shipped artifact.

Replace the example statistics domain with your behavior while preserving the layer boundaries.

## Validation

`just ci` runs initialization, formatting, linting, spelling, shell script checks, Semgrep guardrails, strict TypeScript checks, security linting, secret scanning, dependency and dead-code hygiene, import-boundary and deep architecture checks, package correctness (publint, arethetypeswrong, `npm pack --dry-run`), the full test suite, coverage thresholds, local CodeQL data-flow analysis, and mutation testing. `just ci-quiet` runs the same checks with compact fail-fast output and is installed as the repository pre-commit hook.

Run `just help` for every available command.
