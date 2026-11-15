import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  CommitDetail,
  FileChange,
  FileDiff,
  GitRef,
  GraphCommit,
  GraphSnapshot,
  GraphView,
} from '../types'
import {
  LOG_FORMAT,
  ROW,
  WIP,
  clip,
  clipStart,
  countStatus,
  diffHunks,
  drawRow,
  fullDate,
  githubUrl,
  graphWidth,
  issuesOf,
  laneColor,
  layout,
  parseDiff,
  parseFiles,
  parseLog,
  pullRequestOf,
  relativeDate,
  untrackedFiles,
} from './graph'

import { TOKEN_COLORS, highlightLine, languageOf, splitAt } from './syntax'
import type { SyntaxState } from './syntax'

const PANE = 'git-graph'
const TITLE = 'Graphe git'
const PAGE = 100
const POLL_MS = 3000
/** Pixels per cell of the desktop's code font, to size the text beside the graph. */
const CELL_PX = 7.6

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const snapshot = atom({ plugin: 'git-graph', key: 'snapshot' } as const, null, {
  shape: 'snapshot-2',
})
const view = atom(
  { plugin: 'git-graph', key: 'view' } as const,
  { scope: 'all', limit: PAGE },
  { shape: 'view-1' },
)
const detail = atom({ plugin: 'git-graph', key: 'detail' } as const, null, {
  shape: 'detail-3',
})
const isOpen = atom({ plugin: 'git-graph', key: 'isOpen' } as const, false)

type Git = { isOk: boolean; out: string; err: string }

/** Runs git; `okCodes` are the exit codes that mean it worked (`diff --no-index` exits 1 on a difference). */
async function git($: EngineInterface, args: string[], okCodes: readonly number[] = [0]): Promise<Git> {
  try {
    const run = await $.process.run(['git', ...args], { timeoutMs: 15_000 })

    return { isOk: okCodes.includes(run.exitCode), out: run.stdout, err: run.stderr.trim() }
  } catch (error) {
    return { isOk: false, out: '', err: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The current branch, every ref's commit and the working tree's status: any
 * change in them means a reload.
 */
async function signatureOf(
  $: EngineInterface,
): Promise<{ branch: string; signature: string; changes: number }> {
  const [branch, refs, status] = await Promise.all([
    git($, ['symbolic-ref', '-q', '--short', 'HEAD']),
    git($, ['show-ref', '--head']),
    git($, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ])
  const name = branch.out.trim()

  return {
    branch: name,
    signature: `${name}\n${refs.out}\n${status.out}`,
    changes: status.isOk ? countStatus(status.out) : 0,
  }
}

let isRefreshing = false

async function refresh($: EngineInterface): Promise<void> {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const { scope, limit } = await read($, view)
    const [{ branch, signature, changes }, log, head, remote] = await Promise.all([
      signatureOf($),
      git($, [
        'log',
        ...(scope === 'all' ? ['--exclude=refs/stash', '--all'] : ['HEAD']),
        '--topo-order',
        '--decorate=full',
        `--max-count=${limit + 1}`,
        `--format=${LOG_FORMAT}`,
      ]),
      git($, ['rev-parse', '--verify', '-q', 'HEAD']),
      git($, ['remote', 'get-url', 'origin']),
    ])
    const commits = log.isOk ? parseLog(log.out) : []
    const shared = {
      branch,
      signature,
      head: head.out.trim(),
      changes,
      repoUrl: remote.isOk ? githubUrl(remote.out) : '',
    }
    const next: GraphSnapshot = log.isOk
      ? { ...shared, commits: commits.slice(0, limit), hasMore: commits.length > limit }
      : { ...shared, commits: [], hasMore: false, error: log.err || 'git log a échoué.' }
    await update($, snapshot, () => next)
  } finally {
    isRefreshing = false
  }
}

async function poll($: EngineInterface): Promise<void> {
  if (!(await read($, isOpen)) || isRefreshing) return
  const current = await read($, snapshot)
  const { signature } = await signatureOf($)
  if (current === null || current.signature !== signature) await refresh($)
}

async function open($: EngineInterface): Promise<boolean> {
  await update($, isOpen, () => true)
  const { isPlaced } = await $.ui.open({ id: PANE, title: TITLE })
  await refresh($)

  return isPlaced
}

/** Opens a commit in the pane: its message, then the files it changed. */
async function select($: EngineInterface, hash: string): Promise<void> {
  const empty = { hash, body: '', isPushed: false, files: [], file: null }
  await update($, detail, (): CommitDetail => ({ ...empty, isLoading: true }))
  void $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)

  // The uncommitted changes: tracked files against HEAD, then the untracked ones.
  const diff =
    hash === WIP
      ? ['diff', 'HEAD', '-M', '-z']
      : ['show', '--format=', '-M', '--diff-merges=first-parent', '-z', hash]
  const [body, names, stats, extra] = await Promise.all([
    hash === WIP ? Promise.resolve({ isOk: true, out: '', err: '' }) : git($, ['show', '-s', '--format=%b', hash]),
    git($, [...diff, '--name-status']),
    git($, [...diff, '--numstat']),
    hash === WIP
      ? git($, ['ls-files', '--others', '--exclude-standard', '-z'])
      : git($, ['branch', '-r', '--contains', hash, '--format=%(refname)']),
  ])
  const loaded: CommitDetail =
    body.isOk && names.isOk && stats.isOk
      ? {
          ...empty,
          isLoading: false,
          body: body.out.trim(),
          isPushed: hash !== WIP && extra.out.trim() !== '',
          files: [
            ...parseFiles(names.out, stats.out),
            ...(hash === WIP && extra.isOk ? untrackedFiles(extra.out) : []),
          ],
        }
      : {
          ...empty,
          isLoading: false,
          error: body.err || names.err || stats.err || 'git show a échoué.',
        }
  // Another commit may have been opened meanwhile: only the latest one lands.
  await update($, detail, current => (current?.hash === hash ? loaded : current))
}

/** Shows the changes one file of the opened commit went through. */
async function openFile($: EngineInterface, hash: string, file: FileChange): Promise<void> {
  const loading: FileDiff = { path: file.path, isLoading: true, source: '', isTruncated: false }
  await update($, detail, current => (current?.hash === hash ? { ...current, file: loading } : current))
  void $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)

  const paths = file.oldPath === undefined ? [file.path] : [file.oldPath, file.path]
  const plain = ['--no-color', '--no-ext-diff']
  const run = file.isUntracked
    ? // A file git does not track yet: all of it, against nothing.
      await git($, ['diff', '--no-index', ...plain, '--', '/dev/null', file.path], [0, 1])
    : hash === WIP
      ? await git($, ['diff', 'HEAD', '-M', ...plain, '--', ...paths])
      : await git($, ['show', '--format=', '-M', '--diff-merges=first-parent', ...plain, hash, '--', ...paths])
  const loaded: FileDiff = run.isOk
    ? { path: file.path, isLoading: false, ...diffHunks(run.out) }
    : { ...loading, isLoading: false, error: run.err || 'git show a échoué.' }
  // Only the file still asked for lands.
  await update($, detail, current =>
    current?.hash === hash && current.file?.path === file.path ? { ...current, file: loaded } : current,
  )
}

async function closeFile($: EngineInterface, path: string): Promise<void> {
  await update($, detail, current => (current === null ? current : { ...current, file: null }))
  void $.ui.scroll({ in: PANE, to: { key: `file:${path}` }, block: 'center' }).catch(() => undefined)
}

async function backToGraph($: EngineInterface, hash: string): Promise<void> {
  await update($, detail, () => null)
  void $.ui.scroll({ in: PANE, to: { key: hash }, block: 'center' }).catch(() => undefined)
}

const refLabel = (ref: GitRef) => (ref.hasRemote ? `${ref.name} ⇅` : ref.name)

// A chip's background, under white text at 4.5:1 or more.
const STATUS: Record<string, { label: string; color: string }> = {
  A: { label: 'Ajouté', color: '#1a7f37' },
  M: { label: 'Modifié', color: '#9a6700' },
  D: { label: 'Supprimé', color: '#cf222e' },
  R: { label: 'Renommé', color: '#8250df' },
  C: { label: 'Copié', color: '#8250df' },
  T: { label: 'Type changé', color: '#6e7781' },
}

// Text in colour on the pane itself, whose theme a mod cannot read: mid tones,
// about 3:1 on a light and on a dark background alike.
const ADDED_TEXT = '#2da44e'
const DELETED_TEXT = '#e5534b'

const statusOf = (file: FileChange) => STATUS[file.status] ?? { label: file.status, color: '#6e7781' }

/** Diff lines drawn at most: past this the view says how many are left out. */
const MAX_LINES = 1000

const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? 's' : ''}`

/** A path cut into its file name and the folder it sits in ("" at the root). */
function splitPath(path: string): { name: string; folder: string } {
  const slash = path.lastIndexOf('/')

  return slash === -1 ? { name: path, folder: '' } : { name: path.slice(slash + 1), folder: path.slice(0, slash + 1) }
}

/** "3 fichiers · 2 modifiés, 1 ajouté": how many, and of which kind, in git's order of kinds. */
function fileSummary(files: readonly FileChange[]): string {
  const byKind = Object.entries(STATUS)
    .map(([letter, status]) => {
      const count = files.filter(file => file.status === letter).length

      return count === 0 ? '' : plural(count, status.label.toLowerCase())
    })
    .filter(Boolean)

  return `${plural(files.length, 'fichier')}${byKind.length > 0 ? ` · ${byKind.join(', ')}` : ''}`
}

const lineTotals = (files: readonly FileChange[]) => ({
  added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
  deleted: files.reduce((sum, file) => sum + (file.deleted ?? 0), 0),
})

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'git-graph',
      description: "Affiche le graphe de l'historique git dans un panneau",
    })
    $.clock.every(POLL_MS, () => {
      void poll($)
    })

    return next(e)
  })

  on('command.run', { command: 'git-graph' }, async $ => {
    const isPlaced = await open($)

    return {
      text: isPlaced
        ? 'Graphe git ouvert dans un panneau.'
        : "Le graphe git est prêt, mais cette surface n'affiche pas de panneau.",
    }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, isOpen, () => false)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Markdown, Link } = table

    /** Lines added and deleted, in their colours: "+12 −3". */
    const counts = (added: number, deleted: number) => (
      <Text mono tabular>
        <Text color={ADDED_TEXT}>+{added}</Text> <Text color={DELETED_TEXT}>−{deleted}</Text>
      </Text>
    )

    /** Where the view sits: "Graphe › a1b2c3d › layout.tsx", each level but the last a way back. */
    const crumbs = (levels: { key: string; label: string; onPress: () => void }[], here: string) => (
      <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1}>
        {levels.flatMap(level => [
          <Button key={level.key} plain onPress={level.onPress}>
            <Text color="suggestion" underline>
              {level.label}
            </Text>
          </Button>,
          <Text dimColor>›</Text>,
        ])}
        <Text weight="semibold" wrap="truncate-end">
          {here}
        </Text>
      </Box>
    )

    /** A file's status as a coloured chip: " M ". */
    const badge = (file: FileChange) => (
      <Text mono backgroundColor={statusOf(file).color} color="#ffffff" weight="semibold">
        {` ${file.status} `}
      </Text>
    )

    /** The diff drawn line by line: old and new numbers, then the line on its colour. */
    const diffView = (source: string, path: string) => {
      const lines = parseDiff(source)
      const drawn = lines.slice(0, MAX_LINES)
      // Each line's colours, with what a line leaves open (a comment) carried on.
      const language = languageOf(path)
      let state: SyntaxState = {}
      const colours = drawn.map(line => {
        if (line.kind === 'hunk') state = {}
        if (line.kind !== 'add' && line.kind !== 'del' && line.kind !== 'ctx') return []
        const coloured = highlightLine(line.text, language, state)
        state = coloured.state

        return splitAt(coloured.tokens, line.change)
      })
      const widest = drawn.reduce(
        (most, line) =>
          'oldNo' in line || 'newNo' in line
            ? Math.max(most, String(line.oldNo ?? 0).length, String(line.newNo ?? 0).length)
            : most,
        1,
      )
      const number = (value: number | undefined) => (value === undefined ? '' : String(value)).padStart(widest)

      return (
        <Box flexDirection="column">
          {drawn.map((line, at) => {
            if (line.kind === 'hunk') {
              return (
                <Box paddingTop={1}>
                  <Text dimColor>
                    {`⋯ ligne ${line.newStart}`}
                    {line.section === '' ? '' : ` · ${line.section}`}
                  </Text>
                </Box>
              )
            }
            if (line.kind === 'note') {
              return (
                <Text dimColor italic>
                  {line.text}
                </Text>
              )
            }
            const isAdd = line.kind === 'add'
            const isDel = line.kind === 'del'
            const pieces = colours[at] ?? []
            const wordBackground = isAdd ? 'diffAddedWord' : 'diffRemovedWord'

            return (
              <Box
                flexDirection="row"
                backgroundColor={isAdd ? 'diffAddedDimmed' : isDel ? 'diffRemovedDimmed' : undefined}
              >
                <Box width={widest + 1} flexShrink={0}>
                  <Text mono dimColor>
                    {number(line.oldNo)}
                  </Text>
                </Box>
                <Box width={widest + 1} flexShrink={0}>
                  <Text mono dimColor>
                    {number(line.newNo)}
                  </Text>
                </Box>
                <Box width={2} flexShrink={0}>
                  <Text mono color={isAdd ? ADDED_TEXT : isDel ? DELETED_TEXT : undefined}>
                    {isAdd ? '+' : isDel ? '−' : ' '}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text mono>
                    {pieces.length === 0
                      ? ' '
                      : pieces.map(piece => (
                          <Text
                            mono
                            color={TOKEN_COLORS[piece.kind]}
                            backgroundColor={piece.isChanged ? wordBackground : undefined}
                            italic={piece.kind === 'comment'}
                            weight={piece.kind === 'heading' ? 'semibold' : undefined}
                          >
                            {piece.text}
                          </Text>
                        ))}
                  </Text>
                </Box>
              </Box>
            )
          })}
          {lines.length > drawn.length && (
            <Box paddingTop={1}>
              <Text dimColor>{lines.length - drawn.length} lignes de plus ne sont pas affichées.</Text>
            </Box>
          )}
        </Box>
      )
    }
    const snap = await read($, snapshot)
    const { scope } = await read($, view)
    const opened = await read($, detail)

    if (snap === null) return <Text dimColor>Lecture de l'historique…</Text>
    if (snap.error !== undefined) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text>Pas de graphe : {snap.error}</Text>
          <Button key="retry" label="Réessayer" onPress={() => void refresh($)} />
        </Box>
      )
    }

    const now = Date.now()
    const branch = snap.branch === '' ? 'HEAD détachée' : snap.branch
    const last = snap.commits[0]

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          <Text weight="semibold">{branch}</Text>
          {last !== undefined && (
            <Text dimColor wrap="truncate-end">
              {last.subject} · {relativeDate(last.date, now)}
            </Text>
          )}
        </Box>
      )
    }

    // The uncommitted changes stand as a row of their own above HEAD.
    const wip: GraphCommit | undefined =
      snap.changes > 0
        ? {
            hash: WIP,
            parents: snap.head === '' ? [] : [snap.head],
            refs: [],
            subject: 'Modifications non commitées',
            author: '',
            date: '',
          }
        : undefined
    const rows = wip === undefined ? snap.commits : [wip, ...snap.commits]
    const graph = layout(rows)
    const shortId = (hash: string) => (hash === WIP ? 'En cours' : hash.slice(0, 7))

    /** The commit on GitHub, the pull request a merge names, the issues its message cites. */
    const githubLinks = (commit: GraphCommit, loaded: CommitDetail) => {
      const pull = pullRequestOf(commit.subject)
      const issues = issuesOf(`${commit.subject}\n${loaded.body}`, pull).slice(0, 8)

      return (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {loaded.isPushed ? (
            <Link href={`${snap.repoUrl}/commit/${commit.hash}`}>Commit sur GitHub ↗</Link>
          ) : (
            <Text dimColor>Pas encore poussé sur GitHub</Text>
          )}
          {pull !== undefined && <Link href={`${snap.repoUrl}/pull/${pull}`}>{`PR #${pull} ↗`}</Link>}
          {issues.map(number => (
            <Link href={`${snap.repoUrl}/issues/${number}`}>{`#${number} ↗`}</Link>
          ))}
        </Box>
      )
    }

    // The commit opened from the graph.
    if (opened !== null) {
      const index = rows.findIndex(commit => commit.hash === opened.hash)
      const commit = rows[index]
      const newer = rows[index - 1]
      const older = rows[index + 1]
      const isWip = opened.hash === WIP

      // One file of that commit, and its changes.
      const shown = opened.file
      if (shown !== null) {
        const at = opened.files.findIndex(file => file.path === shown.path)
        const file = opened.files[at]
        const previous = opened.files[at - 1]
        const following = opened.files[at + 1]

        const { name, folder } = splitPath(shown.path)

        return (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
              {crumbs(
                [
                  { key: 'back', label: 'Graphe', onPress: () => void backToGraph($, opened.hash) },
                  { key: 'commit', label: shortId(opened.hash), onPress: () => void closeFile($, shown.path) },
                ],
                name,
              )}
              <Box flexDirection="row" gap={1} flexShrink={0}>
                {previous !== undefined && (
                  <Button
                    key="previous-file"
                    label="↑ Précédent"
                    onPress={() => void openFile($, opened.hash, previous)}
                  />
                )}
                {following !== undefined && (
                  <Button key="next-file" label="↓ Suivant" onPress={() => void openFile($, opened.hash, following)} />
                )}
              </Box>
            </Box>
            <Box flexDirection="column">
              <Text>
                {file === undefined ? '' : badge(file)}
                {file === undefined ? '' : ' '}
                <Text weight="semibold">{name}</Text>
                {folder === '' ? '' : '  '}
                <Text dimColor>{folder}</Text>
              </Text>
              <Text dimColor>
                {file === undefined ? '' : statusOf(file).label}
                {file?.oldPath === undefined ? '' : ` depuis ${file.oldPath}`}
                {file === undefined || file.added === null ? '' : ' · '}
                {file === undefined || file.added === null ? '' : counts(file.added, file.deleted ?? 0)}
              </Text>
            </Box>
            {shown.isLoading ? (
              <Text dimColor>Lecture des modifications…</Text>
            ) : shown.error !== undefined ? (
              <Text color="error">Lecture impossible : {shown.error}</Text>
            ) : shown.source === '' ? (
              <Text dimColor>
                {file?.isUntracked
                  ? 'Fichier vide, ou binaire : pas de ligne à afficher.'
                  : file?.added === null
                    ? 'Fichier binaire : pas de modification ligne à ligne à afficher.'
                    : 'Aucune ligne modifiée : le fichier a seulement été renommé ou déplacé.'}
              </Text>
            ) : (
              diffView(shown.source, shown.path)
            )}
            {shown.isTruncated && (
              <Text dimColor>Modifications trop longues pour être affichées en entier : les derniers blocs manquent.</Text>
            )}
          </Box>
        )
      }

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
            {crumbs(
              [{ key: 'back', label: 'Graphe', onPress: () => void backToGraph($, opened.hash) }],
              shortId(opened.hash),
            )}
            <Box flexDirection="row" gap={1} flexShrink={0}>
              {newer !== undefined && (
                <Button key="newer" label="↑ Plus récent" onPress={() => void select($, newer.hash)} />
              )}
              {older !== undefined && (
                <Button key="older" label="↓ Plus ancien" onPress={() => void select($, older.hash)} />
              )}
            </Box>
          </Box>
          {commit === undefined ? (
            <Text dimColor>
              {isWip ? 'Plus aucune modification en cours.' : "Ce commit n'est plus dans le graphe."}
            </Text>
          ) : isWip ? (
            <Box flexDirection="column" gap={1}>
              <Text size="heading" weight="semibold">
                {commit.subject}
              </Text>
              <Text dimColor>
                Pas encore commitées · sur {branch}
                {snap.head === '' ? '' : ' · comparées à '}
                {snap.head === '' ? '' : <Text mono>{snap.head.slice(0, 7)}</Text>}
              </Text>
            </Box>
          ) : (
            <Box flexDirection="column" gap={1}>
              <Text size="heading" weight="semibold">
                {commit.subject}
              </Text>
              <Text dimColor>
                {commit.author} · {fullDate(commit.date)} · <Text mono>{commit.hash.slice(0, 10)}</Text>
              </Text>
              {commit.refs.length > 0 && (
                <Text>
                  {commit.refs.map(ref => (
                    <Text color={ref.kind === 'tag' ? '#d4a72c' : laneColor(graph.nodes[index]?.color ?? 0)} weight="semibold">
                      {refLabel(ref)}{'  '}
                    </Text>
                  ))}
                </Text>
              )}
              {commit.parents.length > 1 && (
                <Text dimColor>
                  Merge de {commit.parents.map(parent => parent.slice(0, 7)).join(' et ')} : fichiers
                  comparés au premier parent.
                </Text>
              )}
            </Box>
          )}
          {opened.isLoading ? (
            <Text dimColor>Lecture du commit…</Text>
          ) : opened.error !== undefined ? (
            <Text color="error">Lecture impossible : {opened.error}</Text>
          ) : (
            <Box flexDirection="column" gap={1}>
              {commit !== undefined && !isWip && snap.repoUrl !== '' && githubLinks(commit, opened)}
              {isWip ? (
                ''
              ) : opened.body === '' ? (
                <Text dimColor>Pas de description au-delà du titre.</Text>
              ) : (
                <Markdown text={opened.body} />
              )}
              <Box flexDirection="row" justifyContent="space-between" gap={1}>
                <Text weight="semibold">{fileSummary(opened.files)}</Text>
                {counts(lineTotals(opened.files).added, lineTotals(opened.files).deleted)}
              </Box>
              <Box flexDirection="column">
                {opened.files.map(file => {
                  const { name, folder } = splitPath(file.path)
                  const countCells = file.added === null ? 7 : `+${file.added} −${file.deleted}`.length
                  // The file name stays whole; its folder gives way first, from its start.
                  const room = e.props.bodyColumns - 4 - name.length - countCells - 5
                  const where = file.oldPath === undefined ? folder : `← ${file.oldPath}`

                  return (
                    <Box flexDirection="row" alignItems="center" gap={1}>
                      {badge(file)}
                      <Box flexGrow={1} flexShrink={1}>
                        <Button key={`file:${file.path}`} plain onPress={() => void openFile($, opened.hash, file)}>
                          <Text
                            weight="semibold"
                            color={file.status === 'A' ? ADDED_TEXT : file.status === 'D' ? DELETED_TEXT : undefined}
                            strikethrough={file.status === 'D'}
                          >
                            {name}
                          </Text>
                          {where === '' ? '' : '  '}
                          <Text dimColor>{clipStart(where, room)}</Text>
                        </Button>
                      </Box>
                      <Box flexShrink={0}>
                        {file.added === null ? (
                          <Text dimColor>{file.isUntracked ? 'non suivi' : 'binaire'}</Text>
                        ) : (
                          counts(file.added, file.deleted ?? 0)
                        )}
                      </Box>
                    </Box>
                  )
                })}
              </Box>
            </Box>
          )}
        </Box>
      )
    }

    const showScope = (next: GraphView['scope']) => {
      if (next === scope) return
      void update($, view, (): GraphView => ({ scope: next, limit: PAGE })).then(() => refresh($))
    }
    const loadMore = () => {
      void update($, view, current => ({ ...current, limit: current.limit + PAGE })).then(() =>
        refresh($),
      )
    }

    const Svg = 'Svg' in table ? table.Svg : undefined
    const width = graphWidth(graph.columns)
    const graphCells = Svg === undefined ? 0 : Math.ceil(width / CELL_PX) + 1
    const ages = rows.map(commit => relativeDate(commit.date, now))
    // Ages line up in a right-hand column, as wide as the longest.
    const ageCells = ages.reduce((most, age) => Math.max(most, age.length), 0)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Box flexDirection="row" gap={1} flexShrink={1}>
            <Text weight="semibold" wrap="truncate-end">
              {branch}
            </Text>
            <Text dimColor>
              {snap.commits.length}
              {snap.hasMore ? '+' : ''} commits
            </Text>
          </Box>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            <Button
              key="scope-all"
              label="Toutes"
              variant={scope === 'all' ? 'primary' : 'secondary'}
              onPress={() => showScope('all')}
            />
            <Button
              key="scope-current"
              label="Branche courante"
              variant={scope === 'current' ? 'primary' : 'secondary'}
              onPress={() => showScope('current')}
            />
          </Box>
        </Box>
        <Box flexDirection="column">
          {rows.map((commit, row) => {
            const isWip = commit.hash === WIP
            const isHead = commit.refs.some(ref => ref.kind === 'head')
            const isMerge = commit.parents.length > 1
            const color = laneColor(graph.nodes[row]?.color ?? 0)
            const age = ages[row] ?? ''
            const refCells = commit.refs.reduce((sum, ref) => sum + refLabel(ref).length + 3, 0)
            const room = e.props.bodyColumns - graphCells - 9 - refCells - ageCells - 3
            const graphSlice = Svg !== undefined && (
              <Svg
                source={drawRow(graph, row, { isHead, isMerge, isWip })}
                alt={
                  isWip
                    ? 'Modifications non commitées'
                    : `${isMerge ? 'Fusion' : 'Commit'}${isHead ? ', position actuelle' : ''}`
                }
                width={width}
                height={ROW}
              />
            )

            if (isWip) {
              return (
                <Box flexDirection="row" alignItems="center">
                  {graphSlice}
                  <Box flexGrow={1} flexShrink={1}>
                    <Button key={WIP} plain onPress={() => void select($, WIP)}>
                      <Text italic weight="semibold">
                        {commit.subject}
                      </Text>
                      {'  '}
                      <Text dimColor>{plural(snap.changes, 'fichier')}</Text>
                    </Button>
                  </Box>
                </Box>
              )
            }

            return (
              <Box flexDirection="row" alignItems="center">
                {graphSlice}
                <Box flexGrow={1} flexShrink={1}>
                  <Button key={commit.hash} plain onPress={() => void select($, commit.hash)}>
                  <Text mono dimColor>
                    {commit.hash.slice(0, 7)}
                  </Text>
                  {'  '}
                  {commit.refs.map(ref =>
                    ref.kind === 'head' ? (
                      <Text backgroundColor={color} color="#ffffff" weight="semibold">
                        {` ${refLabel(ref)} `}
                      </Text>
                    ) : (
                      <Text
                        color={ref.kind === 'tag' ? '#d4a72c' : ref.kind === 'local' ? color : undefined}
                        dimColor={ref.kind === 'remote'}
                        weight="semibold"
                      >
                        {` ${refLabel(ref)} `}
                      </Text>
                    ),
                  )}
                  {' '}
                  <Text weight={isHead ? 'semibold' : 'regular'}>{clip(commit.subject, room)}</Text>
                  </Button>
                </Box>
                <Box width={ageCells + 1} flexShrink={0} justifyContent="flex-end">
                  <Text dimColor tabular>
                    {age}
                  </Text>
                </Box>
              </Box>
            )
          })}
        </Box>
        {snap.hasMore ? (
          <Button key="more" label={`Afficher ${PAGE} de plus`} onPress={loadMore} />
        ) : (
          <Text dimColor>Début de l'historique.</Text>
        )}
      </Box>
    )
  })
}
