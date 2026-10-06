/** A graph.json with a small but complete board that uses every kind of item and reference. */
export function validProject(): Record<string, unknown> {
  return {
    format: 'location-graph',
    version: 2,
    title: 'Harbor Town',
    view: { x: 10, y: -20, k: 1.5 },
    assets: {
      x_img1: {
        kind: 'image',
        name: 'docks.png',
        file: 'images/docks-0a1b2c3d.png',
      },
      x_snd1: {
        kind: 'audio',
        name: 'Gulls',
        file: 'audio/gulls-0a1b2c3d.mp3',
      },
    },
    board: {
      nodes: [
        {
          id: 'n_docks',
          x: 0,
          y: 0,
          w: 240,
          aspect: 0.75,
          name: 'The Docks',
          subtitle: 'The gulls have been arguing since dawn.',
          img: 'x_img1',
          audio: [{ id: 'a_gulls', asset: 'x_snd1' }],
        },
        {
          id: 'n_market',
          x: 300,
          y: 0,
          w: 240,
          aspect: 0.625,
          name: 'Fish Market',
          img: null,
          audio: [],
        },
      ],
      scenes: [
        { id: 's_harbor', x: -40, y: -40, w: 660, h: 380, title: 'Harbor' },
      ],
      edges: [
        { id: 'e_walk', from: 'n_docks', to: 'n_market', label: 'Walk east' },
      ],
      floats: [{ id: 'f_wind', x: 100, y: 400, asset: 'x_snd1' }],
    },
  }
}

/** The same board as the project.json of the single-graph layout: version 1, no title. */
export function legacyProject(): Record<string, unknown> {
  const project: Record<string, unknown> = { ...validProject(), version: 1 }
  delete project['title']
  return project
}

/** The fixture with the extra fields of other changes, which must pass through untouched. */
export function projectWithExtras(): Record<string, unknown> {
  const project = validProject()
  const board = project['board'] as { nodes: Record<string, unknown>[] }
  board.nodes = board.nodes.map((node, index) => ({
    ...node,
    notes: index === 0 ? '# Docks\n\n- *gulls*' : '',
    showName: index === 0,
  }))
  return { ...project, extra: { kept: true } }
}

export const validChat = [
  { role: 'user', text: 'Summarize this graph' },
  { role: 'assistant', text: '2 locations in 1 scene.' },
  { role: 'note', text: 'Applied 1 change to the graph', depth: 3 },
]

/** The fixture with animation sequences and characters whose rows of sprites use them. */
export function castProject(): Record<string, unknown> {
  const project = validProject()
  const board = project['board'] as Record<string, unknown>
  board['sequences'] = [
    { id: 'q_walk', name: 'Walking', frames: 8 },
    { id: 'q_idle', name: 'Standing still', frames: 2 },
  ]
  board['characters'] = [
    {
      id: 'c_penny',
      name: 'Ms. Moneypenny',
      bio: 'Guards the office.',
      img: 'x_img1',
      rows: [
        { id: 'r_walk', sequence: 'q_walk', frames: ['x_img1', null, null] },
        { id: 'r_idle', sequence: 'q_idle', frames: [] },
      ],
    },
    { id: 'c_rico', name: 'Rico', bio: '', img: null, rows: [] },
  ]
  return project
}

/** The fixture with a mood deck: two moods, one with more images, and edited prompts. */
export function moodProject(): Record<string, unknown> {
  const project = validProject()
  const assets = project['assets'] as Record<string, unknown>
  assets['x_img2'] = {
    kind: 'image',
    name: 'rain.png',
    file: 'images/rain-0a1b2c3d.png',
  }
  const board = project['board'] as Record<string, unknown>
  board['moods'] = [
    {
      id: 'm_rain',
      img: 'x_img2',
      title: 'Rainy harbor',
      refs: ['x_img1', 'x_img1'],
      colors: 'teal and amber, low contrast',
      visual: 'painterly anime background',
      elements: 'boats, lanterns, wet cobblestones',
      scene: 'a window view onto a rainy harbor at dusk',
    },
    {
      id: 'm_docks',
      img: 'x_img1',
      title: '',
      refs: [],
      colors: '',
      visual: '',
      elements: '',
      scene: '',
    },
  ]
  board['moodPrompts'] = {
    colors: 'Describe the colors.',
    visual: 'Describe the style.',
    elements: 'List the objects.',
    scene: 'Describe the scene.',
  }
  return project
}
