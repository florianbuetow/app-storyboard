import { describe, expect, it } from 'vitest'

import {
  emptyGraph,
  InvalidDocumentError,
  newGraphTitle,
  parseJsonDocument,
  upgradeLegacyProject,
  validateChat,
  validateGraph,
} from '../../src/domain/project.js'
import {
  castProject,
  legacyProject,
  moodProject,
  projectWithExtras,
  validChat,
  validProject,
} from '../fixtures/project.js'

type Path = readonly (string | number)[]
type Fields = Record<string, unknown>

function edit(
  path: Path,
  change: (parent: Fields, key: string) => void,
  base: () => Record<string, unknown> = validProject,
): unknown {
  const project = structuredClone(base())
  let parent: Fields = project
  for (const step of path.slice(0, -1)) {
    parent = parent[String(step)] as Fields
  }
  change(parent, String(path.at(-1)))
  return project
}

const withValue = (path: Path, value: unknown): unknown =>
  edit(path, (parent, key) => {
    parent[key] = value
  })

const without = (path: Path): unknown =>
  edit(path, (parent, key) => {
    delete parent[key]
  })

function problemOf<T>(validate: (value: T) => unknown, value: T): string {
  try {
    validate(value)
  } catch (error: unknown) {
    if (error instanceof InvalidDocumentError) {
      return error.message
    }
    throw error
  }
  throw new Error('expected the document to be rejected')
}

const projectProblem = (value: unknown): string =>
  problemOf((graph) => validateGraph(graph, 'graph.json'), value)

const legacyProblem = (value: unknown): string =>
  problemOf((project) => upgradeLegacyProject(project, 'Location graph'), value)

describe('parseJsonDocument', () => {
  it('parses valid JSON', () => {
    expect(parseJsonDocument('project.json', '{"a":[1,2]}')).toEqual({
      a: [1, 2],
    })
  })

  it('names the document and keeps the syntax error as cause', () => {
    let caught: unknown
    try {
      parseJsonDocument('chat.json', '{oops')
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(InvalidDocumentError)
    const error = caught as InvalidDocumentError
    expect(error.name).toBe('InvalidDocumentError')
    expect(error.message).toBe('chat.json is invalid: it is not valid JSON')
    expect(error.document).toBe('chat.json')
    expect(error.problem).toBe('it is not valid JSON')
    expect(error.cause).toBeInstanceOf(SyntaxError)
  })
})

describe('validateGraph', () => {
  it('accepts a complete board and reports its title and locations', () => {
    expect(validateGraph(validProject(), 'graph.json')).toEqual({
      title: 'Harbor Town',
      locations: 2,
    })
  })

  it('accepts an empty board without assets', () => {
    const empty = {
      ...validProject(),
      assets: {},
      board: { nodes: [], scenes: [], edges: [], floats: [] },
    }
    expect(validateGraph(empty, 'graph.json')).toEqual({
      title: 'Harbor Town',
      locations: 0,
    })
  })

  it('accepts fields it does not know, such as notes on locations', () => {
    expect(validateGraph(projectWithExtras(), 'graph.json')).toEqual({
      title: 'Harbor Town',
      locations: 2,
    })
  })

  it('names the document it was given', () => {
    expect(
      problemOf(
        (value) => validateGraph(value, 'graphs/harbor-0a1b2c3d/graph.json'),
        { format: 'x' },
      ),
    ).toBe(
      'graphs/harbor-0a1b2c3d/graph.json is invalid: format must be "location-graph"',
    )
  })

  it.each([
    [null, 'the graph must be an object'],
    [[], 'the graph must be an object'],
    ['text', 'the graph must be an object'],
  ])('rejects %j as a whole', (value, problem) => {
    expect(projectProblem(value)).toBe(`graph.json is invalid: ${problem}`)
  })

  it.each<[string, unknown, string]>([
    [
      'format',
      withValue(['format'], 'other'),
      'format must be "location-graph"',
    ],
    ['version', withValue(['version'], 1), 'version must be 2'],
    ['missing title', without(['title']), 'title must be non-empty text'],
    ['empty title', withValue(['title'], ''), 'title must be non-empty text'],
    [
      'blank title',
      withValue(['title'], ' \n\t'),
      'title must be non-empty text',
    ],
    ['title type', withValue(['title'], 7), 'title must be non-empty text'],
    ['missing view', without(['view']), 'view must be an object'],
    ['view.x', withValue(['view', 'x'], '1'), 'view.x must be a finite number'],
    [
      'view.y',
      withValue(['view', 'y'], null),
      'view.y must be a finite number',
    ],
    [
      'infinite view.x',
      withValue(['view', 'x'], Number.POSITIVE_INFINITY),
      'view.x must be a finite number',
    ],
    ['zero zoom', withValue(['view', 'k'], 0), 'view.k must be greater than 0'],
    [
      'negative zoom',
      withValue(['view', 'k'], -1),
      'view.k must be greater than 0',
    ],
    ['missing assets', without(['assets']), 'assets must be an object'],
    [
      'asset id',
      withValue(['assets', 'img'], {
        kind: 'image',
        name: 'a.png',
        file: 'images/a-1.png',
      }),
      'assets.img must have an id like "x_1a2b3c"',
    ],
    [
      'asset id with capitals',
      withValue(['assets', 'x_IMG'], {
        kind: 'image',
        name: 'a.png',
        file: 'images/a-1.png',
      }),
      'assets.x_IMG must have an id like "x_1a2b3c"',
    ],
    [
      'asset entry',
      withValue(['assets', 'x_img1'], 'images/docks-0a1b2c3d.png'),
      'assets.x_img1 must be an object',
    ],
    [
      'asset name',
      without(['assets', 'x_img1', 'name']),
      'assets.x_img1.name must be text',
    ],
    [
      'asset file',
      withValue(['assets', 'x_img1', 'file'], 7),
      'assets.x_img1.file must be text',
    ],
    [
      'asset path',
      withValue(['assets', 'x_img1', 'file'], '../docks.png'),
      'assets.x_img1 must be an image in images/ or a sound in audio/ with a matching kind',
    ],
    [
      'asset kind',
      withValue(['assets', 'x_img1', 'kind'], 'audio'),
      'assets.x_img1 must be an image in images/ or a sound in audio/ with a matching kind',
    ],
    ['missing board', without(['board']), 'board must be an object'],
    ['nodes', withValue(['board', 'nodes'], {}), 'board.nodes must be a list'],
    [
      'node entry',
      withValue(['board', 'nodes', 0], 'n_docks'),
      'board.nodes[0] must be an object',
    ],
    [
      'node id prefix',
      withValue(['board', 'nodes', 1, 'id'], 's_market'),
      'board.nodes[1].id must be text starting with "n_"',
    ],
    [
      'bare node id prefix',
      withValue(['board', 'nodes', 1, 'id'], 'n_'),
      'board.nodes[1].id must be text starting with "n_"',
    ],
    [
      'node id type',
      withValue(['board', 'nodes', 1, 'id'], 5),
      'board.nodes[1].id must be text starting with "n_"',
    ],
    [
      'repeated node id',
      withValue(['board', 'nodes', 1, 'id'], 'n_docks'),
      'board.nodes[1].id repeats the id "n_docks"',
    ],
    [
      'node x',
      withValue(['board', 'nodes', 0, 'x'], 'left'),
      'board.nodes[0].x must be a finite number',
    ],
    [
      'node y',
      without(['board', 'nodes', 0, 'y']),
      'board.nodes[0].y must be a finite number',
    ],
    [
      'node width',
      withValue(['board', 'nodes', 0, 'w'], 0),
      'board.nodes[0].w must be greater than 0',
    ],
    [
      'node aspect',
      withValue(['board', 'nodes', 0, 'aspect'], -0.5),
      'board.nodes[0].aspect must be greater than 0',
    ],
    [
      'missing node image',
      without(['board', 'nodes', 0, 'img']),
      'board.nodes[0].img must name an image asset',
    ],
    [
      'unknown node image',
      withValue(['board', 'nodes', 0, 'img'], 'x_gone'),
      'board.nodes[0].img must name an image asset',
    ],
    [
      'sound as node image',
      withValue(['board', 'nodes', 0, 'img'], 'x_snd1'),
      'board.nodes[0].img must name an image asset',
    ],
    [
      'node audio',
      withValue(['board', 'nodes', 0, 'audio'], 'x_snd1'),
      'board.nodes[0].audio must be a list',
    ],
    [
      'node audio entry',
      withValue(['board', 'nodes', 0, 'audio', 0], 'x_snd1'),
      'board.nodes[0].audio[0] must be an object',
    ],
    [
      'node audio id',
      withValue(['board', 'nodes', 0, 'audio', 0, 'id'], ''),
      'board.nodes[0].audio[0].id must be non-empty text',
    ],
    [
      'image as node audio',
      withValue(['board', 'nodes', 0, 'audio', 0, 'asset'], 'x_img1'),
      'board.nodes[0].audio[0].asset must name an audio asset',
    ],
    [
      'node audio asset type',
      withValue(['board', 'nodes', 0, 'audio', 0, 'asset'], 1),
      'board.nodes[0].audio[0].asset must name an audio asset',
    ],
    ['scenes', without(['board', 'scenes']), 'board.scenes must be a list'],
    [
      'scene entry',
      withValue(['board', 'scenes', 0], null),
      'board.scenes[0] must be an object',
    ],
    [
      'scene id',
      withValue(['board', 'scenes', 0, 'id'], 'n_harbor'),
      'board.scenes[0].id must be text starting with "s_"',
    ],
    [
      'scene x',
      withValue(['board', 'scenes', 0, 'x'], '0'),
      'board.scenes[0].x must be a finite number',
    ],
    [
      'scene y',
      withValue(['board', 'scenes', 0, 'y'], false),
      'board.scenes[0].y must be a finite number',
    ],
    [
      'scene width',
      withValue(['board', 'scenes', 0, 'w'], 0),
      'board.scenes[0].w must be greater than 0',
    ],
    [
      'scene height',
      withValue(['board', 'scenes', 0, 'h'], -10),
      'board.scenes[0].h must be greater than 0',
    ],
    ['edges', without(['board', 'edges']), 'board.edges must be a list'],
    [
      'edge entry',
      withValue(['board', 'edges', 0], []),
      'board.edges[0] must be an object',
    ],
    [
      'edge id',
      withValue(['board', 'edges', 0, 'id'], 'walk'),
      'board.edges[0].id must be text starting with "e_"',
    ],
    [
      'edge start',
      withValue(['board', 'edges', 0, 'from'], 'n_gone'),
      'board.edges[0].from must name a location or a scene',
    ],
    [
      'edge start type',
      without(['board', 'edges', 0, 'from']),
      'board.edges[0].from must name a location or a scene',
    ],
    [
      'edge from a location to a scene',
      withValue(['board', 'edges', 0, 'to'], 's_harbor'),
      'board.edges[0].to must name a location, like from',
    ],
    [
      'edge end type',
      without(['board', 'edges', 0, 'to']),
      'board.edges[0].to must name a location, like from',
    ],
    ['floats', without(['board', 'floats']), 'board.floats must be a list'],
    [
      'float entry',
      withValue(['board', 'floats', 0], 3),
      'board.floats[0] must be an object',
    ],
    [
      'float id',
      withValue(['board', 'floats', 0, 'id'], 'a_wind'),
      'board.floats[0].id must be text starting with "f_"',
    ],
    [
      'float x',
      withValue(['board', 'floats', 0, 'x'], 'x'),
      'board.floats[0].x must be a finite number',
    ],
    [
      'float y',
      without(['board', 'floats', 0, 'y']),
      'board.floats[0].y must be a finite number',
    ],
    [
      'image as float',
      withValue(['board', 'floats', 0, 'asset'], 'x_img1'),
      'board.floats[0].asset must name an audio asset',
    ],
  ])('rejects an invalid %s', (_name, value, problem) => {
    expect(projectProblem(value)).toBe(`graph.json is invalid: ${problem}`)
  })

  it('rejects an id that a sound already uses', () => {
    const project = withValue(['board', 'nodes', 0, 'audio', 0, 'id'], 'f_wind')
    expect(projectProblem(project)).toBe(
      'graph.json is invalid: board.floats[0].id repeats the id "f_wind"',
    )
  })

  describe('arrows between scenes', () => {
    function withSceneArrow(to: unknown): unknown {
      const project = structuredClone(validProject()) as {
        board: { scenes: unknown[]; edges: unknown[] }
      }
      project.board.scenes.push({ id: 's_cliff', x: 0, y: 500, w: 660, h: 380 })
      project.board.edges.push({ id: 'e_sail', from: 's_harbor', to })
      return project
    }

    it('accepts an arrow from one scene to another', () => {
      expect(validateGraph(withSceneArrow('s_cliff'), 'graph.json')).toEqual({
        title: 'Harbor Town',
        locations: 2,
      })
    })

    it.each([['n_docks'], ['s_gone'], [undefined]])(
      'rejects a scene arrow that ends at %j',
      (to) => {
        expect(projectProblem(withSceneArrow(to))).toBe(
          'graph.json is invalid: board.edges[1].to must name a scene, like from',
        )
      },
    )
  })
})

describe('validateGraph with characters', () => {
  const castWith = (path: Path, value: unknown): unknown =>
    edit(
      path,
      (parent, key) => {
        parent[key] = value
      },
      castProject,
    )
  const castWithout = (path: Path): unknown =>
    edit(
      path,
      (parent, key) => {
        delete parent[key]
      },
      castProject,
    )
  const SEQUENCE = ['board', 'sequences', 0]
  const CHARACTER = ['board', 'characters', 0]
  const ROW = [...CHARACTER, 'rows', 0]

  it('accepts animation sequences and characters with sprites and placeholders', () => {
    expect(validateGraph(castProject(), 'graph.json')).toEqual({
      title: 'Harbor Town',
      locations: 2,
    })
  })

  it('accepts the crop of a profile picture', () => {
    const crop = { left: -12.5, top: 0, width: 140, height: 186.5 }
    expect(
      validateGraph(castWith([...CHARACTER, 'crop'], crop), 'graph.json'),
    ).toEqual({ title: 'Harbor Town', locations: 2 })
  })

  it('accepts a sequence of a single sprite', () => {
    expect(
      validateGraph(castWith([...SEQUENCE, 'frames'], 1), 'graph.json'),
    ).toEqual({ title: 'Harbor Town', locations: 2 })
  })

  it('accepts characters without rows when there are no sequences', () => {
    const project = castWithout(['board', 'sequences']) as {
      board: { characters: { rows: unknown[] }[] }
    }
    for (const character of project.board.characters) character.rows = []
    expect(validateGraph(project, 'graph.json')).toEqual({
      title: 'Harbor Town',
      locations: 2,
    })
  })

  it.each<[string, unknown, string]>([
    [
      'sequences',
      castWith(['board', 'sequences'], {}),
      'board.sequences must be a list',
    ],
    [
      'sequence',
      castWith(SEQUENCE, 'walk'),
      'board.sequences[0] must be an object',
    ],
    [
      'sequence id',
      castWith([...SEQUENCE, 'id'], 'x_walk'),
      'board.sequences[0].id must be text starting with "q_"',
    ],
    [
      'sequence name',
      castWith([...SEQUENCE, 'name'], '  '),
      'board.sequences[0].name must be non-empty text',
    ],
    [
      'missing sequence name',
      castWithout([...SEQUENCE, 'name']),
      'board.sequences[0].name must be non-empty text',
    ],
    [
      'zero frames',
      castWith([...SEQUENCE, 'frames'], 0),
      'board.sequences[0].frames must be a whole number of at least 1',
    ],
    [
      'fractional frames',
      castWith([...SEQUENCE, 'frames'], 1.5),
      'board.sequences[0].frames must be a whole number of at least 1',
    ],
    [
      'frames as text',
      castWith([...SEQUENCE, 'frames'], '8'),
      'board.sequences[0].frames must be a whole number of at least 1',
    ],
    [
      'characters',
      castWith(['board', 'characters'], {}),
      'board.characters must be a list',
    ],
    [
      'character',
      castWith(CHARACTER, null),
      'board.characters[0] must be an object',
    ],
    [
      'character id',
      castWith([...CHARACTER, 'id'], 'n_penny'),
      'board.characters[0].id must be text starting with "c_"',
    ],
    [
      'repeated character id',
      castWith([...CHARACTER, 'id'], 'c_rico'),
      'board.characters[1].id repeats the id "c_rico"',
    ],
    [
      'character name',
      castWith([...CHARACTER, 'name'], ''),
      'board.characters[0].name must be non-empty text',
    ],
    [
      'bio',
      castWith([...CHARACTER, 'bio'], 7),
      'board.characters[0].bio must be text',
    ],
    [
      'sound as profile picture',
      castWith([...CHARACTER, 'img'], 'x_snd1'),
      'board.characters[0].img must name an image asset',
    ],
    [
      'missing profile picture',
      castWithout([...CHARACTER, 'img']),
      'board.characters[0].img must name an image asset',
    ],
    [
      'crop',
      castWith([...CHARACTER, 'crop'], []),
      'board.characters[0].crop must be an object',
    ],
    [
      'crop left',
      castWith([...CHARACTER, 'crop'], { top: 0, width: 100, height: 100 }),
      'board.characters[0].crop.left must be a finite number',
    ],
    [
      'crop top',
      castWith([...CHARACTER, 'crop'], {
        left: 0,
        top: 'x',
        width: 100,
        height: 100,
      }),
      'board.characters[0].crop.top must be a finite number',
    ],
    [
      'crop width',
      castWith([...CHARACTER, 'crop'], {
        left: 0,
        top: 0,
        width: 0,
        height: 100,
      }),
      'board.characters[0].crop.width must be greater than 0',
    ],
    [
      'crop height',
      castWith([...CHARACTER, 'crop'], { left: 0, top: 0, width: 100 }),
      'board.characters[0].crop.height must be a finite number',
    ],
    [
      'rows',
      castWith([...CHARACTER, 'rows'], {}),
      'board.characters[0].rows must be a list',
    ],
    ['row', castWith(ROW, []), 'board.characters[0].rows[0] must be an object'],
    [
      'row id',
      castWith([...ROW, 'id'], 'q_walk2'),
      'board.characters[0].rows[0].id must be text starting with "r_"',
    ],
    [
      'unknown sequence',
      castWith([...ROW, 'sequence'], 'q_gone'),
      'board.characters[0].rows[0].sequence must name an animation sequence',
    ],
    [
      'sequence that is not text',
      castWith([...ROW, 'sequence'], 7),
      'board.characters[0].rows[0].sequence must name an animation sequence',
    ],
    [
      'row without sequences',
      castWithout(['board', 'sequences']),
      'board.characters[0].rows[0].sequence must name an animation sequence',
    ],
    [
      'frames',
      castWith([...ROW, 'frames'], null),
      'board.characters[0].rows[0].frames must be a list',
    ],
    [
      'sound as sprite',
      castWith([...ROW, 'frames', 1], 'x_snd1'),
      'board.characters[0].rows[0].frames[1] must name an image asset',
    ],
    [
      'unknown sprite',
      castWith([...ROW, 'frames', 0], 'x_gone'),
      'board.characters[0].rows[0].frames[0] must name an image asset',
    ],
  ])('rejects an invalid %s', (_name, value, problem) => {
    expect(projectProblem(value)).toBe(`graph.json is invalid: ${problem}`)
  })
})

describe('validateGraph with a mood deck', () => {
  const moodWith = (path: Path, value: unknown): unknown =>
    edit(
      path,
      (parent, key) => {
        parent[key] = value
      },
      moodProject,
    )
  const moodWithout = (path: Path): unknown =>
    edit(
      path,
      (parent, key) => {
        delete parent[key]
      },
      moodProject,
    )
  const MOOD = ['board', 'moods', 0]
  const PROMPTS = ['board', 'moodPrompts']

  it('accepts moods with more images, descriptions, and edited prompts', () => {
    expect(validateGraph(moodProject(), 'graph.json')).toEqual({
      title: 'Harbor Town',
      locations: 2,
    })
  })

  it.each<[string, unknown, string]>([
    ['moods', moodWith(['board', 'moods'], {}), 'board.moods must be a list'],
    ['mood', moodWith(MOOD, 1), 'board.moods[0] must be an object'],
    [
      'mood id',
      moodWith([...MOOD, 'id'], 'c_rain'),
      'board.moods[0].id must be text starting with "m_"',
    ],
    [
      'sound as mood',
      moodWith([...MOOD, 'img'], 'x_snd1'),
      'board.moods[0].img must name an image asset',
    ],
    [
      'mood without an image',
      moodWith([...MOOD, 'img'], null),
      'board.moods[0].img must name an image asset',
    ],
    [
      'title',
      moodWith([...MOOD, 'title'], 7),
      'board.moods[0].title must be text',
    ],
    [
      'refs',
      moodWith([...MOOD, 'refs'], 'x_img1'),
      'board.moods[0].refs must be a list',
    ],
    [
      'three more images',
      moodWith([...MOOD, 'refs'], ['x_img1', 'x_img1', 'x_img2']),
      'board.moods[0].refs must hold at most 2 images',
    ],
    [
      'sound as more image',
      moodWith([...MOOD, 'refs', 1], 'x_snd1'),
      'board.moods[0].refs[1] must name an image asset',
    ],
    [
      'colors',
      moodWith([...MOOD, 'colors'], null),
      'board.moods[0].colors must be text',
    ],
    [
      'visual',
      moodWithout([...MOOD, 'visual']),
      'board.moods[0].visual must be text',
    ],
    [
      'elements',
      moodWith([...MOOD, 'elements'], []),
      'board.moods[0].elements must be text',
    ],
    [
      'scene',
      moodWithout([...MOOD, 'scene']),
      'board.moods[0].scene must be text',
    ],
    ['prompts', moodWith(PROMPTS, 'x'), 'board.moodPrompts must be an object'],
    [
      'colors prompt',
      moodWithout([...PROMPTS, 'colors']),
      'board.moodPrompts.colors must be text',
    ],
    [
      'visual prompt',
      moodWith([...PROMPTS, 'visual'], 1),
      'board.moodPrompts.visual must be text',
    ],
    [
      'elements prompt',
      moodWithout([...PROMPTS, 'elements']),
      'board.moodPrompts.elements must be text',
    ],
    [
      'scene prompt',
      moodWith([...PROMPTS, 'scene'], null),
      'board.moodPrompts.scene must be text',
    ],
  ])('rejects an invalid %s', (_name, value, problem) => {
    expect(projectProblem(value)).toBe(`graph.json is invalid: ${problem}`)
  })

  it('rejects an id that a location already uses', () => {
    expect(projectProblem(moodWith([...MOOD, 'id'], 'm_docks'))).toBe(
      'graph.json is invalid: board.moods[1].id repeats the id "m_docks"',
    )
  })
})

describe('upgradeLegacyProject', () => {
  it('turns a version 1 project into a titled version 2 graph', () => {
    const graph = upgradeLegacyProject(legacyProject(), 'Location graph')
    expect(graph).toEqual({ ...validProject(), title: 'Location graph' })
    expect(Object.keys(graph)).toEqual([
      'format',
      'version',
      'view',
      'assets',
      'board',
      'title',
    ])
    expect(validateGraph(graph, 'graph.json')).toEqual({
      title: 'Location graph',
      locations: 2,
    })
  })

  it('keeps fields it does not know', () => {
    const legacy = { ...projectWithExtras(), version: 1 }
    expect(upgradeLegacyProject(legacy, 'Old')).toEqual({
      ...projectWithExtras(),
      title: 'Old',
    })
  })

  it.each<[string, unknown, string]>([
    ['a list', [], 'the project must be an object'],
    [
      'another format',
      { ...legacyProject(), format: 'x' },
      'format must be "location-graph"',
    ],
    ['a graph', validProject(), 'version must be 1'],
    [
      'an invalid view',
      { ...legacyProject(), view: { x: 0, y: 0, k: 0 } },
      'view.k must be greater than 0',
    ],
    [
      'an edge to nowhere',
      {
        ...legacyProject(),
        board: { nodes: [], scenes: [], floats: [], edges: [{ id: 'e_1' }] },
      },
      'board.edges[0].from must name a location or a scene',
    ],
  ])('rejects %s and names project.json', (_name, value, problem) => {
    expect(legacyProblem(value)).toBe(`project.json is invalid: ${problem}`)
  })
})

describe('newGraphTitle', () => {
  it('reads the title of the graph to create', () => {
    expect(newGraphTitle('{"title":"Harbor Town"}')).toBe('Harbor Town')
    expect(newGraphTitle('{"title":" x ","other":1}')).toBe(' x ')
  })

  it.each([
    ['{', 'it is not valid JSON'],
    ['[]', 'the request must be an object'],
    ['"Harbor"', 'the request must be an object'],
    ['{}', 'title must be non-empty text'],
    ['{"title":""}', 'title must be non-empty text'],
    ['{"title":"  "}', 'title must be non-empty text'],
    ['{"title":["a"]}', 'title must be non-empty text'],
  ])('rejects %s', (json, problem) => {
    expect(problemOf(newGraphTitle, json)).toBe(
      `the new graph is invalid: ${problem}`,
    )
  })
})

describe('emptyGraph', () => {
  it('is a titled graph with an empty board at 100 % zoom', () => {
    const graph = emptyGraph('Harbor Town')
    expect(graph).toEqual({
      format: 'location-graph',
      version: 2,
      title: 'Harbor Town',
      view: { x: 0, y: 0, k: 1 },
      assets: {},
      board: { nodes: [], scenes: [], edges: [], floats: [] },
    })
    expect(Object.keys(graph)).toEqual([
      'format',
      'version',
      'title',
      'view',
      'assets',
      'board',
    ])
    expect(validateGraph(graph, 'graph.json')).toEqual({
      title: 'Harbor Town',
      locations: 0,
    })
  })
})

describe('validateChat', () => {
  const chatProblem = (value: unknown): string =>
    problemOf((chat) => validateChat(chat, 'chat.json'), value)

  it('accepts user, assistant, and note messages', () => {
    expect(() => validateChat(validChat, 'chat.json')).not.toThrow()
    expect(() => validateChat([], 'chat.json')).not.toThrow()
  })

  it('names the document it was given', () => {
    expect(
      problemOf(
        (chat) => validateChat(chat, 'graphs/a-0a1b2c3d/chat.json'),
        {},
      ),
    ).toBe(
      'graphs/a-0a1b2c3d/chat.json is invalid: the chat must be a list of messages',
    )
  })

  it.each<[string, unknown, string]>([
    ['an object', {}, 'the chat must be a list of messages'],
    ['a message', ['hi'], 'messages[0] must be an object'],
    [
      'a role',
      [...validChat, { role: 'system', text: 'x' }],
      'messages[3].role must be "user", "assistant", or "note"',
    ],
    ['a text', [{ role: 'user' }], 'messages[0].text must be text'],
  ])('rejects %s that does not fit', (_name, value, problem) => {
    expect(chatProblem(value)).toBe(`chat.json is invalid: ${problem}`)
  })
})
