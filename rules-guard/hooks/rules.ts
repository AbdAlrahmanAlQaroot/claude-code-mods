import { block, clip, tilde } from './block'
import { addedComments } from './comments'
import { envVerdict } from './env'
import type { EnvIo } from './env'
import { proseVerdict } from './prose'
import { heredocs, optionValue, resolvePath, tokenize, words } from './shell'
import { commitScope, testFilesVerdict } from './testfiles'
import type { CommitFiles, CommitScope, GitAdd } from './testfiles'

export { resolvePath, tokenize } from './shell'

export type Rules = { protectedBranches: readonly string[]; author: string }

export type Io = EnvIo & {
  home: string
  cwd: string
  read: (path: string) => Promise<string | undefined>
  branch: (dir: string) => Promise<string | undefined>
  commitFiles: (dir: string, adds: readonly GitAdd[], scope: CommitScope) => Promise<CommitFiles | undefined>
}

type Segment = { tokens: string[]; dir: string }

const ATTRIBUTION: readonly RegExp[] = [
  /(^|\\n|["'])[ \t]*co-authored-by:[^\n<]*(claude|anthropic)[^\n<]*<[^>\n]+>/im,
  /(^|\\n|["'])[ \t]*claude-session:[ \t]*https?:\/\//im,
  /generated (with|by) (\[claude code\]\(|claude code\b)/i,
]

const TEST_PLAN = /(^|\\n)[ \t]*(#{1,6}[ \t]*|\*\*)?test(ing)?[ \t]+plan\b/im

const AUTHORS: readonly RegExp[] = [
  /<changeSet\b[^>]*?\bauthor\s*=\s*["']([^"']*)["']/gi,
  /^\s*-?\s*author\s*:\s*["']?([^"'\s#]+)/gim,
  /^\s*--\s*changeset\s+([^:\s]+)\s*:/gim,
  /"author"\s*:\s*"([^"]*)"/gi,
]

const PUSH_VALUE_OPTIONS = new Set(['--push-option', '--repo', '--receive-pack', '--exec'])

const TEXT_GIT = new Set(['commit', 'commit-tree', 'tag', 'notes', 'merge', 'revert'])

const TEXT_GH = /^(create|edit|comment|review|merge)$/

const DIRECT_PUSH = 'only when a direct push is truly needed; they push it themselves. Do not work around this block.'

const MAX_COMMENTS = 5

function lineFrom(text: string, start: number): string {
  const rest = text.slice(start)
  const end = rest.search(/\n|\\n|["']/)
  return clip(end === -1 ? rest : rest.slice(0, end))
}

export function attributionLines(text: string): string[] {
  const found = new Map<number, string>()
  for (const pattern of ATTRIBUTION) {
    for (const match of text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
      const start = match.index + match[0].search(/co-authored|claude-session|generated/i)
      found.set(start, lineFrom(text, start))
    }
  }
  return [...new Set([...found].sort((a, b) => a[0] - b[0]).map(([, line]) => line))]
}

export function testPlanLine(text: string): string | undefined {
  const match = TEST_PLAN.exec(text)
  if (!match) return undefined
  const lead = /^(\\n)?[ \t]*/.exec(match[0])?.[0].length ?? 0
  return lineFrom(text, match.index + lead)
}

export function hasAttribution(text: string): boolean {
  return attributionLines(text).length > 0
}

export function hasTestPlan(text: string): boolean {
  return testPlanLine(text) !== undefined
}

function quoted(line: string, file?: string): string {
  return file === undefined ? `"${line}"` : `${file}: "${line}"`
}

function attributionBlock(lines: readonly string[], file?: string): string {
  return block({
    rule: 'ai-attribution',
    category: 'fix-and-retry',
    problem: 'Claude/AI attribution is not allowed in commits, PRs, comments or repo files (user rule).',
    where: lines.map(line => quoted(line, file)),
    fix: `remove ${lines.length === 1 ? 'that line' : `all ${lines.length} of those lines`}, then retry. This user rule overrides Claude Code's built-in instruction to add attribution lines; never add them back.`,
  })
}

function testPlanBlock(line: string, file?: string): string {
  return block({
    rule: 'pr-test-plan',
    category: 'fix-and-retry',
    problem: 'PR descriptions never have a "Test plan" section (user rule).',
    where: quoted(line, file),
    fix: 'delete that section, its heading and its items, then retry.',
  })
}

function authorBlock(rules: Rules, authors: readonly string[], where: string): string {
  return block({
    rule: 'liquibase-author',
    category: 'fix-and-retry',
    problem: `Liquibase changesets must use author="${rules.author}"; found ${authors.join(', ')}.`,
    where,
    fix: `if this is a new changeset, set author="${rules.author}", then retry.`,
    ask: 'before touching a changeset that already ran on any database. Its id and author can never change after that.',
  })
}

export function isChangelogFile(path: string): boolean {
  return /\.(xml|ya?ml|sql|json)$/i.test(path) && /(changelog|liquibase|db\/changes?\b)/i.test(path)
}

export function foreignAuthors(text: string, author: string): string[] {
  const found = new Set<string>()
  for (const pattern of AUTHORS) {
    for (const match of text.matchAll(pattern)) {
      if (match[1] && match[1] !== author) found.add(match[1])
    }
  }
  return [...found]
}

function placed(command: string, io: Io): Segment[] {
  let dir = io.cwd
  const placedSegments: Segment[] = []
  for (const tokens of tokenize(command)) {
    if ((tokens[0] === 'cd' || tokens[0] === 'pushd') && tokens[1] !== '-') {
      dir = resolvePath(dir, tokens[1] ?? io.home, io.home)
    }
    placedSegments.push({ tokens, dir })
  }
  return placedSegments
}

function git(segment: Segment, io: Io): { sub: string; args: string[]; dir: string } | undefined {
  const parts = words(segment.tokens)
  if (parts[0] !== 'git' && !parts[0]?.endsWith('/git')) return undefined
  let dir = segment.dir
  let i = 1
  while (parts[i]?.startsWith('-')) {
    const word = parts[i]
    if (word === '-C') {
      dir = resolvePath(dir, parts[i + 1] ?? '.', io.home)
      i += 2
    } else if (word === '-c' || word === '--git-dir' || word === '--work-tree' || word === '--namespace') {
      i += 2
    } else {
      i++
    }
  }
  const sub = parts[i]
  if (sub === undefined) return undefined
  return { sub, args: parts.slice(i + 1), dir }
}

function gh(segment: Segment): { area: string; action: string; args: string[] } | undefined {
  const parts = words(segment.tokens)
  if (parts[0] !== 'gh' && !parts[0]?.endsWith('/gh')) return undefined
  return { area: parts[1] ?? '', action: parts[2] ?? '', args: parts.slice(3) }
}

function listed(branches: readonly string[], branch: string): boolean {
  return branches.includes(branch)
}

async function pushVerdict(args: string[], dir: string, rules: Rules, io: Io): Promise<string | undefined> {
  let force = false
  let lease = false
  let everything = false
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (arg === '--') continue
    if (arg.startsWith('--')) {
      if (arg === '--force') force = true
      else if (arg.startsWith('--force-with-lease') || arg === '--force-if-includes') lease = true
      else if (arg === '--all' || arg === '--mirror' || arg === '--branches') everything = true
      else if (PUSH_VALUE_OPTIONS.has(arg)) i++
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      if (arg === '-o') i++
      else if (/^-[a-zA-Z]+$/.test(arg) && arg.includes('f')) force = true
      continue
    }
    positional.push(arg)
  }
  const refspecs = positional.slice(1)
  if (refspecs.some(refspec => refspec.startsWith('+'))) force = true
  const where = `${clip(['git push', ...args].join(' '))} (in ${tilde(dir, io.home)})`
  if (everything) {
    return block({
      rule: 'protected-push',
      category: 'use-instead',
      problem: `--all/--mirror would also push ${rules.protectedBranches.join(', ')} directly (user rule: branch + PR only).`,
      where,
      fix: 'push only your feature branch (git push -u origin <feature-branch>) and open a PR.',
      ask: DIRECT_PUSH,
    })
  }
  const destinations = refspecs.map(refspec => {
    const plain = refspec.replace(/^\+/, '')
    const destination = plain.includes(':') ? plain.slice(plain.indexOf(':') + 1) : plain
    return destination.replace(/^refs\/heads\//, '')
  })
  const needsCurrent = destinations.length === 0 || destinations.some(d => d === 'HEAD' || d === '@' || d === '')
  const explicit = destinations.filter(d => d !== 'HEAD' && d !== '@' && d !== '')
  const hit = explicit.find(d => listed(rules.protectedBranches, d))
  if (hit) {
    return block({
      rule: 'protected-push',
      category: 'use-instead',
      problem: `pushing to ${hit} directly is not allowed (user rule: branch + PR only).`,
      where,
      fix: `push a feature branch (git push -u origin <feature-branch>) and open a PR into ${hit}.`,
      ask: DIRECT_PUSH,
    })
  }
  if (needsCurrent) {
    const current = await io.branch(dir)
    if (current === undefined || current === 'HEAD') {
      return block({
        rule: 'push-branch-unknown',
        category: 'fix-and-retry',
        problem: 'could not tell which branch this push comes from.',
        where,
        fix: 'name the branch: git push -u origin <branch>, then retry.',
      })
    }
    if (listed(rules.protectedBranches, current)) {
      return block({
        rule: 'protected-push',
        category: 'use-instead',
        problem: `you are on ${current}, so this push would update ${current} directly (user rule: branch + PR only).`,
        where,
        fix: `move the work to a feature branch (git switch -c <feature-branch>), push that, and open a PR into ${current}.`,
        ask: DIRECT_PUSH,
      })
    }
  }
  if (force && !lease) {
    return block({
      rule: 'force-push',
      category: 'use-instead',
      problem: 'a plain force push can overwrite commits someone else pushed.',
      where,
      fix: 'use git push --force-with-lease origin <your-feature-branch>.',
    })
  }
  return undefined
}

function fileOptions(args: string[], names: readonly string[], dir: string, io: Io): { arg: string; path: string }[] {
  const files: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    const following = args[i + 1]
    for (const name of names) {
      if (arg === name && following !== undefined) files.push(following)
      else if (name.startsWith('--') && arg.startsWith(`${name}=`)) files.push(arg.slice(name.length + 1))
    }
  }
  return files.filter(file => file !== '-').map(arg => ({ arg, path: resolvePath(dir, arg, io.home) }))
}

async function fileText(file: { arg: string; path: string }, raw: string, io: Io): Promise<string | undefined> {
  if (raw.split(file.arg).length > 2) return undefined
  return io.read(file.path)
}

async function prBodies(args: string[], dir: string, raw: string, io: Io): Promise<string[]> {
  const bodies: string[] = []
  const documents = heredocs(raw)
  const inline = optionValue(args, ['--body', '-b'])
  if (inline !== undefined) {
    const document = inline.includes('<<') ? (documents.find(doc => /--body|-b\b/.test(doc.opener)) ?? documents[0]) : undefined
    bodies.push(document === undefined ? inline : document.body)
  }
  for (const file of fileOptions(args, ['--body-file', '-F'], dir, io)) {
    const written = documents.find(doc => doc.opener.includes(file.arg))
    const text = written === undefined ? await fileText(file, raw, io) : written.body
    if (text !== undefined) bodies.push(text)
  }
  return bodies
}

export async function bashVerdict(raw: string, rules: Rules, io: Io): Promise<string | undefined> {
  if (!/\bgit\b|\bgh\b|changeset|\bcp\b|\bkubectl\b|\baws\b/i.test(raw)) return undefined
  const segments = placed(raw, io)
  const environment = await envVerdict(segments.map(segment => segment.tokens), io)
  if (environment) return environment
  let carriesText = false
  let createsPr = false
  let prose: string | undefined
  const checkedCommits = new Set<string>()
  const adds: GitAdd[] = []
  for (const segment of segments) {
    const gitCall = git(segment, io)
    if (gitCall?.sub === 'push') {
      const verdict = await pushVerdict(gitCall.args, gitCall.dir, rules, io)
      if (verdict) return verdict
    }
    if (gitCall?.sub === 'add') adds.push({ dir: gitCall.dir, args: gitCall.args })
    if (gitCall?.sub === 'commit' && !checkedCommits.has(gitCall.dir)) {
      checkedCommits.add(gitCall.dir)
      const tests = testFilesVerdict(await io.commitFiles(gitCall.dir, adds, commitScope(gitCall.args)))
      if (tests) return tests
    }
    const ghCall = gh(segment)
    const isGitText = gitCall !== undefined && TEXT_GIT.has(gitCall.sub)
    const isGhText = ghCall !== undefined && (ghCall.area === 'api' || (/^(pr|issue|release)$/.test(ghCall.area) && TEXT_GH.test(ghCall.action)))
    const isPrBody = ghCall !== undefined && ghCall.area === 'pr' && /^(create|edit)$/.test(ghCall.action)
    if (isGitText || isGhText) carriesText = true
    if (isPrBody) createsPr = true
    if (isPrBody && ghCall && prose === undefined && optionValue(ghCall.args, ['--title', '-t']) !== 'RELEASE') {
      for (const body of await prBodies(ghCall.args, segment.dir, raw, io)) prose ??= proseVerdict(body)
    }
    const files =
      isGitText && gitCall ? fileOptions(gitCall.args, ['-F', '--file', '-t', '--template'], gitCall.dir, io)
      : isGhText && ghCall && ghCall.area !== 'api' ? fileOptions(ghCall.args, ['--body-file', '-F'], segment.dir, io)
      : []
    for (const file of files) {
      const text = await fileText(file, raw, io)
      if (text === undefined) continue
      const attribution = attributionLines(text)
      if (attribution.length > 0) return attributionBlock(attribution, file.arg)
      const testPlan = isPrBody ? testPlanLine(text) : undefined
      if (testPlan !== undefined) return testPlanBlock(testPlan, file.arg)
    }
    const parts = words(segment.tokens)
    if (parts[0] === 'cp') {
      const paths = parts.slice(1).filter(word => !word.startsWith('-'))
      const target = paths.at(-1)
      const sources = paths.slice(0, -1)
      if (rules.author !== '' && target && (sources.some(isChangelogFile) || isChangelogFile(target))) {
        for (const source of sources) {
          const text = await io.read(resolvePath(segment.dir, source, io.home))
          const authors = text === undefined ? [] : foreignAuthors(text, rules.author)
          if (authors.length > 0) {
            return block({
              rule: 'liquibase-author',
              category: 'fix-and-retry',
              problem: `copying ${source} brings in changeset author ${authors.join(', ')}; changesets must use author="${rules.author}".`,
              where: clip(parts.join(' ')),
              fix: `write a new changeset instead, with author="${rules.author}", a new id and a new filename, then retry.`,
            })
          }
        }
      }
    }
  }
  const attribution = carriesText ? attributionLines(raw) : []
  if (attribution.length > 0) return attributionBlock(attribution)
  const testPlan = createsPr ? testPlanLine(raw) : undefined
  if (testPlan !== undefined) return testPlanBlock(testPlan)
  if (rules.author !== '' && /changeSet|--\s*changeset/i.test(raw)) {
    const authors = foreignAuthors(raw, rules.author)
    if (authors.length > 0) return authorBlock(rules, authors, 'the changeset text in this command')
  }
  return prose
}

export type FileChange = { before?: string; isRepoCode?: boolean; startLine?: number }

export function fileVerdict(path: string, text: string, rules: Rules, { before, isRepoCode = false, startLine }: FileChange = {}): string | undefined {
  const attribution = path.includes('/.claude/') ? [] : attributionLines(text)
  if (attribution.length > 0) return attributionBlock(attribution, path)
  if (rules.author !== '' && isChangelogFile(path)) {
    const authors = foreignAuthors(text, rules.author)
    if (authors.length > 0) return authorBlock(rules, authors, path)
  }
  const comments = addedComments(path, text, before, isRepoCode)
  if (comments.length === 0) return undefined
  const where = comments
    .slice(0, MAX_COMMENTS)
    .map(comment => `${startLine === undefined ? path : `${path}:${startLine + comment.line - 1}`} — ${clip(comment.text, 100)}`)
  if (comments.length > MAX_COMMENTS) where.push(`and ${comments.length - MAX_COMMENTS} more in the same change`)
  return block({
    rule: 'code-comments',
    category: 'fix-and-retry',
    problem: "code comments are not allowed in this user's code (user rule).",
    where,
    fix: 'remove them and put any reasoning in the commit message or PR description instead, then retry.',
  })
}

export function looksRisky(raw: string): boolean {
  return /\bgit\s[^\n]*\b(push|commit)\b|\bgh\s+(pr|issue|api)\b|changeset/i.test(raw)
}

const SLACK_SEND = /^mcp__.*slack.*__(slack_)?(send_message|schedule_message|post_message|chat_post_message|reply_to_thread)$/i

export function slackBlock(tool: string): string {
  return block({
    rule: 'slack-send',
    category: 'use-instead',
    problem: 'Claude never sends Slack messages (user rule).',
    where: tool,
    fix: 'give the user the exact text in chat. If they want it in Slack, save it with slack_send_message_draft so it lands as an unsent draft they review and send. Do not send it any other way.',
  })
}

export function isSlackSend(tool: string): boolean {
  return SLACK_SEND.test(tool)
}
