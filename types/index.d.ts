export type GitRefKind = 'head' | 'local' | 'remote' | 'tag'

export type GitRef = {
  name: string
  kind: GitRefKind
  /** A local branch whose remote-tracking twin points at the same commit. */
  hasRemote?: boolean
}

export type GraphCommit = {
  hash: string
  parents: string[]
  refs: GitRef[]
  subject: string
  author: string
  /** Author date, ISO 8601. */
  date: string
}

export type GraphSnapshot = {
  commits: GraphCommit[]
  /** Current branch, or empty when HEAD is detached. */
  branch: string
  /** What the refs and the working tree looked like when read: a change means a reload. */
  signature: string
  hasMore: boolean
  /** The commit HEAD points at; empty in a repository with no commit yet. */
  head: string
  /** How many paths have uncommitted changes, untracked files included. */
  changes: number
  /** The repository's page on GitHub, or "" when its remote is elsewhere. */
  repoUrl: string
  error?: string
}

export type GraphView = {
  scope: 'all' | 'current'
  limit: number
}

export type FileChange = {
  /** git's status letter: A, M, D, R, C, T. */
  status: string
  path: string
  /** The path before a rename or copy. */
  oldPath?: string
  /** Lines added and deleted; null for a binary file or an untracked one. */
  added: number | null
  deleted: number | null
  /** A new file git does not track yet (only among the uncommitted changes). */
  isUntracked?: boolean
}

/** The changes of one file of the opened commit. */
export type FileDiff = {
  path: string
  isLoading: boolean
  /** The diff's hunks, from the first `@@`; empty for a binary file or a bare rename. */
  source: string
  /** The diff was too long to draw whole: its last hunks are left out. */
  isTruncated: boolean
  error?: string
}

/** The commit opened from the graph, or null while the graph shows. */
export type CommitDetail = {
  hash: string
  isLoading: boolean
  /** The message after its subject line. */
  body: string
  /** The commit is on a remote branch, so its GitHub page exists. */
  isPushed: boolean
  files: FileChange[]
  /** The file whose changes show, or null while the commit's summary shows. */
  file: FileDiff | null
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'git-graph': {
      snapshot: Shaped<GraphSnapshot | null>
      view: Shaped<GraphView>
      detail: Shaped<CommitDetail | null>
      isOpen: boolean
    }
  }
}
