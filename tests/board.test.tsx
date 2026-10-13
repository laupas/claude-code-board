import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 20,
  bodyColumns: 140,
  scroll: { offset: 0, bodyRows: 19 },
}

function engine(on: On, { hasTools = true } = {}) {
  mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  if (hasTools) on('tool.call', () => ({ result: 'ok', text: 'ok' }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => ({ text: e.text }) as never)
  on('ui.open', () => ({ value: { isPlaced: false } }) as never)
}

const spawn = {
  prompt: 'count to ten',
  description: 'Count 1 to 10',
  subagentType: 'general-purpose',
} as never

const finish = {
  answer: '',
  durationMs: 10,
  isAborted: false,
  turnId: 't1',
  agentId: 'a1',
  reason: 'answer',
} as never

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the band lists this prompt's subagent, then marks it done`, async ($, on) => {
    engine(on)
    await $.agent.spawn(spawn)
    await $.tool.call({ tool: 'Grep', pattern: 'auth', path: 'src' } as never)

    const band = await $.ui.mount({ plugin: 'agent-board', surface, component: 'AbovePrompt', props: BAND as never })
    expect(await band.find({ text: /Count 1 to 10/ })).toBeDefined()
    expect(await band.find({ text: /1 running · 0 done/ })).toBeDefined()

    await $.turn.complete(finish)
    const after = await $.ui.mount({ plugin: 'agent-board', surface, component: 'AbovePrompt', props: BAND as never })
    expect(await after.find({ text: /0 running · 1 done/ })).toBeDefined()
    expect(await after.find({ text: '✓ ' })).toBeDefined()
  })

  test(`${surface}: a new prompt starts the board from zero`, async ($, on) => {
    engine(on)
    await $.agent.spawn(spawn)
    await $.turn.complete(finish)
    await $.prompt.submit({ text: 'next task', origin: { kind: 'composer' } } as never)

    const band = await $.ui.mount({ plugin: 'agent-board', surface, component: 'AbovePrompt', props: BAND as never })
    expect(await band.find({ text: /Count 1 to 10/ })).toBeUndefined()

    const pane = await $.ui.mount({
      plugin: 'agent-board',
      surface,
      component: 'Pane',
      requestId: 'agent-board',
      props: { bodyColumns: 80 } as never,
    })
    expect(await pane.find({ text: /No subagents for this prompt yet/ })).toBeDefined()
  })

  test(`${surface}: the panel shows model and sections`, async ($, on) => {
    engine(on)
    await $.agent.spawn(spawn)

    const pane = await $.ui.mount({
      plugin: 'agent-board',
      surface,
      component: 'Pane',
      requestId: 'agent-board',
      props: { bodyColumns: 80 } as never,
    })
    expect(await pane.find({ text: /Running · 1/ })).toBeDefined()
    expect(await pane.find({ text: /Haiku 5\.5/ })).toBeDefined()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: file changes show as a tree with counts`, async ($, on) => {
    engine(on)
    on('fs.exists', ($, e) => ({ value: (e as { path: string }).path.endsWith('old.ts') }) as never)
    on('fs.read', () => ({ value: '' }) as never)

    await $.tool.call({ tool: 'Write', file_path: '/repo/src/new.ts', content: 'a\nb\nc\n' } as never)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/lib/old.ts', old_string: 'a\nb', new_string: 'a\nc\nd' } as never)

    const pane = await $.ui.mount({
      plugin: 'agent-board',
      surface,
      component: 'Pane',
      requestId: 'agent-board-files',
      props: { bodyColumns: 120 } as never,
    })
    expect(await pane.find({ text: /Files changed · 2/ })).toBeDefined()
    expect(await pane.find({ text: /^lib\/$/ })).toBeDefined()
    expect(await pane.find({ text: /new\.ts/ })).toBeDefined()
    expect(await pane.find({ text: ' A ' })).toBeDefined()
    expect(await pane.find({ text: ' M ' })).toBeDefined()
    expect(await pane.find({ text: /\+3/ })).toBeDefined()
    expect(await pane.find({ text: /−1/ })).toBeDefined()

    const band = await $.ui.mount({ plugin: 'agent-board', surface, component: 'AbovePrompt', props: BAND as never })
    expect(await band.find({ text: /✎ 2 files/ })).toBeDefined()

    // the agents panel draws the same tree
    const agents = await $.ui.mount({
      plugin: 'agent-board',
      surface,
      component: 'Pane',
      requestId: 'agent-board',
      props: { bodyColumns: 120 } as never,
    })
    expect(await agents.find({ text: /Files changed · 2/ })).toBeDefined()
    expect(await agents.find({ text: /new\.ts/ })).toBeDefined()
  })
}

// a working directory whose listing a Bash call changes
function disk(on: On, before: Record<string, string>, after: Record<string, string>) {
  let current = before
  const entries = () =>
    Object.entries(current).map(([name, text]) => ({
      name,
      kind: 'file',
      size: text.length,
      mtimeMs: before[name] === text ? 1 : 2, // only a changed file gets a new mtime
      isLink: false,
    }))
  on('session.cwd', () => ({ value: '/repo' }) as never)
  on('fs.list', () => ({ value: entries() }) as never)
  on('fs.read', ($, e) => ({ value: current[(e as { path: string }).path.replace('/repo/', '')] ?? '' }) as never)
  on('tool.call', ($, e) => {
    if ((e as { tool: string }).tool === 'Bash') current = after
    return { result: 'ok', text: 'ok' } as never
  })
}

const filesPane = (surface: 'terminal' | 'desktop') => ({
  plugin: 'agent-board',
  surface,
  component: 'Pane',
  requestId: 'agent-board-files',
  props: { bodyColumns: 120 } as never,
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: files a Bash command writes show as changed`, async ($, on) => {
    engine(on, { hasTools: false })
    disk(on, { 'keep.txt': 'same\n' }, { 'keep.txt': 'same\n', 'count.txt': '1\n2\n3\n' })

    await $.tool.call({ tool: 'Bash', command: 'seq 1 3 > count.txt' } as never)

    const pane = await $.ui.mount(filesPane(surface) as never)
    expect(await pane.find({ text: /Files changed · 1/ })).toBeDefined()
    expect(await pane.find({ text: /count\.txt/ })).toBeDefined()
    expect(await pane.find({ text: /keep\.txt/ })).toBeUndefined()
    expect(await pane.find({ text: ' A ' })).toBeDefined()
    expect(await pane.find({ text: /\+3/ })).toBeDefined()
  })
}

test('a file Bash changes without a known earlier text says its lines are not known', async ($, on) => {
  engine(on, { hasTools: false })
  disk(on, { 'log.txt': 'a\n' }, { 'log.txt': 'a\nb\n' })

  await $.tool.call({ tool: 'Bash', command: 'echo b >> log.txt' } as never)

  const pane = await $.ui.mount(filesPane('terminal') as never)
  expect(await pane.find({ text: ' M ' })).toBeDefined()
  await pane.press({ key: 'file:/repo/log.txt' })
  expect(await pane.find({ text: /the lines are not known/ })).toBeDefined()
})

test('agents already running when the board loads are on it', async ($, on) => {
  engine(on)
  on('session.start', () => ({ cwd: '/repo' }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('agent.list', () => ({
    value: [{ id: 'a9', description: 'Count 1 to 7', type: 'general-purpose', status: 'running' }],
  }) as never)

  await $.session.start({ cwd: '/repo', surface: 'terminal' } as never)

  const band = await $.ui.mount({ plugin: 'agent-board', surface: 'terminal', component: 'AbovePrompt', props: BAND as never })
  expect(await band.find({ text: /Count 1 to 7/ })).toBeDefined()
})

test('a subagent hand-back does not reset the board', async ($, on) => {
  engine(on)
  await $.agent.spawn(spawn)
  await $.turn.complete(finish)
  await $.prompt.submit({ text: 'Counted 1 to 10.', origin: { kind: 'task-notification' } } as never)
  const band = await $.ui.mount({ plugin: 'agent-board', surface: 'terminal', component: 'AbovePrompt', props: BAND as never })
  expect(await band.find({ text: /Count 1 to 10/ })).toBeDefined()

  await $.prompt.submit({ text: 'next task', origin: { kind: 'composer' } } as never)
  const after = await $.ui.mount({ plugin: 'agent-board', surface: 'terminal', component: 'AbovePrompt', props: BAND as never })
  expect(await after.find({ text: /Count 1 to 10/ })).toBeUndefined()
})

test('a file row expands to its changed lines and collapses again', async ($, on) => {
  engine(on)
  on('fs.exists', () => ({ value: true }) as never)
  on('fs.read', () => ({ value: '' }) as never)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'const a = 1', new_string: 'const a = 2' } as never)

  const pane = await $.ui.mount({
    plugin: 'agent-board',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'agent-board-files',
    props: { bodyColumns: 120 } as never,
  })
  expect(await pane.find({ text: /const a = 2/ })).toBeUndefined()

  await pane.press({ key: 'file:/repo/src/app.ts' })
  expect(await pane.find({ text: /\+ const a = 2/ })).toBeDefined()
  expect(await pane.find({ text: /− const a = 1/ })).toBeDefined()

  await pane.press({ key: 'file:/repo/src/app.ts' })
  expect(await pane.find({ text: /const a = 2/ })).toBeUndefined()
})
