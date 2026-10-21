export type Category = 'fix-and-retry' | 'use-instead' | 'needs-user' | 'env-setup' | 'held'

export type Block = {
  rule: string
  category: Category
  problem: string
  where?: string | readonly string[]
  fix: string | readonly string[]
  ask?: string
}

export function block({ rule, category, problem, where, fix, ask }: Block): string {
  const lines = [`rules-guard · ${rule} · ${category}`, `Problem: ${problem}`]
  if (typeof where === 'string') lines.push(`Where: ${where}`)
  else if (where !== undefined && where.length === 1) lines.push(`Where: ${where[0] ?? ''}`)
  else if (where !== undefined && where.length > 1) lines.push('Where:', ...where.map(item => `- ${item}`))
  const [first = '', ...rest] = typeof fix === 'string' ? [fix] : fix
  lines.push(`Fix: ${first}`, ...rest)
  if (ask !== undefined) lines.push(`Ask the user: ${ask}`)
  return lines.join('\n')
}

export function clip(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function tilde(path: string, home: string): string {
  return home !== '' && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
}

export function heldBlock(where: string): string {
  return block({
    rule: 'guard-error',
    category: 'held',
    problem: 'rules-guard failed while checking this, so it was held.',
    where: clip(where),
    fix: 'retry once.',
    ask: 'when it is held a second time.',
  })
}
