import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { SessionActivity, UsageWarnings } from '../types'

const LEVELS = [95, 80]
const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const REFRESH_MS = 60_000
const HANDOFF_TURNS = 5
const HANDOFF_RECENT_MS = 20 * 60_000

const warned = atom({ plugin: 'usage-pacer', key: 'warned' } as const, {} as UsageWarnings)
const activity = atom({ plugin: 'usage-pacer', key: 'activity' } as const, { turns: 0, lastAt: 0, isInteractive: false } as SessionActivity)
const handedOff = atom({ plugin: 'usage-pacer', key: 'handedOff' } as const, '')

const label = (kind: string) => LABELS[kind] ?? kind.replaceAll('_', ' ')

const percent = (limit: SessionRateLimit) => Math.round(limit.percentUsed)

const timeLeft = (resetsAt: string | undefined, now: number) => {
  if (resetsAt === undefined) return undefined
  const minutes = Math.ceil((Date.parse(resetsAt) - now) / 60_000)
  if (!(minutes > 0)) return undefined
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

const statusText = (limits: readonly SessionRateLimit[], now: number) =>
  limits
    .map(limit => {
      const left = timeLeft(limit.resetsAt, now)
      return `${label(limit.kind)} ${percent(limit)}%${left ? ` (resets in ${left})` : ''}`
    })
    .join(' · ')

const warningText = (limit: SessionRateLimit, level: number, now: number) => {
  const head = `${label(limit.kind)} usage ${percent(limit)}%`
  if (level < 95) return `${head} — consider /model sonnet for bulk work or scans`
  const left = timeLeft(limit.resetsAt, now)
  return `${head} — almost at the limit${left ? `, resets in ${left}` : ''}`
}

const isActive = (seen: SessionActivity, now: number) =>
  seen.isInteractive && seen.turns >= HANDOFF_TURNS && now - seen.lastAt <= HANDOFF_RECENT_MS

const startHandoff = ($: EngineInterface) => {
  $.clock.after(0, () => {
    void $.command.run({ command: 'handoff', args: '' }).catch(() => $.ui.toast('usage-pacer: /handoff did not start, run it yourself'))
  })
}

const pace = async ($: EngineInterface, limits: readonly SessionRateLimit[], handoffAt: number) => {
  const now = await $.clock.now()
  $.ui.status(limits.length === 0 ? undefined : statusText(limits, now))

  const before = await read($, warned)
  const toasts: { kind: string; text: string }[] = []
  const after: UsageWarnings = {}

  for (const limit of limits) {
    const resetsAt = limit.resetsAt ?? ''
    const kept = before[limit.kind]
    const levels = kept !== undefined && kept.resetsAt === resetsAt ? kept.levels : []
    const reached = LEVELS.find(level => limit.percentUsed >= level)
    if (reached !== undefined && !levels.includes(reached)) toasts.push({ kind: limit.kind, text: warningText(limit, reached, now) })
    after[limit.kind] = {
      resetsAt,
      levels: reached === undefined ? levels : [...new Set([...levels, ...LEVELS.filter(level => level <= reached)])],
    }
  }

  await update($, warned, () => after)

  const five = limits.find(limit => limit.kind === 'five_hour')
  if (handoffAt > 0 && five !== undefined && five.percentUsed >= handoffAt) {
    const window = five.resetsAt ?? 'unknown'
    if ((await read($, handedOff)) !== window && isActive(await read($, activity), now)) {
      await update($, handedOff, () => window)
      const text = `5h usage ${percent(five)}% — writing a handoff now so you can switch accounts`
      const at = toasts.findIndex(toast => toast.kind === 'five_hour')
      if (at >= 0) toasts[at] = { kind: 'five_hour', text }
      else toasts.push({ kind: 'five_hour', text })
      startHandoff($)
    }
  }

  for (const toast of toasts) $.ui.toast(toast.text, { timeoutMs: 10_000 })
}

export const register: Register = (on, options) => {
  const above = Number(options.sonnetSubagentsAbove ?? 0)
  const handoffAt = Number(options.handoffAt ?? 0)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await update($, activity, seen => ({ ...seen, isInteractive: e.isInteractive }))
    $.clock.every(REFRESH_MS, () => {
      void $.session.usage().then(usage => pace($, usage.rateLimits, handoffAt))
    })
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, activity, seen => ({ ...seen, turns: seen.turns + 1, lastAt: now }))
    }
    return done
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await pace($, e.rateLimits, handoffAt)
    return next(e)
  })

  if (above > 0) {
    on('agent.spawn', async ($, e, next) => {
      const isPinned = e.fork || e.workflow !== undefined || e.isTeammate === true || e.model !== undefined
      if (isPinned || e.subagentType !== 'general-purpose' || !/opus/i.test(e.parentModel)) return next(e)
      const { rateLimits } = await $.session.usage()
      const peak = Math.max(0, ...rateLimits.map(limit => limit.percentUsed))
      if (peak <= above) return next(e)
      $.ui.log(`usage-pacer: "${e.description}" runs on sonnet, usage at ${Math.round(peak)}%`)
      return next({ ...e, model: 'sonnet' })
    })
  }
}
