import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 20,
  bodyColumns: 140,
  scroll: { offset: 0, bodyRows: 19 },
}

function engine(on: On) {
  mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }) as never)
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
