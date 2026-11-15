import { expect, test } from 'claude-code/testing'

import {
  countStatus,
  diffHunks,
  drawRow,
  githubUrl,
  issuesOf,
  layout,
  parseDiff,
  parseFiles,
  parseLog,
  parseRefs,
  pullRequestOf,
} from '../hooks/graph'
import { highlightLine, languageOf, splitAt } from '../hooks/syntax'
import type { Token } from '../hooks/syntax'

const kinds = (tokens: readonly Token[]) =>
  tokens.filter(token => token.kind !== 'plain').map(token => `${token.kind}:${token.text}`)

test('colours a TypeScript line: keywords, calls, strings, numbers, types, comments', () => {
  expect(languageOf('src/user.service.tsx')).toBe('js')
  const { tokens } = highlightLine(
    "export const total = sum(items, 'eur', 3) as Money // TVA comprise",
    'js',
  )
  expect(kinds(tokens)).toEqual([
    'keyword:export',
    'keyword:const',
    'function:sum',
    "string:'eur'",
    'number:3',
    'keyword:as',
    'type:Money',
    'comment:// TVA comprise',
  ])
  // A subtraction is not one dashed name.
  expect(kinds(highlightLine('a-1', 'js').tokens)).toEqual(['number:1'])
  // JSX: the tag, then its attributes.
  expect(kinds(highlightLine('<Button key="x" plain>', 'js').tokens)).toEqual([
    'tag:Button',
    'property:key',
    'string:"x"',
    'property:plain',
  ])
})

test('carries a block comment and a template string to the next line', () => {
  const first = highlightLine('const a = 1 /* début', 'js')
  expect(first.state).toEqual({ open: 'comment' })
  const second = highlightLine('fin */ return a', 'js', first.state)
  expect(kinds(second.tokens)).toEqual(['comment:fin */', 'keyword:return'])
  const opened = highlightLine('const sql = `select', 'js')
  expect(highlightLine('from users`', 'js', opened.state).tokens[0]).toEqual({
    text: 'from users`',
    kind: 'string',
  })
})

test('colours JSON keys, SQL keywords, Markdown and a dashed CSS property', () => {
  expect(kinds(highlightLine('  "name": "demo-app",', 'json').tokens)).toEqual([
    'property:"name"',
    'string:"demo-app"',
  ])
  expect(kinds(highlightLine('SELECT id FROM users WHERE team_id = 1', 'sql').tokens)).toEqual([
    'keyword:SELECT',
    'keyword:FROM',
    'keyword:WHERE',
    'number:1',
  ])
  expect(kinds(highlightLine('- Voir `bun run test` et **attention**', languageOf('README.md')).tokens)).toEqual([
    'keyword:-',
    'string:`bun run test`',
    'keyword:**attention**',
  ])
  expect(kinds(highlightLine('  font-size: 12px;', 'css').tokens)).toEqual(['property:font-size', 'number:12px'])
})

test('cuts the colours where the changed part of a line starts and ends', () => {
  const { tokens } = highlightLine('const a = 12', 'js')
  const pieces = splitAt(tokens, { start: 6, end: 11 })
  // `12` is a number cut in two by the change's end; `a = ` stays one plain piece.
  expect(pieces.filter(piece => piece.isChanged).map(piece => piece.text)).toEqual(['a = ', '1'])
  expect(pieces.at(-1)).toEqual({ text: '2', kind: 'number', isChanged: false })
  expect(pieces.map(piece => piece.text).join('')).toBe('const a = 12')
})

const F = '\x1f'
const R = '\x1e'
const record = (fields: string[]) => `${fields.join(F)}${R}\n`

// main merged feat: c3 (merge) → c2 (main) and b1 (feat) → c1 (root, tagged).
const LOG = [
  record(['c3', 'c2 b1', 'HEAD -> refs/heads/main, refs/remotes/origin/main', 'Merge feat', 'Ada', '2026-11-15T10:00:00+01:00']),
  record(['b1', 'c1', 'refs/heads/feat', 'Ajoute la fonctionnalité', 'Ada', '2026-11-14T10:00:00+01:00']),
  record(['c2', 'c1', '', 'Corrige le bug', 'Ada', '2026-11-13T10:42:00+01:00']),
  record(['c1', '', 'tag: refs/tags/v1.0.0', 'Initial', 'Ada', '2026-01-01T10:00:00+01:00']),
].join('')

// What git prints for c2 under -z: a modified file, a rename, a binary file.
const NAME_STATUS = 'M\0src/a.ts\0R099\0docs/old.md\0docs/new.md\0A\0logo.png\0'
const NUMSTAT = '3\t1\tsrc/a.ts\0' + '1\t1\t\0docs/old.md\0docs/new.md\0' + '-\t-\tlogo.png\0'

// What `git show c2 -- src/a.ts` prints: headers, then two hunks.
const HUNK_1 = '@@ -1,2 +1,3 @@\n-const a = 1\n+const a = 2\n+const b = 3\n const c = 4'
const HUNK_2 = '@@ -10,2 +11,2 @@\n-old()\n+fresh()\n end()'
const DIFF_A = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 3de4119..b89650c 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  HUNK_1,
  HUNK_2,
  '',
].join('\n')

const PANE = {
  plugin: 'git-graph',
  component: 'Pane',
  requestId: 'git-graph',
  props: {
    title: 'Graphe git',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const RUN = {
  command: 'git-graph',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

/** What the repository answers beside the commit at hand: branch, refs, the tree's status, the remote. */
function repository(args: string, status = '') {
  if (args.startsWith('git symbolic-ref')) return ok('main\n')
  if (args.startsWith('git show-ref')) return ok('c3 HEAD\nc3 refs/heads/main\n')
  if (args.startsWith('git status')) return ok(status)
  if (args.startsWith('git rev-parse')) return ok('c3\n')
  if (args.startsWith('git remote get-url')) return ok('git@github.com:octo/demo.git\n')
  if (args.startsWith('git branch -r --contains')) return ok('refs/remotes/origin/main\n')

  return undefined
}

test('a row draws from its own segments: the same ones a scan of them all finds', () => {
  // Thirty commits on three lanes merging into each other.
  const commits = Array.from({ length: 30 }, (_, i) => ({
    hash: `h${i}`,
    parents: i === 29 ? [] : i % 5 === 0 && i < 25 ? [`h${i + 1}`, `h${i + 3}`] : [`h${i + 1}`],
    refs: [],
    subject: '',
    author: '',
    date: '',
  }))
  const graph = layout(commits)
  for (let row = 0; row < commits.length; row++) {
    const scanned = graph.segments.filter(
      s => Math.max(s.r1, s.r2) >= row - 0.5 && Math.min(s.r1, s.r2) <= row + 0.5,
    )
    expect(graph.byRow[row]?.length).toBe(scanned.length)
  }
})

test('finds the GitHub page, the pull request and the issues a commit names', () => {
  expect(githubUrl('https://github.com/octo/demo.git')).toBe('https://github.com/octo/demo')
  expect(githubUrl('git@github.com:octo/demo.git\n')).toBe('https://github.com/octo/demo')
  expect(githubUrl('https://gitlab.com/a/b.git')).toBe('')
  expect(pullRequestOf('Merge pull request #7 from octo/fix-login')).toBe(7)
  expect(pullRequestOf('fix(ui): corrige le menu (#42)')).toBeUndefined()
  expect(issuesOf('Merge pull request #7 from x\n\nCloses #42, refs #12 et #42', 7)).toEqual([42, 12])
  // A colour or an anchor is no issue.
  expect(issuesOf('color: #fff; voir README#install')).toEqual([])
  expect(countStatus(' M src/a.ts\0R  new.md\0old.md\0?? notes.txt\0')).toBe(3)
})

test('the uncommitted changes stand above HEAD and open like a commit', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  const asked: string[] = []
  on('process.run', (_, e) => {
    const args = e.argv.join(' ')
    asked.push(args)
    const repo = repository(args, ' M src/a.ts\0?? notes.txt\0')
    if (repo !== undefined) return repo
    if (args.startsWith('git diff HEAD -M -z --name-status')) return ok('M\0src/a.ts\0')
    if (args.startsWith('git diff HEAD -M -z --numstat')) return ok('3\t1\tsrc/a.ts\0')
    if (args.startsWith('git ls-files --others')) return ok('notes.txt\0')
    if (args.includes('--no-index')) {
      // git diff --no-index exits 1 when the files differ.
      return { value: { ...ok('@@ -0,0 +1,2 @@\n+premier\n+second\n').value, exitCode: 1 } }
    }
    if (args.startsWith('git diff HEAD -M')) return ok(DIFF_A)

    return ok(LOG)
  })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'wip' }))?.text).toBe('Modifications non commitées  2 fichiers')
  const slice = await ui.find({ type: 'Svg' })
  expect(slice?.props.alt).toBe('Modifications non commitées')
  // The line from the changes down to HEAD is dashed.
  expect(String(slice?.props.source)).toContain('stroke-dasharray="3 3"')

  await ui.press({ key: 'wip' })
  expect((await ui.find({ type: 'Text', text: /fichiers ·/ }))?.text).toBe('2 fichiers · 1 ajouté, 1 modifié')
  expect((await ui.find({ type: 'Text', text: /non suivi/ }))?.text).toBe('non suivi')
  // Nothing to link to on GitHub before a commit.
  expect((await ui.find({ type: 'Link' })) === undefined).toBe(true)

  await ui.press({ key: 'file:notes.txt' })
  expect(asked).toContain('git diff --no-index --no-color --no-ext-diff -- /dev/null notes.txt')
  expect((await ui.find({ type: 'Text', text: /^premier$/ }))?.text).toBe('premier')
  await ui.press({ key: 'commit' })
  await ui.press({ key: 'file:src/a.ts' })
  expect(asked).toContain('git diff HEAD -M --no-color --no-ext-diff -- src/a.ts')
  await ui.unmount()
})

test('a pushed commit links to GitHub, its pull request and the issues it cites', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  const log = [
    record(['c3', 'c2', 'HEAD -> refs/heads/main', 'Merge pull request #7 from octo/fix-login', 'Ada', '2026-11-15T10:00:00+01:00']),
    record(['c2', '', '', 'fix(api): corrige le bug', 'Ada', '2026-11-13T10:42:00+01:00']),
  ].join('')
  let isPushed = true
  on('process.run', (_, e) => {
    const args = e.argv.join(' ')
    if (args.startsWith('git branch -r --contains')) return ok(isPushed ? 'refs/remotes/origin/main\n' : '')
    const repo = repository(args)
    if (repo !== undefined) return repo
    if (args.startsWith('git show -s')) return ok('Closes #42\n')
    if (args.includes('--name-status') || args.includes('--numstat')) return ok('')

    return ok(log)
  })

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'c3' })
  const hrefs = (await ui.findAll({ type: 'Link' })).map(link => link.props.href)
  expect(hrefs).toEqual([
    'https://github.com/octo/demo/commit/c3',
    'https://github.com/octo/demo/pull/7',
    'https://github.com/octo/demo/issues/42',
  ])

  isPushed = false
  await ui.press({ key: 'older' })
  expect((await ui.find({ type: 'Text', text: /Pas encore poussé/ }))?.text).toBe('Pas encore poussé sur GitHub')
  await ui.unmount()
})

test('parses the log and folds a remote branch into its local twin', () => {
  const commits = parseLog(LOG)
  expect(commits.map(commit => commit.hash)).toEqual(['c3', 'b1', 'c2', 'c1'])
  expect(commits[0]?.parents).toEqual(['c2', 'b1'])
  expect(commits[0]?.refs).toEqual([{ name: 'main', kind: 'head', hasRemote: true }])
  expect(commits[3]?.refs).toEqual([{ name: 'v1.0.0', kind: 'tag' }])
  expect(parseRefs('refs/remotes/origin/HEAD, refs/remotes/origin/old')).toEqual([
    { name: 'origin/old', kind: 'remote' },
  ])
})

test('a merge opens a second lane that rejoins at the common parent', () => {
  const graph = layout(parseLog(LOG))
  expect(graph.nodes.map(node => node.col)).toEqual([0, 1, 0, 0])
  expect(graph.columns).toBe(2)
  // feat's lane runs from the merge to b1, then back into c1.
  expect(graph.segments).toContainEqual({ c1: 0, r1: 0, c2: 1, r2: 1, color: 1 })
  expect(graph.segments).toContainEqual({ c1: 1, r1: 2, c2: 0, r2: 3, color: 1 })
  // Nothing runs off the end once the root is reached.
  expect(graph.segments.some(segment => segment.r2 > 3)).toBe(false)
  // A row's slice is the band of the whole graph that row covers.
  expect(drawRow(graph, 2)).toContain('viewBox="0 56 44 28"')
})

test('joins the files of a commit with their line counts', () => {
  expect(parseFiles(NAME_STATUS, NUMSTAT)).toEqual([
    { status: 'M', path: 'src/a.ts', added: 3, deleted: 1 },
    { status: 'R', path: 'docs/new.md', oldPath: 'docs/old.md', added: 1, deleted: 1 },
    { status: 'A', path: 'logo.png', added: null, deleted: null },
  ])
})

test('keeps the hunks of a diff, and cuts a long one between hunks', () => {
  expect(diffHunks(DIFF_A)).toEqual({ source: `${HUNK_1}\n${HUNK_2}`, isTruncated: false })
  expect(diffHunks(DIFF_A, HUNK_1.length + 5)).toEqual({ source: HUNK_1, isTruncated: true })
  // A bare rename or a binary file has no hunk.
  expect(diffHunks('diff --git a/x b/y\nsimilarity index 100%\nrename from x\nrename to y\n')).toEqual({
    source: '',
    isTruncated: false,
  })
})

test('numbers the lines of a diff and marks the part of a line that changed', () => {
  const lines = parseDiff(`${HUNK_1}\n${HUNK_2}\n\\ No newline at end of file`)
  expect(lines[0]).toEqual({ kind: 'hunk', newStart: 1, section: '' })
  expect(lines[1]).toEqual({ kind: 'del', oldNo: 1, text: 'const a = 1', change: { start: 10, end: 11 } })
  expect(lines[2]).toEqual({ kind: 'add', newNo: 1, text: 'const a = 2', change: { start: 10, end: 11 } })
  // The unpaired added line has nothing to compare with.
  expect(lines[3]).toEqual({ kind: 'add', newNo: 2, text: 'const b = 3' })
  expect(lines[4]).toEqual({ kind: 'ctx', oldNo: 2, newNo: 3, text: 'const c = 4' })
  expect(lines[5]).toEqual({ kind: 'hunk', newStart: 11, section: '' })
  // A line rewritten almost whole is not marked: its colour says it already.
  expect(lines[6]).toEqual({ kind: 'del', oldNo: 10, text: 'old()' })
  expect(lines[8]).toEqual({ kind: 'ctx', oldNo: 11, newNo: 12, text: 'end()' })
  expect(lines[9]).toEqual({ kind: 'note', text: 'Pas de saut de ligne en fin de fichier' })
  expect(parseDiff('@@ -3 +3 @@ function main() {\n-\tx')[1]).toEqual({ kind: 'del', oldNo: 3, text: '  x' })
  expect(parseDiff('@@ -3 +3 @@ function main() {')[0]).toEqual({
    kind: 'hunk',
    newStart: 3,
    section: 'function main() {',
  })
})

test('a file of the commit opens its changes', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  on('process.run', (_, e) => {
    const args = e.argv.join(' ')
    const repo = repository(args)
    if (repo !== undefined) return repo
    if (args.startsWith('git show -s')) return ok('\n')
    if (args.includes('--name-status')) return ok(NAME_STATUS)
    if (args.includes('--numstat')) return ok(NUMSTAT)
    if (args.endsWith('-- src/a.ts')) return ok(DIFF_A)
    if (args.endsWith('-- docs/old.md docs/new.md')) {
      return ok('diff --git a/docs/old.md b/docs/new.md\nsimilarity index 99%\n@@ -1 +1 @@\n-v1\n+v2\n')
    }
    if (args.includes(' -- ')) return ok('')

    return ok(LOG)
  })

  await $.command.run(RUN)
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'c2' })
    await ui.press({ key: 'file:src/a.ts' })
    // Each hunk opens on the line it starts at; a rewritten line marks what changed.
    expect((await ui.find({ type: 'Text', text: /^⋯ ligne 11/ }))?.text).toBe('⋯ ligne 11')
    const word = await ui.find({ type: 'Text', text: /^2$/ })
    expect(word?.props.backgroundColor).toBe('diffAddedWord')
    // Syntax colours: a call reads as a function, a keyword as a keyword.
    expect((await ui.find({ type: 'Text', text: /^fresh$/ }))?.props.color).toBe('#3b82f6')
    expect((await ui.find({ type: 'Text', text: /^const$/ }))?.props.color).toBe('#a855f7')
    expect((await ui.find({ type: 'Text', text: /^ M $/ }))?.props.backgroundColor).toBe('#9a6700')

    // A rename is asked with both of its paths, or git finds no change.
    await ui.press({ key: 'next-file' })
    expect((await ui.find({ type: 'Text', text: /^v2$/ }))?.text).toBe('v2')
    await ui.press({ key: 'next-file' })
    expect((await ui.find({ type: 'Text', text: /binaire/ }))?.text).toBe(
      'Fichier binaire : pas de modification ligne à ligne à afficher.',
    )

    await ui.press({ key: 'commit' })
    expect((await ui.find({ type: 'Text', text: /fichiers ·/ }))?.text).toBe(
      '3 fichiers · 1 ajouté, 1 modifié, 1 renommé',
    )
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('a row opens its commit, with its message and its files', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  on('process.run', (_, e) => {
    const args = e.argv.join(' ')
    const repo = repository(args)
    if (repo !== undefined) return repo
    if (args.startsWith('git show -s')) return ok('Le détail du correctif.\n\nRefs #12\n')
    if (args.includes('--name-status')) return ok(NAME_STATUS)
    if (args.includes('--numstat')) return ok(NUMSTAT)

    return ok(LOG)
  })

  const ran = await $.command.run(RUN)
  expect(ran.text).toBe('Graphe git ouvert dans un panneau.')

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /4 commits/ }))?.text).toBe('4 commits')
    // The scope in force is the primary of the two buttons, not a label that names the other.
    expect((await ui.find({ key: 'scope-all' }))?.props.variant).toBe('primary')
    expect((await ui.find({ key: 'scope-current' }))?.props.variant).toBe('secondary')
    expect((await ui.find({ type: 'Svg' }))?.props.alt ?? 'none').toBe(
      surface === 'desktop' ? 'Fusion, position actuelle' : 'none',
    )

    await ui.press({ key: 'c2' })
    expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('Le détail du correctif.\n\nRefs #12')
    expect((await ui.find({ type: 'Text', text: /fichiers/ }))?.text).toBe(
      '3 fichiers · 1 ajouté, 1 modifié, 1 renommé',
    )
    // A file reads by its name first, its folder or former path after.
    expect((await ui.find({ key: 'file:docs/new.md' }))?.text).toBe('new.md  ← docs/old.md')
    expect((await ui.find({ key: 'file:src/a.ts' }))?.text).toBe('a.ts  src/')
    expect((await ui.find({ type: 'Text', text: /binaire/ }))?.text).toBe('binaire')

    await ui.press({ key: 'older' })
    expect((await ui.find({ type: 'Text', text: /^Initial$/ }))?.text).toBe('Initial')

    await ui.press({ key: 'back' })
    expect((await ui.find({ type: 'Text', text: /4 commits/ }))?.text).toBe('4 commits')
    await ui.unmount()
  }
})

test('outside a repository the pane says why', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => ({
    value: {
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Pas de graphe/ }))?.text).toBe(
    'Pas de graphe : fatal: not a git repository (or any of the parent directories): .git',
  )
  await ui.unmount()
})
