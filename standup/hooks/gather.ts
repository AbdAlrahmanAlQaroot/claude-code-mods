import type { StandupCommit, StandupData, StandupPr, StandupSession } from '../types'
import { offsetOf, rangeOf, sinceOf, untilOf } from './day'

export const reposOf = (configured: string, home: string) =>
  configured
    .split(',')
    .map(path => path.trim())
    .filter(Boolean)
    .map(path => (path === '~' || path.startsWith('~/') ? `${home}${path.slice(1)}` : path.startsWith('/') ? path : `${home}/${path}`))

const HISTORY_BYTES = '4000000'
const DAY_MS = 86_400_000
const PROMPT_CHARS = 90
const SHORT_REPLY = /^(y|yes|n|no|ok|okay|sure|go|go on|do it|continue|retry|again|done|thanks|thank you|good|nothing)\W*$/i
const MARKERS = /\[(?:Image|Pasted text)[^\]]*\]/g

const QUERY = `query($opened: String!, $merged: String!, $reviewed: String!) {
  opened: search(query: $opened, type: ISSUE, first: 50) {
    nodes { ... on PullRequest { number title url baseRefName repository { nameWithOwner } } }
  }
  merged: search(query: $merged, type: ISSUE, first: 50) {
    nodes { ... on PullRequest { number title url baseRefName repository { nameWithOwner } } }
  }
  reviewed: search(query: $reviewed, type: ISSUE, first: 50) {
    nodes { ... on PullRequest { number title url baseRefName repository { nameWithOwner } } }
  }
}`

type RawPr = {
  number?: number
  title?: string
  url?: string
  baseRefName?: string
  repository?: { nameWithOwner: string }
}

type RawSearch = { nodes?: RawPr[] }

type RawPrs = {
  data?: { opened?: RawSearch; merged?: RawSearch; reviewed?: RawSearch }
  errors?: { message?: string }[]
}

type RawCommit = {
  sha?: string
  commit?: { message?: string }
  repository?: { name?: string }
}

export const prArgs = (day: string) => [
  'gh',
  'api',
  'graphql',
  '-f',
  `query=${QUERY}`,
  '-f',
  `opened=author:@me is:pr created:${rangeOf(day)}`,
  '-f',
  `merged=author:@me is:pr is:merged merged:${rangeOf(day)}`,
  '-f',
  `reviewed=reviewed-by:@me -author:@me is:pr updated:${rangeOf(day)}`,
]

export const commitArgs = (day: string) => [
  'gh',
  'search',
  'commits',
  '--author=@me',
  `--committer-date=${rangeOf(day)}`,
  '--json',
  'sha,commit,repository',
  '--limit',
  '100',
]

export const logArgs = (dir: string, email: string, day: string) => [
  'git',
  '-C',
  dir,
  'log',
  '--branches',
  '--remotes',
  '--no-merges',
  '--fixed-strings',
  `--author=${email}`,
  `--since=${sinceOf(day)}`,
  `--until=${untilOf(day)}`,
  '--format=%H%x1f%s',
]

export const shortRepo = (repo: string) => repo.split('/').pop() ?? repo

export const repoOfRemote = (url: string, fallback: string) =>
  /[/:]([^/:]+?)(\.git)?\s*$/.exec(url.trim())?.[1] ?? fallback

const isMerge = (subject: string) => /^Merge (pull request|branch|remote-tracking branch)\b/.test(subject)

const toPrs = (search: RawSearch | undefined): StandupPr[] =>
  (search?.nodes ?? []).flatMap(node =>
    node.number === undefined || node.url === undefined
      ? []
      : [
          {
            repo: shortRepo(node.repository?.nameWithOwner ?? ''),
            number: node.number,
            title: node.title ?? '',
            url: node.url,
            base: node.baseRefName ?? '',
          },
        ],
  )

export const parsePrs = (stdout: string) => {
  const raw = JSON.parse(stdout) as RawPrs
  if (raw.data === undefined) throw new Error(raw.errors?.[0]?.message ?? 'no data from GitHub')
  return { opened: toPrs(raw.data.opened), merged: toPrs(raw.data.merged), reviewed: toPrs(raw.data.reviewed) }
}

export const parseSearchCommits = (stdout: string): StandupCommit[] =>
  (JSON.parse(stdout) as RawCommit[]).flatMap(item => {
    const subject = item.commit?.message?.split('\n')[0] ?? ''
    return item.sha === undefined || isMerge(subject)
      ? []
      : [{ repo: item.repository?.name ?? '', sha: item.sha, subject }]
  })

export const parseLog = (stdout: string, repo: string): StandupCommit[] =>
  stdout
    .split('\n')
    .filter(line => line.includes('\x1f'))
    .map(line => {
      const [sha = '', subject = ''] = line.split('\x1f')
      return { repo, sha, subject }
    })

export const mergeCommits = (lists: readonly StandupCommit[][]) => {
  const seen = new Set<string>()
  return lists.flat().filter(commit => {
    if (seen.has(commit.sha)) return false
    seen.add(commit.sha)
    return true
  })
}

export const reasonOf = (text: string) => {
  if (/gh auth login|not logged in|authentication|HTTP 401|Bad credentials/i.test(text)) return 'gh not logged in'
  if (/could not resolve|no such host|dial tcp|network is unreachable|timed? ?out|connection refused/i.test(text))
    return 'offline'
  return text.trim().split('\n')[0]?.slice(0, 80) || 'failed'
}

export const countsOf = (data: StandupData) =>
  [
    `${data.opened.length} PRs opened`,
    `${data.merged.length} merged`,
    `${data.reviewed.length} reviewed`,
    `${data.commits.length} commits`,
    ...(data.sessions.length > 0 ? [`${data.sessions.length} Claude sessions`] : []),
  ].join(' · ')

export const historyArgs = (home: string) => ['tail', '-c', HISTORY_BYTES, `${home}/.claude/history.jsonl`]

type RawPrompt = { display?: unknown; timestamp?: unknown; project?: unknown; sessionId?: unknown }

const meaningful = (display: string) => {
  const text = display.replace(MARKERS, ' ').replace(/\s+/g, ' ').trim()
  if (text === '' || text.startsWith('/') || text.startsWith('!') || SHORT_REPLY.test(text)) return undefined
  return text.length > PROMPT_CHARS ? `${text.slice(0, PROMPT_CHARS - 1)}…` : text
}

export const parseSessions = (stdout: string, day: string, home: string): StandupSession[] => {
  const start = Date.parse(`${day}T00:00:00${offsetOf()}`)
  const end = start + DAY_MS
  const sessions = new Map<string, StandupSession>()
  for (const line of stdout.split('\n')) {
    let row: RawPrompt
    try {
      row = JSON.parse(line) as RawPrompt
    } catch {
      continue
    }
    if (typeof row.timestamp !== 'number' || row.timestamp < start || row.timestamp >= end) continue
    if (typeof row.sessionId !== 'string' || typeof row.display !== 'string') continue
    const project = typeof row.project === 'string' && row.project !== home ? row.project.replace(home, '~') : ''
    const session = sessions.get(row.sessionId) ?? { id: row.sessionId, project, prompts: 0, firstPrompts: [] }
    sessions.set(row.sessionId, session)
    session.prompts += 1
    const text = meaningful(row.display)
    if (text !== undefined && session.firstPrompts.length < 2) session.firstPrompts.push(text)
  }
  return [...sessions.values()]
}

export type RepoActivity = {
  repo: string
  opened: StandupPr[]
  merged: StandupPr[]
  reviewed: StandupPr[]
  commits: StandupCommit[]
}

export const byRepo = (data: StandupData): RepoActivity[] => {
  const repos = new Map<string, RepoActivity>()
  const entry = (repo: string) => {
    const found = repos.get(repo) ?? { repo, opened: [], merged: [], reviewed: [], commits: [] }
    repos.set(repo, found)
    return found
  }
  for (const pr of data.opened) entry(pr.repo).opened.push(pr)
  for (const pr of data.merged) entry(pr.repo).merged.push(pr)
  for (const pr of data.reviewed) entry(pr.repo).reviewed.push(pr)
  for (const commit of data.commits) entry(commit.repo).commits.push(commit)
  const size = (a: RepoActivity) => a.opened.length + a.merged.length + a.reviewed.length + a.commits.length
  return [...repos.values()].sort((a, b) => size(b) - size(a))
}
