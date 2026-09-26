/**
 * gen-source-snapshot.ts — snapshot the Tagent source tree for the website.
 *
 * Produces (under website/):
 *   public/source/index.json        manifest: file list + metadata + URLs
 *   public/source/tree.json         the whole tree in one shot — dir nodes
 *                                    carry files/dirs/lines aggregates
 *   public/source/dir.json          root directory listing (the dir API)
 *   public/source/dir/<path>.json   one directory's listing — files carry
 *                                    rawUrl/jsonUrl, dirs carry aggregates
 *                                    + their own dirUrl, plus a parent link
 *   public/source/symbols.json      lightweight symbol index (search)
 *   public/source/raw/<path>        raw file contents — humans AND agents
 *   public/source/json/<path>.json  { path, content, language, lines, bytes,
 *                                    lastModified, summary }
 *   src/data/source-snapshot.ts     TS module for the /source page (tree + stats)
 *
 * Every file's metadata also carries `lastModified` (the last git commit
 * date that touched it — mtime fallback for uncommitted files) and
 * `summary` (the first meaningful line of its header comment / first md
 * heading), which the /source/ls API serves without reading contents.
 *
 * The dir listings are fully navigable with zero state: an agent fetches
 * dir.json, follows any child's dirUrl deeper (or parent back up), then
 * rawUrl/jsonUrl to read a file — a walkable file system over plain HTTP.
 *
 * Usage: bun scripts/gen-source-snapshot.ts
 * Test hooks (hermetic): TAGENT_SNAPSHOT_ROOT (repo root), TAGENT_SNAPSHOT_OUT
 * (website dir), TAGENT_SNAPSHOT_VERSION (version override).
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(process.env.TAGENT_SNAPSHOT_ROOT ?? path.join(import.meta.dir, '..'))
const OUT = path.resolve(process.env.TAGENT_SNAPSHOT_OUT ?? path.join(ROOT, 'website'))
const SRC_DIR = path.join(OUT, 'public', 'source')

/* ---------------------------------------------------------------- config -- */

/** directory roots (relative to repo root) that are walked recursively */
const INCLUDE_ROOTS = [
  'packages/core/src',
  'packages/cli/src',
  'src',
  'website/src',
  'scripts',
  'native',
  'docs',
  'demo-workspace',
  'mini-services',
  'builtin-skills',
]

/** individual root-level files added when they exist */
const ROOT_FILES = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'WORKLOG.md',
  'LICENSE',
  'package.json',
  'tsconfig.json',
  'next.config.ts',
  'tailwind.config.ts',
  'postcss.config.mjs',
  'eslint.config.mjs',
  'components.json',
  'prisma/schema.prisma',
  'bin/tagent',
  'packages/core/package.json',
  'packages/core/tsconfig.json',
  'packages/cli/package.json',
  'packages/cli/tsconfig.json',
  'website/README.md',
  'website/next.config.ts',
  'website/package.json',
  'website/tsconfig.json',
  'website/postcss.config.mjs',
]

/** directory names never entered, anywhere in the walk */
const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'generated', // packages/cli/src/generated/gui-bundle.ts — built from src/
  'public', // website/public — images + the snapshot itself
  '.git',
  '.tagent',
  'coverage',
  '__pycache__',
  '.turbo',
  '.vercel',
  'db',
  'test-results',
  'playwright-report',
])

/** file names never included */
const EXCLUDE_FILES = new Set([
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'dev.log',
  '.DS_Store',
])

const MAX_BYTES = 512 * 1024

const LANG_BY_EXT: Record<string, string> = {
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  jsx: 'jsx',
  mjs: 'js',
  cjs: 'js',
  json: 'json',
  md: 'md',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  css: 'css',
  html: 'html',
  htm: 'html',
  svg: 'html',
  go: 'go',
  mod: 'go',
  py: 'py',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'txt',
  txt: 'txt',
}

function languageOf(file: string): string {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
  return LANG_BY_EXT[ext] ?? (ext === file ? 'txt' : 'txt')
}

/** URL-safe path (repo paths are tame, but be strict anyway) */
function encPath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/')
}

/* ------------------------------------------------------------- version -- */

function readVersion(): string {
  if (process.env.TAGENT_SNAPSHOT_VERSION) return process.env.TAGENT_SNAPSHOT_VERSION
  try {
    const vf = fs.readFileSync(path.join(ROOT, 'packages/core/src/version.ts'), 'utf8')
    const m = vf.match(/CURRENT_VERSION\s*=\s*'([^']+)'/)
    if (m) return m[1]
  } catch {
    /* fixture roots have no version.ts */
  }
  return 'dev'
}

/* ------------------------------------------------- lastModified + summary */

/**
 * One `git log` pass → map of repo path → last commit date (YYYY-MM-DD).
 * Newer commits come first, so the first time a path is seen wins. When git
 * is unavailable (hermetic fixtures) the map is empty and collectFile falls
 * back to the filesystem mtime.
 */
function gitLastModified(): Map<string, string> {
  const map = new Map<string, string>()
  try {
    const out = execFileSync(
      'git',
      ['log', '--no-merges', '--name-only', '--date=short', '--format=%x00%ad'],
      { cwd: ROOT, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
    )
    for (const chunk of (out as string).split('\0')) {
      const lines = chunk.split('\n').filter(Boolean)
      if (lines.length < 2) continue
      const date = lines[0]
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      for (const f of lines.slice(1)) if (!map.has(f)) map.set(f, date)
    }
  } catch {
    /* no git / no history — the mtime fallback in collectFile applies */
  }
  return map
}

const GIT_DATES = gitLastModified()

/** collapse + de-decorate a candidate summary line */
function cleanSummary(s: string): string | null {
  const t = s.replace(/\s+/g, ' ').replace(/^[-\u2013\u2014:]+\s*/, '').trim()
  return t ? t.slice(0, 160) : null
}

/**
 * The file's one-line "what is this": the first meaningful line of its
 * leading block/line comment (JSDoc header), its first md heading, or the
 * first comment line of a shell script / python docstring. null when the
 * file starts straight into code.
 */
function summaryOf(content: string, language: string): string | null {
  const lines = content.split('\n')
  if (language === 'md') {
    for (const line of lines) {
      const m = line.match(/^#{1,3}\s+(.+)/)
      if (m) return cleanSummary(m[1])
    }
    return null
  }
  let i = 0
  while (i < lines.length) {
    const t = lines[i].trim()
    if (t === '' || t.startsWith('#!')) {
      i++
      continue
    }
    break
  }
  const first = (lines[i] ?? '').trim()
  if (!first) return null
  let m: RegExpMatchArray | null
  if ((m = first.match(/^\/\*\*?\s*(.*)$/))) {
    // block comment (JSDoc) — m[1] is the rest of the opening line, then the
    // comment body lines follow until the closing */
    const out: string[] = []
    const closedOnOpening = /\*\//.test(m[1])
    const opening = m[1].replace(/\*\/.*$/, '').trim()
    if (opening && !opening.startsWith('@')) out.push(opening)
    if (!closedOnOpening) {
      for (let j = i + 1; j < lines.length && out.length < 2; j++) {
        const endedHere = lines[j].includes('*/')
        const b = lines[j].replace(/^\s*\*+\s?/, '').replace(/\*\/.*$/, '').trim()
        if (!b || b.startsWith('@')) {
          if (out.length) break
          else continue
        }
        out.push(b)
        if (endedHere) break
      }
    }
    return out.length ? cleanSummary(out.join(' ')) : null
  }
  if ((m = first.match(/^\/\/\s?(.*)$/))) return cleanSummary(m[1])
  if ((m = first.match(/^#\s?(.*)$/)) && (language === 'sh' || language === 'py')) return cleanSummary(m[1])
  if (language === 'py' && (m = first.match(/^"""(.*)$/))) {
    const out: string[] = []
    for (let j = i; j < lines.length && out.length < 2; j++) {
      let l = lines[j].replace(/^"""/, '').replace(/""".*$/, '').trim()
      if (!l) {
        if (out.length) break
        continue
      }
      out.push(l)
    }
    return out.length ? cleanSummary(out.join(' ')) : null
  }
  return null
}

/* ------------------------------------------------------------- walking -- */

interface SnapFile {
  path: string
  bytes: number
  lines: number
  language: string
  content: string
  lastModified: string | null
  summary: string | null
}

const excluded: string[] = []

function excludedBecause(rel: string, why: string) {
  excluded.push(`${rel} (${why})`)
}

function isSecretOrJunk(name: string): boolean {
  return (
    EXCLUDE_FILES.has(name) ||
    name.startsWith('.env') ||
    name.endsWith('.pem') ||
    name.endsWith('.pyc') ||
    name.endsWith('.tsbuildinfo')
  )
}

function walkDir(absDir: string, relDir: string, out: SnapFile[]) {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true })
  } catch {
    excludedBecause(relDir, 'unreadable')
    return
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = relDir ? `${relDir}/${e.name}` : e.name
    const abs = path.join(absDir, e.name)
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) {
        excludedBecause(`${rel}/`, `dir: ${e.name}`)
        continue
      }
      walkDir(abs, rel, out)
    } else if (e.isFile()) {
      collectFile(abs, rel, out)
    }
  }
}

function collectFile(abs: string, rel: string, out: SnapFile[]) {
  const name = rel.slice(rel.lastIndexOf('/') + 1)
  if (isSecretOrJunk(name)) {
    excludedBecause(rel, 'file: lock/log/secret pattern')
    return
  }
  let stat: fs.Stats
  try {
    stat = fs.statSync(abs)
  } catch {
    return
  }
  if (stat.size > MAX_BYTES) {
    excludedBecause(rel, `too large: ${Math.round(stat.size / 1024)} KB > 512 KB cap`)
    return
  }
  const content = fs.readFileSync(abs, 'utf8')
  if (content.includes('\0')) {
    excludedBecause(rel, 'binary')
    return
  }
  const language = languageOf(rel)
  out.push({
    path: rel,
    bytes: stat.size,
    lines: content.split('\n').length,
    language,
    content,
    lastModified: GIT_DATES.get(rel) ?? stat.mtime.toISOString().slice(0, 10),
    summary: summaryOf(content, language),
  })
}

/* ------------------------------------------------------------- symbols -- */

interface Symbol {
  n: string
  f: string
  l: number
  k: string
}

const TS_DECL =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/

function symbolsOf(f: SnapFile): Symbol[] {
  const syms: Symbol[] = []
  const lines = f.content.split('\n')
  for (let i = 0; i < lines.length && syms.length < 300; i++) {
    const line = lines[i]
    let m: RegExpMatchArray | null
    switch (f.language) {
      case 'ts':
      case 'tsx':
      case 'js':
      case 'jsx':
        m = line.match(TS_DECL)
        if (m) syms.push({ n: m[2], f: f.path, l: i + 1, k: kindOf(m[1]) })
        break
      case 'md':
        m = line.match(/^(#{1,3})\s+(.+)$/)
        if (m) syms.push({ n: m[2].slice(0, 80), f: f.path, l: i + 1, k: 'heading' })
        break
      case 'go':
        m = line.match(/^\s*(func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/)
        if (m) syms.push({ n: m[2], f: f.path, l: i + 1, k: m[1] })
        break
      case 'py':
        m = line.match(/^\s*(def|class)\s+([A-Za-z_]\w*)/)
        if (m) syms.push({ n: m[2], f: f.path, l: i + 1, k: m[1] === 'def' ? 'func' : 'class' })
        break
      case 'sh':
        m = line.match(/^\s*([a-zA-Z_]\w*)\s*\(\)\s*\{/)
        if (m) syms.push({ n: m[1], f: f.path, l: i + 1, k: 'func' })
        break
    }
  }
  return syms
}

function kindOf(kw: string): string {
  if (kw.startsWith('function')) return 'func'
  return kw
}

/* ----------------------------------------------------------------- tree -- */

type TreeNode =
  | { type: 'dir'; name: string; path: string; children: TreeNode[] }
  | { type: 'file'; name: string; path: string; bytes: number; lines: number; language: string }

function buildTree(files: SnapFile[]): TreeNode {
  const root: TreeNode = { type: 'dir', name: '', path: '', children: [] }
  for (const f of files) {
    const parts = f.path.split('/')
    let cur: TreeNode = root
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]
      const curPath = parts.slice(0, i + 1).join('/')
      let next = (cur as { children: TreeNode[] }).children.find(
        (c) => c.type === 'dir' && c.name === seg,
      ) as TreeNode | undefined
      if (!next) {
        next = { type: 'dir', name: seg, path: curPath, children: [] }
        ;(cur as { children: TreeNode[] }).children.push(next)
      }
      cur = next
    }
    ;(cur as { children: TreeNode[] }).children.push({
      type: 'file',
      name: parts[parts.length - 1],
      path: f.path,
      bytes: f.bytes,
      lines: f.lines,
      language: f.language,
    })
  }
  const sortNode = (n: TreeNode) => {
    if (n.type !== 'dir') return
    n.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    n.children.forEach(sortNode)
  }
  sortNode(root)
  return root
}

function countDirs(node: TreeNode): number {
  if (node.type !== 'dir') return 0
  return 1 + node.children.reduce((acc, c) => acc + countDirs(c), 0)
}

/* -------------------------------------------------------------- dir API -- */

type FileNode = Extract<TreeNode, { type: 'file' }>

const dirUrlOf = (p: string) => (p ? `/source/dir/${encPath(p)}.json` : '/source/dir.json')

/** files/dirs/lines totals for a subtree (a dir counts itself in `dirs`) */
function statsOf(node: TreeNode): { files: number; dirs: number; lines: number } {
  if (node.type === 'file') return { files: 1, dirs: 0, lines: node.lines }
  return node.children.reduce(
    (acc, c) => {
      const s = statsOf(c)
      return { files: acc.files + s.files, dirs: acc.dirs + s.dirs, lines: acc.lines + s.lines }
    },
    { files: 0, dirs: 1, lines: 0 },
  )
}

function fileEntry(f: FileNode) {
  return {
    type: 'file' as const,
    name: f.name,
    path: f.path,
    bytes: f.bytes,
    lines: f.lines,
    language: f.language,
    rawUrl: `/source/raw/${encPath(f.path)}`,
    jsonUrl: `/source/json/${encPath(f.path)}.json`,
  }
}

/** one listing per directory: dir.json for the root, dir/<path>.json below */
function emitDirListing(dir: TreeNode, parentPath: string | null, version: string) {
  if (dir.type !== 'dir') return
  const listing = {
    version,
    path: dir.path,
    dirUrl: dirUrlOf(dir.path),
    parent: parentPath === null ? null : { path: parentPath, dirUrl: dirUrlOf(parentPath) },
    children: dir.children.map((c) =>
      c.type === 'file'
        ? fileEntry(c)
        : { type: 'dir' as const, name: c.name, path: c.path, ...statsOf(c), dirUrl: dirUrlOf(c.path) },
    ),
  }
  const abs = dir.path
    ? path.join(SRC_DIR, 'dir', `${dir.path}.json`)
    : path.join(SRC_DIR, 'dir.json')
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, JSON.stringify(listing))
  for (const c of dir.children) if (c.type === 'dir') emitDirListing(c, dir.path, version)
}

/** tree.json — the full structure in ONE fetch, every node self-describing */
function augNode(node: TreeNode): unknown {
  if (node.type === 'file') return fileEntry(node)
  return {
    type: 'dir' as const,
    name: node.name,
    path: node.path,
    ...statsOf(node),
    dirUrl: dirUrlOf(node.path),
    children: node.children.map(augNode),
  }
}

/* ----------------------------------------------------------------- main -- */

function main() {
  const version = readVersion()
  const files: SnapFile[] = []

  for (const rel of INCLUDE_ROOTS) {
    const abs = path.join(ROOT, rel)
    if (fs.existsSync(abs)) walkDir(abs, rel, files)
    else excludedBecause(rel, 'root missing')
  }
  for (const rel of ROOT_FILES) {
    const abs = path.join(ROOT, rel)
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) collectFile(abs, rel, files)
  }

  files.sort((a, b) => a.path.localeCompare(b.path))

  const symbols = files.flatMap(symbolsOf).slice(0, 25000)
  const tree = buildTree(files)

  const generatedAt = new Date().toISOString().slice(0, 10)
  const counts = {
    files: files.length,
    dirs: countDirs(tree),
    lines: files.reduce((a, f) => a + f.lines, 0),
    bytes: files.reduce((a, f) => a + f.bytes, 0),
    symbols: symbols.length,
  }

  // clean the output dir — it is fully regenerated every run
  fs.rmSync(SRC_DIR, { recursive: true, force: true })
  fs.mkdirSync(SRC_DIR, { recursive: true })

  for (const f of files) {
    const rawAbs = path.join(SRC_DIR, 'raw', f.path)
    fs.mkdirSync(path.dirname(rawAbs), { recursive: true })
    fs.writeFileSync(rawAbs, f.content)
    const jsonAbs = path.join(SRC_DIR, 'json', `${f.path}.json`)
    fs.mkdirSync(path.dirname(jsonAbs), { recursive: true })
    fs.writeFileSync(
      jsonAbs,
      JSON.stringify({
        path: f.path,
        content: f.content,
        language: f.language,
        lines: f.lines,
        bytes: f.bytes,
        lastModified: f.lastModified,
        summary: f.summary,
        rawUrl: `/source/raw/${encPath(f.path)}`,
      }),
    )
  }

  // the dir API: root listing → per-dir listings → tree.json
  emitDirListing(tree, null, version)
  fs.writeFileSync(
    path.join(SRC_DIR, 'tree.json'),
    JSON.stringify({ version, counts, tree: augNode(tree) }),
  )

  const manifest = {
    version,
    generatedAt,
    counts,
    excluded: [
      // static notes first — explain what the walk NEVER includes
      'node_modules/ (dependencies — fetch from the registry, not the repo)',
      'bun.lock / package-lock.json (lockfiles — see git history)',
      'website/public/ (site assets + this snapshot itself)',
      'dist/ · .next/ · binaries (build output)',
      '.env* / secrets (never snapshotted)',
      'files > 512 KB (cap)',
      ...excluded,
    ],
    files: files.map((f) => ({
      path: f.path,
      bytes: f.bytes,
      lines: f.lines,
      language: f.language,
      ...(f.lastModified ? { lastModified: f.lastModified } : {}),
      ...(f.summary ? { summary: f.summary } : {}),
      rawUrl: `/source/raw/${encPath(f.path)}`,
      jsonUrl: `/source/json/${encPath(f.path)}.json`,
    })),
    tree,
  }
  fs.writeFileSync(path.join(SRC_DIR, 'index.json'), JSON.stringify(manifest))
  fs.writeFileSync(
    path.join(SRC_DIR, 'symbols.json'),
    JSON.stringify({ version, counts: { symbols: symbols.length }, symbols }),
  )

  // the TS module the /source page imports (tree + stats, NO file contents)
  const moduleSrc = `// GENERATED by scripts/gen-source-snapshot.ts — do not edit by hand.
// Regenerate: bun scripts/gen-source-snapshot.ts

export interface SourceFileMeta {
  path: string
  bytes: number
  lines: number
  language: string
  /** last git commit that touched the file (YYYY-MM-DD; mtime fallback) */
  lastModified?: string
  /** first meaningful line of the file's header comment / first md heading */
  summary?: string
  rawUrl: string
  jsonUrl: string
}

export interface SourceDirNode {
  type: 'dir'
  name: string
  path: string
  children: SourceNode[]
}

export interface SourceFileNode {
  type: 'file'
  name: string
  path: string
  bytes: number
  lines: number
  language: string
}

export type SourceNode = SourceDirNode | SourceFileNode

export interface SourceSnapshot {
  version: string
  generatedAt: string
  counts: { files: number; dirs: number; lines: number; bytes: number; symbols: number }
  excluded: string[]
  files: SourceFileMeta[]
  tree: SourceDirNode
}

export const SOURCE_SNAPSHOT: SourceSnapshot = ${JSON.stringify(manifest)} as const
`
  const modPath = path.join(OUT, 'src', 'data', 'source-snapshot.ts')
  fs.mkdirSync(path.dirname(modPath), { recursive: true })
  fs.writeFileSync(modPath, moduleSrc)

  const kb = (n: number) => `${Math.round(n / 1024)} KB`
  console.log(`[snapshot] v${version} · ${counts.files} files · ${counts.dirs} dirs · ${counts.lines} lines · ${kb(counts.bytes)} source`)
  console.log(`[snapshot] ${symbols.length} symbols · ${excluded.length} excluded entries`)
  console.log(`[snapshot] dir listings   → ${counts.dirs} files under public/source/dir/ (+ dir.json root + tree.json)`)
  console.log(`[snapshot] raw+json+index → ${path.relative(ROOT, SRC_DIR)}`)
  console.log(`[snapshot] page module    → ${path.relative(ROOT, modPath)}`)
}

main()
