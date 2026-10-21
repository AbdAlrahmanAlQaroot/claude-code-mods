export type RepoSpot = { dir: string; label: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'repo-context': { spot: RepoSpot | null; titled: boolean }
  }
}
