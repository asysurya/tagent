/**
 * source-ls.ts — the queryable directory API behind /source/ls.
 *
 * `ls` for the Tagent source snapshot: list one folder, walk it recursively,
 * find files by name, stat a single file, or fetch the curated quickref map.
 * Everything is served from the build-time snapshot (SOURCE_SNAPSHOT — the
 * same data as /source/index.json) through one in-memory index per server
 * instance: no filesystem access, no per-request rescans, no cache to
 * invalidate beyond the deploy itself (every response carries
 * `snapshot: { version, generatedAt }` as the build stamp).
 *
 * Routes (thin adapters over handleLsApi):
 *   GET /source/ls?path=&recursive=&depth=&all=&detail=&layer=
 *   GET /source/ls/find?q=&layer=&limit=
 *   GET /source/ls/stat?path=<file>
 *   GET /source/ls/quickref
 *
 * JSON by default; plain text (a `tree`-style listing) when the client asks:
 * `Accept: text/plain` or `?format=text`.
 *
 * Path safety: paths are looked up in the in-memory snapshot tree, never on
 * disk — there is nothing to traverse. `.` / `..` segments, backslashes, NUL
 * and control characters are still rejected outright (400) so the contract
 * is hardened even against future refactors.
 */
import { SOURCE_SNAPSHOT } from '../data/source-snapshot'
import type { SourceFileMeta } from '../data/source-snapshot'
import { SOURCE_QUICKREF } from '../data/source-quickref'

/* ------------------------------------------------------------- errors -- */

export class LsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'LsError'
  }
}

/* ------------------------------------------------------ the data model -- */

type LsDirNode = { type: 'dir'; name: string; path: string; children: LsNode[] }
type LsFileNode = { type: 'file'; name: string; path: string; meta: SourceFileMeta }
type LsNode = LsDirNode | LsFileNode

interface SnapshotIndex {
  root: LsDirNode
  dirs: Map<string, LsDirNode> // '' → root
  files: Map<string, LsFileNode>
  aggregates: Map<string, { files: number; lines: number }> // per dir path, no layer filter
}

let INDEX: SnapshotIndex | null = null

/** build the in-memory tree once per server instance (323 files — sub-ms) */
function index(): SnapshotIndex {
  if (INDEX) return INDEX
  const root: LsDirNode = { type: 'dir', name: '', path: '', children: [] }
  const dirs = new Map<string, LsDirNode>([['', root]])
  const files = new Map<string, LsFileNode>()

  const dirOf = (dirPath: string): LsDirNode => {
    let d = dirs.get(dirPath)
    if (!d) {
      const parentPath = parentOf(dirPath)
      const name = dirPath.slice(dirPath.lastIndexOf('/') + 1)
      d = { type: 'dir', name, path: dirPath, children: [] }
      dirs.set(dirPath, d)
      dirOf(parentPath).children.push(d)
    }
    return d
  }

  for (const meta of SOURCE_SNAPSHOT.files) {
    const name = meta.path.slice(meta.path.lastIndexOf('/') + 1)
    const node: LsFileNode = { type: 'file', name, path: meta.path, meta }
    files.set(meta.path, node)
    dirOf(parentOf(meta.path)).children.push(node)
  }

  const sortDir = (d: LsDirNode) => {
    d.children.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)))
    for (const c of d.children) if (c.type === 'dir') sortDir(c)
  }
  sortDir(root)

  const aggregates = new Map<string, { files: number; lines: number }>()
  const agg = (d: LsDirNode): { files: number; lines: number } => {
    let a = aggregates.get(d.path)
    if (!a) {
      a = { files: 0, lines: 0 }
      for (const c of d.children) {
        const s = c.type === 'file' ? { files: 1, lines: c.meta.lines } : agg(c)
        a.files += s.files
        a.lines += s.lines
      }
      aggregates.set(d.path, a)
    }
    return a
  }
  agg(root)

  INDEX = { root, dirs, files, aggregates }
  return INDEX
}

/* --------------------------------------------------------------- paths -- */

const MAX_PATH_LEN = 512

/**
 * Normalize a query path to its snapshot-internal form ('' = root).
 * Leading/trailing '/' are stripped; '.', '..', empty segments, backslashes,
 * NUL and control characters are rejected.
 */
export function normalizeQueryPath(raw: string | null | undefined): string {
  if (raw == null) return ''
  if (raw.length > MAX_PATH_LEN) throw new LsError(400, 'bad_path', 'path is longer than 512 characters')
  if (raw.includes('\0')) throw new LsError(400, 'bad_path', 'path contains a NUL byte')
  if (raw.includes('\\')) throw new LsError(400, 'bad_path', 'backslash is not a path separator here — use /')
  const p = raw.trim().replace(/^\/+/, '').replace(/\/+$/, '')
  if (p === '') return ''
  const segs = p.split('/')
  for (const s of segs) {
    if (s === '') throw new LsError(400, 'bad_path', 'empty path segment (double slash)')
    if (s === '.' || s === '..')
      throw new LsError(400, 'path_traversal', 'rejected: "." and ".." are not allowed — paths are always snapshot-relative')
    if (/[\u0000-\u001f\u007f]/.test(s)) throw new LsError(400, 'bad_path', 'control characters in path')
  }
  return segs.join('/')
}

/** parent path of a snapshot-internal path ('packages/core' → 'packages', 'bin' → '') */
function parentOf(internal: string): string {
  const slash = internal.lastIndexOf('/')
  return slash === -1 ? '' : internal.slice(0, slash)
}

const apiPath = (internal: string) => (internal === '' ? '/' : `/${internal}`)

function dirAt(internal: string): LsDirNode {
  const idx = index()
  const d = idx.dirs.get(internal)
  if (!d) {
    if (idx.files.has(internal))
      throw new LsError(400, 'not_a_directory', `"${apiPath(internal)}" is a file — use /source/ls/stat?path=${encodeURIComponent(apiPath(internal))} or its rawUrl`, {
        hint: `/source/ls/stat?path=${encodeURIComponent(apiPath(internal))}`,
      })
    throw new LsError(404, 'not_found', `no such directory in this snapshot: "${apiPath(internal)}"`, {
      hint: 'GET /source/ls to list the root, or /source/ls/find?q=… to search',
    })
  }
  return d
}

/* --------------------------------------------------------------- layers -- */

export const LAYERS: Record<string, readonly string[]> = {
  core: ['packages/core'],
  cli: ['packages/cli'],
  gui: ['src'],
  website: ['website'],
  native: ['native'],
  scripts: ['scripts'],
}

function layerPrefixes(layer: string | null | undefined): readonly string[] | null {
  if (!layer) return null
  const p = LAYERS[layer]
  if (!p)
    throw new LsError(400, 'bad_layer', `unknown layer "${layer}"`, {
      layers: Object.keys(LAYERS),
      hint: 'try one of: ' + Object.keys(LAYERS).join(', '),
    })
  return p
}

/** inside the layer, or an ancestor directory on the way to it */
function inLayer(path: string, prefixes: readonly string[] | null): boolean {
  if (!prefixes) return true
  if (path === '') return true
  for (const p of prefixes) {
    if (path === p || path.startsWith(p + '/')) return true
    if (p.startsWith(path + '/')) return true
  }
  return false
}

function visibleChildren(d: LsDirNode, prefixes: readonly string[] | null): LsNode[] {
  return d.children.filter((c) => inLayer(c.path, prefixes))
}

/** subtree aggregates, layer-filtered */
function aggregate(d: LsDirNode, prefixes: readonly string[] | null): { files: number; lines: number } {
  if (!prefixes) return index().aggregates.get(d.path) ?? { files: 0, lines: 0 }
  let files = 0
  let lines = 0
  for (const c of d.children) {
    if (c.type === 'file') {
      if (inLayer(c.path, prefixes)) {
        files++
        lines += c.meta.lines
      }
    } else {
      const s = aggregate(c, prefixes)
      files += s.files
      lines += s.lines
    }
  }
  return { files, lines }
}

/* ------------------------------------------------------------- results -- */

export interface LsSnapshotInfo {
  version: string
  generatedAt: string
}

export interface LsFileEntry {
  name: string
  type: 'file'
  size: number
  lines: number
  language: string
  path?: string
  lastModified?: string | null
  rawUrl?: string
  jsonUrl?: string
}

export interface LsDirEntry {
  name: string
  type: 'directory'
  children: number
  path?: string
  files?: number
  lines?: number
  dirUrl?: string
}

export type LsEntry = LsFileEntry | LsDirEntry

export interface LsTreeNode {
  name: string
  type: 'directory'
  files: number
  lines: number
  children: LsTreeChild[] | number // array while expanded; the count at the depth cut
  path?: string
}

/** inside a recursive tree: expanded dirs and plain file entries */
export type LsTreeChild = LsTreeNode | LsFileEntry

export interface LsResultBase {
  snapshot: LsSnapshotInfo
  path: string
  parent: string | null
  totalFiles: number
  totalLines: number
  all?: boolean
  layer?: string
  hiddenDirs?: string[]
  note?: string
}

export interface LsFlatResult extends LsResultBase {
  recursive: false
  entries: LsEntry[]
}

export interface LsTreeResult extends LsResultBase {
  recursive: true
  depth: number
  tree: LsTreeNode
}

export type LsResult = LsFlatResult | LsTreeResult

export const MAX_DEPTH = 8

/** directory names that are never part of the snapshot (excluded at build) */
export const HIDDEN_DIRS = [
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'gui-dist',
  'coverage',
  '__pycache__',
  '.turbo',
  '.vercel',
  '.tagent',
  'test-results',
  'playwright-report',
]

const LANG_DISPLAY: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  json: 'json',
  md: 'markdown',
  sh: 'shell',
  css: 'css',
  html: 'html',
  go: 'go',
  py: 'python',
  yaml: 'yaml',
  txt: 'text',
}

const displayLang = (code: string) => LANG_DISPLAY[code] ?? code

const dirUrlOf = (internal: string) => (internal === '' ? '/source/dir.json' : `/source/dir/${internal}.json`)

/* ------------------------------------------------------------------ ls -- */

export interface LsQuery {
  path?: string | null
  recursive?: boolean
  depth?: number
  all?: boolean
  detail?: boolean
  layer?: string | null
}

function fileEntry(n: LsFileNode, detail: boolean): LsFileEntry {
  const e: LsFileEntry = {
    name: n.name,
    type: 'file',
    size: n.meta.bytes,
    lines: n.meta.lines,
    language: displayLang(n.meta.language),
  }
  if (detail)
    Object.assign(e, {
      path: apiPath(n.path),
      lastModified: n.meta.lastModified ?? null,
      rawUrl: n.meta.rawUrl,
      jsonUrl: n.meta.jsonUrl,
    })
  return e
}

function dirEntry(d: LsDirNode, prefixes: readonly string[] | null, detail: boolean): LsDirEntry {
  const e: LsDirEntry = { name: d.name, type: 'directory', children: visibleChildren(d, prefixes).length }
  if (detail) {
    const agg = aggregate(d, prefixes)
    Object.assign(e, { path: apiPath(d.path), files: agg.files, lines: agg.lines, dirUrl: dirUrlOf(d.path) })
  }
  return e
}

function buildTreeNode(d: LsDirNode, prefixes: readonly string[] | null, remaining: number, detail: boolean): LsTreeNode {
  const agg = aggregate(d, prefixes)
  const vis = visibleChildren(d, prefixes)
  const node: LsTreeNode = {
    name: d.path === '' ? 'tagent' : d.name,
    type: 'directory',
    files: agg.files,
    lines: agg.lines,
    children:
      remaining <= 0
        ? vis.length // the depth cut: the count, like the flat dir entries
        : vis.map((c) => (c.type === 'file' ? fileEntry(c, detail) : buildTreeNode(c, prefixes, remaining - 1, detail))),
  }
  if (detail) node.path = apiPath(d.path)
  return node
}

export function ls(q: LsQuery): LsResult {
  const internal = normalizeQueryPath(q.path)
  const dir = dirAt(internal)
  const prefixes = layerPrefixes(q.layer)
  const depth = q.depth ?? 1
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH)
    throw new LsError(400, 'bad_param', `depth must be an integer between 1 and ${MAX_DEPTH} — got ${JSON.stringify(String(q.depth ?? depth))}`)

  const parent = internal === '' ? null : apiPath(parentOf(internal))
  const agg = aggregate(dir, prefixes)
  const base: LsResultBase = {
    snapshot: { version: SOURCE_SNAPSHOT.version, generatedAt: SOURCE_SNAPSHOT.generatedAt },
    path: apiPath(internal),
    parent,
    totalFiles: agg.files,
    totalLines: agg.lines,
  }
  if (q.layer) base.layer = q.layer
  if (q.all) {
    base.all = true
    base.hiddenDirs = HIDDEN_DIRS
    base.note = 'node_modules, .git, dist, build, .next, gui-dist (and friends) are excluded at snapshot time — they are never in the index; all=true surfaces this list instead of their contents.'
  }

  if (q.recursive) {
    const result: LsTreeResult = { ...base, recursive: true, depth, tree: buildTreeNode(dir, prefixes, depth, q.detail ?? false) }
    return result
  }
  const result: LsFlatResult = {
    ...base,
    recursive: false,
    entries: visibleChildren(dir, prefixes).map((c) => (c.type === 'file' ? fileEntry(c, q.detail ?? false) : dirEntry(c, prefixes, q.detail ?? false))),
  }
  return result
}

/* ---------------------------------------------------------------- find -- */

export interface FindQuery {
  q: string
  layer?: string | null
  limit?: number
}

export interface FindResultItem {
  name: string
  path: string
  type: 'file' | 'directory'
  lines?: number
  language?: string
  files?: number
}

export interface FindResult {
  snapshot: LsSnapshotInfo
  q: string
  total: number
  count: number
  truncated: boolean
  limit: number
  layer?: string
  results: FindResultItem[]
}

export const MAX_FIND_LIMIT = 200

export function find(query: FindQuery): FindResult {
  const q = (query.q ?? '').trim()
  if (!q) throw new LsError(400, 'missing_query', 'q is required — e.g. /source/ls/find?q=loop')
  if (q.length > 256) throw new LsError(400, 'bad_query', 'q is longer than 256 characters')
  const limit = query.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FIND_LIMIT)
    throw new LsError(400, 'bad_param', `limit must be an integer between 1 and ${MAX_FIND_LIMIT} — got ${JSON.stringify(String(query.limit))}`)
  const prefixes = layerPrefixes(query.layer)
  const ql = q.toLowerCase()

  const ranked: Array<{ rank: number; item: FindResultItem }> = []
  for (const f of index().files.values()) {
    if (!inLayer(f.path, prefixes)) continue
    const rank = f.name.toLowerCase().includes(ql) ? 0 : f.path.toLowerCase().includes(ql) ? 1 : -1
    if (rank < 0) continue
    ranked.push({ rank, item: { name: f.name, path: apiPath(f.path), type: 'file', lines: f.meta.lines, language: displayLang(f.meta.language) } })
  }
  for (const [dirPath, d] of index().dirs) {
    if (dirPath === '' || !inLayer(dirPath, prefixes)) continue
    const rank = d.name.toLowerCase().includes(ql) ? 0 : dirPath.toLowerCase().includes(ql) ? 1 : -1
    if (rank < 0) continue
    const agg = aggregate(d, prefixes)
    ranked.push({ rank, item: { name: d.name, path: apiPath(dirPath), type: 'directory', files: agg.files } })
  }
  ranked.sort((a, b) => a.rank - b.rank || a.item.path.localeCompare(b.item.path))

  const total = ranked.length
  const results = ranked.slice(0, limit).map((r) => r.item)
  const out: FindResult = {
    snapshot: { version: SOURCE_SNAPSHOT.version, generatedAt: SOURCE_SNAPSHOT.generatedAt },
    q,
    total,
    count: results.length,
    truncated: total > results.length,
    limit,
    results,
  }
  if (query.layer) out.layer = query.layer
  return out
}

/* ---------------------------------------------------------------- stat -- */

export interface StatResult {
  snapshot: LsSnapshotInfo
  path: string
  name: string
  type: 'file'
  size: number
  lines: number
  language: string
  lastModified: string | null
  summary: string | null
  rawUrl: string
  jsonUrl: string
  dirUrl: string
}

export function stat(path: string | null | undefined): StatResult {
  const internal = normalizeQueryPath(path)
  const f = index().files.get(internal)
  if (!f) {
    if (index().dirs.has(internal))
      throw new LsError(400, 'not_a_file', `"${apiPath(internal)}" is a directory — use /source/ls?path=${encodeURIComponent(apiPath(internal))} to list it`)
    throw new LsError(404, 'not_found', `no such file in this snapshot: "${apiPath(internal)}"`, {
      hint: 'GET /source/ls/find?q=… to locate it, or /source/index.json for the full list',
    })
  }
  const parentInternal = parentOf(internal)
  return {
    snapshot: { version: SOURCE_SNAPSHOT.version, generatedAt: SOURCE_SNAPSHOT.generatedAt },
    path: apiPath(internal),
    name: f.name,
    type: 'file',
    size: f.meta.bytes,
    lines: f.meta.lines,
    language: displayLang(f.meta.language),
    lastModified: f.meta.lastModified ?? null,
    summary: f.meta.summary ?? null,
    rawUrl: f.meta.rawUrl,
    jsonUrl: f.meta.jsonUrl,
    dirUrl: dirUrlOf(parentInternal),
  }
}

/* ------------------------------------------------------------- quickref -- */

export interface QuickrefEntry {
  label: string
  paths: string[]
  note?: string
  ok: boolean
}

export interface QuickrefResult {
  snapshot: LsSnapshotInfo
  count: number
  entries: QuickrefEntry[]
  map: Record<string, string | string[]>
  stale: Array<{ label: string; missing: string[] }>
}

export function quickref(): QuickrefResult {
  const have = index().files
  const entries: QuickrefEntry[] = SOURCE_QUICKREF.map((e) => ({
    label: e.label,
    paths: e.paths,
    ...(e.note ? { note: e.note } : {}),
    ok: e.paths.every((p) => have.has(p)),
  }))
  const map: Record<string, string | string[]> = {}
  for (const e of entries) map[e.label] = e.paths.length === 1 ? apiPath(e.paths[0]) : e.paths.map(apiPath)
  const stale = entries.filter((e) => !e.ok).map((e) => ({ label: e.label, missing: e.paths.filter((p) => !have.has(p)) }))
  return {
    snapshot: { version: SOURCE_SNAPSHOT.version, generatedAt: SOURCE_SNAPSHOT.generatedAt },
    count: entries.length,
    entries,
    map,
    stale,
  }
}

/* --------------------------------------------------------- plain text -- */

function fmtKb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}

export function renderLsText(r: LsResult): string {
  const head = `tagent v${r.snapshot.version} — snapshot ${r.snapshot.generatedAt}`
  const totals = `${r.totalFiles.toLocaleString('en-US')} files · ${r.totalLines.toLocaleString('en-US')} lines`
  const out: string[] = [head, '', `${r.path} — ${totals}${r.layer ? ` · layer ${r.layer}` : ''}`]

  const lines: string[] = []
  const emit = (prefix: string, branch: string, label: string, meta: string) =>
    lines.push(`${prefix}${branch}${label}${meta}`)

  if (r.recursive) {
    const walk = (node: LsTreeNode, prefix: string) => {
      if (!Array.isArray(node.children)) return
      const kids = node.children
      const w = Math.max(...kids.map((n) => (n.name + (n.type === 'directory' ? '/' : '')).length)) + 2
      kids.forEach((n, i) => {
        const last = i === kids.length - 1
        const branch = last ? '└── ' : '├── '
        const label = (n.name + (n.type === 'directory' ? '/' : '')).padEnd(w)
        const meta =
          n.type === 'file'
            ? `${n.lines.toLocaleString('en-US')} lines`
            : typeof n.children === 'number'
              ? `${n.children} entries (deeper — raise depth or ls this path)`
              : `${n.files.toLocaleString('en-US')} files · ${n.lines.toLocaleString('en-US')} lines`
        emit(prefix, branch, label, meta)
        if (n.type === 'directory' && Array.isArray(n.children)) walk(n, prefix + (last ? '    ' : '│   '))
      })
    }
    walk(r.tree, '')
  } else {
    const w = Math.max(...r.entries.map((n) => (n.name + (n.type === 'directory' ? '/' : '')).length)) + 2
    r.entries.forEach((n, i) => {
      const last = i === r.entries.length - 1
      const branch = last ? '└── ' : '├── '
      const label = (n.name + (n.type === 'directory' ? '/' : '')).padEnd(w)
      const meta = n.type === 'file' ? `${n.lines.toLocaleString('en-US')} lines` : `${n.children} entries`
      emit('', branch, label, meta)
    })
  }

  out.push('')
  out.push(...lines)
  if (r.hiddenDirs) {
    out.push('', `never in the snapshot: ${r.hiddenDirs.join(', ')}`)
  }
  return out.join('\n') + '\n'
}

export function renderFindText(r: FindResult): string {
  const out = [`find "${r.q}" — ${r.total} match${r.total === 1 ? '' : 'es'}${r.truncated ? ` (showing ${r.count}, limit ${r.limit})` : ''}`]
  for (const it of r.results) {
    const meta = it.type === 'file' ? `file · ${(it.lines ?? 0).toLocaleString('en-US')} lines · ${it.language}` : `directory · ${(it.files ?? 0).toLocaleString('en-US')} files`
    out.push(`${it.path.padEnd(Math.max(48, it.path.length + 2))}${meta}`)
  }
  if (r.results.length === 0) out.push('no matches')
  return out.join('\n') + '\n'
}

export function renderStatText(r: StatResult): string {
  const rows: Array<[string, string]> = [
    ['size', `${fmtKb(r.size)} (${r.size.toLocaleString('en-US')} bytes)`],
    ['lines', r.lines.toLocaleString('en-US')],
    ['language', r.language],
    ['modified', r.lastModified ?? 'unknown'],
    ['summary', r.summary ?? '—'],
    ['raw', r.rawUrl],
    ['json', r.jsonUrl],
    ['listing', r.dirUrl],
  ]
  const w = Math.max(...rows.map(([k]) => k.length)) + 2
  return [`${r.path}`, ...rows.map(([k, v]) => `  ${(k + ':').padEnd(w)}${v}`)].join('\n') + '\n'
}

export function renderQuickrefText(r: QuickrefResult): string {
  const out = [`tagent v${r.snapshot.version} — quickref: where things live (${r.count} entries)`]
  const w = Math.max(...r.entries.map((e) => e.label.length)) + 2
  for (const e of r.entries) {
    const where = e.paths.length === 1 ? apiPath(e.paths[0]) : e.paths.map(apiPath).join(' · ')
    out.push(`${e.label.padEnd(w)}${where}${e.ok ? '' : '  [stale]'}`)
  }
  if (r.stale.length) out.push('', `stale entries (paths missing from this snapshot): ${r.stale.map((s) => s.label).join(', ')}`)
  return out.join('\n') + '\n'
}

export function renderErrorText(e: LsError): string {
  const out = [`${e.status} ${e.code} — ${e.message}`]
  const hint = e.extra && typeof e.extra.hint === 'string' ? e.extra.hint : undefined
  if (hint) out.push(`hint: ${hint}`)
  if (e.extra?.layers) out.push(`layers: ${(e.extra.layers as string[]).join(', ')}`)
  return out.join('\n') + '\n'
}

/* ------------------------------------------------------------ the HTTP -- */

const CACHE_CONTROL = 'public, max-age=600, s-maxage=3600'

export type LsApiKind = 'ls' | 'find' | 'stat' | 'quickref'

export function wantsText(request: Request, url: URL): boolean {
  const f = (url.searchParams.get('format') ?? '').trim().toLowerCase()
  if (f === 'text' || f === 'txt' || f === 'plain') return true
  if (f === 'json') return false
  return (request.headers.get('accept') ?? '').includes('text/plain')
}

function parseBoolParam(url: URL, name: string, def: boolean): boolean {
  const raw = url.searchParams.get(name)
  if (raw == null || raw === '') return def
  const v = raw.trim().toLowerCase()
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false
  throw new LsError(400, 'bad_param', `?${name} must be a boolean (true/false) — got ${JSON.stringify(raw)}`)
}

function parseIntParam(url: URL, name: string, def: number, min: number, max: number): number {
  const raw = url.searchParams.get(name)
  if (raw == null || raw === '') return def
  const v = Number(raw)
  if (!Number.isInteger(v) || v < min || v > max)
    throw new LsError(400, 'bad_param', `?${name} must be an integer between ${min} and ${max} — got ${JSON.stringify(raw)}`)
  return v
}

function respond(body: string, status: number, text: boolean): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': text ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'cache-control': CACHE_CONTROL,
      vary: 'Accept',
    },
  })
}

function errorResponse(e: LsError, text: boolean): Response {
  const body: Record<string, unknown> = { error: e.message, code: e.code, status: e.status }
  if (e.extra) for (const [k, v] of Object.entries(e.extra)) body[k] = v
  return respond(text ? renderErrorText(e) : JSON.stringify(body, null, 2) + '\n', e.status, text)
}

/**
 * The one handler every route delegates to. `kind` picks the endpoint;
 * the request supplies the query. Runs against the in-memory snapshot —
 * no filesystem, no state, safe to cache at the CDN.
 */
export function handleLsApi(request: Request, kind: LsApiKind): Response {
  const url = new URL(request.url)
  const text = wantsText(request, url)
  try {
    let payload: LsResult | FindResult | StatResult | QuickrefResult
    let body: string | null = null
    switch (kind) {
      case 'ls': {
        const p = ls({
          path: url.searchParams.get('path'),
          recursive: parseBoolParam(url, 'recursive', false),
          depth: parseIntParam(url, 'depth', 1, 1, MAX_DEPTH),
          all: parseBoolParam(url, 'all', false),
          detail: parseBoolParam(url, 'detail', false),
          layer: url.searchParams.get('layer'),
        })
        payload = p
        body = renderLsText(p)
        break
      }
      case 'find': {
        const p = find({
          q: url.searchParams.get('q') ?? '',
          layer: url.searchParams.get('layer'),
          limit: parseIntParam(url, 'limit', 50, 1, MAX_FIND_LIMIT),
        })
        payload = p
        body = renderFindText(p)
        break
      }
      case 'stat': {
        const p = stat(url.searchParams.get('path'))
        payload = p
        body = renderStatText(p)
        break
      }
      case 'quickref': {
        const p = quickref()
        payload = p
        body = renderQuickrefText(p)
        break
      }
    }
    return respond(text ? body! : JSON.stringify(payload, null, 2) + '\n', 200, text)
  } catch (e) {
    if (e instanceof LsError) return errorResponse(e, text)
    return errorResponse(new LsError(500, 'internal', e instanceof Error ? e.message : String(e)), text)
  }
}
