import type { FileChange, GitRef, GraphCommit } from '../types'

// Pure part of the mod: reading git's output, laying the commits out in lanes,
// and drawing one row's slice of the graph as an SVG document.

const FIELD = '\x1f'
const RECORD = '\x1e'

/** Hash, parents, decorations, subject, author, author date. */
export const LOG_FORMAT = '%H%x1f%P%x1f%D%x1f%s%x1f%an%x1f%aI%x1e'

const KIND_ORDER: Record<GitRef['kind'], number> = {
  head: 0,
  local: 1,
  tag: 2,
  remote: 3,
}

/** Reads `%D` as printed under `--decorate=full`. */
export function parseRefs(decoration: string): GitRef[] {
  const refs: GitRef[] = []
  for (const raw of decoration.split(', ')) {
    const item = raw.trim()
    if (item === '') continue
    if (item.startsWith('HEAD -> ')) {
      refs.push({ name: item.slice(8).replace(/^refs\/heads\//, ''), kind: 'head' })
    } else if (item === 'HEAD') {
      refs.push({ name: 'HEAD', kind: 'head' })
    } else if (item.startsWith('tag: ')) {
      refs.push({ name: item.slice(5).replace(/^refs\/tags\//, ''), kind: 'tag' })
    } else if (item.startsWith('refs/heads/')) {
      refs.push({ name: item.slice(11), kind: 'local' })
    } else if (item.startsWith('refs/remotes/')) {
      const name = item.slice(13)
      if (!name.endsWith('/HEAD')) refs.push({ name, kind: 'remote' })
    }
  }

  // A remote branch on the same commit as its local twin folds into it.
  const locals = new Set(
    refs.filter(ref => ref.kind === 'head' || ref.kind === 'local').map(ref => ref.name),
  )
  const folded = new Set<string>()
  const kept = refs.filter(ref => {
    if (ref.kind !== 'remote') return true
    const short = ref.name.slice(ref.name.indexOf('/') + 1)
    if (!locals.has(short)) return true
    folded.add(short)

    return false
  })

  return kept
    .map(ref =>
      (ref.kind === 'head' || ref.kind === 'local') && folded.has(ref.name)
        ? { ...ref, hasRemote: true }
        : ref,
    )
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
}

export function parseLog(stdout: string): GraphCommit[] {
  const commits: GraphCommit[] = []
  for (const record of stdout.split(RECORD)) {
    const line = record.replace(/^\s+/, '')
    if (line === '') continue
    const [hash = '', parents = '', decoration = '', subject = '', author = '', date = ''] =
      line.split(FIELD)
    if (hash === '') continue
    commits.push({
      hash,
      parents: parents.split(' ').filter(Boolean),
      refs: parseRefs(decoration),
      subject,
      author,
      date: date.trim(),
    })
  }

  return commits
}

const tokens = (stdout: string) => {
  const list = stdout.replace(/^\s+/, '').split('\0')
  if (list[list.length - 1] === '') list.pop()

  return list
}

/**
 * Joins `git show --name-status -z` and `git show --numstat -z` of one commit
 * into one list, in git's order. A binary file has no line counts.
 */
export function parseFiles(nameStatus: string, numstat: string): FileChange[] {
  const counts = new Map<string, { added: number | null; deleted: number | null }>()
  const stats = tokens(numstat)
  for (let i = 0; i < stats.length; ) {
    const [added = '-', deleted = '-', path = ''] = (stats[i] ?? '').split('\t')
    const count = {
      added: added === '-' ? null : Number(added),
      deleted: deleted === '-' ? null : Number(deleted),
    }
    if (path === '') {
      // A rename: the old and the new path follow as tokens of their own.
      counts.set(stats[i + 2] ?? '', count)
      i += 3
    } else {
      counts.set(path, count)
      i += 1
    }
  }

  const files: FileChange[] = []
  const names = tokens(nameStatus)
  for (let i = 0; i < names.length; ) {
    const status = names[i] ?? ''
    const isMove = status.startsWith('R') || status.startsWith('C')
    const path = (isMove ? names[i + 2] : names[i + 1]) ?? ''
    const count = counts.get(path) ?? { added: null, deleted: null }
    files.push({
      status: status.charAt(0),
      path,
      ...(isMove ? { oldPath: names[i + 1] ?? '' } : {}),
      ...count,
    })
    i += isMove ? 3 : 2
  }

  return files
}

/**
 * The GitHub page of a repository from its remote's URL (https or ssh), or ""
 * when the remote is not on github.com.
 */
export function githubUrl(remote: string): string {
  const match =
    /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
      remote.trim(),
    )

  return match === null ? '' : `https://github.com/${match[1]}/${match[2]}`
}

/** The pull request a merge commit's subject names ("Merge pull request #514 from …"). */
export function pullRequestOf(subject: string): number | undefined {
  const match = /^Merge pull request #(\d+)\b/.exec(subject)

  return match === null ? undefined : Number(match[1])
}

/** Every `#N` a commit's message mentions, in order, once each, its own pull request left out. */
export function issuesOf(message: string, pullRequest?: number): number[] {
  const seen = new Set<number>()
  for (const match of message.matchAll(/(?:^|[\s([,;])#(\d+)\b/g)) {
    const number = Number(match[1])
    if (number !== pullRequest) seen.add(number)
  }

  return [...seen]
}

/** How many paths `git status --porcelain=v1 -z` lists, a rename's former path not counted twice. */
export function countStatus(porcelain: string): number {
  const entries = porcelain.split('\0').filter(Boolean)
  let count = 0
  for (let i = 0; i < entries.length; i++) {
    const code = entries[i]?.slice(0, 2) ?? ''
    count++
    if (code.includes('R') || code.includes('C')) i++
  }

  return count
}

/** The files `git ls-files --others --exclude-standard -z` lists: new files, no line counts yet. */
export function untrackedFiles(listing: string): FileChange[] {
  return listing
    .split('\0')
    .filter(Boolean)
    .map(path => ({ status: 'A', path, added: null, deleted: null, isUntracked: true }))
}

/** The id of the row that stands for the changes not yet committed. */
export const WIP = 'wip'

/**
 * A line between two row centres, in lane columns and row indexes; dashed on
 * its way from the uncommitted changes down to HEAD.
 */
export type Segment = { c1: number; r1: number; c2: number; r2: number; color: number; isDashed?: true }
export type Layout = {
  /** Lane and colour of each commit's node. */
  nodes: { col: number; color: number }[]
  segments: Segment[]
  /** The segments that cross each row's band, so a row draws without a scan of them all. */
  byRow: Segment[][]
  columns: number
}

type Lane = { hash: string; color: number; col: number; row: number; isDashed?: true } | null

const dashed = (lane: NonNullable<Lane>) => (lane.isDashed ? { isDashed: true as const } : {})

/**
 * Lays the commits (children before parents, as `git log` prints them) out in
 * lanes: each lane waits for one commit; a commit takes the lane that waits
 * for it, the lanes that also waited for it merge into it, and its first
 * parent takes over its lane.
 */
export function layout(commits: readonly GraphCommit[]): Layout {
  const lanes: Lane[] = []
  const nodes: Layout['nodes'] = []
  const segments: Segment[] = []
  let nextColor = 0
  let columns = 0

  const freeSlot = (avoid: number) => {
    const index = lanes.findIndex((lane, i) => lane === null && i !== avoid)

    return index === -1 ? Math.max(lanes.length, avoid + 1) : index
  }

  commits.forEach((commit, row) => {
    let col = lanes.findIndex(lane => lane?.hash === commit.hash)
    let color: number
    if (col === -1) {
      col = freeSlot(-1)
      color = nextColor++
    } else {
      color = lanes[col]?.color ?? nextColor++
    }

    lanes.forEach((lane, i) => {
      if (lane === null) return
      if (lane.hash === commit.hash) {
        segments.push({ c1: lane.col, r1: lane.row, c2: col, r2: row, color: lane.color, ...dashed(lane) })
        lanes[i] = null
      } else {
        segments.push({ c1: lane.col, r1: lane.row, c2: i, r2: row, color: lane.color, ...dashed(lane) })
        lanes[i] = { ...lane, col: i, row }
      }
    })

    const [first, ...others] = commit.parents
    lanes[col] =
      first === undefined
        ? null
        : { hash: first, color, col, row, ...(commit.hash === WIP ? { isDashed: true as const } : {}) }
    for (const parent of others) {
      const waiting = lanes.findIndex(lane => lane?.hash === parent)
      if (waiting !== -1) {
        // Already awaited by another lane: join it on the next row.
        segments.push({
          c1: col,
          r1: row,
          c2: waiting,
          r2: row + 1,
          color: lanes[waiting]?.color ?? color,
        })
      } else {
        const slot = freeSlot(col)
        lanes[slot] = { hash: parent, color: nextColor++, col, row }
      }
    }

    nodes.push({ col, color })
    columns = Math.max(columns, col + 1, lanes.length)
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
  })

  // Lanes still open lead to commits below the window: run them off the end.
  const end = commits.length - 0.5
  lanes.forEach((lane, i) => {
    if (lane !== null) {
      segments.push({ c1: lane.col, r1: lane.row, c2: i, r2: end, color: lane.color, ...dashed(lane) })
    }
  })

  // A row's band runs from half a row above its centre to half a row below.
  const byRow: Segment[][] = commits.map(() => [])
  for (const segment of segments) {
    const top = Math.max(0, Math.ceil(Math.min(segment.r1, segment.r2) - 0.5))
    const bottom = Math.min(commits.length - 1, Math.floor(Math.max(segment.r1, segment.r2) + 0.5))
    for (let row = top; row <= bottom; row++) byRow[row]?.push(segment)
  }

  return { nodes, segments, byRow, columns }
}

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']

/** A short French age for a commit date ("3 h", "2 j", "12 oct."). */
export function relativeDate(iso: string, now: number): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return ''
  const minutes = Math.floor(Math.max(0, now - time) / 60_000)
  if (minutes < 1) return "à l'instant"
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} j`
  if (days < 30) return `${Math.floor(days / 7)} sem.`
  const date = new Date(time)
  const label = `${date.getDate()} ${MONTHS[date.getMonth()]}`

  return date.getFullYear() === new Date(now).getFullYear() ? label : `${label} ${date.getFullYear()}`
}

/** The date as the author wrote it: "15 nov. 2026 à 10:42". */
export function fullDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso)
  if (match === null) return iso
  const [, year, month, day, hour, minute] = match

  return `${Number(day)} ${MONTHS[Number(month) - 1] ?? ''} ${year} à ${hour}:${minute}`
}

export const PALETTE = [
  '#3b82f6',
  '#f59e0b',
  '#10b981',
  '#ec4899',
  '#8b5cf6',
  '#14b8a6',
  '#ef4444',
  '#84cc16',
  '#06b6d4',
  '#f97316',
]

/** Height of one row in CSS pixels: each row's slice of the graph is this tall. */
export const ROW = 28
const LANE = 14
const PAD = 8
const NODE = 4.5

export const laneColor = (index: number) => PALETTE[index % PALETTE.length] ?? '#3b82f6'
const laneX = (col: number) => PAD + col * LANE + LANE / 2
const rowY = (row: number) => row * ROW + ROW / 2

/** Width in pixels of the graph column for this many lanes. */
export const graphWidth = (columns: number) => PAD * 2 + Math.max(1, columns) * LANE

/**
 * Draws row `row` of the graph: the node, and every line that crosses the
 * row's band. The document's viewBox is that band of the whole graph, so the
 * rows stacked one under the other join into one drawing.
 */
export function drawRow(
  graph: Layout,
  row: number,
  { isHead = false, isMerge = false, isWip = false }: { isHead?: boolean; isMerge?: boolean; isWip?: boolean } = {},
): string {
  const width = graphWidth(graph.columns)
  // Keyed by colour, dashed lines apart: one path each.
  const paths = new Map<string, string[]>()
  for (const segment of graph.byRow[row] ?? []) {
    const x1 = laneX(segment.c1)
    const y1 = rowY(segment.r1)
    const x2 = laneX(segment.c2)
    const y2 = rowY(segment.r2)
    const key = `${segment.color % PALETTE.length}${segment.isDashed ? ':dashed' : ''}`
    const list = paths.get(key) ?? []
    if (x1 === x2) {
      list.push(`M${x1} ${y1}V${y2}`)
    } else {
      const mid = (y1 + y2) / 2
      list.push(`M${x1} ${y1}C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`)
    }
    paths.set(key, list)
  }
  const lines = [...paths].map(([key, d]) => {
    const [color = '0', style] = key.split(':')

    return `<path d="${d.join('')}" fill="none" stroke="${laneColor(Number(color))}" stroke-width="2" stroke-linecap="butt"${
      style === 'dashed' ? ' stroke-dasharray="3 3"' : ''
    }/>`
  })

  const node = graph.nodes[row] ?? { col: 0, color: 0 }
  const cx = laneX(node.col)
  const cy = rowY(row)
  const color = laneColor(node.color)
  const ring = isHead
    ? `<circle cx="${cx}" cy="${cy}" r="${NODE + 2.5}" fill="none" stroke="${color}" stroke-width="2"/>`
    : ''
  const dot = isWip
    ? `<circle cx="${cx}" cy="${cy}" r="${NODE}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="2.5 2"/>`
    : isMerge
      ? `<circle cx="${cx}" cy="${cy}" r="${NODE - 0.5}" fill="${color}" fill-opacity=".35" stroke="${color}" stroke-width="2"/>`
      : `<circle cx="${cx}" cy="${cy}" r="${NODE}" fill="${color}"/>`

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${ROW}" viewBox="0 ${row * ROW} ${width} ${ROW}">`,
    lines.join(''),
    ring,
    dot,
    '</svg>',
  ].join('')
}

/** What a `Code` element draws at most: a diff is cut between hunks under this. */
export const MAX_DIFF = 90_000

/**
 * Keeps the hunks of `git show`'s diff of one file (what `Code` reads under
 * `format: 'diff'`), dropping the header lines before the first `@@`. A diff
 * too long to draw is cut before the hunk that passes `max`; a single hunk
 * longer than that is cut at a line, and is then drawn as plain text.
 */
export function diffHunks(output: string, max = MAX_DIFF): { source: string; isTruncated: boolean } {
  const start = output.startsWith('@@') ? 0 : output.indexOf('\n@@') + 1
  if (start === 0 && !output.startsWith('@@')) return { source: '', isTruncated: false }
  const hunks = output.slice(start).replace(/\n+$/, '')
  if (hunks.length <= max) return { source: hunks, isTruncated: false }
  const lastHunk = hunks.lastIndexOf('\n@@', max)
  const cut = lastHunk > 0 ? lastHunk : hunks.lastIndexOf('\n', max)

  return { source: hunks.slice(0, Math.max(0, cut)), isTruncated: true }
}

/** A part of a line that changed against its counterpart, by character offsets. */
export type Span = { start: number; end: number }

export type DiffLine =
  | { kind: 'hunk'; newStart: number; section: string }
  | { kind: 'add' | 'del' | 'ctx'; oldNo?: number; newNo?: number; text: string; change?: Span }
  | { kind: 'note'; text: string }

/** Tabs as two spaces, and no other control character, as a Text takes it. */
const printable = (text: string) =>
  text.replace(/\t/g, '  ').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')

/**
 * Where two versions of a line differ: what lies between their common start
 * and their common end. None when the lines are the same, or when almost all
 * of the line changed (a highlight would then only repeat the line's colour).
 */
export function changedSpans(before: string, after: string): { before: Span; after: Span } | undefined {
  const shortest = Math.min(before.length, after.length)
  let head = 0
  while (head < shortest && before[head] === after[head]) head++
  let tail = 0
  while (
    tail < shortest - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++
  }
  if (head + tail === before.length && head + tail === after.length) return undefined
  const kept = head + tail
  if (kept < 3 || kept / Math.max(before.length, after.length) < 0.25) return undefined

  return {
    before: { start: head, end: before.length - tail },
    after: { start: head, end: after.length - tail },
  }
}

/**
 * Reads unified-diff hunks into numbered lines. A run of removed lines followed
 * by a run of added ones is read as a rewrite: the n-th of each are paired and
 * the part of them that changed is marked.
 */
export function parseDiff(source: string): DiffLine[] {
  const lines: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  for (const raw of source.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(raw)
    if (hunk !== null) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      lines.push({ kind: 'hunk', newStart: newNo, section: printable(hunk[3] ?? '').trim() })
    } else if (raw.startsWith('+')) {
      lines.push({ kind: 'add', newNo: newNo++, text: printable(raw.slice(1)) })
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', oldNo: oldNo++, text: printable(raw.slice(1)) })
    } else if (raw.startsWith('\\')) {
      lines.push({ kind: 'note', text: 'Pas de saut de ligne en fin de fichier' })
    } else {
      lines.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: printable(raw.slice(1)) })
    }
  }

  for (let i = 0; i < lines.length; ) {
    let dels = i
    while (lines[dels]?.kind === 'del') dels++
    let adds = dels
    while (lines[adds]?.kind === 'add') adds++
    const pairs = Math.min(dels - i, adds - dels)
    for (let k = 0; k < pairs; k++) {
      const removed = lines[i + k]
      const added = lines[dels + k]
      if (removed?.kind !== 'del' || added?.kind !== 'add') continue
      const spans = changedSpans(removed.text, added.text)
      if (spans === undefined) continue
      lines[i + k] = { ...removed, change: spans.before }
      lines[dels + k] = { ...added, change: spans.after }
    }
    i = adds > i ? adds : i + 1
  }

  return lines
}

/** Cuts a path to `chars` characters from its start, keeping the file name. */
export const clipStart = (text: string, chars: number) =>
  chars <= 1 ? '' : text.length <= chars ? text : `…${text.slice(text.length - chars + 1)}`

/** Cuts a text to `chars` characters, an ellipsis standing for the rest. */
export const clip = (text: string, chars: number) =>
  chars <= 1 ? '' : text.length <= chars ? text : `${text.slice(0, chars - 1)}…`
