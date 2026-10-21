import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { StandupCommit, StandupData, StandupSession } from '../types'
import { DEFAULT_OFFSET, DEFAULT_WORK_DAYS, configureDays, isWorkTime, labelOf, resolveDay, todayOf, workArgsOf } from './day'
import {
  byRepo,
  commitArgs,
  countsOf,
  historyArgs,
  logArgs,
  mergeCommits,
  parseLog,
  parsePrs,
  parseSearchCommits,
  parseSessions,
  prArgs,
  reasonOf,
  repoOfRemote,
  reposOf,
} from './gather'

const PANE = 'standup'
const MAX_COMMITS = 12

let settings = { repos: '', draftCommand: '' }

const viewAtom = atom({ plugin: 'standup', key: 'view' } as const, null)

async function githubPrs($: EngineInterface, day: string) {
  const ran = await $.process.run(prArgs(day), { timeoutMs: 30_000 })
  if (ran.exitCode !== 0) throw new Error(reasonOf(ran.stderr || ran.stdout))
  return parsePrs(ran.stdout)
}

async function githubCommits($: EngineInterface, day: string) {
  const ran = await $.process.run(commitArgs(day), { timeoutMs: 30_000 })
  if (ran.exitCode !== 0) throw new Error(reasonOf(ran.stderr || ran.stdout))
  return parseSearchCommits(ran.stdout)
}

async function localCommits($: EngineInterface, dir: string, day: string): Promise<StandupCommit[]> {
  const email = await $.process.run(['git', '-C', dir, 'config', 'user.email'], { timeoutMs: 10_000 })
  if (email.exitCode !== 0 || email.stdout.trim() === '') return []
  const remote = await $.process.run(['git', '-C', dir, 'remote', 'get-url', 'origin'], { timeoutMs: 10_000 })
  const repo = repoOfRemote(remote.stdout, dir.split('/').pop() ?? dir)
  const log = await $.process.run(logArgs(dir, email.stdout.trim(), day), { timeoutMs: 20_000 })
  return log.exitCode === 0 ? parseLog(log.stdout, repo) : []
}

async function claudeSessions($: EngineInterface, home: string, day: string): Promise<StandupSession[]> {
  const ran = await $.process.run(historyArgs(home), { timeoutMs: 10_000 })
  return ran.exitCode === 0 ? parseSessions(ran.stdout, day, home) : []
}

async function gather($: EngineInterface, day: string): Promise<StandupData> {
  const home = (await $.env.get('HOME')) ?? ''
  const errors: string[] = []
  const caught = <T,>(label: string, fallback: T) => (error: unknown) => {
    errors.push(`${label}: ${reasonOf(error instanceof Error ? error.message : String(error))}`)
    return fallback
  }
  const [prs, searched, sessions, ...local] = await Promise.all([
    githubPrs($, day).catch(caught('GitHub PRs', { opened: [], merged: [], reviewed: [] })),
    githubCommits($, day).catch(caught('GitHub commits', [] as StandupCommit[])),
    claudeSessions($, home, day).catch(caught('Claude sessions', [] as StandupSession[])),
    ...reposOf(settings.repos, home).map(dir => localCommits($, dir, day).catch(() => [] as StandupCommit[])),
  ])
  return { ...prs, commits: mergeCommits([searched, ...local]), sessions, errors }
}

async function show($: EngineInterface, day: string) {
  const label = labelOf(day)
  await update($, viewAtom, () => ({ day, label, isLoading: true, data: null }))
  const data = await gather($, day)
  await update($, viewAtom, () => ({ day, label, isLoading: false, data }))
  return data
}

const draftPrompt = (label: string, data: StandupData) =>
  [
    `Draft a short standup update for ${label} from this activity. Plain bullet points grouped by repo, no filler.`,
    ...byRepo(data).flatMap(activity => [
      `${activity.repo}:`,
      ...activity.merged.map(pr => `- merged #${pr.number} ${pr.title} into ${pr.base}`),
      ...activity.opened.map(pr => `- opened #${pr.number} ${pr.title}`),
      ...activity.reviewed.map(pr => `- reviewed #${pr.number} ${pr.title}`),
      ...activity.commits.map(commit => `- commit ${commit.subject}`),
    ]),
  ].join('\n')

async function draft($: EngineInterface, day: string) {
  const command = settings.draftCommand.replace(/^\//, '')
  if (command === '') {
    const view = await read($, viewAtom)
    if (view === null || view.data === null || view.day !== day) return
    await $.prompt.submit({ text: draftPrompt(view.label, view.data), asUser: true })
    return
  }
  const args = workArgsOf(day, await $.clock.now())
  try {
    await $.command.run({ command, args })
  } catch {
    await $.prompt.submit({ text: `/${command} ${args}`, asUser: true })
  }
}

export const register: Register = (on, options) => {
  settings = {
    repos: typeof options.repos === 'string' ? options.repos : '',
    draftCommand: typeof options.draftCommand === 'string' ? options.draftCommand.trim() : '',
  }
  configureDays(
    typeof options.utcOffset === 'string' && options.utcOffset.trim() !== '' ? options.utcOffset : DEFAULT_OFFSET,
    typeof options.workDays === 'string' && options.workDays.trim() !== '' ? options.workDays : DEFAULT_WORK_DAYS,
  )

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'standup',
      description: 'What you shipped on a work day: PRs opened, merged, reviewed and commits (default: previous work day)',
      argumentHint: '[today|yesterday|YYYY-MM-DD]',
    })
    if (e.isInteractive) {
      const now = await $.clock.now()
      const today = todayOf(now)
      if (isWorkTime(now) && (await $.store.get('toastedOn')) !== today) {
        $.ui.toast('Standup ready — /standup', { timeoutMs: 8_000 })
        await $.store.set('toastedOn', today)
      }
    }

    return next(e)
  })

  on('command.run', { command: 'standup' }, async ($, e) => {
    const day = resolveDay(e.args, await $.clock.now())
    if (day === null) return { text: 'Usage: /standup [today|yesterday|YYYY-MM-DD]' }
    await $.ui.open({ id: PANE, title: `Standup · ${labelOf(day)}` })
    const data = await show($, day)

    return { text: `Standup for ${labelOf(day)}: ${countsOf(data)}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    if (view === null) return <Text dimColor>Run /standup to gather a day.</Text>
    if (view.isLoading || view.data === null) return <Text dimColor>Gathering {view.label}…</Text>
    const data = view.data

    return (
      <Box flexDirection="column">
        <Text bold>
          {view.label} · {countsOf(data)}
        </Text>
        {data.errors.map(error => (
          <Text color="warning">⚠ {error}</Text>
        ))}
        {byRepo(data).length === 0 && data.sessions.length === 0 && <Text dimColor>Nothing found for this day.</Text>}
        {byRepo(data).map(activity => (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{activity.repo}</Text>
            {activity.merged.map(pr => (
              <Link
                href={pr.url}
                label={`  ${/^(master|main)$/.test(pr.base) ? 'released' : 'merged'} #${pr.number} ${pr.title}`}
              />
            ))}
            {activity.opened
              .filter(pr => !activity.merged.some(merged => merged.url === pr.url))
              .map(pr => (
                <Link href={pr.url} label={`  opened #${pr.number} ${pr.title}`} />
              ))}
            {activity.reviewed.map(pr => (
              <Link href={pr.url} label={`  reviewed #${pr.number} ${pr.title}`} />
            ))}
            {activity.commits.slice(0, MAX_COMMITS).map(commit => (
              <Text dimColor wrap="truncate-end">
                {'  • '}
                {commit.subject}
              </Text>
            ))}
            {activity.commits.length > MAX_COMMITS && (
              <Text dimColor>
                {'  '}+{activity.commits.length - MAX_COMMITS} more commits
              </Text>
            )}
          </Box>
        ))}
        {data.sessions.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Claude sessions</Text>
            {data.sessions.map(session => (
              <Box flexDirection="column">
                <Text wrap="truncate-end">
                  {`  ${session.prompts} prompts`}
                  {session.project === '' ? '' : ` · ${session.project}`}
                  {session.firstPrompts[0] === undefined ? '' : ` · ${session.firstPrompts[0]}`}
                </Text>
                {session.firstPrompts.slice(1).map(prompt => (
                  <Text dimColor wrap="truncate-end">
                    {'      '}
                    {prompt}
                  </Text>
                ))}
              </Box>
            ))}
          </Box>
        )}
        <Box marginTop={1} gap={1}>
          <Button key="draft" label="Draft standup" hotkey="d" variant="primary" onPress={() => draft($, view.day)} />
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => show($, view.day)} />
        </Box>
      </Box>
    )
  })
}
