import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ctx, CtxPart, DiffLine, FileChange, Progress, Row, RowStatus, Session } from '../types'

const ctx = atom({ plugin: 'agent-board', key: 'ctx' } as const, null)
const rows = atom({ plugin: 'agent-board', key: 'rows' } as const, {})
const now = atom({ plugin: 'agent-board', key: 'now' } as const, 0)
const isHidden = atom({ plugin: 'agent-board', key: 'isHidden' } as const, false)
const files = atom({ plugin: 'agent-board', key: 'files' } as const, {})
const expanded = atom({ plugin: 'agent-board', key: 'expanded' } as const, [])
const session = atom({ plugin: 'agent-board', key: 'session' } as const, {
  prompts: 0,
  warned: [],
  hasAutoOpened: false,
})

const MAIN = 'main'
const PANE = 'agent-board'
const FILES_PANE = 'agent-board-files'
const FILE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])
const KEEP_LINES = 40 // changed lines kept per edit
const KEEP_EDITS = 20 // edits kept per file
const PERSON = new Set(['composer', 'bridge', 'sdk']) // prompt origins that are the person typing
const STEP_TOOL = 'mcp__agent-board__step'
const STEP_BRIEF = `

Progress reporting: before any other work, call \`${STEP_TOOL}\` with \`total\` (your plan in 3-8 steps) and \`done: 0\`; call it again with \`done\` and a few-word \`note\` as each step finishes. It only draws a progress bar.`
const FRAME_MS = 200
const BREAKDOWN_EVERY = 5 // data refreshes (seconds) between context breakdowns
const CACHE_TTL_MS = 60 * 60_000 // Claude Code writes 1-hour prompt cache entries
const CACHE_WARN_MIN = [10, 5]
const BAND_AGENTS = 4
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const FULL = '█'
const LIGHT = '░'
const PROGRESS = /(\d+)\s*(?:of|\/)\s*(\d+)/i

type $ = EngineInterface

// ── cost ──────────────────────────────────────────────────────────────────
// USD per million tokens: input, output, cache read, cache write (1-hour rate).
// List prices as of 2026-10-10, taken from johnnyvizz/claude-kit (MIT). An
// estimate from token counts, not a bill.

type Price = [input: number, output: number, cacheRead: number, cacheWrite: number]
type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-1/, [10, 50, 0.25, 20]],
  [/fable|mythos/, [10, 50, 1, 20]],
  [/opus-5-5/, [4, 20, 0.2, 8]],
  [/opus/, [5, 25, 0.5, 10]],
  [/sonnet-5-5/, [2, 10, 0.1, 4]],
  [/sonnet-5/, [2, 10, 0.2, 4]],
  [/sonnet/, [3, 15, 0.3, 6]],
  [/haiku-5-5/, [0.1, 0.5, 0.01, 0.2]],
  [/haiku/, [1, 5, 0.1, 2]],
]
// Haiku 5.5 requests whose prompt is over 100k tokens pay more.
const HAIKU_LONG: Price = [0.5, 2.5, 0.05, 1]

function costOf(model: string, u: Usage): number {
  const id = model.toLowerCase()
  const prompt = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  const [i, o, r, w] =
    prompt > 100_000 && /haiku-5-5/.test(id)
      ? HAIKU_LONG
      : PRICES.find(([re]) => re.test(id))?.[1] ?? [4, 20, 0.2, 8]
  return (
    (u.input_tokens * i + u.output_tokens * o + u.cache_read_input_tokens * r + u.cache_creation_input_tokens * w) /
    1e6
  )
}

const windowOf = (model?: string): number => (model && /haiku-4|claude-3/i.test(model) ? 200_000 : 1_000_000)

// claude-haiku-5-5 -> Haiku 5.5
function modelName(model?: string): string {
  if (!model) return ''
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(model)
  if (!m) return model
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase()
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

// ── formatting ────────────────────────────────────────────────────────────

function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`
  return String(Math.round(n))
}

function usd(n: number): string {
  return n < 0.01 ? '<$0.01' : n < 10 ? `$${n.toFixed(2)}` : `$${n.toFixed(1)}`
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : flat.slice(0, Math.max(1, limit - 1)) + '…'
}

function base(path: unknown): string {
  return typeof path === 'string' ? path.split('/').filter(Boolean).pop() ?? path : ''
}

function describeTool(tool: string, a: Record<string, unknown>): string {
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '')
  switch (tool) {
    case 'Bash':
      return `Bash: ${str('description') || str('command')}`
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return `${tool} ${base(a.file_path ?? a.notebook_path)}`
    case 'Grep':
      return `Grep "${str('pattern')}"${a.path ? ` in ${base(a.path)}` : ''}`
    case 'Glob':
      return `Glob ${str('pattern')}`
    case 'Agent':
    case 'Task':
      return `spawn ${str('subagent_type') || 'agent'}: ${str('description')}`
    case 'WebFetch':
      return `fetch ${str('url')}`
    case 'WebSearch':
      return `search "${str('query')}"`
    case 'Skill':
      return `skill ${str('skill')}`
    default: {
      const first = Object.values(a).find(v => typeof v === 'string') as string | undefined
      return first ? `${tool}: ${first}` : tool
    }
  }
}

// "count 23 of 50", "step 3/8": a fraction guessed from what the agent is
// doing, used until the agent reports its own steps.
function guessProgress(label: string): Progress | undefined {
  const m = PROGRESS.exec(label)
  if (!m) return undefined
  const done = Number(m[1])
  const total = Number(m[2])
  return total > 0 && done <= total ? { done, total, source: 'guess' } : undefined
}

// ── file changes ──────────────────────────────────────────────────────────

const lines = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))

// Lines added and removed, counted as a multiset: cheap, and right for the
// usual edit (a reordered line counts as unchanged).
function lineDiff(before: string, after: string): DiffLine[] {
  const left = new Map<string, number>()
  for (const l of lines(before)) left.set(l, (left.get(l) ?? 0) + 1)
  const plus: DiffLine[] = []
  for (const l of lines(after)) {
    const n = left.get(l) ?? 0
    if (n > 0) left.set(l, n - 1)
    else plus.push({ k: '+', t: l })
  }
  // removed lines in their original order
  const minus: DiffLine[] = []
  for (const l of lines(before)) {
    const n = left.get(l) ?? 0
    if (n > 0) {
      left.set(l, n - 1)
      minus.push({ k: '-', t: l })
    }
  }
  return [...minus, ...plus]
}

type Pending = { path: string; existed: boolean; before: string }

// What a file tool is about to change, read before it runs.
async function beforeChange($: $, tool: string, a: Record<string, unknown>): Promise<Pending | undefined> {
  const path = a.file_path ?? a.notebook_path
  if (typeof path !== 'string' || !path) return undefined
  try {
    const existed = await $.fs.exists(path)
    const text = tool === 'Write' && existed ? await $.fs.read(path) : ''
    return { path, existed, before: typeof text === 'string' ? text : '' }
  } catch {
    return { path, existed: true, before: '' }
  }
}

function changeOf(tool: string, a: Record<string, unknown>, p: Pending): DiffLine[] {
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '')
  if (tool === 'Write') return lineDiff(p.before, str('content'))
  if (tool === 'Edit') return lineDiff(str('old_string'), str('new_string'))
  // NotebookEdit: a cell's source in, or out
  return a.edit_mode === 'delete' ? [] : lines(str('new_source')).map((t): DiffLine => ({ k: '+', t }))
}

async function recordChange($: $, who: string, tool: string, a: Record<string, unknown>, p: Pending) {
  const diff = changeOf(tool, a, p)
  const added = diff.filter(l => l.k === '+').length
  const removed = diff.length - added
  const at = await $.clock.now()
  await update($, files, all => {
    const prev = all[p.path]
    const next: FileChange = {
      path: p.path,
      status: prev?.status ?? (p.existed ? 'M' : 'A'),
      added: (prev?.added ?? 0) + added,
      removed: (prev?.removed ?? 0) + removed,
      edits: (prev?.edits ?? 0) + 1,
      by: prev?.by.includes(who) ? prev.by : [...(prev?.by ?? []), who],
      lastAt: at,
      history: [
        ...(prev?.history ?? []),
        { at, by: who, tool, lines: diff.slice(0, KEEP_LINES), more: Math.max(0, diff.length - KEEP_LINES) },
      ].slice(-KEEP_EDITS),
    }
    return { ...all, [p.path]: next }
  })
}

// ── state ─────────────────────────────────────────────────────────────────

function freshRow(id: string, at: number): Row {
  return {
    id,
    type: id === MAIN ? 'main' : 'agent',
    desc: '',
    status: 'running',
    startedAt: at,
    steps: 0,
    tools: 0,
    activity: 'starting',
    isBusy: true,
    costUsd: 0,
  }
}

async function touch($: $, id: string, fn: (row: Row) => Row) {
  try {
    const at = await $.clock.now()
    await update($, rows, all => ({ ...all, [id]: fn(all[id] ?? freshRow(id, at)) }))
  } catch {
    // bookkeeping only: never let the board break a tool call or a turn
  }
}

const STATUS_OF: Record<string, RowStatus> = {
  pending: 'running',
  running: 'running',
  waiting: 'running',
  idle: 'idle',
  completed: 'done',
  failed: 'failed',
  killed: 'stopped',
}

async function refresh($: $, withBreakdown: boolean) {
  const at = await $.clock.now()
  const prev = await read($, ctx)

  const usage = await $.session.usage(withBreakdown ? { breakdown: 'summary' } : undefined)
  const b = usage.context.breakdown
  const next: Ctx = {
    tokens: usage.context.tokens,
    window: usage.context.window,
    percent: usage.context.percent,
    parts: b
      ? b.categories
          .filter(c => c.kind !== 'deferred' && c.tokens > 0)
          .map((c): CtxPart => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind }))
      : prev?.parts,
    partsMax: b ? b.rawMaxTokens : prev?.partsMax,
    sessionUsd: usage.cost?.usd ?? prev?.sessionUsd,
  }
  if (JSON.stringify(prev) !== JSON.stringify(next)) await update($, ctx, () => next)

  // Only agents already on the board (this prompt's) are synced: the list also
  // holds earlier prompts' agents, which a new prompt cleared.
  const listed = await $.agent.list()
  const all = await read($, rows)
  let changed = false
  const out: Record<string, Row> = { ...all }
  for (const agent of listed) {
    const row = out[agent.id]
    if (!row) continue
    const status = STATUS_OF[agent.status] ?? row.status
    const merged: Row = {
      ...row,
      type: agent.type || row.type,
      desc: agent.description || row.desc,
      parentId: agent.parentId ?? row.parentId,
      status,
      isBusy: status === 'running' ? row.isBusy : false,
      endedAt: status === 'running' ? undefined : row.endedAt ?? at,
    }
    if (JSON.stringify(merged) !== JSON.stringify(row)) {
      out[agent.id] = merged
      changed = true
    }
  }
  if (changed) await update($, rows, () => out)

  await warnCache($, at, out[MAIN]?.status === 'running')
}

// At 10 and 5 minutes left on the prompt cache, once each per answer, and
// never while a turn runs (a turn keeps the cache warm).
async function warnCache($: $, at: number, isWorking: boolean) {
  const s = await read($, session)
  if (!s.cacheExpiresAt || isWorking) return
  const left = (s.cacheExpiresAt - at) / 60_000
  const due = CACHE_WARN_MIN.find(m => left <= m && left > m - 1 && !s.warned.includes(m))
  if (due === undefined) return
  await update($, session, p => ({ ...p, warned: [...p.warned, due] }))
  const text = `Prompt cache expires in ${due} min: your next message re-reads the whole context at full price.`
  const sent = await $.ui.notify(text, { title: 'Claude Code' })
  if (!sent.isSent) $.ui.toast(text)
}

async function togglePane($: $, id = PANE, title = 'Agents'): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === id)
  if (isOpen) {
    await $.ui.close({ id })
    return false
  }
  await $.ui.open({ id, title })
  return true
}

type El = ReturnType<EngineInterface['ui']['resolve']>

// ── the changes panel: this prompt's file changes as a tree ──

type Dir = { name: string; dirs: Map<string, Dir>; files: FileChange[] }
type Line = { indent: string; branch: string; name: string; file?: FileChange; sum?: [number, number, number] }

function buildTree(list: FileChange[]): { root: string; tree: Dir } {
  let common = list[0]!.path.split('/').slice(0, -1)
  for (const f of list) {
    const parts = f.path.split('/')
    let i = 0
    while (i < common.length && i < parts.length - 1 && parts[i] === common[i]) i++
    common = common.slice(0, i)
  }
  const tree: Dir = { name: '', dirs: new Map(), files: [] }
  for (const f of list) {
    const parts = f.path.split('/').slice(common.length)
    let node = tree
    for (const d of parts.slice(0, -1)) {
      let child = node.dirs.get(d)
      if (!child) {
        child = { name: d, dirs: new Map(), files: [] }
        node.dirs.set(d, child)
      }
      node = child
    }
    node.files.push(f)
  }
  const root = common.join('/').replace(/^\/(Users|home)\/[^/]+/, '~') || '/'
  return { root, tree }
}

function sumOf(d: Dir): [added: number, removed: number, count: number] {
  let added = 0
  let removed = 0
  let count = 0
  for (const f of d.files) {
    added += f.added
    removed += f.removed
    count++
  }
  for (const c of d.dirs.values()) {
    const [a, r, n] = sumOf(c)
    added += a
    removed += r
    count += n
  }
  return [added, removed, count]
}

function flatten(d: Dir, indent: string, out: Line[]) {
  const dirs = [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))
  const own = [...d.files].sort((a, b) => a.path.localeCompare(b.path))
  const total = dirs.length + own.length
  dirs.forEach((dir, i) => {
    const isLast = i === total - 1
    // a folder holding only one folder is drawn as one row: a/b/c/
    let node = dir
    let name = dir.name
    while (node.files.length === 0 && node.dirs.size === 1) {
      node = [...node.dirs.values()][0]!
      name += '/' + node.name
    }
    out.push({ indent, branch: isLast ? '└ ' : '├ ', name: name + '/', sum: sumOf(node) })
    flatten(node, indent + (isLast ? '  ' : '│ '), out)
  })
  own.forEach((f, i) => {
    const isLast = dirs.length + i === total - 1
    out.push({ indent, branch: isLast ? '└ ' : '├ ', name: base(f.path), file: f })
  })
}

// The tree of this prompt's file changes: drawn in the agents panel and,
// alone, in the changes panel.
function treeView($: $, ui: El, list: FileChange[], open: string[], cols: number, at: number) {
  const { Box, Text, Button } = ui
  const toggle = (path: string) =>
    void update($, expanded, cur => (cur.includes(path) ? cur.filter(p => p !== path) : [...cur, path]))
  const { root, tree } = buildTree(list)
  const out: Line[] = []
  flatten(tree, '', out)

  const added = list.reduce((n, f) => n + f.added, 0)
  const removed = list.reduce((n, f) => n + f.removed, 0)
  const biggest = Math.max(1, ...list.map(f => f.added + f.removed))
  const statCells = 10
  const nameWidth = Math.min(Math.floor(cols * 0.45), Math.max(...out.map(l => l.indent.length + 2 + l.name.length)) + 2)
  const isWide = cols >= nameWidth + 50

  const fileRow = (l: Line, f: FileChange) => {
    const name = clip(l.name, nameWidth - l.indent.length - 2)
    const scale = (f.added + f.removed) / biggest
    const cells = Math.max(1, Math.round(scale * statCells))
    const plus = f.added + f.removed > 0 ? Math.round((f.added / (f.added + f.removed)) * cells) : 0
    const isOpen = open.includes(f.path)
    // the whole row is one button: a click (or Enter once focused) shows or hides its lines
    const row = (
      <Button key={`file:${f.path}`} plain onPress={() => toggle(f.path)}>
        <Text dimColor>{l.indent + l.branch}</Text>
        <Text color="claude">{isOpen ? '▾ ' : '▸ '}</Text>
        <Text>{name.padEnd(nameWidth - l.indent.length - 4)}</Text>
        <Text color={f.status === 'A' ? 'success' : 'warning'} bold>
          {f.status === 'A' ? ' A ' : ' M '}
        </Text>
        <Text color="success">{`  +${f.added}`.padEnd(7)}</Text>
        <Text color="error">{`−${f.removed}`.padEnd(6)}</Text>
        <Text color="success">{'+'.repeat(plus)}</Text>
        <Text color="error">{'−'.repeat(cells - plus)}</Text>
        <Text>{' '.repeat(statCells - cells)}</Text>
        {isWide ? (
          <Text dimColor>
            {`  ${f.edits} edit${f.edits === 1 ? '' : 's'} · ${f.by.join(', ')} · ${elapsed(at - f.lastAt)} ago`}
          </Text>
        ) : null}
      </Button>
    )
    if (!isOpen) return row

    // the changed lines, edit by edit, under the row
    const pad = l.indent + (l.branch.startsWith('└') ? '  ' : '│ ') + '  '
    const history = f.history ?? []
    const shown = history.slice(-SHOW_EDITS)
    const earlier = history.length - shown.length
    const room = Math.max(10, cols - pad.length - 4)
    return (
      <Box key={f.path} flexDirection="column">
        {row}
        {history.length === 0 ? <Text dimColor>{pad + 'no line details recorded for this file'}</Text> : null}
        {earlier > 0 ? <Text dimColor>{`${pad}… ${earlier} earlier edit${earlier === 1 ? '' : 's'}`}</Text> : null}
        {shown.map((ed, i) => {
          const a = ed.lines.filter(x => x.k === '+').length
          const r = ed.lines.length - a
          return (
            <Box key={`${f.path}:${history.length - shown.length + i}`} flexDirection="column">
              <Text wrap="truncate-end">
                <Text dimColor>{pad + '┄ '}</Text>
                <Text bold dimColor>{ed.tool}</Text>
                <Text dimColor>{` · ${ed.by} · ${elapsed(at - ed.at)} ago  `}</Text>
                <Text color="success">{`+${a}`}</Text>
                <Text color="error">{` −${r}`}</Text>
              </Text>
              {ed.lines.length === 0 ? <Text dimColor>{pad + '  (no line changes)'}</Text> : null}
              {ed.lines.map(x => (
                <Text wrap="truncate-end">
                  <Text dimColor>{pad + '  '}</Text>
                  <Text color={x.k === '+' ? 'success' : 'error'}>{`${x.k === '+' ? '+' : '−'} ${clip(x.t, room) || ' '}`}</Text>
                </Text>
              ))}
              {ed.more > 0 ? <Text dimColor>{`${pad}  … ${ed.more} more line${ed.more === 1 ? '' : 's'}`}</Text> : null}
            </Box>
          )
        })}
      </Box>
    )
  }

  const dirRow = (l: Line) => {
    const [a, r, n] = l.sum!
    return (
      <Text key={l.indent + l.name} wrap="truncate-end">
        <Text dimColor>{l.indent + l.branch}</Text>
        <Text bold color="suggestion">
          {clip(l.name, nameWidth - l.indent.length - 2)}
        </Text>
        <Text dimColor>{`  ${n} file${n === 1 ? '' : 's'} · +${a} −${r}`}</Text>
      </Text>
    )
  }

  const isAllOpen = list.every(f => open.includes(f.path))
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text bold color="claude">{`Files changed · ${list.length}  `}</Text>
          <Text color="success">{`+${added}`}</Text>
          <Text color="error">{` −${removed}`}</Text>
          <Text dimColor>{`  ·  ${list.filter(f => f.status === 'A').length} new, ${list.filter(f => f.status === 'M').length} modified`}</Text>
        </Text>
        <Button
          key="files:all"
          plain
          label={isAllOpen ? 'collapse all' : 'expand all'}
          onPress={() => void update($, expanded, () => (isAllOpen ? [] : list.map(f => f.path)))}
        />
      </Box>
      <Text dimColor wrap="truncate-start">{root + '/'}</Text>
      {out.map(l => (l.file ? fileRow(l, l.file) : dirRow(l)))}
    </Box>
  )
}

const SHOW_EDITS = 10 // edits drawn per open file, newest last
const FILES_NOTE =
  'Click a file to show or hide its changed lines. Counts Edit, Write and NotebookEdit calls; changes made through Bash are not seen.'

// ── hooks ─────────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await $.tool.register({
      name: 'step',
      description:
        'For subagents: report progress on your own task to the agent board. ' +
        'Right after reading your brief, call it with `total` (your plan in 3-8 steps) and `done: 0`; ' +
        'call it again as each step finishes. Cheap and silent: it only draws a progress bar.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
          note: { type: 'string', description: 'The step in progress, a few words.' },
        },
        required: ['done'],
      },
      // listed up front: a subagent does not go looking for it behind ToolSearch
      isDeferred: false,
    })
    await $.command.register({
      name: 'board',
      description:
        'Open or close the agents panel; `/board files` the changed-files tree; `/board hide` or `/board show` the band',
    })

    let isRefreshing = false
    let count = 0
    $.clock.every(1000, () => {
      if (isRefreshing) return
      isRefreshing = true
      refresh($, count++ % BREAKDOWN_EVERY === 0)
        .catch(() => undefined)
        .finally(() => {
          isRefreshing = false
        })
    })

    // animation frames, only while something runs
    let isTicking = false
    $.clock.every(FRAME_MS, () => {
      if (isTicking) return
      isTicking = true
      ;(async () => {
        const all = await read($, rows)
        if (Object.values(all).some(r => r.status === 'running')) {
          const at = await $.clock.now()
          await update($, now, () => at)
        }
      })()
        .catch(() => undefined)
        .finally(() => {
          isTicking = false
        })
    })

    return started
  })

  on('command.run', { command: 'board' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (arg === 'hide' || arg === 'show') {
      await update($, isHidden, () => arg === 'hide')
      return { text: arg === 'hide' ? 'Agent band hidden.' : 'Agent band shown.' }
    }
    if (arg === 'files') {
      const isOpen = await togglePane($, FILES_PANE, 'Changes')
      return { text: isOpen ? 'Changes panel opened.' : 'Changes panel closed.' }
    }
    const isOpen = await togglePane($)
    return { text: isOpen ? 'Agents panel opened.' : 'Agents panel closed.' }
  })

  // A prompt the person sends starts the board from zero: earlier prompts'
  // agents go, agents still running stay. A subagent's hand-back, a task
  // notification or a peer's message arrives here too, and resets nothing.
  on('prompt.submit', async ($, e, next) => {
    if (!PERSON.has(e.origin.kind)) return next(e)
    try {
      const at = await $.clock.now()
      await update($, rows, all => {
        const out: Record<string, Row> = {}
        for (const row of Object.values(all)) {
          if (row.id !== MAIN && row.status === 'running') out[row.id] = row
        }
        out[MAIN] = { ...freshRow(MAIN, at), model: all[MAIN]?.model, effort: all[MAIN]?.effort, activity: 'thinking' }
        return out
      })
      await update($, session, s => ({ ...s, prompts: s.prompts + 1, warned: [] }))
      await update($, files, () => ({}))
      await update($, expanded, () => [])
    } catch {
      // bookkeeping only
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await touch($, MAIN, row => ({ ...row, status: 'running', endedAt: undefined, activity: 'thinking', isBusy: true }))

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId ?? MAIN
    const sentAt = await $.clock.now()
    await touch($, id, row => ({
      ...row,
      status: 'running',
      endedAt: undefined,
      activity: row.isBusy && row.steps > 0 ? row.activity : 'thinking',
      isBusy: true,
    }))

    const result = yield* next(e)

    const u = result.usage
    const model = u?.model || e.model
    const tokens = u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : undefined
    await touch($, id, row => ({
      ...row,
      steps: row.steps + 1,
      tokens: tokens ?? row.tokens,
      model,
      effort: typeof e.effort === 'string' ? e.effort : row.effort,
      costUsd: row.costUsd + (u ? costOf(model, u) : 0),
      activity: result.toolUses.length === 0 ? 'writing the answer' : row.activity,
    }))

    if (id === MAIN && u && u.output_tokens > 50) {
      const seconds = ((await $.clock.now()) - sentAt) / 1000
      if (seconds > 0) await update($, session, s => ({ ...s, speed: Math.round(u.output_tokens / seconds) }))
    }

    return result
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId ?? MAIN

    // the board's own tool: a subagent's report of its steps
    if (e.tool === STEP_TOOL) {
      const input = e as unknown as { done?: number; total?: number; note?: string }
      if (!e.agentId) return { result: 'ignored: only subagents report steps' } as never
      await touch($, id, row => {
        const total = Math.max(0, Math.round(input.total ?? (row.progress?.source === 'step' ? row.progress.total : 0)))
        const done = Math.max(0, Math.round(input.done ?? row.progress?.done ?? 0))
        return {
          ...row,
          progress:
            total > 0 && !(row.progress?.source === 'guess' && row.progress.total > total)
              ? { done: Math.min(done, total), total, source: 'step' }
              : row.progress,
          note: input.note?.trim() || row.note,
        }
      })
      return { result: 'ok' } as never
    }

    const label = describeTool(e.tool, e as unknown as Record<string, unknown>)
    const guess = guessProgress(label)
    await touch($, id, row => ({
      ...row,
      tools: row.tools + 1,
      activity: label,
      isBusy: true,
      // an agent's own plan wins, unless the work names a finer count ("count 7 of 20" over "step 1 of 3")
      progress: guess && (row.progress?.source !== 'step' || guess.total > row.progress.total) ? guess : row.progress,
    }))

    const args = e as unknown as Record<string, unknown>
    const pending = FILE_TOOLS.has(e.tool) ? await beforeChange($, e.tool, args) : undefined

    const ran = await next(e)

    if (pending && ran.deny === undefined && !ran.isError) {
      try {
        const row = (await read($, rows))[id]
        await recordChange($, id === MAIN ? 'main' : row?.type ?? 'agent', e.tool, args, pending)
      } catch {
        // bookkeeping only
      }
    }

    await touch($, id, row => ({
      ...row,
      activity: row.activity === label ? `${label}${ran.isError ? ' (failed)' : ''}` : row.activity,
      isBusy: row.activity === label ? false : row.isBusy,
    }))

    return ran
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const isBriefed = e.prompt.includes(STEP_TOOL)
    const result = await next(isBriefed ? e : { ...e, prompt: e.prompt + STEP_BRIEF })
    if (result.agentId) try {
      const at = await $.clock.now()
      const id = result.agentId
      await update($, rows, all => ({
        ...all,
        [id]: {
          ...(all[id] ?? freshRow(id, at)),
          type: e.subagentType || 'agent',
          desc: e.description || '',
          parentId: e.parentAgentId,
          model: result.model,
        },
      }))
      const s = await read($, session)
      if (!s.hasAutoOpened) {
        await update($, session, p => ({ ...p, hasAutoOpened: true }))
        void $.ui.open({ id: PANE, title: 'Agents' }).catch(() => undefined)
      }
    } catch {
      // bookkeeping only
    }

    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const at = await $.clock.now()
    const id = e.agentId ?? MAIN
    const status: RowStatus =
      e.reason === 'aborted' ? 'stopped' : e.reason === 'answer' ? (id === MAIN ? 'idle' : 'done') : 'failed'
    await touch($, id, row => ({
      ...row,
      status,
      endedAt: at,
      isBusy: false,
      activity: status === 'idle' || status === 'done' ? 'finished' : e.reason,
      progress:
        status === 'done' && row.progress?.source === 'step'
          ? { ...row.progress, done: row.progress.total }
          : row.progress,
    }))
    if (id === MAIN) {
      await update($, session, s => ({
        ...s,
        cacheExpiresAt: at + CACHE_TTL_MS,
        warned: [],
        lastTurnUsd: e.usage ? costOf(e.usage.model, e.usage) : s.lastTurnUsd,
      }))
    }

    return next(e)
  })

  // ── drawing ───────────────────────────────────────────────────────────────


  const BADGE: Record<RowStatus, [string, string]> = {
    running: [' RUN  ', 'claude'],
    idle: [' IDLE ', 'inactive'],
    done: [' DONE ', 'success'],
    failed: [' FAIL ', 'error'],
    stopped: [' STOP ', 'warning'],
  }

  const glyphOf = (row: Row, frame: number) =>
    row.status === 'running'
      ? SPIN[frame % SPIN.length]!
      : row.status === 'done'
        ? '✓'
        : row.status === 'failed'
          ? '✗'
          : row.status === 'stopped'
            ? '■'
            : '○'

  const sorted = (all: Record<string, Row>) =>
    Object.values(all).sort((a, b) => (a.id === MAIN ? -1 : b.id === MAIN ? 1 : a.startedAt - b.startedAt))

  function bar(ui: El, row: Row, width: number, frame: number, ctxWindow: number) {
    const { Text } = ui
    const p = row.progress
    if (p) {
      const fill = Math.round((p.done / p.total) * width)
      const color =
        row.status === 'failed' ? 'error' : p.done >= p.total || row.status === 'done' ? 'success' : 'claude'
      return (
        <Text>
          <Text color={color}>{FULL.repeat(fill)}</Text>
          <Text dimColor>{LIGHT.repeat(width - fill)}</Text>
          <Text bold>{`  ${p.done}/${p.total}`}</Text>
          <Text dimColor>{` ${Math.round((100 * p.done) / p.total)}%`}</Text>
        </Text>
      )
    }
    if (row.status === 'running') {
      // nothing reported: a sweep says "working", the context fill in grey beside it
      const seg = Math.max(3, Math.round(width / 6))
      const pos = (frame % (width + seg)) - seg
      const cells = Array.from({ length: width }, (_, i) => (i >= pos && i < pos + seg ? FULL : LIGHT)).join('')
      const fill = row.tokens ? Math.min(100, Math.round((100 * row.tokens) / ctxWindow)) : undefined
      return (
        <Text>
          <Text color="claude">{cells}</Text>
          <Text dimColor>{fill === undefined ? '  working' : `  working · ctx ${fill}%`}</Text>
        </Text>
      )
    }
    const color = row.status === 'done' || row.status === 'idle' ? 'success' : row.status === 'failed' ? 'error' : 'warning'
    return <Text color={color}>{FULL.repeat(width)}</Text>
  }

  function contextBar(ui: El, context: Ctx, width: number, withLegend: boolean, maxWidth = 80) {
    const { Box, Text } = ui
    const pct = Math.max(0, Math.min(100, context.percent ?? 0))
    const used = context.tokens ?? 0
    const free = Math.max(0, context.window - used)
    const level = pct < 50 ? 'success' : pct < 75 ? 'warning' : 'error'
    const parts = (context.parts ?? []).filter(p => p.kind === 'used' || p.kind === 'buffer')
    const max = context.partsMax || context.window
    const segments: { color: string; cells: number }[] = []
    if (parts.length > 0) {
      let cum = 0
      let drawn = 0
      for (const p of parts) {
        cum += p.tokens
        const upTo = Math.min(width, Math.round((cum / max) * width))
        const cells = Math.max(p.tokens > 0 && upTo === drawn && upTo < width ? 1 : 0, upTo - drawn)
        segments.push({ color: p.color, cells })
        drawn += cells
      }
    } else {
      segments.push({ color: level, cells: Math.round((pct / 100) * width) })
    }
    const filled = segments.reduce((n, s) => n + s.cells, 0)

    // the legend, wrapped into as many lines as the width needs
    const legend: CtxPart[][] = []
    let lineWidth = 0
    for (const p of withLegend ? parts : []) {
      const w = `■ ${p.name} ${shortTokens(p.tokens)}   `.length
      if (legend.length === 0 || lineWidth + w > maxWidth - 9) {
        legend.push([])
        lineWidth = 0
      }
      legend[legend.length - 1]!.push(p)
      lineWidth += w
    }

    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>{'Context  '}</Text>
          {segments.map(s => (
            <Text color={s.color}>{FULL.repeat(s.cells)}</Text>
          ))}
          <Text dimColor>{LIGHT.repeat(Math.max(0, width - filled))}</Text>
          <Text color={level} bold>{`  ${Math.round(pct)}%`}</Text>
          <Text>{`  ${shortTokens(used)} used`}</Text>
          <Text dimColor>{' · '}</Text>
          <Text color="success">{`${shortTokens(free)} free`}</Text>
          <Text dimColor>{` of ${shortTokens(context.window)}`}</Text>
        </Text>
        {legend.map(line => (
          <Text wrap="truncate-end">
            <Text>{'         '}</Text>
            {line.map(p => (
              <Text>
                <Text color={p.color}>■</Text>
                <Text dimColor>{` ${p.name} ${shortTokens(p.tokens)}   `}</Text>
              </Text>
            ))}
          </Text>
        ))}
      </Box>
    )
  }

  // ── the band: one summary line and this prompt's agents, compact ──

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const context = await read($, ctx)
    const all = await read($, rows)
    const s = await read($, session)
    const tick = await read($, now)
    const at = Math.max(tick, ...Object.values(all).map(r => r.endedAt ?? r.startedAt))
    const frame = Math.floor(at / FRAME_MS)
    const cols = Math.max(40, e.props.bodyColumns - 4)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui

    const list = sorted(all)
    const main = all[MAIN]
    const subs = list.filter(r => r.id !== MAIN)
    const changed = Object.values(await read($, files))
    if (!context?.tokens && subs.length === 0 && !e.props.isWorking) return next(e)

    const running = subs.filter(r => r.status === 'running').length
    const done = subs.length - running
    const isWorking = main?.status === 'running' || running > 0

    const cacheLeftMs = s.cacheExpiresAt && !isWorking ? s.cacheExpiresAt - at : undefined
    const cacheMin = cacheLeftMs === undefined ? undefined : Math.max(0, Math.ceil(cacheLeftMs / 60_000))
    const cacheColor = cacheMin === undefined ? 'inactive' : cacheMin <= 10 ? 'error' : cacheMin <= 20 ? 'warning' : 'success'
    const frameColor = cacheMin !== undefined && cacheMin <= 20 ? cacheColor : 'inactive'

    // the summary drops pieces, least useful first, until it fits the width
    const pct = Math.round(context?.percent ?? 0)
    const ctxColor = pct < 50 ? 'success' : pct < 75 ? 'warning' : 'error'
    const ctxCells = 10
    const ctxFill = Math.round((pct / 100) * ctxCells)
    const pieces: { key: string; width: number; el: unknown }[] = []
    const head = isWorking ? SPIN[frame % SPIN.length]! : '○'
    const headText = subs.length > 0 ? ` ${running} running · ${done} done` : main?.status === 'running' ? ' working' : ' idle'
    pieces.push({
      key: 'head',
      width: 1 + headText.length,
      el: (
        <Text>
          <Text color={isWorking ? 'claude' : 'inactive'}>{head}</Text>
          <Text bold>{headText}</Text>
        </Text>
      ),
    })
    if (context) {
      const t = ` ${pct}% ${shortTokens(context.tokens ?? 0)}/${shortTokens(context.window)}`
      pieces.push({
        key: 'ctx',
        width: 6 + ctxCells + t.length,
        el: (
          <Text>
            <Text dimColor>{'ctx '}</Text>
            <Text color={ctxColor}>{FULL.repeat(ctxFill)}</Text>
            <Text dimColor>{LIGHT.repeat(ctxCells - ctxFill)}</Text>
            <Text color={ctxColor}>{t}</Text>
          </Text>
        ),
      })
    }
    if (changed.length > 0) {
      const added = changed.reduce((n, f) => n + f.added, 0)
      const removed = changed.reduce((n, f) => n + f.removed, 0)
      const head = `✎ ${changed.length} file${changed.length === 1 ? '' : 's'} `
      pieces.push({
        key: 'files',
        width: head.length + `+${added} −${removed}`.length,
        el: (
          <Text>
            <Text>{head}</Text>
            <Text color="success">{`+${added}`}</Text>
            <Text color="error">{` −${removed}`}</Text>
          </Text>
        ),
      })
    }
    if (cacheMin !== undefined) {
      const t = `⧗ cache ${cacheMin}m`
      pieces.push({ key: 'cache', width: t.length, el: <Text color={cacheColor}>{t}</Text> })
    }
    if (context?.sessionUsd !== undefined) {
      const t = `${usd(context.sessionUsd)} session${s.lastTurnUsd !== undefined ? ` · ${usd(s.lastTurnUsd)} last turn` : ''}`
      pieces.push({ key: 'cost', width: t.length, el: <Text dimColor>{t}</Text> })
    }
    if (s.speed) {
      const t = `${s.speed} tok/s`
      pieces.push({ key: 'speed', width: t.length, el: <Text dimColor>{t}</Text> })
    }
    if (s.prompts > 0) {
      const t = `prompt ${s.prompts}`
      pieces.push({ key: 'prompt', width: t.length, el: <Text dimColor>{t}</Text> })
    }
    const room = cols - (changed.length > 0 ? 20 : 12) // the buttons
    const shown: typeof pieces = []
    let used = 0
    for (const p of pieces) {
      const w = p.width + (shown.length ? 5 : 0)
      if (used + w > room) continue
      shown.push(p)
      used += w
    }

    const agentLine = (row: Row) => {
      const [, color] = BADGE[row.status]
      const until = row.status === 'running' ? at : row.endedAt ?? at
      const width = Math.max(8, Math.min(20, cols - 70))
      const label = clip(row.desc || row.type, 24)
      const what = clip(row.note || row.activity, Math.max(10, cols - width - label.length - 30))
      return (
        <Text key={row.id} wrap="truncate-end">
          <Text dimColor>{'└ '}</Text>
          <Text color={color}>{glyphOf(row, frame) + ' '}</Text>
          <Text bold color="suggestion">
            {label}
          </Text>
          <Text>{'  '}</Text>
          {bar(ui, row, width, frame, windowOf(row.model))}
          <Text dimColor>{`  ${elapsed(until - row.startedAt)}  `}</Text>
          <Text color={row.isBusy ? 'text' : 'inactive'}>{what}</Text>
        </Text>
      )
    }

    const visible = subs.slice(-BAND_AGENTS)
    const hidden = subs.length - visible.length

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={frameColor} paddingX={1}>
        <Box justifyContent="space-between">
          <Text wrap="truncate-end">
            {shown.map((p, i) => (
              <Text key={p.key}>
                {i > 0 ? <Text dimColor>{'  │  '}</Text> : null}
                {p.el as never}
              </Text>
            ))}
          </Text>
          <Box>
            {changed.length > 0 ? (
              <Button key="files" label="files" plain onPress={() => void togglePane($, FILES_PANE, 'Changes')} />
            ) : null}
            {changed.length > 0 ? <Text dimColor>{' · '}</Text> : null}
            <Button key="details" label="details" plain onPress={() => void togglePane($)} />
          </Box>
        </Box>
        {visible.map(agentLine)}
        {hidden > 0 ? <Text dimColor>{`    +${hidden} more · /board for all`}</Text> : null}
      </Box>
    )
  })

  // ── the panel: everything, per agent ──

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const context = await read($, ctx)
    const all = await read($, rows)
    const s = await read($, session)
    const tick = await read($, now)
    const at = Math.max(tick, ...Object.values(all).map(r => r.endedAt ?? r.startedAt))
    const frame = Math.floor(at / FRAME_MS)
    const cols = Math.max(40, (e.props as { bodyColumns?: number }).bodyColumns ?? e.viewport?.columns ?? 80)
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const barWidth = Math.max(10, Math.min(36, cols - 24))

    const list = sorted(all)
    const running = list.filter(r => r.id !== MAIN && r.status === 'running')
    const finished = list.filter(r => r.id !== MAIN && r.status !== 'running')
    const main = all[MAIN]

    const block = (row: Row) => {
      const isMain = row.id === MAIN
      const [label, color] = BADGE[row.status]
      const until = row.status === 'running' ? at : row.endedAt ?? at
      const win = isMain ? context?.window ?? windowOf(row.model) : windowOf(row.model)
      const ctxPct = row.tokens ? Math.min(100, Math.round((100 * row.tokens) / win)) : undefined
      const meta = [modelName(row.model), row.effort, row.costUsd > 0 ? `~${usd(row.costUsd)}` : '']
        .filter(Boolean)
        .join(' · ')
      const toolCount = `${row.tools} tool${row.tools === 1 ? '' : 's'}`
      const stats = isMain
        ? row.status === 'running'
          ? `${elapsed(until - row.startedAt)} · ${toolCount} this prompt`
          : `waiting for you · ${toolCount} this prompt`
        : `${elapsed(until - row.startedAt)} · ${row.tools} tools · ${row.steps} model calls`

      return (
        <Box key={row.id} flexDirection="column" marginBottom={1}>
          <Text wrap="truncate-end">
            <Text color={color}>{glyphOf(row, frame) + ' '}</Text>
            <Text bold color={isMain ? 'claude' : 'suggestion'}>
              {isMain ? 'main' : row.type}
            </Text>
            <Text>{' '}</Text>
            <Text backgroundColor={color} color="inverseText" bold>
              {label}
            </Text>
            {meta ? <Text dimColor>{`  ${meta}`}</Text> : null}
          </Text>
          {row.desc ? <Text>{'  ' + clip(row.desc, cols - 4)}</Text> : null}
          {isMain ? null : (
            <Text wrap="truncate-end">
              <Text>{'  '}</Text>
              {bar(ui, row, barWidth, frame, win)}
            </Text>
          )}
          <Text dimColor>{`  ${stats}${ctxPct !== undefined ? ` · ctx ${ctxPct}% of ${shortTokens(win)}` : ''}`}</Text>
          <Text wrap="truncate-end">
            <Text dimColor>{'  ↳ '}</Text>
            <Text color={row.isBusy ? 'text' : 'inactive'}>
              {clip(row.note ? `${row.note}  (${row.activity})` : row.activity, cols - 6)}
            </Text>
          </Text>
        </Box>
      )
    }

    const changed = Object.values(await read($, files))

    const section = (title: string, n: number) => (
      <Box marginBottom={1}>
        <Text bold color="claude">{`${title} · ${n}`}</Text>
      </Box>
    )

    const cost = [
      context?.sessionUsd !== undefined ? `${usd(context.sessionUsd)} session` : '',
      s.lastTurnUsd !== undefined ? `~${usd(s.lastTurnUsd)} last turn` : '',
      s.speed ? `${s.speed} tok/s` : '',
      s.prompts ? `prompt ${s.prompts}` : '',
    ]
      .filter(Boolean)
      .join(' · ')

    return (
      <Box flexDirection="column" paddingX={1}>
        {context ? contextBar(ui, context, Math.max(10, Math.min(40, cols - 44)), true, cols - 2) : null}
        {cost ? <Text dimColor>{cost}</Text> : null}
        <Text>{' '}</Text>
        {main ? block(main) : null}
        {running.length > 0 ? section('Running', running.length) : null}
        {running.map(block)}
        {finished.length > 0 ? section('Finished', finished.length) : null}
        {finished.map(block)}
        {running.length + finished.length === 0 ? (
          <Box marginBottom={1}>
            <Text dimColor>No subagents for this prompt yet.</Text>
          </Box>
        ) : null}
        {changed.length > 0 ? (
          <Box marginBottom={1}>
            {treeView($, ui, changed, await read($, expanded), cols - 2, Math.max(at, ...changed.map(f => f.lastAt)))}
          </Box>
        ) : null}
        <Text dimColor>Costs are estimates from token counts.</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: FILES_PANE }, async ($, e) => {
    const list = Object.values(await read($, files))
    const open = await read($, expanded)
    const at = Math.max(await read($, now), ...list.map(f => f.lastAt))
    const cols = Math.max(40, (e.props as { bodyColumns?: number }).bodyColumns ?? e.viewport?.columns ?? 80)
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui

    return (
      <Box flexDirection="column" paddingX={1}>
        {list.length === 0 ? (
          <Text dimColor>No files changed for this prompt yet.</Text>
        ) : (
          treeView($, ui, list, open, cols - 2, at)
        )}
        <Text>{' '}</Text>
        <Text dimColor>{FILES_NOTE}</Text>
      </Box>
    )
  })
}
