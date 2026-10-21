import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RepoSpot } from '../types'

const FRESH_MS = 30_000
const PATH = String.raw`(?:"([^"]+)"|'([^']+)'|([^\s;&|()]+))`
const LEADING_CD = new RegExp(String.raw`^\s*(?:cd|pushd)\s+${PATH}`)
const GIT_DASH_C = new RegExp(String.raw`\bgit\s+-C\s+${PATH}`)
const MAY_MOVE_BRANCH = /\b(git|gh)\b/
const SHORT_REPLY = /^(y|yes|n|no|ok|okay|sure|go|go on|do it|continue|retry|again|done|thanks|thank you)\W*$/i
const NOISE = /\[(?:Image|Pasted text)[^\]]*\]|https?:\/\/\S+/g

const spot = atom({ plugin: 'repo-context', key: 'spot' } as const, null as RepoSpot | null)
const titled = atom({ plugin: 'repo-context', key: 'titled' } as const, false)

const pathIn = (command: string, pattern: RegExp) => {
  const found = pattern.exec(command)
  return found === null ? undefined : (found[1] ?? found[2] ?? found[3])
}

const resolve = (path: string, base: string, home: string | undefined) => {
  if (home !== undefined && (path === '~' || path.startsWith('~/'))) return home + path.slice(1)
  if (path.startsWith('/')) return path
  return `${base.replace(/\/+$/, '')}/${path}`
}

const probe = async ($: EngineInterface, dir: string) => {
  const head = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 })
  if (head.exitCode !== 0) return undefined
  const [top = '', branch = ''] = head.stdout.trim().split('\n')
  const repo = top.split('/').filter(Boolean).at(-1)
  if (repo === undefined || branch === '') return undefined
  if (branch !== 'HEAD') return `${repo}:${branch}`
  const sha = await $.process.run(['git', '-C', dir, 'rev-parse', '--short', 'HEAD'], { timeoutMs: 5000 })
  return `${repo}:detached@${sha.stdout.trim()}`
}

const follow = async ($: EngineInterface, command: string, before: string) => {
  const home = await $.env.get('HOME')
  const named = pathIn(command, GIT_DASH_C) ?? pathIn(command, LEADING_CD)
  const dir = named === undefined ? await $.session.cwd() : resolve(named, before, home)
  const now = await $.clock.now()
  const last = await read($, spot)
  const isFresh = last !== null && last.dir === dir && now - last.at < FRESH_MS
  if (isFresh && !MAY_MOVE_BRANCH.test(command)) return
  const label = await probe($, dir)
  if (label === undefined) return
  await update($, spot, () => ({ dir, label, at: now }))
  if (last?.label !== label) $.ui.status(label)
}

const fallbackTitle = (prompt: string) =>
  prompt
    .replace(NOISE, ' ')
    .replace(/[^\p{L}\p{N}\s/#.:_-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(' ')

const cleanTitle = (text: string) =>
  (text.trim().split('\n')[0] ?? '')
    .replace(/^[\s"'`*#]+|[\s"'`*.!?]+$/g, '')
    .split(/\s+/)
    .slice(0, 6)
    .join(' ')
    .slice(0, 60)

const nameSession = async ($: EngineInterface, prompt: string) => {
  const reply = await $.model.complete({
    model: 'haiku',
    system: 'You name coding sessions. Reply with a 3 to 6 word title in plain words and nothing else: no quotes, no trailing punctuation.',
    prompt: `Name the session that starts with this request:\n\n${prompt.slice(0, 2000)}`,
    maxTokens: 30,
    effort: 'low',
    timeoutMs: 6000,
  })
  if (!reply.isAnswered) return undefined
  const title = cleanTitle(reply.text)
  return title === '' ? undefined : title
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const last = await read($, spot)
    if (last !== null) $.ui.status(last.label)
    return started
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const before = await $.session.cwd()
    const ran = await next(e)
    try {
      await follow($, e.command, before)
    } catch {}
    return ran
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    const isTyped = e.agent_id === undefined && (e.source === undefined || e.source === 'user')
    if (!isTyped || e.session_title || result.sessionTitle || (await read($, titled))) return result
    const prompt = e.prompt.trim()
    const words = fallbackTitle(prompt)
    if (prompt.startsWith('/') || SHORT_REPLY.test(prompt) || words.split(' ').length < 3) return result
    await update($, titled, () => true)
    return { ...result, sessionTitle: (await nameSession($, prompt)) ?? words }
  })
}
