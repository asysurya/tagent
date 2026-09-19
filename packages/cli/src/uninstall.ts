/**
 * uninstall.ts — `tagent uninstall`: remove EVERYTHING tagent-related.
 *
 * Finds and lists, then deletes (after confirmation):
 *   a. the global data dir  (~/.tagent — config, credentials, models, agents…)
 *   b. the `tagent` command  (~/.local/bin/tagent, /usr/local/bin/tagent)
 *   c. the bun global link   (~/.bun/install/global — link + package.json entry)
 *   d. the source repo       (own confirmation — it may contain user work)
 *   e. the release binary    (own confirmation — self-delete of the running exe)
 *
 * Per-workspace `.tagent/` dirs inside project folders are never touched,
 * except the current workspace's, which gets its own default-no offer.
 *
 * The plan building is factored out (`collectUninstallTargets` / `planToString`)
 * so tests can run it against a fake home without deleting anything real
 * (scripts/test-uninstall.ts). Removals never throw — failures are reported
 * and the rest continues.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { GLOBAL_DIR, homeDir } from '@tagent/core'
import { confirm } from './select'

/* ------------------------------------------------------------------ */
/* tiny ansi (same style as index.ts — dependency-free)                */
/* ------------------------------------------------------------------ */

function bold(s: string): string { return process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s }
function dim(s: string): string { return process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s }
function green(s: string): string { return process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s }
function red(s: string): string { return process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s }

/** bytes → human — same style as the TUI's fmtBytes (core exports none). */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}GB`
}

/** recursive du (bytes) — never follows symlinks, never throws. */
export function pathSize(p: string): number {
  try {
    const st = fs.lstatSync(p)
    if (!st.isDirectory()) return st.size // a file (or a symlink's own size)
  } catch {
    return 0
  }
  let total = 0
  const stack: string[] = [p]
  while (stack.length) {
    const cur = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const child = path.join(cur, e.name)
      try {
        if (e.isDirectory()) stack.push(child)
        else if (e.isFile()) total += fs.statSync(child).size
        // symlinks & specials: counted as 0 — we never follow
      } catch { /* unreadable — skip */ }
    }
  }
  return total
}

/* ------------------------------------------------------------------ */
/* markers / path helpers                                              */
/* ------------------------------------------------------------------ */

/** a plain file only counts as ours when it carries the launcher header */
export const LAUNCHER_HEADER = '# Tagent launcher'

/** does this dir look like the tagent source repo? (root package.json name + packages/cli) */
export function isTagentRepo(root: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { name?: string }
    if (pkg?.name !== 'tagent') return false
    return fs.existsSync(path.join(root, 'packages', 'cli', 'package.json'))
  } catch {
    return false
  }
}

/** is `child` equal to or inside `parent`? */
export function isInside(child: string, parent: string): boolean {
  const c = path.resolve(child)
  const p = path.resolve(parent)
  return c === p || c.startsWith(p + path.sep)
}

/** git status --porcelain line count (modified/untracked) — undefined when git can't tell. */
export function gitDirtyCount(repo: string): number | undefined {
  try {
    const r = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', timeout: 15_000 })
    if (r.status !== 0 || r.error) return undefined
    return r.stdout.split('\n').filter((l) => l.trim().length > 0).length
  } catch {
    return undefined
  }
}

/**
 * The repo root this file lives in, when running from source.
 * Compiled single-file binaries live in bun's virtual fs ($bunfs) — there is
 * no source repo to delete then.
 */
export function defaultRepoRoot(): string | undefined {
  if (import.meta.url.startsWith('file:///$bunfs')) return undefined
  try {
    const here = path.dirname(fileURLToPath(import.meta.url)) // <repo>/packages/cli/src
    const root = path.resolve(here, '..', '..', '..')
    if (isTagentRepo(root)) return root
  } catch { /* fall through */ }
  return undefined
}

/* ------------------------------------------------------------------ */
/* the plan — pure, testable, deletes nothing                          */
/* ------------------------------------------------------------------ */

export type ItemKind =
  | 'global-dir'      // ~/.tagent
  | 'command-link'    // ~/.local/bin/tagent, /usr/local/bin/tagent
  | 'bun-link'        // ~/.bun/install/global/node_modules/tagent
  | 'bun-package-json' // the "tagent" entry inside the bun global package.json
  | 'workspace-dir'   // <workspace>/.tagent
  | 'repo'            // the source repo itself
  | 'binary'          // a downloaded release binary (self-delete)

export interface UninstallItem {
  kind: ItemKind
  /** short human label */
  label: string
  /** absolute path */
  path: string
  /** bytes, when sensible */
  size?: number
  /** dim extra line */
  detail?: string
}

export interface UninstallPlan {
  /** removed under the single main confirmation */
  items: UninstallItem[]
  /** the source repo — ALWAYS its own confirmation */
  repo?: UninstallItem
  /** modified/untracked file count in the repo (undefined = git can't tell) */
  repoDirty?: number
  /** a downloaded release binary — own confirmation, same section as the repo */
  binary?: UninstallItem
  /** the current workspace's .tagent — own confirmation, default no */
  workspace?: UninstallItem
  /** dim notes (things we deliberately left alone) */
  notes: string[]
}

export interface CollectOptions {
  home: string
  /** default: GLOBAL_DIR from @tagent/core */
  globalDir?: string
  /** dirs that may hold the `tagent` command — default: [~/.local/bin, /usr/local/bin] */
  binDirs?: string[]
  /** default: <home>/.bun/install/global */
  bunGlobalDir?: string
  /** repo root candidate — default: resolved from this file's location */
  repoRoot?: string
  /** default: process.cwd() */
  cwd?: string
  /** TAGENT_WORKSPACE — default: process.env.TAGENT_WORKSPACE */
  envWorkspace?: string
  /** default: process.execPath */
  execPath?: string
  /** default: process.argv[1] */
  argv1?: string
}

/** symlink target or '?' — never throws */
function readLinkSafe(p: string): string {
  try {
    return fs.readlinkSync(p)
  } catch {
    return '?'
  }
}

/**
 * Is the file at `p` (named `tagent`) ours to delete?
 * Symlinks are ours (they're named exactly `tagent` in a bin dir); plain files
 * only when their content carries the tagent launcher header. Anything else —
 * directories, unrelated binaries, unreadable files — is left alone.
 */
function inspectCommandCandidate(p: string): { ours: boolean; detail?: string; note?: string } {
  let st: fs.Stats
  try {
    st = fs.lstatSync(p)
  } catch {
    return { ours: false } // not there
  }
  if (st.isSymbolicLink()) {
    const target = readLinkSafe(p)
    let dead = false
    try {
      fs.statSync(p) // follows — throws when the target is gone
    } catch {
      dead = true
    }
    return { ours: true, detail: dead ? `dead symlink → ${target}` : `symlink → ${target}` }
  }
  if (st.isFile()) {
    try {
      const head = fs.readFileSync(p, 'utf8').slice(0, 256)
      if (head.includes(LAUNCHER_HEADER)) return { ours: true, detail: 'launcher copy (plain file)' }
      return { ours: false, note: `${p} is not a tagent launcher — left in place` }
    } catch {
      return { ours: false, note: `${p} unreadable — left in place` }
    }
  }
  return { ours: false, note: `${p} is a directory — left in place` }
}

/** does the bun global package.json register a "tagent" dependency? */
function bunDepsHaveTagent(pj: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(pj, 'utf8')) as { dependencies?: Record<string, unknown> }
    return !!raw.dependencies && Object.prototype.hasOwnProperty.call(raw.dependencies, 'tagent')
  } catch {
    return false
  }
}

/**
 * A downloaded release binary running as this process — offered for
 * self-delete. Only when the executable (or entry script) is named /^tagent/
 * and lives OUTSIDE the repo (inside it, the repo section owns it).
 */
function releaseBinaryPath(execPath: string, argv1: string | undefined, repoRoot?: string): string | undefined {
  for (const c of [execPath, argv1]) {
    if (!c) continue
    const base = path.basename(c).replace(/\.exe$/i, '')
    if (!/^tagent/.test(base)) continue
    const abs = path.resolve(c)
    if (!fs.existsSync(abs)) continue
    if (repoRoot && isInside(abs, repoRoot)) continue
    return abs
  }
  return undefined
}

/** Find everything tagent-related. Pure: reads the fs, never deletes. */
export function collectUninstallTargets(opts: CollectOptions): UninstallPlan {
  const home = opts.home
  const globalDir = opts.globalDir ?? GLOBAL_DIR
  const binDirs = opts.binDirs ?? [path.join(home, '.local', 'bin'), '/usr/local/bin']
  const bunGlobalDir = opts.bunGlobalDir ?? path.join(home, '.bun', 'install', 'global')
  const cwd = opts.cwd ?? process.cwd()
  const repoRoot = opts.repoRoot ?? defaultRepoRoot()
  const notes: string[] = []
  const items: UninstallItem[] = []

  // (a) global data — ~/.tagent
  if (fs.existsSync(globalDir)) {
    items.push({
      kind: 'global-dir',
      label: 'global data',
      path: globalDir,
      size: pathSize(globalDir),
      detail: 'config, credentials, models, agents, gui-cache',
    })
  }

  // (b) the command — `tagent` on the PATH
  for (const dir of binDirs) {
    const p = path.join(dir, 'tagent')
    const info = inspectCommandCandidate(p)
    if (info.ours) items.push({ kind: 'command-link', label: 'command', path: p, detail: info.detail })
    else if (info.note) notes.push(info.note)
  }

  // (c) bun link registration — ~/.bun/install/global
  {
    const nm = path.join(bunGlobalDir, 'node_modules', 'tagent')
    if (fs.existsSync(nm)) {
      const target = readLinkSafe(nm)
      items.push({
        kind: 'bun-link',
        label: 'bun global link',
        path: nm,
        detail: target !== '?' ? `symlink → ${target}` : undefined,
      })
    }
    const pj = path.join(bunGlobalDir, 'package.json')
    if (bunDepsHaveTagent(pj)) {
      items.push({
        kind: 'bun-package-json',
        label: 'bun global registration',
        path: pj,
        detail: 'removes the "tagent" entry from dependencies',
      })
    }
  }

  const plan: UninstallPlan = { items, notes }

  // (d) the source repo — own confirmation, may contain user work
  if (repoRoot && isTagentRepo(repoRoot)) {
    plan.repo = { kind: 'repo', label: 'source repo', path: repoRoot, size: pathSize(repoRoot) }
    plan.repoDirty = gitDirtyCount(repoRoot)
  }

  // (e) a downloaded release binary — own confirmation, same section as the repo
  const binPath = releaseBinaryPath(opts.execPath ?? process.execPath, opts.argv1 ?? process.argv[1], repoRoot)
  if (binPath) plan.binary = { kind: 'binary', label: 'release binary', path: binPath }

  // (f) the current workspace's .tagent — offered, default no.
  // (inside the repo it goes with the repo — never offered twice)
  const wsEnv = (opts.envWorkspace ?? process.env.TAGENT_WORKSPACE ?? '').trim()
  const wsRoot = wsEnv || cwd
  const wsDir = path.join(wsRoot, '.tagent')
  if (fs.existsSync(wsDir) && !(plan.repo && isInside(wsDir, plan.repo.path))) {
    plan.workspace = {
      kind: 'workspace-dir',
      label: 'workspace data',
      path: wsDir,
      size: pathSize(wsDir),
      detail: 'sessions, agents, file-state of this workspace',
    }
  }

  return plan
}

/** Render the enumerated plan (sizes + dim paths + notes) — pure. */
export function planToString(plan: UninstallPlan): string {
  const lines: string[] = []
  if (plan.items.length > 0) {
    lines.push('  found:')
    plan.items.forEach((it, i) => {
      const size = it.size !== undefined ? ` ${dim('· ' + fmtBytes(it.size))}` : ''
      lines.push(`  ${String(i + 1).padStart(2)}. ${it.label}${size}`)
      lines.push(`     ${dim(it.path)}`)
      if (it.detail) lines.push(`     ${dim(it.detail)}`)
    })
  }
  const extra: string[] = []
  if (plan.repo) {
    const size = plan.repo.size !== undefined ? ` ${dim('· ' + fmtBytes(plan.repo.size))}` : ''
    extra.push(`source repo — ${plan.repo.path}${size}`)
  }
  if (plan.binary) extra.push(`release binary — ${plan.binary.path}`)
  if (plan.workspace) {
    const size = plan.workspace.size !== undefined ? ` ${dim('· ' + fmtBytes(plan.workspace.size))}` : ''
    extra.push(`workspace — ${plan.workspace.path}${size}`)
  }
  if (extra.length > 0) {
    lines.push('')
    lines.push('  asked separately:')
    for (const e of extra) lines.push(`  ${dim('·')} ${dim(e)}`)
  }
  lines.push('')
  lines.push('  notes:')
  lines.push(dim("  · per-workspace .tagent/ dirs inside your projects are NOT touched — find them with:"))
  lines.push(dim('    find ~/projects -maxdepth 2 -name .tagent -type d'))
  for (const n of plan.notes) lines.push(dim(`  · ${n}`))
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* execution — try/catch every removal, report failures, continue      */
/* ------------------------------------------------------------------ */

export interface RemovalResult {
  ok: boolean
  item: UninstallItem
  error?: string
}

/** Delete one plan item. Never throws — returns a result instead. */
export function removeItem(item: UninstallItem): RemovalResult {
  try {
    switch (item.kind) {
      case 'bun-package-json': {
        // remove just the "tagent" entry, keep every other registration
        const raw = JSON.parse(fs.readFileSync(item.path, 'utf8')) as { dependencies?: Record<string, string> }
        if (raw.dependencies) delete raw.dependencies['tagent']
        fs.writeFileSync(item.path, JSON.stringify(raw, null, 2) + '\n')
        return { ok: true, item }
      }
      case 'repo': {
        // never delete the directory the process is standing in
        try {
          if (isInside(process.cwd(), item.path)) process.chdir(os.homedir())
        } catch { /* chdir is best-effort — rm works on a dangling cwd anyway */ }
        fs.rmSync(item.path, { recursive: true, force: true })
        return { ok: true, item }
      }
      default:
        // symlinks: removes the link, not its target (lstat semantics)
        fs.rmSync(item.path, { recursive: true, force: true })
        return { ok: true, item }
    }
  } catch (e) {
    return { ok: false, item, error: (e as Error).message }
  }
}

/* ------------------------------------------------------------------ */
/* the command                                                         */
/* ------------------------------------------------------------------ */

/**
 * `tagent uninstall [--yes]` — print everything found, confirm, remove it all.
 * The repo and release binary always get their own confirmations (even with
 * --yes — too destructive to bundle). Never throws.
 */
export async function uninstall(opts: { yes?: boolean }): Promise<void> {
  const plan = collectUninstallTargets({
    home: homeDir(),
    cwd: process.cwd(),
    envWorkspace: process.env.TAGENT_WORKSPACE,
    execPath: process.execPath,
    argv1: process.argv[1],
  })

  console.log(`\n  ${bold('tagent uninstall')} — removes everything tagent-related\n`)

  if (plan.items.length === 0 && !plan.repo && !plan.binary) {
    console.log(green('  ✔ nothing tagent-related found — already clean'))
    console.log(dim('  (per-workspace .tagent/ dirs in your projects are never touched)\n'))
    return
  }

  console.log(planToString(plan))

  // ---- main confirmation (--yes skips it) ----
  if (plan.items.length > 0 && !opts.yes) {
    const yes = await confirm('Uninstall tagent? This cannot be undone', { default: false, cancelable: true })
    if (!yes) {
      console.log(dim('\n  aborted — nothing was deleted\n'))
      return
    }
  }

  // ---- workspace offer (default no) ----
  const ws = plan.workspace
    ? await confirm(`also remove the workspace data in ${plan.workspace.path}?`, { default: false, cancelable: true }) === true
    : false

  // ---- the source repo — ALWAYS its own confirmation ----
  let repo = false
  if (plan.repo) {
    const p = plan.repo.path
    const size = plan.repo.size !== undefined ? ` ${dim('· ' + fmtBytes(plan.repo.size))}` : ''
    console.log(`\n  ${bold('source repo')} — ${dim(p)}${size}`)
    if (plan.repoDirty === undefined) console.log(dim('  git status unavailable — assume there may be uncommitted work'))
    else if (plan.repoDirty > 0) console.log(red(`  ⚠ ${plan.repoDirty} modified/untracked file(s) — uncommitted work will be lost`))
    else console.log(dim('  git clean — no uncommitted changes'))
    console.log(dim('  sessions, .tagent/ agent defs, PRDs and local changes live here'))
    repo = await confirm(`also delete the source repo at ${p}?`, { default: false, cancelable: true }) === true
  }

  // ---- the release binary — own confirmation, same section ----
  const bin = plan.binary
    ? await confirm(`also delete the binary at ${plan.binary.path}?`, { default: false, cancelable: true }) === true
    : false

  // ---- execute: every removal guarded, failures reported, rest continues ----
  const queue: UninstallItem[] = [...plan.items]
  if (ws && plan.workspace) queue.push(plan.workspace)
  if (repo && plan.repo) queue.push(plan.repo)
  if (bin && plan.binary) queue.push(plan.binary)

  if (queue.length === 0) {
    console.log(dim('\n  nothing selected — nothing was deleted\n'))
    return
  }

  const results: RemovalResult[] = queue.map(removeItem)

  const okd = results.filter((r) => r.ok)
  const bad = results.filter((r) => !r.ok)
  console.log('')
  if (okd.length > 0) console.log(`  ${green('tagent fully removed')}`)
  for (const r of okd) console.log(dim(`  ✔ ${r.item.label} — ${r.item.path}`))
  for (const r of bad) {
    console.log(red(`  ✗ could not remove ${r.item.label}: ${r.item.path}`))
    if (r.item.kind === 'binary' && process.platform === 'win32') {
      // a running exe cannot be deleted on windows
      console.log(red(`    close tagent first, then delete the file yourself`))
    } else {
      console.log(dim(`    ${r.error ?? ''}`))
    }
  }
  if (okd.length > 0 && plan.workspace && !ws) {
    console.log(dim(`  (kept: workspace data at ${plan.workspace.path})`))
  }
  console.log('')
}
