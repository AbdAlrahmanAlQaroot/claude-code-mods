const HEREDOC = /<<-?[ \t]*(['"]?)([A-Za-z_][\w.-]*)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g

const HEREDOC_BODY = /([^\n]*)<<-?[ \t]*(['"]?)([A-Za-z_][\w.-]*)\2([^\n]*)\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\n|$)/g

const WRAPPERS = new Set(['sudo', 'command', 'time', 'nohup', 'env', 'exec', 'xargs'])

export type Heredoc = { opener: string; body: string; index: number }

export function resolvePath(base: string, path: string, home: string): string {
  const absolute =
    path === '~' ? home
    : path.startsWith('~/') ? home + path.slice(1)
    : path.startsWith('/') ? path
    : `${base}/${path}`
  const parts: string[] = []
  for (const part of absolute.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

export function tokenize(command: string): string[][] {
  const text = command.replace(HEREDOC, (_all, _quote, tag: string, rest: string) => `<<${tag}${rest}`)
  const segments: string[][] = []
  let current: string[] = []
  let word = ''
  let hasWord = false
  let quote: string | null = null
  const endWord = () => {
    if (hasWord) current.push(word)
    word = ''
    hasWord = false
  }
  const endSegment = () => {
    endWord()
    if (current.length > 0) segments.push(dropRedirects(current))
    current = []
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote !== null) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < text.length) word += text[++i]
      else word += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      hasWord = true
    } else if (c === '\\' && i + 1 < text.length) {
      word += text[++i]
      hasWord = true
    } else if (c === '&' && (word.endsWith('>') || word.endsWith('<'))) {
      word += c
    } else if (c === '&' && text[i + 1] === '>') {
      endWord()
      word = '&'
      hasWord = true
    } else if (c === '&' || c === '|') {
      if (text[i + 1] === c) i++
      endSegment()
    } else if (c === '\n' || c === ';' || c === '(' || c === ')' || c === '`') {
      endSegment()
    } else if (c === ' ' || c === '\t') {
      endWord()
    } else {
      word += c
      hasWord = true
    }
  }
  endSegment()
  return segments
}

function dropRedirects(tokens: string[]): string[] {
  const kept: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? ''
    if (/^(\d*|&)?(>>?|<<?)/.test(token)) {
      if (/^(\d*|&)?(>>?|<<?)&?$/.test(token)) i++
      continue
    }
    kept.push(token)
  }
  return kept
}

export function words(tokens: readonly string[]): string[] {
  let i = 0
  while (i < tokens.length && (WRAPPERS.has(tokens[i] ?? '') || /^[A-Za-z_]\w*=/.test(tokens[i] ?? ''))) i++
  return tokens.slice(i)
}

export function heredocs(raw: string): Heredoc[] {
  return [...raw.matchAll(HEREDOC_BODY)].map(match => ({
    opener: `${match[1] ?? ''}${match[4] ?? ''}`,
    body: match[5] ?? '',
    index: match.index ?? 0,
  }))
}

export function optionValue(args: readonly string[], names: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    for (const name of names) {
      if (arg === name) return args[i + 1]
      if (name.startsWith('--') && arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
    }
  }
  return undefined
}

export function program(token: string | undefined): string {
  return (token ?? '').split('/').at(-1) ?? ''
}
