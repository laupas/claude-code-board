export type RowStatus = 'running' | 'idle' | 'done' | 'failed' | 'stopped'

export type Progress = { done: number; total: number; source: 'step' | 'guess' }

export type Row = {
  id: string
  type: string
  desc: string
  status: RowStatus
  startedAt: number
  endedAt?: number
  steps: number
  tools: number
  activity: string
  isBusy: boolean
  progress?: Progress
  note?: string
  tokens?: number
  model?: string
  effort?: string
  costUsd: number
  parentId?: string
}

export type CtxPart = { name: string; tokens: number; color: string; kind: string }

export type Ctx = {
  tokens?: number
  window: number
  percent?: number
  parts?: CtxPart[]
  partsMax?: number
  sessionUsd?: number
}

export type DiffLine = { k: '+' | '-'; t: string }

export type Edit = { at: number; by: string; tool: string; lines: DiffLine[]; more: number }

export type FileChange = {
  path: string
  status: 'A' | 'M'
  added: number
  removed: number
  edits: number
  by: string[]
  lastAt: number
  history: Edit[]
}

export type Session = {
  prompts: number
  speed?: number
  lastTurnUsd?: number
  cacheExpiresAt?: number
  warned: number[]
  hasAutoOpened: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'agent-board': {
      ctx: Ctx | null
      rows: Record<string, Row>
      now: number
      isHidden: boolean
      session: Session
      files: Record<string, FileChange>
      expanded: string[]
    }
  }
}
