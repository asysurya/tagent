import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import type { TagentConfig } from './types'
import { getCredential } from './credentials'

const exec = promisify(execFile)

const GH_API = 'https://api.github.com'

/** Default git remote base — override via PushOpts.remoteBase (offline tests, self-hosted git). */
export const DEFAULT_REMOTE_BASE = 'https://github.com/'

/** Default repo name for a workspace root: tagent-<sanitized-basename>. */
export function defaultRepoName(root: string): string {
  const base = path.basename(path.resolve(root)).replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase()
  return `tagent-${base || 'workspace'}`
}

/** Inject a one-shot token into an http(s) git URL. Other schemes (file://, local paths) pass through — they need no auth. */
export function authUrl(url: string, token: string): string {
  if (url.startsWith('https://')) return `https://x-access-token:${token}@${url.slice('https://'.length)}`
  if (url.startsWith('http://')) return `http://x-access-token:${token}@${url.slice('http://'.length)}`
  return url
}

/* ------------------------------ auth ------------------------------ */

export interface DeviceCodeStart {
  device_code: string
  user_code: string
  verification_uri: string
  /** https://github.com/login/device/<code>?user_code=XXXX-XXXX — opens with the code pre-filled. */
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

/**
 * The tagent OAuth App id, baked in once the app exists on github.com/settings/developers.
 * Empty until then — `tagent auth` falls back to paste-a-PAT when unset.
 * Override for testing / self-hosted builds: TAGENT_GH_CLIENT_ID or config github.clientId.
 */
export const BUILTIN_OAUTH_CLIENT_ID = ''

/** Resolution order: env override → the baked-in app → a client id saved in config. */
export function getOAuthClientId(
  envValue?: string,
  configValue?: string,
): string {
  return (envValue && envValue.trim()) || BUILTIN_OAUTH_CLIENT_ID || (configValue && configValue.trim()) || ''
}

/** Start GitHub OAuth device flow (requires a client_id from a GitHub OAuth App). */
export async function startDeviceLogin(clientId: string): Promise<DeviceCodeStart> {
  const res = await fetch(`${GH_API.replace('https://api', 'https://github')}/login/device/code`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: 'repo workflow' }),
  })
  if (!res.ok) throw new Error(`device code failed: HTTP ${res.status}`)
  return (await res.json()) as DeviceCodeStart
}

/** One round-trip of the device-flow token poll — so UIs can poll on their own clock. */
export type DevicePollResult =
  | { status: 'ok'; token: string }
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'error'; error: string }

/** Poll github.com/login/oauth/access_token exactly once. */
export async function pollDeviceTokenOnce(
  clientId: string,
  deviceCode: string,
): Promise<DevicePollResult> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, string>
  if (json.access_token) return { status: 'ok', token: json.access_token }
  if (json.error === 'authorization_pending') return { status: 'pending' }
  if (json.error === 'slow_down') return { status: 'slow_down' }
  return { status: 'error', error: `device flow: ${json.error || `HTTP ${res.status}`}` }
}

export async function pollDeviceToken(
  clientId: string,
  start: DeviceCodeStart,
): Promise<string> {
  const deadline = Date.now() + (start.expires_in ?? 900) * 1000
  let intervalMs = Math.max((start.interval ?? 5) * 1000, 3000)
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs))
    const r = await pollDeviceTokenOnce(clientId, start.device_code)
    if (r.status === 'ok') return r.token
    if (r.status === 'slow_down') {
      intervalMs = Math.min(intervalMs + 5000, 30000) // GitHub asked to back off
      continue
    }
    if (r.status === 'error') throw new Error(r.error)
  }
  throw new Error('device flow timed out')
}

/** Validate a Personal Access Token and return the login. */
export async function validatePat(token: string): Promise<string> {
  const res = await fetch(`${GH_API}/user`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
  })
  if (!res.ok) throw new Error(`invalid token (HTTP ${res.status})`)
  const json = (await res.json()) as { login: string }
  return json.login
}

export interface EnsureRepoResult {
  repo: string
  /** true only when the repo was just created by this call (not when it already existed). */
  created: boolean
}

/**
 * Ensure a repo exists; returns owner/name plus whether WE created it.
 * A 422 on create means the name is taken (e.g. same name, different case —
 * GitHub treats repo names case-insensitively for collisions) — the repo
 * exists either way, so that counts as "not created by us".
 */
export async function ensureRepoDetailed(
  token: string,
  login: string,
  name: string,
): Promise<EnsureRepoResult> {
  const check = await fetch(`${GH_API}/repos/${login}/${name}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (check.ok) return { repo: `${login}/${name}`, created: false }
  if (check.status !== 404) throw new Error(`repo check failed: HTTP ${check.status}`)
  const create = await fetch(`${GH_API}/user/repos`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name, private: true, description: 'Workspace synced by Tagent', auto_init: false }),
  })
  if (create.ok) return { repo: `${login}/${name}`, created: true }
  if (create.status === 422) return { repo: `${login}/${name}`, created: false }
  throw new Error(`repo create failed: HTTP ${create.status} ${await create.text()}`)
}

/** Ensure a repo exists; returns owner/name. (Backward-compatible wrapper.) */
export async function ensureRepo(
  token: string,
  login: string,
  name: string,
): Promise<string> {
  return (await ensureRepoDetailed(token, login, name)).repo
}

/** Delete a repo — the "remove it from GitHub too" arm of `tagent projects`.
 *  Needs a classic PAT with the delete_repo scope; 404 counts as done. */
export async function deleteRepo(token: string, repo: string): Promise<void> {
  const res = await fetch(`${GH_API}/repos/${repo}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
  })
  if (res.status !== 204 && res.status !== 404) {
    throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`)
  }
}

/* ------------------------------ push ------------------------------ */

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: root, timeout: 120_000 })
  return stdout.trim()
}

export interface PushResult {
  repo: string
  branch: string
  commit: string
  created: boolean
  url: string
}

export interface PushOpts {
  /** Remote base URL (default https://github.com/). A non-default base skips
   * GitHub API calls (validatePat / ensureRepo) — used by offline tests and
   * self-hosted git; the remote is assumed to already exist. */
  remoteBase?: string
}

/**
 * Commit the workspace and push to the git remote.
 * The token is used for the push/fetch URLs only — it is never written to
 * .git/config (and FETCH_HEAD, which records the fetch URL verbatim, is
 * scrubbed after use).
 *
 * Multi-device safe: the remote's main is fetched and rebased in before the
 * push, so a project synced from several devices converges instead of being
 * rejected. Non-overlapping edits merge automatically; a true conflict
 * throws a clear "nothing was lost" error and leaves the repo clean.
 */
export async function pushWorkspace(
  root: string,
  cfg: TagentConfig,
  message: string,
  onLog?: (line: string) => void,
  opts?: PushOpts,
): Promise<PushResult> {
  const remoteBase = opts?.remoteBase ?? DEFAULT_REMOTE_BASE
  const isGithub = remoteBase === DEFAULT_REMOTE_BASE
  const token = getCredential('github') || cfg.github?.token
  if (!token) throw new Error('GitHub not connected — run `tagent auth` first, or add a token in Settings → GitHub.')
  const login = cfg.github?.login ?? (isGithub ? await validatePat(token) : 'tagent')
  const repoName = cfg.github?.repo || defaultRepoName(root)
  let repo: string
  let created = false
  if (isGithub) {
    onLog?.(`Ensuring repo ${login}/${repoName}…`)
    const ensured = await ensureRepoDetailed(token, login, repoName)
    repo = ensured.repo
    created = ensured.created
  } else {
    // non-GitHub remote (tests / self-hosted): repo is used verbatim, no API calls
    repo = repoName
  }

  if (!fs.existsSync(path.join(root, '.git'))) {
    onLog?.('Initializing git repository…')
    await git(root, 'init', '-b', 'main')
  }
  // make sure .tagent is ignored before the first commit
  const gi = path.join(root, '.gitignore')
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '.tagent/\n')
  else if (!fs.readFileSync(gi, 'utf8').includes('.tagent')) {
    fs.appendFileSync(gi, '\n.tagent/\n')
  }

  onLog?.('Committing changes…')
  await git(root, 'add', '-A')
  // commit identity: never fail on machines without git identity configured —
  // fall back to `tagent <login>@users.noreply.github.com` via one-shot -c flags
  // (per-invocation; user/global git config is never touched)
  let identity: string[] = []
  try {
    if (!(await git(root, 'config', 'user.email'))) throw new Error('no git identity configured')
  } catch {
    identity = ['-c', 'user.name=tagent', '-c', `user.email=${login || 'tagent'}@users.noreply.github.com`]
  }
  let commit = ''
  try {
    commit = (await git(root, ...identity, 'commit', '-m', message)).split('\n')[0]
  } catch {
    const log = await git(root, 'log', '--oneline', '-1').catch(() => '')
    if (log) commit = log
    else commit = await git(root, ...identity, 'commit', '--allow-empty', '-m', message)
  }

  const cleanRemote = `${remoteBase}${repo}.git`

  /* ---- multi-device: integrate the remote's main BEFORE pushing ----
   * Two devices syncing the same project diverge, and a plain push from the
   * second one would be rejected ("fetch first"). fetch + rebase keeps the
   * history linear and never loses work: edits to different files (or
   * different regions of one file) merge automatically; a true conflict
   * aborts the rebase with a clear message — both versions stay safe, one
   * on each device, and the user resolves manually. */
  const fetchRemote = async (): Promise<boolean> => {
    try {
      await exec('git', ['fetch', authUrl(cleanRemote, token), 'main'], {
        cwd: root,
        timeout: 120_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
      return true
    } catch {
      return false // empty / fresh remote — nothing to integrate
    }
  }
  const integrateRemote = async (): Promise<void> => {
    if (!(await fetchRemote())) return
    try {
      const remoteHead = await git(root, 'rev-parse', 'FETCH_HEAD').catch(() => '')
      if (!remoteHead) return
      const upToDate = await exec(
        'git',
        ['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD'],
        { cwd: root, timeout: 30_000 },
      ).then(() => true, () => false)
      if (upToDate) return
      onLog?.('Remote moved — rebasing your changes on top…')
      await exec(
        'git',
        [...identity, '-c', 'commit.gpgsign=false', 'rebase', 'FETCH_HEAD'],
        { cwd: root, timeout: 120_000 },
      )
    } catch (err) {
      // leave no half-finished rebase behind — abort restores pre-rebase state
      await exec('git', ['rebase', '--abort'], { cwd: root, timeout: 30_000 }).catch(() => undefined)
      const stderr = String((err as { stderr?: string }).stderr ?? '')
      const detail = stderr
        .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('hint:')).slice(-2).join(' · ').slice(0, 160)
      throw new Error(
        'conflict: GitHub has newer changes that overlap with yours — nothing was lost. ' +
        'Run `git pull --rebase` in the project folder, resolve the conflicts, then `tagent sync` again.' +
        (detail ? ` (${detail})` : ''),
      )
    } finally {
      // FETCH_HEAD records the fetch URL verbatim — including the one-shot
      // token. It is transient bookkeeping (every fetch rewrites it), so
      // remove it to keep the "token never on disk" invariant.
      try { fs.rmSync(path.join(root, '.git', 'FETCH_HEAD'), { force: true }) } catch { /* best-effort */ }
    }
  }

  if (!created) await integrateRemote() // just-created repos are empty — nothing to fetch

  onLog?.('Pushing…')
  // keep origin's URL fresh WITHOUT remove/add — `git remote remove` also
  // deletes the branch tracking config (branch.main.remote/.merge) and the
  // refs/remotes/origin/* refs, which would leave every synced clone unable
  // to `git pull` (the manual conflict-recovery path depends on it).
  const curOrigin = await git(root, 'remote', 'get-url', 'origin').catch(() => '')
  if (!curOrigin) await git(root, 'remote', 'add', 'origin', cleanRemote)
  else if (curOrigin !== cleanRemote) await git(root, 'remote', 'set-url', 'origin', cleanRemote)
  // one-time authenticated push — token not persisted in config. If another
  // device pushed in the gap between our fetch and this push, integrate its
  // work once and retry instead of failing.
  for (let attempt = 0; ; attempt++) {
    try {
      await exec(
        'git',
        ['push', authUrl(cleanRemote, token), 'main'],
        { cwd: root, timeout: 180_000 },
      )
      break
    } catch (e) {
      const se = String((e as { stderr?: string }).stderr ?? '')
      // rejection shapes when the remote ref moved on us: the classic
      // "(fetch first)" / "(non-fast-forward)", the push-race "stale info",
      // and the CAS-level "failed to update ref" / "cannot lock ref" that
      // surfaces when another push lands mid-negotiation
      if (attempt === 0 && /fetch first|non-fast-forward|stale[- ]info|failed to update ref|cannot lock ref/i.test(se)) {
        await integrateRemote() // a true conflict throws here — the message says nothing was lost
        continue
      }
      throw e
    }
  }
  const sha = await git(root, 'rev-parse', '--short', 'HEAD').catch(() => '')
  return {
    repo,
    branch: 'main',
    commit: sha || commit.slice(0, 7),
    created,
    url: `${remoteBase}${repo}`,
  }
}
