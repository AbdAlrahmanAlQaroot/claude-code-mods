export type UsageWarning = { resetsAt: string; levels: number[] }

export type UsageWarnings = Record<string, UsageWarning>

export type SessionActivity = { turns: number; lastAt: number; isInteractive: boolean }

declare module 'claude-code' {
  interface PluginState {
    'usage-pacer': { warned: UsageWarnings; activity: SessionActivity; handedOff: string }
  }
}
