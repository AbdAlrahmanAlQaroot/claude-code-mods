type Family = 'slash' | 'hash' | 'dash'

const FAMILIES: Record<string, Family> = {
  kt: 'slash', kts: 'slash', java: 'slash', ts: 'slash', tsx: 'slash', js: 'slash', jsx: 'slash', mjs: 'slash',
  cjs: 'slash', go: 'slash', rs: 'slash', swift: 'slash', gradle: 'slash',
  py: 'hash', sh: 'hash',
  sql: 'dash',
}

const DIRECTIVE =
  /^\/\/\/\s*<reference|@ts-|eslint-|prettier-|oxlint-|biome-ignore|noqa|type:\s*ignore|pragma|ktlint-disable|detekt|@formatter:|noinspection|istanbul|c8 ignore|go:(build|generate|embed)|swiftlint:|fmt:|pylint:|mypy:|-\*-\s*coding|^#!|^--\s*(liquibase|changeset|rollback|precondition|validchecksum|comment:|property|include)/i

const STRINGS = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g

export function familyOf(path: string): Family | undefined {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase()
  return extension === undefined ? undefined : FAMILIES[extension]
}

function trailingSlash(line: string): boolean {
  return /\s\/\/(\s|$)/.test(line.replace(STRINGS, '""'))
}

export type Comment = { line: number; text: string }

export function addedComments(path: string, text: string, before: string | undefined, isRepoCode: boolean): Comment[] {
  if (!isRepoCode || path.includes('/.claude/')) return []
  const family = familyOf(path)
  if (family === undefined) return []
  const kept = new Set((before ?? '').split('\n').map(line => line.trim()).filter(line => line.length > 0))
  const found: Comment[] = []
  let inBlock = false
  let blockShown = false
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim()
    if (line.length === 0) continue
    const added = !DIRECTIVE.test(line) && !kept.has(line)
    if (inBlock) {
      if (line.includes('*/')) inBlock = false
      if (added && !blockShown) found.push({ line: index + 1, text: line })
      blockShown ||= added
      continue
    }
    let isComment: boolean
    if (family !== 'hash' && (line.startsWith('/*') || line.startsWith('{/*'))) {
      isComment = true
      inBlock = !line.includes('*/')
      blockShown = added
    } else if (family === 'slash') {
      isComment = line.startsWith('//') || trailingSlash(line)
    } else if (family === 'hash') {
      isComment = line.startsWith('#') && !line.startsWith('#!')
    } else {
      isComment = line.startsWith('--')
    }
    if (isComment && added) found.push({ line: index + 1, text: line })
  }
  return found
}
