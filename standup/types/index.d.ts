export type StandupPr = {
  repo: string
  number: number
  title: string
  url: string
  base: string
}

export type StandupCommit = {
  repo: string
  sha: string
  subject: string
}

export type StandupSession = {
  id: string
  project: string
  prompts: number
  firstPrompts: string[]
}

export type StandupData = {
  opened: StandupPr[]
  merged: StandupPr[]
  reviewed: StandupPr[]
  commits: StandupCommit[]
  sessions: StandupSession[]
  errors: string[]
}

export type StandupView = {
  day: string
  label: string
  isLoading: boolean
  data: StandupData | null
}

declare module 'claude-code' {
  interface PluginState {
    standup: { view: StandupView | null }
  }
}
