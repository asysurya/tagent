import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import type { TagentConfig } from './types'
import { getCredential } from './credentials'

const exec = promisify(execFile)

const GH_API = 'https://api.github.com'

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

/** Ensure a repo exists; returns owner/name. */
export async function ensureRepo(
  token: string,
  login: string,
  name: string,
): Promise<string> {
  const check = await fetch(`${GH_API}/repos/${login}/${name}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (check.ok) return `${login}/${name}`
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
  if (!create.ok && create.status !== 422) {
    throw new Error(`repo create failed: HTTP ${create.status} ${await create.text()}`)
  }
  return `${login}/${name}`
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

/**
 * Commit the workspace and push to GitHub.
 * The token is used for the push URL only — it is never written to .git/config.
 */
export async function pushWorkspace(
  root: string,
  cfg: TagentConfig,
  message: string,
  onLog?: (line: string) => void,
): Promise<PushResult> {
  const token = getCredential('github') || cfg.github?.token
  if (!token) throw new Error('GitHub not connected — add a token in Settings → GitHub')
  const login = cfg.github?.login ?? (await validatePat(token))
  const repoName = cfg.github?.repo || `tagent-${path.basename(path.resolve(root)).replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase() || 'workspace'}`
  onLog?.(`Ensuring repo ${login}/${repoName}…`)
  const repo = await ensureRepo(token, login, repoName)

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
  let commit = ''
  try {
    commit = (await git(root, 'commit', '-m', message)).split('\n')[0]
  } catch {
    const log = await git(root, 'log', '--oneline', '-1').catch(() => '')
    if (log) commit = log
    else commit = await git(root, 'commit', '--allow-empty', '-m', message)
  }

  onLog?.('Pushing…')
  await git(root, 'remote', 'remove', 'origin').catch(() => undefined)
  await git(root, 'remote', 'add', 'origin', `https://github.com/${repo}.git`)
  // one-time authenticated push — token not persisted in config
  await exec(
    'git',
    ['push', `https://x-access-token:${token}@github.com/${repo}.git`, 'main'],
    { cwd: root, timeout: 180_000 },
  )
  const sha = await git(root, 'rev-parse', '--short', 'HEAD').catch(() => '')
  return {
    repo,
    branch: 'main',
    commit: sha || commit.slice(0, 7),
    created: true,
    url: `https://github.com/${repo}`,
  }
}
