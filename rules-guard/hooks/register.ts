import type { EngineInterface, Register } from 'claude-code'

import { heldBlock } from './block'
import { familyOf } from './comments'
import type { CommitFiles } from './testfiles'
import { bashVerdict, fileVerdict, isChangelogFile, isSlackSend, looksRisky, slackBlock } from './rules'
import type { Io, Rules } from './rules'

const CONTEXT_FRESH_MS = 30_000

const INTERACTIVE_ADD = new Set(['-p', '-i', '-e', '--patch', '--interactive', '--edit'])

const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean)

let contextCache: { value: string | undefined; at: number } | undefined

const repoCache = new Map<string, boolean>()

type EnvChecks = { vpnProcess: string; awsSso: boolean }

let envChecks: EnvChecks = { vpnProcess: '', awsSso: false }

async function hostIo($: EngineInterface): Promise<Io> {
  const home = (await $.env.get('HOME')) ?? ''
  const cwd = await $.session.cwd()
  return {
    home,
    cwd,
    read: async path => {
      try {
        return await $.fs.read(path)
      } catch {
        return undefined
      }
    },
    branch: async dir => {
      try {
        const { exitCode, stdout } = await $.process.run(['git', '-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 })
        return exitCode === 0 ? stdout.trim() : undefined
      } catch {
        return undefined
      }
    },
    commitFiles: async (dir, adds, scope) => {
      try {
        const toplevel = async (at: string) => {
          const { exitCode, stdout } = await $.process.run(['git', '-C', at, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })
          return exitCode === 0 ? stdout.trim() : undefined
        }
        const root = await toplevel(dir)
        if (root === undefined) return undefined
        const paths = new Set<string>()
        const staged = await $.process.run(['git', '-C', root, 'diff', '--cached', '--name-only', '--diff-filter=ACMR'], { timeoutMs: 5000 })
        for (const path of lines(staged.stdout)) paths.add(path)
        for (const add of adds) {
          if ((await toplevel(add.dir)) !== root) continue
          const named = add.args.filter(arg => !arg.startsWith('-'))
          if (add.args.some(arg => INTERACTIVE_ADD.has(arg))) {
            for (const path of named) paths.add(path)
            continue
          }
          const dry = await $.process.run(['git', '-C', add.dir, 'add', '--dry-run', ...add.args], { timeoutMs: 10_000 })
          const added = dry.exitCode === 0 ? lines(dry.stdout).map(line => /^add '(.*)'$/.exec(line)?.[1]).filter(path => path !== undefined) : named
          for (const path of added) paths.add(path)
        }
        if (scope.all) {
          const tracked = await $.process.run(['git', '-C', root, 'diff', '--name-only', '--diff-filter=ACMR'], { timeoutMs: 5000 })
          for (const path of lines(tracked.stdout)) paths.add(path)
        }
        if (scope.paths.length > 0) {
          const named = await $.process.run(['git', '-C', dir, 'diff', 'HEAD', '--name-only', '--diff-filter=ACMR', '--', ...scope.paths], { timeoutMs: 5000 })
          for (const path of lines(named.stdout)) paths.add(path)
        }
        const files: CommitFiles = { root, paths: [...paths] }
        return files
      } catch {
        return undefined
      }
    },
    vpnUp: async () => {
      if (envChecks.vpnProcess === '') return true
      try {
        const { exitCode } = await $.process.run(['pgrep', '-x', envChecks.vpnProcess], { timeoutMs: 3000 })
        return exitCode === 0
      } catch {
        return true
      }
    },
    kubeContext: async () => {
      const now = await $.clock.now()
      if (contextCache !== undefined && now - contextCache.at < CONTEXT_FRESH_MS) return contextCache.value
      try {
        const { exitCode, stdout } = await $.process.run(['kubectl', 'config', 'current-context'], { timeoutMs: 3000 })
        contextCache = { value: exitCode === 0 ? stdout.trim() : undefined, at: now }
      } catch {
        contextCache = { value: undefined, at: now }
      }
      return contextCache.value
    },
    ssoAgeMs: async () => {
      if (!envChecks.awsSso) return 0
      const folder = `${home}/.aws/sso/cache`
      const entries = await $.fs.list(folder).catch(() => [])
      let newest: number | undefined
      for (const entry of entries) {
        if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
        const token = parseToken(await $.fs.read(`${folder}/${entry.name}`).catch(() => ''))
        const expiresAt = token === undefined ? Number.NaN : Date.parse(token)
        if (Number.isFinite(expiresAt) && (newest === undefined || expiresAt > newest)) newest = expiresAt
      }
      return newest === undefined ? undefined : (await $.clock.now()) - newest
    },
  }
}

function parseToken(text: string): string | undefined {
  try {
    const token = JSON.parse(text) as { accessToken?: unknown; expiresAt?: unknown }
    return typeof token.accessToken === 'string' && typeof token.expiresAt === 'string' ? token.expiresAt : undefined
  } catch {
    return undefined
  }
}

async function insideRepo($: EngineInterface, path: string): Promise<boolean> {
  if (familyOf(path) === undefined) return false
  let dir = path.slice(0, path.lastIndexOf('/')) || '/'
  const known = repoCache.get(dir)
  if (known !== undefined) return known
  const asked = dir
  try {
    while (dir !== '/' && !(await $.fs.exists(dir))) dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
    const { exitCode, stdout } = await $.process.run(['git', '-C', dir, 'rev-parse', '--is-inside-work-tree'], { timeoutMs: 3000 })
    const isInside = exitCode === 0 && stdout.trim() === 'true'
    repoCache.set(asked, isInside)
    return isInside
  } catch {
    return false
  }
}

async function existing($: EngineInterface, path: string): Promise<string | undefined> {
  if (familyOf(path) === undefined) return undefined
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

export const register: Register = (on, options) => {
  const rules: Rules = {
    protectedBranches: String(options.protectedBranches ?? 'main,master')
      .split(',')
      .map(name => name.trim())
      .filter(name => name.length > 0),
    author: String(options.liquibaseAuthor ?? '').trim(),
    noCodeComments: options.noCodeComments === true,
    noTestFiles: options.noTestFiles === true,
    prBulletsOnly: options.prBulletsOnly === true,
    noTestPlan: options.noTestPlan === true,
    noAiAttribution: options.noAiAttribution === true,
  }
  const noSlackSend = options.noSlackSend === true
  envChecks = {
    vpnProcess: String(options.vpnProcess ?? '').trim(),
    awsSso: options.awsSsoCheck === true,
  }

  if (noSlackSend) {
    on('tool.call', ($, e, next) => (isSlackSend(String(e.tool)) ? { deny: slackBlock(String(e.tool)) } : next(e))).catch(($, e, next) =>
      next.called ? next(e) : isSlackSend(String(e.tool)) ? { deny: slackBlock(String(e.tool)) } : next(e),
    )
  }

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await bashVerdict(e.command, rules, await hostIo($))
    return verdict ? { deny: verdict } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : looksRisky(e.command) ? { deny: heldBlock(e.command) } : next(e)))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const before = await existing($, e.file_path)
    const verdict = fileVerdict(e.file_path, e.content, rules, { before, isRepoCode: rules.noCodeComments && (await insideRepo($, e.file_path)), startLine: 1 })
    return verdict ? { deny: verdict } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : rules.author !== '' && isChangelogFile(e.file_path) ? { deny: heldBlock(e.file_path) } : next(e)))

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const current = await existing($, e.file_path)
    const at = current === undefined ? -1 : current.indexOf(e.old_string)
    const startLine = current === undefined || at < 0 ? undefined : current.slice(0, at).split('\n').length
    const verdict = fileVerdict(e.file_path, e.new_string, rules, { before: e.old_string, isRepoCode: rules.noCodeComments && (await insideRepo($, e.file_path)), startLine })
    return verdict ? { deny: verdict } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : rules.author !== '' && isChangelogFile(e.file_path) ? { deny: heldBlock(e.file_path) } : next(e)))
}
