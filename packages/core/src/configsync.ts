/**
 * Global config sync — "kalo auth nanti tagent otomatis bikin repo private
 * untuk default config / global, jadi config nya bakal sama meskipun beda
 * device".
 *
 * One PRIVATE repo (default name `tagent-config`) holds the user's WHOLE
 * global config — provider + every apikey (the keychain), models, mcp
 * servers, permissions, theme, fallback chain, … — sealed in an encrypted
 * vault file. The GitHub token NEVER rides along (it stays in each device's
 * credential store); the vault passphrase is shared per device exactly like
 * the project vault (credential `vault`, /repo).
 *
 * Layout:
 *   GitHub  login/tagent-config      private, auto-created on first auth
 *          ├─ vault.json              encrypted ConfigPayload (AES-256-GCM)
 *          └─ README.md
 *   local  ~/.tagent/config-repo/     tiny git checkout doing the push/pull
 *          ~/.tagent/config-sync.json state: repo, last push/pull, hashes
 *
 * Semantics (the same discipline as the project sync engine — no data loss):
 *   push = local config is the truth (fetch+rebase before pushing; a deleted
 *          repo is recreated on the fly)
 *   pull = remote config is the truth (per-key merge into the global config)
 *
 * Health: `tagent start` checks the repo exists and WARNS when it is gone —
 * /config push recreates it with the local config.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CustomProviderConfig, McpServerConfig, TagentConfig } from './types'
import { GLOBAL_DIR, readGlobalConfig, updateGlobalConfig } from './config'
import { ensureDir, deepMerge } from './util'
import { getCredential } from './credentials'
import { DEFAULT_REMOTE_BASE, ensureRepoDetailed, authUrl, validatePat } from './github'
import { mergeKeychain } from './keychain'
import {
  encryptVaultJSON,
  decryptVaultJSON,
  parseVaultFile,
  getVaultPassphrase,
  setVaultPassphrase,
  generatePassphrase,
  type VaultFile,
} from './vault'

const exec = promisify(execFile)

/** Default repo name for the global config. */
export const CONFIG_REPO_NAME = 'tagent-config'

/** The tiny local checkout that pushes/pulls the config repo. */
export function configRepoDir(): string {
  return path.join(GLOBAL_DIR, 'config-repo')
}

/* ------------------------------ state ------------------------------ */

export interface ConfigSyncState {
  /** owner/name on GitHub */
  repo?: string
  lastPushAt?: number
  lastPullAt?: number
  /** local payload hash at the last push */
  payloadHash?: string
  /** remote vault payload hash applied last (kills re-apply churn) */
  appliedHash?: string
  /** last time the repo was confirmed MISSING on GitHub (the start warning) */
  repoMissingAt?: number
}

function stateFile(): string {
  return path.join(GLOBAL_DIR, 'config-sync.json')
}

export function readConfigSyncState(): ConfigSyncState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as ConfigSyncState
  } catch {
    return {}
  }
}

export function writeConfigSyncState(patch: ConfigSyncState): void {
  try {
    const next = { ...readConfigSyncState(), ...patch }
    ensureDir(GLOBAL_DIR)
    fs.writeFileSync(stateFile(), JSON.stringify(next, null, 2))
  } catch {
    /* state is an optimization — never break sync over it */
  }
}

/** login + token for the config repo (credential store → legacy config). */
export function configSyncAuth(): { token?: string; login?: string } {
  const g = readGlobalConfig().github
  const token = getCredential('github') || g?.token
  return { token, login: g?.login }
}

/* ------------------------------ payload ------------------------------ */

export interface ConfigPayload {
  v: 2
  savedAt: number
  config: Partial<TagentConfig>
}

/** Keys that are device-local and never travel: the token (credential store
 * only), the per-project repo override, absolute workspace paths. */
const DEVICE_LOCAL: { drop: (k: string) => boolean } = {
  drop: (k) => k === 'token' || k === 'repo',
}

/** Whole global config → payload (secrets stay, the vault encrypts them). */
export function exportConfigPayload(): ConfigPayload {
  const g = readGlobalConfig() as unknown as Record<string, unknown>
  const config: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(g)) {
    if (k === 'recentWorkspaces') continue // absolute paths, device-specific
    if (k === 'github' && v && typeof v === 'object') {
      const gh: Record<string, unknown> = {}
      for (const [gk, gv] of Object.entries(v as Record<string, unknown>)) {
        if (DEVICE_LOCAL.drop(gk)) continue
        if (gv !== undefined) gh[gk] = gv
      }
      config.github = gh // login + clientId travel; token/repo never do
      continue
    }
    if (v !== undefined) config[k] = v
  }
  return { v: 2, savedAt: Date.now(), config: config as Partial<TagentConfig> }
}

/** payload rendered + hashed — change detection without the scrypt churn. */
export function hashConfigPayload(p: ConfigPayload): string {
  const { savedAt, ...rest } = p
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex')
}

/** Merge a pulled payload into the LOCAL global config. "Remote is the
 *  truth" — per key the remote value wins; keychain + custom providers
 *  union (never lose an entry); mcp servers merge by name. Returns the
 *  top-level keys that actually moved. */
export function applyConfigPayload(p: ConfigPayload): { changed: string[] } {
  const g = readGlobalConfig() as unknown as Record<string, unknown>
  const remote = (p?.config ?? {}) as Record<string, unknown>
  const changed: string[] = []
  const next: Record<string, unknown> = {}

  for (const [k, rv] of Object.entries(remote)) {
    if (k === 'recentWorkspaces') continue
    switch (k) {
      case 'keychain': {
        const fresh = mergeKeychain((rv as never) ?? [])
        if (fresh.length) changed.push(`keys(${fresh.length})`)
        continue
      }
      case 'apiKeys': {
        const cur = { ...((g.apiKeys as Record<string, string>) ?? {}) }
        for (const [prov, key] of Object.entries((rv as Record<string, string>) ?? {})) {
          if (key && cur[prov] !== key) {
            cur[prov] = key
            changed.push(`apikey:${prov}`)
          }
        }
        next.apiKeys = cur
        continue
      }
      case 'customProviders': {
        const cur = (g.customProviders as CustomProviderConfig[]) ?? []
        const merged = [...cur]
        for (const cp of (rv as CustomProviderConfig[]) ?? []) {
          const i = merged.findIndex((x) => x.id === cp?.id)
          if (i >= 0) {
            if (JSON.stringify(merged[i]) !== JSON.stringify(cp)) {
              merged[i] = cp
              changed.push(`provider:${cp.id}`)
            }
          } else {
            merged.push(cp)
            changed.push(`provider:${cp.id}`)
          }
        }
        next.customProviders = merged
        continue
      }
      case 'mcp': {
        const curServers = ((g.mcp as { servers?: Record<string, McpServerConfig> })?.servers) ?? {}
        const servers = { ...curServers }
        for (const [name, srv] of Object.entries(((rv as { servers?: Record<string, McpServerConfig> })?.servers) ?? {})) {
          if (JSON.stringify(servers[name]) !== JSON.stringify(srv)) {
            servers[name] = srv
            changed.push(`mcp:${name}`)
          }
        }
        next.mcp = { ...((g.mcp as object) ?? {}), servers }
        continue
      }
      case 'github': {
        // only login + clientId travel; never overwrite with a token-less
        // payload wholesale — keep whatever local github state exists
        const gh = { ...((g.github as Record<string, unknown>) ?? {}) }
        for (const [gk, gv] of Object.entries((rv as Record<string, unknown>) ?? {})) {
          if (DEVICE_LOCAL.drop(gk)) continue
          if (gv !== undefined && JSON.stringify(gh[gk]) !== JSON.stringify(gv)) {
            gh[gk] = gv
            changed.push(`github.${gk}`)
          }
        }
        next.github = gh
        continue
      }
      default: {
        if (JSON.stringify(g[k]) !== JSON.stringify(rv)) {
          next[k] = rv
          changed.push(k)
        } else {
          next[k] = g[k] // keep pointer-identity for unchanged keys
        }
      }
    }
  }

  if (Object.keys(next).length) {
    updateGlobalConfig(next as Partial<TagentConfig>)
  }
  return { changed }
}

/* ------------------------------ git plumbing ------------------------------ */

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: dir, timeout: 60_000 })
  return stdout.trim()
}

function vaultPath(): string {
  return path.join(configRepoDir(), 'vault.json')
}

/** init the local checkout (once): git init -b main + the README stub. */
async function prepareCheckout(): Promise<void> {
  const dir = configRepoDir()
  if (!fs.existsSync(path.join(dir, '.git'))) {
    ensureDir(dir)
    fs.writeFileSync(path.join(dir, 'README.md'), CONFIG_README)
    await exec('git', ['init', '-b', 'main'], { cwd: dir, timeout: 30_000 })
  }
}

const CONFIG_README = `# tagent config

This private repo syncs your global tagent configuration across devices:
providers, api keys (the keychain), models, MCP servers, permissions, theme…

\`vault.json\` is AES-256-GCM encrypted — nothing readable is stored here.
Open it locally with: \`tagent start\` → \`/config\`

Managed by tagent. Manual edits do nothing; the vault is sealed.
`

/** fetch + fast-forward/rebase the checkout onto the remote main.
 *  Returns the remote head sha, or '' when the remote is empty/unreachable. */
async function integrateRemote(
  repo: string,
  token: string,
  remoteBase: string,
  onLog?: (l: string) => void,
): Promise<string> {
  const dir = configRepoDir()
  const cleanRemote = `${remoteBase}${repo}.git`
  try {
    await exec('git', ['fetch', authUrl(cleanRemote, token), 'main'], {
      cwd: dir,
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
  } catch {
    return '' // empty remote / offline — nothing to integrate
  }
  try {
    const remoteHead = await git(dir, ['rev-parse', 'FETCH_HEAD']).catch(() => '')
    if (!remoteHead) return ''
    // unborn HEAD = a fresh checkout with no commits yet (new device):
    // take the remote as the starting point — nothing local to rebase
    const headOk = await exec('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: dir,
      timeout: 30_000,
    }).then(() => true, () => false)
    if (!headOk) {
      await git(dir, ['reset', '--hard', remoteHead])
      return remoteHead
    }
    const upToDate = await exec('git', ['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD'], {
      cwd: dir,
      timeout: 30_000,
    }).then(() => true, () => false)
    if (upToDate) return remoteHead
    onLog?.('Remote config moved — rebasing…')
    await exec('git', ['-c', 'user.name=tagent', '-c', 'user.email=tagent@users.noreply.github.com', 'rebase', 'FETCH_HEAD'], {
      cwd: dir,
      timeout: 60_000,
    })
    return remoteHead
  } catch (err) {
    await exec('git', ['rebase', '--abort'], { cwd: dir, timeout: 30_000 }).catch(() => undefined)
    const stderr = String((err as { stderr?: string }).stderr ?? '')
    const detail = stderr.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('hint:')).slice(-2).join(' · ')
    throw new Error(
      'config repo diverged — nothing was lost. Run /config pull to take the remote config, ' +
        'or resolve manually in ~/.tagent/config-repo (git pull --rebase).' +
        (detail ? ` (${detail.slice(0, 140)})` : ''),
    )
  } finally {
    // FETCH_HEAD records the fetch URL verbatim — including the one-shot
    // token. Scrub it (same invariant as github.ts).
    try { fs.rmSync(path.join(dir, '.git', 'FETCH_HEAD'), { force: true }) } catch { /* best-effort */ }
  }
}

/* ------------------------------ vault file ------------------------------ */

interface SealResult {
  wrote: boolean
  passphrase: string
  generated: boolean
}

/** Write vault.json when the local payload changed. Returns the passphrase
 *  (+ whether it was just generated — hosts tell the user ONCE). */
function sealVault(payload: ConfigPayload, hash: string): SealResult {
  let passphrase = getVaultPassphrase()
  let generated = false
  if (!passphrase) {
    passphrase = generatePassphrase()
    setVaultPassphrase(passphrase)
    generated = true
  }
  const prev = fs.existsSync(vaultPath())
  const state = readConfigSyncState()
  if (prev && state.payloadHash === hash && state.appliedHash === readVaultFileHash()) {
    return { wrote: false, passphrase, generated }
  }
  const vault: VaultFile = encryptVaultJSON(payload, passphrase)
  fs.writeFileSync(vaultPath(), JSON.stringify(vault, null, 2))
  return { wrote: true, passphrase, generated }
}

function readVaultFileHash(): string | undefined {
  try {
    return createHash('sha256').update(fs.readFileSync(vaultPath(), 'utf8')).digest('hex')
  } catch {
    return undefined
  }
}

/* ------------------------------ public API ------------------------------ */

export interface ConfigSyncOpts {
  remoteBase?: string
  onLog?: (l: string) => void
}

export interface ConfigPushResult {
  repo: string
  created: boolean
  pushed: boolean
  passphrase?: string
  passphraseGenerated?: boolean
}

/**
 * Push the global config to `login/tagent-config` — the /config push path
 * AND the post-auth bootstrap. Ensures (or RE-CREATES, after a deletion) the
 * private repo, integrates the remote first (no force, no loss), seals the
 * vault only when the payload changed, pushes.
 */
export async function pushConfigSync(opts?: ConfigSyncOpts): Promise<ConfigPushResult> {
  const remoteBase = opts?.remoteBase ?? DEFAULT_REMOTE_BASE
  const isGithub = remoteBase === DEFAULT_REMOTE_BASE
  const { token, login: cached } = configSyncAuth()
  if (!token) throw new Error('not logged in — run `tagent auth` first')
  const login = cached || (isGithub ? await validatePat(token) : 'tagent')
  if (isGithub) {
    opts?.onLog?.(`Ensuring repo ${login}/${CONFIG_REPO_NAME}…`)
    const { repo, created } = await ensureRepoDetailed(token, login, CONFIG_REPO_NAME)
    writeConfigSyncState({ repo, repoMissingAt: undefined })
    const payload = exportConfigPayload()
    const hash = hashConfigPayload(payload)
    const dir = configRepoDir()
    await prepareCheckout()
    const fresh = !(await git(dir, ['rev-parse', 'HEAD']).then(() => true, () => false))
    if (!created && !fresh) await integrateRemote(repo, token, remoteBase, opts?.onLog)
    const seal = sealVault(payload, hash)
    if (seal.wrote || created || fresh) {
      await commitAll(dir, `config: ${created ? 'initial upload' : 'update ' + new Date().toISOString().slice(0, 16)} from ${login}`)
    }
    await pushDir(dir, repo, token, remoteBase)
    writeConfigSyncState({ repo, lastPushAt: Date.now(), payloadHash: hash, repoMissingAt: undefined })
    return {
      repo,
      created,
      pushed: true,
      ...(seal.generated ? { passphrase: seal.passphrase, passphraseGenerated: true } : {}),
    }
  }
  // non-GitHub remote (tests / self-hosted): repo name used verbatim
  const repo = CONFIG_REPO_NAME
  await prepareCheckout()
  await integrateRemote(repo, token, remoteBase, opts?.onLog)
  const payload = exportConfigPayload()
  const hash = hashConfigPayload(payload)
  const seal = sealVault(payload, hash)
  const fresh = !(await git(configRepoDir(), ['rev-parse', 'HEAD']).then(() => true, () => false))
  if (seal.wrote || fresh) await commitAll(configRepoDir(), 'config: update')
  await pushDir(configRepoDir(), repo, token, remoteBase)
  writeConfigSyncState({ repo, lastPushAt: Date.now(), payloadHash: hash })
  return { repo, created: false, pushed: true }
}

async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, ['add', '-A'])
  try {
    await exec('git', ['-c', 'user.name=tagent', '-c', `user.email=tagent@users.noreply.github.com`, 'commit', '-m', message], {
      cwd: dir,
      timeout: 30_000,
    })
  } catch {
    /* nothing staged — the payload did not change */
  }
}

async function pushDir(dir: string, repo: string, token: string, remoteBase: string): Promise<void> {
  const cleanRemote = `${remoteBase}${repo}.git`
  for (let attempt = 0; ; attempt++) {
    try {
      await exec('git', ['push', authUrl(cleanRemote, token), 'main'], {
        cwd: dir,
        timeout: 120_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
      return
    } catch (e) {
      const se = String((e as { stderr?: string }).stderr ?? '')
      if (attempt === 0 && /fetch first|non-fast-forward|stale[- ]info|failed to update ref|cannot lock ref/i.test(se)) {
        await integrateRemote(repo, token, remoteBase)
        continue
      }
      throw e
    }
  }
}

export interface ConfigPullResult {
  status: 'applied' | 'up-to-date' | 'empty' | 'needs-passphrase'
  changed: string[]
  repo?: string
}

/**
 * Pull the remote config and apply it to THIS device's global config.
 * "Remote is the truth": per key remote wins; keychain/providers union.
 */
export async function pullConfigSync(opts?: ConfigSyncOpts): Promise<ConfigPullResult> {
  const remoteBase = opts?.remoteBase ?? DEFAULT_REMOTE_BASE
  const { token } = configSyncAuth()
  if (!token) throw new Error('not logged in — run `tagent auth` first')
  const repo = readConfigSyncState().repo || CONFIG_REPO_NAME
  await prepareCheckout()
  const remoteHead = await integrateRemote(repo, token, remoteBase, opts?.onLog)
  if (!remoteHead) {
    // empty remote or unreachable — vault bytes decide "empty"
    if (!fs.existsSync(vaultPath())) return { status: 'empty', changed: [] }
  }
  if (!fs.existsSync(vaultPath())) return { status: 'empty', changed: [] }
  const raw = fs.readFileSync(vaultPath(), 'utf8')
  const vault = parseVaultFile(JSON.parse(raw))
  if (!vault) return { status: 'empty', changed: [] }
  const fileHash = createHash('sha256').update(raw).digest('hex')
  const state = readConfigSyncState()
  const passphrase = getVaultPassphrase()
  if (!passphrase) return { status: 'needs-passphrase', changed: [] }
  const payload = decryptVaultJSON(vault, passphrase) as ConfigPayload
  if (!payload || payload.v !== 2 || !payload.config) {
    return { status: 'empty', changed: [] }
  }
  if (state.appliedHash === fileHash) return { status: 'up-to-date', changed: [], repo }
  const { changed } = applyConfigPayload(payload)
  writeConfigSyncState({ repo, lastPullAt: Date.now(), appliedHash: fileHash, payloadHash: hashConfigPayload(payload) })
  return { status: 'applied', changed, repo }
}

/* ------------------------------ health ------------------------------ */

export type ConfigRepoHealth =
  | { status: 'ok'; repo: string }
  | { status: 'missing'; repo: string }
  | { status: 'nologin' }
  | { status: 'offline' }

/**
 * Does the config repo still exist on GitHub? The `tagent start` warning
 * reads this ("repo dihapus → tagent ngecek terus, kasih warn tiap start").
 * No network when not logged in; offline is reported as-is (next start
 * checks again — "terus").
 */
export async function checkConfigRepo(): Promise<ConfigRepoHealth> {
  const { token, login } = configSyncAuth()
  if (!token) return { status: 'nologin' }
  const who = login || (await validatePat(token).catch(() => ''))
  if (!who) return { status: 'offline' }
  const repo = `${who}/${CONFIG_REPO_NAME}`
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(6000),
    })
    if (res.status === 404) {
      writeConfigSyncState({ repoMissingAt: Date.now() })
      return { status: 'missing', repo }
    }
    if (res.ok) {
      writeConfigSyncState({ repo, repoMissingAt: undefined })
      return { status: 'ok', repo }
    }
    return { status: 'offline' }
  } catch {
    return { status: 'offline' }
  }
}

export interface SmartSyncResult {
  health: ConfigRepoHealth
  pulled?: { status: string; changed: string[] }
  pushed?: { repo: string; created: boolean; passphrase?: string }
  error?: string
}

/**
 * Boot-time convergence — "config bakal sama meskipun beda device", zero
 * clicks: apply the remote when it moved, push when the local config moved
 * since the last push. Never throws; failures ride the result so a boot
 * banner can mention them without blocking the TUI.
 */
export async function smartConfigSync(opts?: ConfigSyncOpts): Promise<SmartSyncResult> {
  const health = await checkConfigRepo()
  if (health.status === 'nologin' || health.status === 'offline') return { health }
  if (health.status === 'missing') {
    const st = readConfigSyncState()
    if (st.repo && st.lastPushAt) {
      // we pushed before and it's gone → genuinely deleted; warn (never
      // surprise-recreate at boot — /config push or the next auth does that)
      return { health }
    }
    // logged in but the config repo was never set up (fresh login on an
    // older release, or the offer was missed) → bootstrap it now: the
    // "auth auto-creates the private config repo" promise, lazily.
    try {
      const r = await pushConfigSync(opts)
      return {
        health: { status: 'ok', repo: r.repo },
        pushed: { repo: r.repo, created: r.created, ...(r.passphrase ? { passphrase: r.passphrase } : {}) },
      }
    } catch (e) {
      return { health, error: `bootstrap: ${(e as Error).message}` }
    }
  }
  const out: SmartSyncResult = { health }
  try {
    out.pulled = await pullConfigSync(opts)
  } catch (e) {
    out.error = `pull: ${(e as Error).message}`
    return out
  }
  // local config changed since the last push? → push (remote already integrated)
  const hash = hashConfigPayload(exportConfigPayload())
  const state = readConfigSyncState()
  if (state.payloadHash !== hash || !readVaultFileHash()) {
    try {
      const r = await pushConfigSync(opts)
      out.pushed = { repo: r.repo, created: r.created, ...(r.passphrase ? { passphrase: r.passphrase } : {}) }
    } catch (e) {
      out.error = `push: ${(e as Error).message}`
    }
  }
  return out
}
