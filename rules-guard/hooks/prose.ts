import { block, clip } from './block'

const MAX_LINES = 20

const MAX_PROSE_WORDS = 15

const STRUCTURED = /^([-*+]\s|\d+[.)]\s|#{1,6}\s|https?:\/\/\S+$|([\w.-]+\/[\w.-]+)?#\d+\b|<!--|\|)/

export function proseVerdict(body: string): string | undefined {
  const lines: string[] = []
  let inFence = false
  for (const raw of body.replaceAll('\\n', '\n').split('\n')) {
    const line = raw.trim()
    if (line.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence || line.length === 0) continue
    lines.push(line)
  }
  if (lines.length > MAX_LINES) {
    return block({
      rule: 'pr-format',
      category: 'fix-and-retry',
      problem: `this PR description has ${lines.length} lines; the limit is ${MAX_LINES} (user rule: short and to the point).`,
      fix: `cut it to ${MAX_LINES} or fewer short "- " bullets saying what changed and why, then retry.`,
    })
  }
  const prose = lines.filter(line => !STRUCTURED.test(line) && line.split(/\s+/).length > MAX_PROSE_WORDS)
  if (prose.length > 0) {
    return block({
      rule: 'pr-format',
      category: 'fix-and-retry',
      problem: 'PR descriptions are short bullet points only, no prose paragraphs (user rule).',
      where: prose.map(line => `"${clip(line, 100)}"`),
      fix: `turn ${prose.length === 1 ? 'that line' : `each of those ${prose.length} lines`} into a short "- " bullet or cut it, then retry.`,
    })
  }
  return undefined
}
