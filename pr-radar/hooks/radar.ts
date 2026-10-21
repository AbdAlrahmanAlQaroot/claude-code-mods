import type {
  LooseCommit,
  MergedPr,
  OpenPr,
  PrChecks,
  PrReview,
  Radar,
  RadarChange,
  Unreleased,
  UnreleasedPr,
  UnreleasedRepo,
} from '../types'

export const QUERY = `query($merged: String!) {
  viewer {
    pullRequests(first: 50, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title url isDraft baseRefName headRefName reviewDecision mergeable updatedAt
        repository { nameWithOwner isArchived }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        reviewThreads(first: 100) { nodes { isResolved } }
      }
    }
  }
  merged: search(query: $merged, type: ISSUE, first: 30) {
    nodes { ... on PullRequest { number title url mergedAt baseRefName repository { nameWithOwner } } }
  }
}`

const DAY_MS = 86_400_000

export const EMPTY: Radar = { open: [], merged: [], fetchedAt: 0, error: null }

export const PR_WORDS =
  /\b(prs?|pull requests?|merg(e|ed|es|ing)|releas(e|ed|es|ing)|approv(e|ed|al)|reviews?|reviewed)\b/i

type RawOpen = {
  number: number
  title: string
  url: string
  isDraft: boolean
  baseRefName: string
  headRefName: string
  reviewDecision: string | null
  mergeable: string | null
  updatedAt: string
  repository: { nameWithOwner: string; isArchived?: boolean }
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] }
  reviewThreads: { nodes: { isResolved: boolean }[] }
}

type RawMerged = {
  number?: number
  title?: string
  url?: string
  mergedAt?: string
  baseRefName?: string
  repository?: { nameWithOwner: string }
}

type Raw = {
  data?: {
    viewer?: { pullRequests?: { nodes?: RawOpen[] } }
    merged?: { nodes?: RawMerged[] }
  }
  errors?: { message?: string }[]
}

export const mergedQuery = (now: number) =>
  `author:@me is:pr is:merged merged:>=${new Date(now - 3 * DAY_MS).toISOString().slice(0, 10)} sort:updated-desc`

export const ghArgs = (now: number) => [
  'gh',
  'api',
  'graphql',
  '-f',
  `query=${QUERY}`,
  '-f',
  `merged=${mergedQuery(now)}`,
]

const checksOf = (state: string | undefined): PrChecks => {
  if (state === 'SUCCESS') return 'passing'
  if (state === 'FAILURE' || state === 'ERROR') return 'failing'
  if (state === 'PENDING' || state === 'EXPECTED') return 'pending'
  return 'none'
}

const reviewOf = (decision: string | null): PrReview => {
  if (decision === 'APPROVED') return 'approved'
  if (decision === 'CHANGES_REQUESTED') return 'changes'
  if (decision === 'REVIEW_REQUIRED') return 'required'
  return 'none'
}

const toOpen = (node: RawOpen): OpenPr => ({
  repo: node.repository.nameWithOwner,
  number: node.number,
  title: node.title,
  url: node.url,
  isDraft: node.isDraft,
  base: node.baseRefName,
  head: node.headRefName,
  review: reviewOf(node.reviewDecision),
  checks: checksOf(node.commits.nodes[0]?.commit.statusCheckRollup?.state),
  hasConflicts: node.mergeable === 'CONFLICTING',
  unresolved: node.reviewThreads.nodes.filter(thread => !thread.isResolved).length,
  updatedAt: node.updatedAt,
})

const toMerged = (node: RawMerged): MergedPr[] =>
  node.number === undefined || node.url === undefined
    ? []
    : [
        {
          repo: node.repository?.nameWithOwner ?? '',
          number: node.number,
          title: node.title ?? '',
          url: node.url,
          base: node.baseRefName ?? '',
          mergedAt: node.mergedAt ?? '',
        },
      ]

export const parse = (stdout: string, now: number): Radar | string => {
  let raw: Raw
  try {
    raw = JSON.parse(stdout) as Raw
  } catch {
    return 'unreadable gh output'
  }
  const nodes = raw.data?.viewer?.pullRequests?.nodes
  if (nodes === undefined) return raw.errors?.[0]?.message?.slice(0, 60) ?? 'no data from GitHub'
  return {
    open: nodes.filter(node => !node.repository.isArchived).map(toOpen),
    merged: (raw.data?.merged?.nodes ?? []).flatMap(toMerged),
    fetchedAt: now,
    error: null,
  }
}

export const reasonOf = (text: string) => {
  if (/gh auth login|not logged in|authentication|HTTP 401|Bad credentials/i.test(text)) return 'gh not logged in'
  if (/ENOENT|executable file not found|command not found|cannot start/i.test(text)) return 'gh not installed'
  if (/could not resolve|no such host|dial tcp|network is unreachable|timed? ?out|connection refused/i.test(text))
    return 'offline'
  if (/rate limit/i.test(text)) return 'rate limited'
  return text.trim().split('\n')[0]?.slice(0, 60) || 'gh failed'
}

export const asRadar = (value: unknown): Radar | null => {
  if (typeof value !== 'object' || value === null) return null
  const radar = value as Partial<Radar>
  return Array.isArray(radar.open) && Array.isArray(radar.merged) && typeof radar.fetchedAt === 'number'
    ? { open: radar.open, merged: radar.merged, fetchedAt: radar.fetchedAt, error: radar.error ?? null }
    : null
}

export const shortRepo = (repo: string) => repo.split('/').pop() ?? repo

export const summary = (radar: Radar) => {
  const approved = radar.open.filter(pr => pr.review === 'approved').length
  const failing = radar.open.filter(pr => pr.checks === 'failing').length
  const unresolved = radar.open.reduce((sum, pr) => sum + pr.unresolved, 0)
  const parts = [`PRs ${radar.open.length}`]
  if (approved > 0) parts.push(`✓${approved} approved`)
  if (failing > 0) parts.push(`✗${failing} failing`)
  if (unresolved > 0) parts.push(`${unresolved} unresolved`)
  if (radar.error !== null) parts.push(`⚠ ${radar.error}`)
  return parts.join(' · ')
}

const REVIEW_WORDS: Record<PrReview, string> = {
  approved: 'approved',
  changes: 'changes requested',
  required: 'review required',
  none: '',
}

const CHECK_WORDS: Record<PrChecks, string> = {
  passing: 'checks ✓',
  failing: 'checks ✗',
  pending: 'checks running',
  none: '',
}

export const describePr = (pr: OpenPr) =>
  [
    pr.isDraft ? 'draft' : '',
    REVIEW_WORDS[pr.review],
    CHECK_WORDS[pr.checks],
    pr.unresolved > 0 ? `${pr.unresolved} unresolved` : '',
    pr.hasConflicts ? 'conflicts' : '',
    `→ ${pr.base}`,
  ]
    .filter(Boolean)
    .join(' · ')

export const describeMerged = (pr: MergedPr) =>
  `merged ${pr.mergedAt.slice(0, 10)} → ${pr.base}${/^(master|main)$/.test(pr.base) ? ' (release)' : ''}`

export const byRepo = <T extends { repo: string }>(list: readonly T[]) => {
  const groups = new Map<string, T[]>()
  for (const item of list) groups.set(item.repo, [...(groups.get(item.repo) ?? []), item])
  return [...groups.entries()]
}

export const age = (now: number, fetchedAt: number) => {
  if (fetchedAt === 0) return 'never fetched'
  const minutes = Math.floor((now - fetchedAt) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  return `${Math.floor(minutes / 60)} h ago`
}

export const listText = (radar: Radar, now: number) => {
  const lines = [`Open PRs (${radar.open.length}), fetched ${age(now, radar.fetchedAt)}`]
  if (radar.error !== null) lines.push(`⚠ last refresh failed: ${radar.error}`)
  for (const [repo, prs] of byRepo(radar.open)) {
    lines.push('', repo)
    for (const pr of prs) lines.push(`  #${pr.number} ${pr.title}`, `    ${describePr(pr)}`, `    ${pr.url}`)
  }
  if (radar.merged.length > 0) {
    lines.push('', `Merged in the last 3 days (${radar.merged.length})`)
    for (const pr of radar.merged)
      lines.push(`  ${shortRepo(pr.repo)} #${pr.number} ${pr.title} · ${describeMerged(pr)}`, `    ${pr.url}`)
  }
  return lines.join('\n')
}

export const contextLine = (radar: Radar, now: number, integration = 'staging') => {
  const open = radar.open.map(pr => `${shortRepo(pr.repo)}#${pr.number} (${describePr(pr)})`).join('; ')
  const merged = radar.merged
    .map(pr => `${shortRepo(pr.repo)}#${pr.number} → ${pr.base} on ${pr.mergedAt.slice(0, 10)}`)
    .join('; ')
  return [
    `Live GitHub PR state from pr-radar, fetched ${age(now, radar.fetchedAt)}; trust it over earlier turns.`,
    `Open: ${open || 'none'}.`,
    `Merged in the last 3 days: ${merged || 'none'}.`,
    `Full list with URLs: the mcp__pr-radar__my_prs tool. What is on ${integration} but not yet released to prod: the mcp__pr-radar__my_unreleased tool.`,
  ].join(' ')
}

export const DEFAULT_REPOS = ''

export const DEFAULT_INTEGRATION = 'staging'

export const LOGIN_ARGS = ['gh', 'api', 'user', '--jq', '.login']

export const RELEASE_BRANCHES = ['main', 'master'] as const

const COMPARE_JQ =
  '{ahead: .ahead_by, base: .merge_base_commit.commit.committer.date, commits: [.commits[] | {sha: .sha[0:7], login: (.author.login // ""), message: .commit.message, isMerge: ((.parents | length) > 1)}]}'

export const compareArgs = (repo: string, release: string, integration = DEFAULT_INTEGRATION) => [
  'gh',
  'api',
  `repos/${repo}/compare/${release}...${integration}`,
  '--jq',
  COMPARE_JQ,
]

export const isNotFound = (text: string) => /HTTP 404|Not Found/i.test(text)

export const reposToCheck = (configured: string, radar: Radar, integration = DEFAULT_INTEGRATION) => {
  const listed = configured
    .split(',')
    .map(repo => repo.trim())
    .filter(repo => /^[\w.-]+\/[\w.-]+$/.test(repo))
  const seen = [...radar.open, ...radar.merged].filter(pr => pr.base === integration).map(pr => pr.repo)
  return [...new Set([...listed, ...seen])]
}

type RawCompare = {
  ahead?: number
  base?: string | null
  commits?: { sha: string; login: string; message: string; isMerge: boolean }[]
}

const MERGE_PR = /^Merge pull request #(\d+) from (\S+)/
const SQUASH_PR = /\s*\(#(\d+)\)\s*$/

export const parseCompare = (repo: string, release: string, stdout: string, me = ''): UnreleasedRepo | string => {
  let raw: RawCompare
  try {
    raw = JSON.parse(stdout) as RawCompare
  } catch {
    return 'unreadable compare output'
  }
  const prs = new Map<number, UnreleasedPr>()
  const mine: LooseCommit[] = []
  let others = 0
  for (const commit of raw.commits ?? []) {
    const [head = '', ...rest] = commit.message.split('\n')
    const isMine = me !== '' && commit.login.toLowerCase() === me.toLowerCase()
    const merge = MERGE_PR.exec(head)
    if (merge !== null) {
      const title = rest.map(line => line.trim()).find(Boolean) ?? merge[2] ?? ''
      prs.set(Number(merge[1]), { number: Number(merge[1]), title, login: commit.login, isMine })
      continue
    }
    const squash = SQUASH_PR.exec(head)
    if (squash !== null) {
      prs.set(Number(squash[1]), { number: Number(squash[1]), title: head.replace(SQUASH_PR, ''), login: commit.login, isMine })
      continue
    }
    if (commit.login.endsWith('[bot]')) continue
    if (isMine) mine.push({ sha: commit.sha, title: head })
    else others += 1
  }
  return {
    repo,
    release,
    ahead: raw.ahead ?? 0,
    prs: [...prs.values()],
    mine,
    others,
    releasedUpTo: raw.base ?? null,
    error: null,
  }
}

export const failedRepo = (repo: string, release: string | null, error: string): UnreleasedRepo => ({
  repo,
  release,
  ahead: 0,
  prs: [],
  mine: [],
  others: 0,
  releasedUpTo: null,
  error,
})

export const asUnreleased = (value: unknown): Unreleased | null => {
  if (typeof value !== 'object' || value === null) return null
  const found = value as Partial<Unreleased>
  return Array.isArray(found.repos) && typeof found.fetchedAt === 'number'
    ? { repos: found.repos, fetchedAt: found.fetchedAt }
    : null
}

const repoLines = (entry: UnreleasedRepo, integration: string) => {
  const name = shortRepo(entry.repo)
  if (entry.error !== null) return [`${name} · ⚠ ${entry.error}`]
  if (entry.ahead === 0) return [`${name} · nothing unreleased (${entry.release})`]
  const head = [
    `${name} · ${entry.ahead} commit${entry.ahead === 1 ? '' : 's'} ahead of ${entry.release}`,
    entry.releasedUpTo === null ? '' : `last release took ${integration} up to ${entry.releasedUpTo.slice(0, 10)}`,
  ]
    .filter(Boolean)
    .join(' · ')
  const lines = [head]
  for (const pr of entry.prs) lines.push(`  #${pr.number} ${pr.title} · ${pr.isMine ? 'you' : pr.login || 'unknown'}`)
  if (entry.mine.length > 0) {
    lines.push('  your commits outside a PR:')
    for (const commit of entry.mine) lines.push(`    ${commit.sha} ${commit.title}`)
  }
  if (entry.others > 0) lines.push(`  + ${entry.others} more commit${entry.others === 1 ? '' : 's'} by others`)
  return lines
}

export const unreleasedText = (unreleased: Unreleased, now: number, integration = DEFAULT_INTEGRATION) => {
  const lines = [`On ${integration}, not yet released to prod · checked ${age(now, unreleased.fetchedAt)}`]
  if (unreleased.repos.length === 0) lines.push('', `No repos to check: set the repos option, or open a PR into ${integration}.`)
  for (const entry of unreleased.repos) lines.push('', ...repoLines(entry, integration))
  return lines.join('\n')
}

const STALE_BASELINE_MS = 24 * 60 * 60_000

export const radarChanges = (previous: Radar, next: Radar): RadarChange[] => {
  if (next.fetchedAt - previous.fetchedAt > STALE_BASELINE_MS) return []
  const before = new Map(previous.open.map(pr => [pr.url, pr]))
  const still = new Set(next.open.map(pr => pr.url))
  const merged = new Map(next.merged.map(pr => [pr.url, pr]))
  const changes: RadarChange[] = []
  const add = (kind: string, url: string, text: string) =>
    changes.push({ id: `${kind}:${url}:${previous.fetchedAt}`, text })
  for (const pr of next.open) {
    const was = before.get(pr.url)
    if (was === undefined) continue
    const name = `${shortRepo(pr.repo)} #${pr.number}`
    if (pr.review !== was.review && pr.review === 'approved') add('approved', pr.url, `${name} approved`)
    if (pr.review !== was.review && pr.review === 'changes') add('changes', pr.url, `${name}: changes requested`)
    if (pr.checks === 'failing' && was.checks !== 'failing') add('failing', pr.url, `${name}: checks failing`)
    if (pr.checks === 'passing' && was.checks === 'failing') add('passing', pr.url, `${name}: checks passing again`)
    if (pr.unresolved > was.unresolved) {
      const count = pr.unresolved - was.unresolved
      add('comments', pr.url, `${name}: ${count} new unresolved comment${count === 1 ? '' : 's'}`)
    }
  }
  for (const was of previous.open) {
    if (still.has(was.url)) continue
    const name = `${shortRepo(was.repo)} #${was.number}`
    const done = merged.get(was.url)
    if (done !== undefined) add('merged', was.url, `${name} merged → ${done.base}`)
    else add('closed', was.url, `${name} closed`)
  }
  return changes
}

export const alertText = (changes: readonly RadarChange[]) => {
  const shown = changes.slice(0, 3).map(change => change.text)
  const more = changes.length - shown.length
  return more > 0 ? `${shown.join(' · ')} · +${more} more` : shown.join(' · ')
}

export const asIds = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
