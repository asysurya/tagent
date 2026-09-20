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
  expires_in: number
  interval: number
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

export async function pollDeviceToken(
  clientId: string,
  start: DeviceCodeStart,
): Promise<string> {
  const deadline = Date.now() + (start.expires_in ?? 900) * 1000
  const intervalMs = Math.max((start.interval ?? 5) * 1000, 3000)
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs))
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        device_code: start.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })
    const json = (await res.json()) as Record<string, string>
    if (json.access_token) return json.access_token
    if (json.error && json.error !== 'authorization_pending') {
      throw new Error(`device flow: ${json.error}`)
    }
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
 * The token is used for the push URL only — it is never written to .git/config.
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

  onLog?.('Pushing…')
  const cleanRemote = `${remoteBase}${repo}.git`
  await git(root, 'remote', 'remove', 'origin').catch(() => undefined)
  await git(root, 'remote', 'add', 'origin', cleanRemote)
  // one-time authenticated push — token not persisted in config
  await exec(
    'git',
    ['push', authUrl(cleanRemote, token), 'main'],
    { cwd: root, timeout: 180_000 },
  )
  const sha = await git(root, 'rev-parse', '--short', 'HEAD').catch(() => '')
  return {
    repo,
    branch: 'main',
    commit: sha || commit.slice(0, 7),
    created,
    url: `${remoteBase}${repo}`,
  }
}
