import { block } from './block'

export type GitAdd = { dir: string; args: string[] }

export type CommitScope = { all: boolean; paths: string[] }

export type CommitFiles = { root: string; paths: string[] }

const TEST_DIR = /(^|\/)(src\/(test|androidTest|testFixtures|integrationTest)\/|__tests__\/|__mocks__\/|tests?\/|e2e\/|cypress\/|playwright\/)/

const TEST_NAME = /\.(test|spec|e2e)\.[cm]?[jt]sx?$|Tests?\.(kt|kts|java)$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/

const COMMIT_VALUE = new Set([
  '--message', '--file', '--reuse-message', '--reedit-message', '--template', '--author', '--date', '--fixup', '--squash', '--trailer', '--cleanup',
])

const MAX_LISTED = 10

export function isTestPath(path: string): boolean {
  return TEST_DIR.test(path) || (TEST_NAME.test(path) && !/(^|\/)src\/main\//.test(path))
}

export function commitScope(args: readonly string[]): CommitScope {
  let all = false
  let rest = false
  const paths: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (rest) {
      paths.push(arg)
    } else if (arg === '--') {
      rest = true
    } else if (arg === '--all') {
      all = true
    } else if (arg.startsWith('--')) {
      if (COMMIT_VALUE.has(arg)) i++
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j] ?? ''
        if (flag === 'a') all = true
        if ('mFCct'.includes(flag)) {
          if (j === arg.length - 1) i++
          break
        }
      }
    } else {
      paths.push(arg)
    }
  }
  return { all, paths }
}

export function testFilesVerdict(files: CommitFiles | undefined): string | undefined {
  const tests = (files?.paths ?? []).filter(isTestPath)
  if (files === undefined || tests.length === 0) return undefined
  const where = tests.slice(0, MAX_LISTED)
  if (tests.length > MAX_LISTED) where.push(`and ${tests.length - MAX_LISTED} more`)
  return block({
    rule: 'test-files',
    category: 'fix-and-retry',
    problem: `this commit in ${files.root} would include test files; tests stay local and never go into any repo (user rule).`,
    where,
    fix: 'leave them out: stage only the files you mean (git add <paths>, not -A or .), or unstage them with git restore --staged <file>. Keep the tests untracked or outside the repo, then commit again.',
    ask: 'when a test file really has to be committed (for example a reviewer requires coverage); that is decided case by case.',
  })
}
