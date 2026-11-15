// A small syntax colourer for the diff view: one pass per line, with what a
// line leaves open (a block comment, a template string) carried to the next.
// Good enough to read a diff by, not a parser.

export type TokenKind =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'function'
  | 'type'
  | 'property'
  | 'constant'
  | 'tag'
  | 'heading'

export type Token = { text: string; kind: TokenKind }

/** What a line leaves open for the next one. */
export type SyntaxState = { open?: 'comment' | 'template' | 'markup-comment' }

// Mid-tone colours, legible on a light and on a dark background alike.
export const TOKEN_COLORS: Record<TokenKind, string | undefined> = {
  plain: undefined,
  keyword: '#a855f7',
  string: '#16a34a',
  number: '#ea580c',
  comment: '#8b949e',
  function: '#3b82f6',
  type: '#d97706',
  property: '#0891b2',
  constant: '#e11d48',
  tag: '#dc2626',
  heading: '#a855f7',
}

type Language = {
  name: string
  lineComment?: string[]
  blockComment?: boolean
  markupComment?: boolean
  quotes: string
  keywords: Set<string>
  constants: Set<string>
  caseInsensitive?: boolean
  hasTags?: boolean
  pascalTypes?: boolean
  keysBeforeColon?: boolean
  dashedWords?: boolean
}

const words = (list: string) => new Set(list.split(' '))

const JS_KEYWORDS = words(
  'const let var function return if else for while do switch case break continue new class extends import export from default as async await try catch finally throw typeof instanceof in of void delete yield type interface enum implements private public protected readonly static declare namespace keyof satisfies get set this super',
)
const JS_CONSTANTS = words('true false null undefined NaN Infinity')

const LANGUAGES: Record<string, Language> = {
  js: {
    name: 'js',
    lineComment: ['//'],
    blockComment: true,
    quotes: `'"\``,
    keywords: JS_KEYWORDS,
    constants: JS_CONSTANTS,
    hasTags: true,
    pascalTypes: true,
  },
  json: {
    name: 'json',
    quotes: '"',
    keywords: new Set(),
    constants: words('true false null'),
    keysBeforeColon: true,
  },
  css: {
    name: 'css',
    blockComment: true,
    dashedWords: true,
    quotes: `'"`,
    keywords: words('important'),
    constants: new Set(),
    keysBeforeColon: true,
  },
  sql: {
    name: 'sql',
    lineComment: ['--'],
    blockComment: true,
    quotes: `'"`,
    keywords: words(
      'select from where insert into update set delete create table alter add column index on join left right inner outer full cross group by order having limit offset as and or not is in values returning primary key foreign references default unique constraint drop if exists cascade begin commit rollback with case when then else end distinct union all type enum varchar text integer boolean timestamp timestamptz uuid jsonb serial bigint',
    ),
    constants: words('null true false'),
    caseInsensitive: true,
  },
  shell: {
    name: 'shell',
    lineComment: ['#'],
    dashedWords: true,
    quotes: `'"`,
    keywords: words(
      'if then else elif fi for do done while until function return export echo local in case esac set unset source param foreach',
    ),
    constants: words('true false $true $false $null'),
  },
  python: {
    name: 'python',
    lineComment: ['#'],
    quotes: `'"`,
    keywords: words(
      'def class return if elif else for while import from as with try except finally raise lambda pass yield and or not in is async await global nonlocal del assert break continue',
    ),
    constants: words('None True False'),
    pascalTypes: true,
  },
  yaml: {
    name: 'yaml',
    lineComment: ['#'],
    dashedWords: true,
    quotes: `'"`,
    keywords: new Set(),
    constants: words('true false null yes no on off'),
    keysBeforeColon: true,
  },
  html: {
    name: 'html',
    markupComment: true,
    dashedWords: true,
    quotes: `'"`,
    keywords: new Set(),
    constants: new Set(),
    hasTags: true,
  },
  plain: { name: 'plain', quotes: '', keywords: new Set(), constants: new Set() },
}

const BY_EXTENSION: Record<string, string> = {
  ts: 'js',
  tsx: 'js',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  mts: 'js',
  cts: 'js',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'css',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  ps1: 'shell',
  py: 'python',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'yaml',
  html: 'html',
  xml: 'html',
  svg: 'html',
  md: 'markdown',
  mdx: 'markdown',
}

/** The language a path is coloured as, by its extension. */
export function languageOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (name === 'dockerfile' || name.startsWith('.env')) return 'shell'
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''

  return BY_EXTENSION[extension] ?? 'plain'
}

const isWordStart = (char: string) => /[A-Za-z_$@]/.test(char)
const WORD = /^[A-Za-z_$@][\w$]*/
/** A name with dashes in it (`font-size`, `my-key`), where the language has them. */
const DASHED_WORD = /^[A-Za-z_$@][\w$-]*/
const NUMBER = /^(0x[\da-fA-F]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?[a-zA-Z%]*|#[\da-fA-F]{3,8}\b)/

function push(tokens: Token[], text: string, kind: TokenKind) {
  if (text === '') return
  const last = tokens[tokens.length - 1]
  if (last !== undefined && last.kind === kind) last.text += text
  else tokens.push({ text, kind })
}

/** Reads a quoted string from `start` (on its quote); returns where it ends. */
function stringEnd(line: string, start: number, quote: string): number {
  for (let i = start + 1; i < line.length; i++) {
    if (line[i] === '\\') i++
    else if (line[i] === quote) return i + 1
  }

  return -1
}

function codeLine(line: string, language: Language, state: SyntaxState): { tokens: Token[]; state: SyntaxState } {
  const tokens: Token[] = []
  let i = 0

  // What the previous line left open.
  if (state.open === 'comment' || state.open === 'markup-comment') {
    const close = state.open === 'comment' ? '*/' : '-->'
    const end = line.indexOf(close)
    if (end === -1) return { tokens: [{ text: line, kind: 'comment' }], state }
    push(tokens, line.slice(0, end + close.length), 'comment')
    i = end + close.length
  } else if (state.open === 'template') {
    const end = stringEnd(`\`${line}`, 0, '`')
    if (end === -1) return { tokens: [{ text: line, kind: 'string' }], state }
    push(tokens, line.slice(0, end - 1), 'string')
    i = end - 1
  }

  let isInTag = false
  while (i < line.length) {
    const rest = line.slice(i)
    const char = line[i] ?? ''

    if (language.lineComment?.some(mark => rest.startsWith(mark)) && (char !== '#' || i === 0 || /\s/.test(line[i - 1] ?? ''))) {
      push(tokens, rest, 'comment')
      return { tokens, state: {} }
    }
    if (language.blockComment && rest.startsWith('/*')) {
      const end = line.indexOf('*/', i + 2)
      if (end === -1) {
        push(tokens, rest, 'comment')
        return { tokens, state: { open: 'comment' } }
      }
      push(tokens, line.slice(i, end + 2), 'comment')
      i = end + 2
      continue
    }
    if (language.markupComment && rest.startsWith('<!--')) {
      const end = line.indexOf('-->', i + 4)
      if (end === -1) {
        push(tokens, rest, 'comment')
        return { tokens, state: { open: 'markup-comment' } }
      }
      push(tokens, line.slice(i, end + 3), 'comment')
      i = end + 3
      continue
    }
    if (language.quotes.includes(char) && char !== '') {
      const end = stringEnd(line, i, char)
      if (end === -1) {
        push(tokens, rest, 'string')
        return { tokens, state: char === '`' ? { open: 'template' } : {} }
      }
      const text = line.slice(i, end)
      const isKey = language.keysBeforeColon === true && /^\s*:/.test(line.slice(end))
      push(tokens, text, isKey ? 'property' : 'string')
      i = end
      continue
    }
    if (language.hasTags && char === '<' && /^<\/?[A-Za-z]/.test(rest)) {
      const name = /^<\/?([A-Za-z][\w.:-]*)/.exec(rest)
      push(tokens, rest.startsWith('</') ? '</' : '<', 'plain')
      push(tokens, name?.[1] ?? '', 'tag')
      i += (rest.startsWith('</') ? 2 : 1) + (name?.[1]?.length ?? 0)
      isInTag = true
      continue
    }
    if (isInTag && char === '>') isInTag = false
    const number = /\w/.test(line[i - 1] ?? '') ? null : NUMBER.exec(rest)
    if (number !== null) {
      push(tokens, number[0], 'number')
      i += number[0].length
      continue
    }
    if (isWordStart(char)) {
      const word = (language.dashedWords ? DASHED_WORD : WORD).exec(rest)?.[0] ?? char
      const key = language.caseInsensitive ? word.toLowerCase() : word
      const after = line.slice(i + word.length)
      let kind: TokenKind = 'plain'
      if (language.keywords.has(key)) kind = 'keyword'
      else if (language.constants.has(key)) kind = 'constant'
      else if (isInTag) kind = 'property'
      else if (/^\s*\(/.test(after)) kind = 'function'
      else if (line[i - 1] === '.' && language.name === 'js') kind = 'property'
      else if (language.keysBeforeColon && /^\s*:/.test(after)) kind = 'property'
      else if (language.name === 'js' && /^\s*\??:/.test(after) && /^\s*$/.test(line.slice(0, i))) kind = 'property'
      else if (language.pascalTypes && /^[A-Z][a-z]/.test(word)) kind = 'type'
      push(tokens, word, kind)
      i += word.length
      continue
    }
    push(tokens, char, 'plain')
    i++
  }

  return { tokens, state: {} }
}

function markdownLine(line: string, state: SyntaxState): { tokens: Token[]; state: SyntaxState } {
  if (/^\s*```/.test(line) || /^#{1,6}\s/.test(line)) return { tokens: [{ text: line, kind: 'heading' }], state }
  const tokens: Token[] = []
  const bullet = /^(\s*)([-*+]|\d+\.)(\s)/.exec(line)
  let rest = line
  if (bullet !== null) {
    push(tokens, bullet[1] ?? '', 'plain')
    push(tokens, bullet[2] ?? '', 'keyword')
    rest = line.slice((bullet[1]?.length ?? 0) + (bullet[2]?.length ?? 0))
  } else if (/^\s*>/.test(line)) {
    return { tokens: [{ text: line, kind: 'comment' }], state }
  }
  // Inline code, links and bold text, in the order they come.
  const inline = /(`[^`]+`)|(\[[^\]]*\]\([^)]*\))|(\*\*[^*]+\*\*)/g
  let at = 0
  for (const match of rest.matchAll(inline)) {
    push(tokens, rest.slice(at, match.index), 'plain')
    push(tokens, match[0], match[1] ? 'string' : match[2] ? 'function' : 'keyword')
    at = (match.index ?? 0) + match[0].length
  }
  push(tokens, rest.slice(at), 'plain')

  return { tokens, state }
}

/** Colours one line in `language`, given what the line before left open. */
export function highlightLine(
  line: string,
  language: string,
  state: SyntaxState = {},
): { tokens: Token[]; state: SyntaxState } {
  if (line === '') return { tokens: [], state }
  if (language === 'markdown') return markdownLine(line, state)
  const spec = LANGUAGES[language] ?? LANGUAGES.plain
  if (spec === undefined || spec.name === 'plain') return { tokens: [{ text: line, kind: 'plain' }], state: {} }

  return codeLine(line, spec, state)
}

/**
 * Cuts the tokens of a line where its changed part starts and ends, so each
 * piece keeps its colour and knows whether it lies in the change.
 */
export function splitAt(
  tokens: readonly Token[],
  change: { start: number; end: number } | undefined,
): (Token & { isChanged: boolean })[] {
  const pieces: (Token & { isChanged: boolean })[] = []
  let offset = 0
  for (const token of tokens) {
    const end = offset + token.text.length
    const cuts = [offset, end]
    if (change !== undefined) {
      if (change.start > offset && change.start < end) cuts.push(change.start)
      if (change.end > offset && change.end < end) cuts.push(change.end)
    }
    cuts.sort((a, b) => a - b)
    for (let k = 0; k < cuts.length - 1; k++) {
      const from = cuts[k] ?? 0
      const to = cuts[k + 1] ?? 0
      if (to <= from) continue
      pieces.push({
        text: token.text.slice(from - offset, to - offset),
        kind: token.kind,
        isChanged: change !== undefined && from >= change.start && to <= change.end,
      })
    }
    offset = end
  }

  return pieces
}
