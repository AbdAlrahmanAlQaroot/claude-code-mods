import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Radar, Unreleased, UnreleasedRepo } from '../types'
import {
  DEFAULT_INTEGRATION,
  DEFAULT_REPOS,
  EMPTY,
  LOGIN_ARGS,
  PR_WORDS,
  RELEASE_BRANCHES,
  age,
  alertText,
  asIds,
  asRadar,
  asUnreleased,
  byRepo,
  compareArgs,
  contextLine,
  describeMerged,
  describePr,
  failedRepo,
  ghArgs,
  isNotFound,
  listText,
  parse,
  parseCompare,
  radarChanges,
  reasonOf,
  reposToCheck,
  shortRepo,
  summary,
  unreleasedText,
} from './radar'

const PANE = 'pr-radar'
const FRESH_MS = 2 * 60_000
const EVERY_MS = 5 * 60_000
const STORE_KEY = 'radar'
const UNRELEASED_KEY = 'unreleased'
const ALERTED_KEY = 'alerted'
const RELEASES_KEY = 'releases'
const RELEASES_TTL_MS = 24 * 60 * 60_000
const PR_CHANGING = /\bgh\s+pr\s+(create|merge|close|ready|reopen|edit)\b|\bgit\s+push\b/

const radarAtom = atom({ plugin: 'pr-radar', key: 'radar' } as const, null)

const TOOL_DESCRIPTION =
  "The user's open GitHub pull requests across every repo (review decision, CI checks, unresolved review threads, conflicts, base branch, URL) plus their PRs merged in the last 3 days, from GitHub itself. Call it before saying whether a PR is merged, released, approved, failing or still has comments, and when asked for PR links."

const unreleasedDescription = (integration: string) =>
  `What is merged to ${integration} but not yet released to production (main/master), per repo, from GitHub's compare of the release branch with ${integration}: the PRs and commits waiting for the next release, and how far the last release took ${integration}. Call it before saying whether a change, fix or PR is released, live in prod, or still only on ${integration}.`

type Settings = { alerts: boolean; sound: boolean; repos: string; login: string; integration: string }

let settings: Settings = { alerts: true, sound: true, repos: DEFAULT_REPOS, login: '', integration: DEFAULT_INTEGRATION }

let login: Promise<string> | null = null

type Releases = Record<string, { branch: string | null; at: number }>

const noBranches = () => `skipped: no ${settings.integration} or main/master branch`

const asReleases = (value: unknown): Releases =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...(value as Releases) } : {}

let inFlight: Promise<Radar> | null = null

let unreleasedInFlight: Promise<Unreleased> | null = null

async function publish($: EngineInterface, radar: Radar) {
  await update($, radarAtom, () => radar)
  $.ui.status(summary(radar))
}

async function fetchRadar($: EngineInterface): Promise<Radar> {
  const now = await $.clock.now()
  const previous = (await read($, radarAtom)) ?? EMPTY
  try {
    const ran = await $.process.run(ghArgs(now), { timeoutMs: 30_000 })
    if (ran.exitCode !== 0) return { ...previous, error: reasonOf(ran.stderr || ran.stdout) }
    const parsed = parse(ran.stdout, now)
    return typeof parsed === 'string' ? { ...previous, error: parsed } : parsed
  } catch (error) {
    return { ...previous, error: reasonOf(String(error)) }
  }
}

async function freshest($: EngineInterface) {
  const candidates = [asRadar(await $.store.get(STORE_KEY)), await read($, radarAtom)]
  return candidates
    .filter((radar): radar is Radar => radar !== null && radar.error === null)
    .sort((a, b) => b.fetchedAt - a.fetchedAt)[0]
}

async function notify($: EngineInterface, text: string) {
  const show = settings.sound
    ? 'display notification (item 1 of argv) with title "PR radar" sound name "Glass"'
    : 'display notification (item 1 of argv) with title "PR radar"'
  try {
    await $.process.run(['osascript', '-e', 'on run argv', '-e', show, '-e', 'end run', text], { timeoutMs: 5000 })
  } catch {}
}

async function alert($: EngineInterface, previous: Radar, radar: Radar) {
  const seen = asIds(await $.store.get(ALERTED_KEY))
  const fresh = radarChanges(previous, radar).filter(change => !seen.includes(change.id))
  if (fresh.length === 0) return
  await $.store.set(ALERTED_KEY, [...seen, ...fresh.map(change => change.id)].slice(-200))
  for (const change of fresh.slice(0, 5)) $.ui.toast(change.text, { timeoutMs: 10_000 })
  await notify($, alertText(fresh))
}

async function load($: EngineInterface, force: boolean): Promise<Radar> {
  if (!force) {
    const cached = await freshest($)
    if (cached !== undefined && (await $.clock.now()) - cached.fetchedAt < FRESH_MS) {
      await publish($, cached)
      return cached
    }
  }
  const previous = asRadar(await $.store.get(STORE_KEY))
  const radar = await fetchRadar($)
  await publish($, radar)
  if (radar.error === null) {
    await $.store.set(STORE_KEY, radar)
    if (settings.alerts && previous !== null && previous.error === null) await alert($, previous, radar)
  }
  return radar
}

function refresh($: EngineInterface, force: boolean) {
  inFlight ??= load($, force).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function resolveLogin($: EngineInterface): Promise<string> {
  if (settings.login !== '') return settings.login
  login ??= $.process
    .run(LOGIN_ARGS, { timeoutMs: 10_000 })
    .then(ran => (ran.exitCode === 0 ? ran.stdout.trim() : ''))
    .catch(() => '')
    .then(found => {
      if (found === '') login = null
      return found
    })
  return login
}

async function compareRepo($: EngineInterface, repo: string, known: Releases, me: string): Promise<UnreleasedRepo> {
  const cached = known[repo]
  const now = await $.clock.now()
  const isKnown = cached !== undefined && now - cached.at < RELEASES_TTL_MS
  if (isKnown && cached.branch === null) return failedRepo(repo, null, noBranches())
  const order = isKnown && cached.branch !== null ? [cached.branch, ...RELEASE_BRANCHES.filter(b => b !== cached.branch)] : [...RELEASE_BRANCHES]
  for (const release of order) {
    try {
      const ran = await $.process.run(compareArgs(repo, release, settings.integration), { timeoutMs: 20_000 })
      if (ran.exitCode === 0) {
        known[repo] = { branch: release, at: now }
        const parsed = parseCompare(repo, release, ran.stdout, me)
        return typeof parsed === 'string' ? failedRepo(repo, release, parsed) : parsed
      }
      const text = ran.stderr || ran.stdout
      if (!isNotFound(text)) return failedRepo(repo, release, reasonOf(text))
    } catch (error) {
      return failedRepo(repo, release, reasonOf(String(error)))
    }
  }
  known[repo] = { branch: null, at: now }
  return failedRepo(repo, null, noBranches())
}

async function loadUnreleased($: EngineInterface, force: boolean): Promise<Unreleased> {
  const now = await $.clock.now()
  if (!force) {
    const cached = asUnreleased(await $.store.get(UNRELEASED_KEY))
    if (cached !== null && now - cached.fetchedAt < FRESH_MS) return cached
  }
  const radar = (await read($, radarAtom)) ?? asRadar(await $.store.get(STORE_KEY)) ?? EMPTY
  const known = asReleases(await $.store.get(RELEASES_KEY))
  const me = await resolveLogin($)
  const repos = await Promise.all(reposToCheck(settings.repos, radar, settings.integration).map(repo => compareRepo($, repo, known, me)))
  await $.store.set(RELEASES_KEY, known)
  const unreleased: Unreleased = { repos, fetchedAt: now }
  if (repos.some(entry => entry.error === null)) await $.store.set(UNRELEASED_KEY, unreleased)
  return unreleased
}

function unreleasedNow($: EngineInterface, force: boolean) {
  unreleasedInFlight ??= loadUnreleased($, force).finally(() => {
    unreleasedInFlight = null
  })
  return unreleasedInFlight
}

export const register: Register = (on, options) => {
  settings = {
    alerts: options.alerts !== false,
    sound: options.sound !== false,
    repos: typeof options.repos === 'string' && options.repos.trim() !== '' ? options.repos : DEFAULT_REPOS,
    login: typeof options.login === 'string' ? options.login.trim() : '',
    integration:
      typeof options.integrationBranch === 'string' && options.integrationBranch.trim() !== ''
        ? options.integrationBranch.trim()
        : DEFAULT_INTEGRATION,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prs',
      description: 'Your open PRs across repos: checks, reviews, unresolved threads, links',
      argumentHint: '[pane|refresh]',
    })
    await $.command.register({
      name: 'unreleased',
      description: `What is merged to ${settings.integration} but not yet released to prod, per repo`,
      argumentHint: '[refresh]',
    })
    await $.tool.register({
      name: 'my_prs',
      description: TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: { refresh: { type: 'boolean', description: 'Fetch from GitHub now instead of the last 2 minutes' } },
      },
    })
    await $.tool.register({
      name: 'my_unreleased',
      description: unreleasedDescription(settings.integration),
      inputSchema: {
        type: 'object',
        properties: { refresh: { type: 'boolean', description: 'Compare on GitHub now instead of using the last 2 minutes' } },
      },
    })
    const stored = asRadar(await $.store.get(STORE_KEY))
    if (stored !== null) await publish($, stored)
    void refresh($, false)
    $.clock.every(EVERY_MS, () => void refresh($, false))

    return next(e)
  })

  on('command.run', { command: 'prs' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'pane') {
      await $.ui.open({ id: PANE, title: 'Pull requests' })
      const radar = await refresh($, false)
      return { text: `PR pane opened · ${summary(radar)}` }
    }
    if (arg !== '' && arg !== 'refresh') return { text: 'Usage: /prs, /prs refresh, /prs pane' }
    const radar = await refresh($, arg === 'refresh')

    return { text: listText(radar, await $.clock.now()) }
  })

  on('command.run', { command: 'unreleased' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg !== '' && arg !== 'refresh') return { text: 'Usage: /unreleased, /unreleased refresh' }
    const unreleased = await unreleasedNow($, arg === 'refresh')

    return { text: unreleasedText(unreleased, await $.clock.now(), settings.integration) }
  })

  on('tool.call', { tool: 'mcp__pr-radar__my_unreleased' }, async ($, e) => {
    const unreleased = await unreleasedNow($, e.refresh === true)

    return { result: unreleasedText(unreleased, await $.clock.now(), settings.integration) }
  }).catch(() => ({ deny: `pr-radar could not compare ${settings.integration} with the release branches` }))

  on('tool.call', { tool: 'mcp__pr-radar__my_prs' }, async ($, e) => {
    const radar = await refresh($, e.refresh === true)

    return { result: listText(radar, await $.clock.now()) }
  }).catch(() => ({ deny: 'pr-radar could not read PR state' }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (PR_CHANGING.test(e.command)) $.clock.after(5_000, () => void refresh($, true))

    return ran
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!isPerson || !PR_WORDS.test(e.text)) return next(e)
    const radar = await read($, radarAtom)
    if (radar === null || radar.fetchedAt === 0) return next(e)

    return next({ ...e, context: [...(e.context ?? []), contextLine(radar, await $.clock.now(), settings.integration)] })
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const radar = (await read($, radarAtom)) ?? EMPTY
    const now = await $.clock.now()

    return (
      <Box flexDirection="column">
        <Text bold>{summary(radar)}</Text>
        <Text dimColor>fetched {age(now, radar.fetchedAt)}</Text>
        {radar.open.length === 0 && <Text dimColor>No open PRs.</Text>}
        {byRepo(radar.open).map(([repo, prs]) => (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{shortRepo(repo)}</Text>
            {prs.map(pr => (
              <Box flexDirection="column">
                <Link href={pr.url} label={`#${pr.number} ${pr.title}`} />
                <Text
                  dimColor={pr.checks !== 'failing' && pr.review !== 'changes'}
                  color={pr.checks === 'failing' || pr.review === 'changes' ? 'error' : undefined}
                  wrap="truncate-end"
                >
                  {'  '}
                  {describePr(pr)}
                </Text>
              </Box>
            ))}
          </Box>
        ))}
        {radar.merged.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Merged, last 3 days</Text>
            {radar.merged.map(pr => (
              <Box flexDirection="column">
                <Link href={pr.url} label={`${shortRepo(pr.repo)} #${pr.number} ${pr.title}`} />
                <Text dimColor>
                  {'  '}
                  {describeMerged(pr)}
                </Text>
              </Box>
            ))}
          </Box>
        )}
        <Box marginTop={1}>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => refresh($, true)} />
        </Box>
      </Box>
    )
  })
}
