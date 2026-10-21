export type PrChecks = 'passing' | 'failing' | 'pending' | 'none'

export type PrReview = 'approved' | 'changes' | 'required' | 'none'

export type OpenPr = {
  repo: string
  number: number
  title: string
  url: string
  isDraft: boolean
  base: string
  head: string
  review: PrReview
  checks: PrChecks
  hasConflicts: boolean
  unresolved: number
  updatedAt: string
}

export type MergedPr = {
  repo: string
  number: number
  title: string
  url: string
  base: string
  mergedAt: string
}

export type Radar = {
  open: OpenPr[]
  merged: MergedPr[]
  fetchedAt: number
  error: string | null
}

export type UnreleasedPr = {
  number: number
  title: string
  login: string
  isMine: boolean
}

export type LooseCommit = {
  sha: string
  title: string
}

export type UnreleasedRepo = {
  repo: string
  release: string | null
  ahead: number
  prs: UnreleasedPr[]
  mine: LooseCommit[]
  others: number
  releasedUpTo: string | null
  error: string | null
}

export type Unreleased = {
  repos: UnreleasedRepo[]
  fetchedAt: number
}

export type RadarChange = {
  id: string
  text: string
}

declare module 'claude-code' {
  interface PluginState {
    'pr-radar': { radar: Radar | null }
  }
  interface McpToolInputs {
    'mcp__pr-radar__my_prs': { refresh?: boolean }
    'mcp__pr-radar__my_unreleased': { refresh?: boolean }
  }
}
