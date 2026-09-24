/**
 * Project sync engine — "login via github untuk menyimpan proyek, proyek
 * sync ke github, lanjutin proyek di device manapun".
 *
 * A small registry (~/.tagent/projects.json) links workspace roots to their
 * GitHub repos, remembers which roots the user refused to link (so we never
 * nag), and stamps the last successful sync. `syncProject` wraps the
 * one-shot-token push in github.ts; `restoreProject` clones a repo back on
 * any device and links it. Tokens are never persisted in any .git/config.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { TagentConfig } from './types'
import { GLOBAL_DIR, readGlobalConfig, updateGlobalConfig } from './config'
import { ensureDir, uid } from './util'
import { getCredential, setCredential, deleteCredential } from './credentials'
import { pushWorkspace, authUrl, DEFAULT_REMOTE_BASE, type PushResult } from './github'

const exec = promisify(execFile)

export interface ProjectReg {
  id: string
  /** workspace display name (basename of root) */
  name: string
  /** owner/name on GitHub (or plain name for non-GitHub remotes) */
  repo: string
  /** resolved absolute workspace path — the registry key */
  root: string
  linkedAt: number
  lastSyncAt?: number
}

export interface SyncOpts {
  message?: string
  /** remote base override (default https://github.com/) — enables offline tests */
  remoteBase?: string
  onLog?: (l: string) => void
}

interface RegistryFile {
  projects: ProjectReg[]
  refused: string[]
}

/* ------------------------------ registry ------------------------------ */

function registryFile(): string {
  return path.join(GLOBAL_DIR, 'projects.json')
}

function isProjectReg(x: unknown): x is ProjectReg {
  if (!x || typeof x !== 'object') return false
  const p = x as Record<string, unknown>
  return (
    typeof p.id === 'string' && typeof p.name === 'string' &&
    typeof p.repo === 'string' && typeof p.root === 'string' &&
    typeof p.linkedAt === 'number'
  )
}

/** Read the registry — corrupt/garbage files start fresh instead of crashing. */
function loadRegistry(): RegistryFile {
  try {
    const raw = JSON.parse(fs.readFileSync(registryFile(), 'utf8')) as Partial<RegistryFile>
    return {
      projects: Array.isArray(raw.projects) ? raw.projects.filter(isProjectReg) : [],
      refused: Array.isArray(raw.refused) ? raw.refused.filter((r) => typeof r === 'string') : [],
    }
  } catch {
    return { projects: [], refused: [] }
  }
}

/** Atomic-ish write: temp file in the same dir, then rename over the target. */
function saveRegistry(reg: RegistryFile): void {
  ensureDir(GLOBAL_DIR)
  const file = registryFile()
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2))
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* best-effort */ }
    throw err
  }
}

export function listProjects(): ProjectReg[] {
  return loadRegistry().projects
}

export function getLinkedProject(root: string): ProjectReg | null {
  const p = path.resolve(root)
  return loadRegistry().projects.find((x) => path.resolve(x.root) === p) ?? null
}

/** Idempotent upsert by resolved root. Linking also clears any refusal. */
export function linkProject(root: string, repo: string): ProjectReg {
  const reg = loadRegistry()
  const p = path.resolve(root)
  const existing = reg.projects.find((x) => path.resolve(x.root) === p)
  let entry: ProjectReg
  if (existing) {
    entry = { ...existing, name: path.basename(p), repo }
    reg.projects = reg.projects.map((x) => (path.resolve(x.root) === p ? entry : x))
  } else {
    entry = { id: uid(), name: path.basename(p), repo, root: p, linkedAt: Date.now() }
    reg.projects.push(entry)
  }
  // a linked root is by definition no longer refused
  reg.refused = reg.refused.filter((r) => path.resolve(r) !== p)
  saveRegistry(reg)
  return entry
}

export function unlinkProject(root: string): boolean {
  const reg = loadRegistry()
  const p = path.resolve(root)
  const before = reg.projects.length
  reg.projects = reg.projects.filter((x) => path.resolve(x.root) !== p)
  if (reg.projects.length === before) return false
  saveRegistry(reg)
  return true
}

/** Stamp lastSyncAt on the linked project (no-op when not linked). */
export function markSynced(root: string): void {
  const reg = loadRegistry()
  const p = path.resolve(root)
  const hit = reg.projects.find((x) => path.resolve(x.root) === p)
  if (!hit) return
  hit.lastSyncAt = Date.now()
  saveRegistry(reg)
}

/** The user declined the sync prompt for this root — don't ask again. */
export function refuseLink(root: string): void {
  const reg = loadRegistry()
  const p = path.resolve(root)
  if (!reg.refused.some((r) => path.resolve(r) === p)) reg.refused.push(p)
  saveRegistry(reg)
}

export function isLinkRefused(root: string): boolean {
  const p = path.resolve(root)
  return loadRegistry().refused.some((r) => path.resolve(r) === p)
}

/** True when the workspace has any entry besides .tagent / .git (top-level scan). */
export function workspaceHasWork(root: string): boolean {
  try {
    for (const entry of fs.readdirSync(root)) {
      if (entry === '.tagent' || entry === '.git') continue
      return true
    }
  } catch {
    /* missing/unreadable dir → no work */
  }
  return false
}

/* ------------------------------ auth ------------------------------ */

/** Whether a GitHub token is available. Reads cached config only — no network. */
export function authStatus(): { logged: boolean; login?: string } {
  const g = readGlobalConfig().github
  // primary: the credential store; legacy fallback: token cached in the global config
  const logged = !!(getCredential('github') || g?.token)
  if (!logged) return { logged: false }
  return { logged: true, login: g?.login || undefined }
}

/** Drop the GitHub credential (store + cached config login/token; clientId is kept). */
export function logout(): void {
  deleteCredential('github')
  try {
    // updateGlobalConfig merges and can't delete keys — patch the raw file
    const file = path.join(GLOBAL_DIR, 'config.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { github?: Record<string, unknown> }
    if (raw.github && ('token' in raw.github || 'login' in raw.github)) {
      delete raw.github.token
      delete raw.github.login
      if (Object.keys(raw.github).length === 0) delete raw.github
      fs.writeFileSync(file, JSON.stringify(raw, null, 2))
    }
  } catch {
    /* no global config / unreadable — nothing to scrub */
  }
}

/* ------------------------------ sync ------------------------------ */

/**
 * Commit the workspace and push to its repo (wraps github.ts pushWorkspace),
 * then record the link + lastSyncAt. A successful sync defines the link —
 * idempotent, so calling this from a manual push is safe.
 * Throws with a clear message when not logged in.
 */
export async function syncProject(
  root: string,
  cfg: TagentConfig,
  opts?: SyncOpts,
): Promise<PushResult> {
  const o = opts ?? {}
  const token = getCredential('github') || cfg.github?.token || readGlobalConfig().github?.token
  if (!token) throw new Error('Not logged in to GitHub — run `tagent auth` first.')
  const result = await pushWorkspace(root, cfg, o.message || 'Update from Tagent', o.onLog, {
    remoteBase: o.remoteBase,
  })
  linkProject(root, result.repo)
  markSynced(root)
  return result
}

/**
 * Clone a synced repo into destDir/<name> and link it — the "continue on any
 * device" path. The token is used one-shot in the clone URL and the remote is
 * immediately rewritten to the clean public URL, so it never persists on disk.
 */
export async function restoreProject(
  token: string,
  repo: string,
  destDir: string,
  opts?: { remoteBase?: string; onLog?: (l: string) => void },
): Promise<{ root: string }> {
  const remoteBase = opts?.remoteBase ?? DEFAULT_REMOTE_BASE
  const name = repo.split('/').pop()?.replace(/\.git$/, '') || 'workspace'
  ensureDir(destDir)
  const target = path.join(destDir, name)
  const url = `${remoteBase}${repo}.git`
  opts?.onLog?.(`Cloning ${repo}…`)
  await exec('git', ['clone', authUrl(url, token), target], { cwd: destDir, timeout: 300_000 })
  // token was one-shot in the clone URL — rewrite to the clean public remote
  await exec('git', ['-C', target, 'remote', 'set-url', 'origin', url], { timeout: 30_000 })
  opts?.onLog?.('Linking restored project…')
  linkProject(target, repo)
  return { root: path.resolve(target) }
}

/* ------------------------------ login helpers ------------------------------ */

/**
 * Persist a validated login: token → credential store, login → global config
 * (that is exactly what authStatus reads). Exported for the CLI `tagent auth`
 * and the GUI login dialog.
 */
export function saveGithubLogin(token: string, login: string): void {
  setCredential('github', token)
  updateGlobalConfig({ github: { login } })
}
