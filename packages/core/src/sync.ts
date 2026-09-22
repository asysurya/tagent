/**
 * Project auto-sync engine — "project akan di update (sync) setiap 5-15
 * detik, jadi device lain akan tetap sinkron".
 *
 * One tick does the cheapest thing that keeps every device converged:
 *
 *   dirty tree or changed vault ─► syncProject (commit + integrate + push)
 *   clean tree ─► fetch; if the remote moved, rebase (fast-forward) +
 *                 re-apply the encrypted vault; if we're ahead, push
 *
 * Settings live IN the project (`.tagent-sync/repo.json` — committed, so
 * every device agrees on the interval), secrets live in the encrypted vault
 * (`.tagent-sync/vault.json`), the passphrase never leaves the device
 * (credential store). `.tagent/` itself stays gitignored.
 *
 * Auto-sync engages only for LINKED projects (a repo that was pushed at
 * least once) — a brand-new folder is never surprise-uploaded.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CustomProviderConfig, McpServerConfig, MemoryFact, ProviderKeyEntry, TagentConfig } from './types'
import { ensureDir } from './util'
import { getCredential } from './credentials'
import { loadConfig, saveConfig } from './config'
import { getLinkedProject, markSynced, syncProject } from './projects'
import { DEFAULT_REMOTE_BASE, authUrl, defaultRepoName, type PushResult } from './github'
import { listFacts } from './memory'
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

/* ------------------------------ settings ------------------------------ */

/** what rides inside the encrypted vault */
export interface VaultSettings {
  apiKeys: boolean
  customProviders: boolean
  mcp: boolean
  memory: boolean
}

export interface RepoSyncSettings {
  /** auto-sync engine on/off (per project) */
  auto: boolean
  /** tick interval — user asked for 5-15s; clamp 5s..1h */
  intervalMs: number
  vault: VaultSettings
}

export const SYNC_DIR = '.tagent-sync'
export const MIN_INTERVAL_MS = 5_000
export const MAX_INTERVAL_MS = 3_600_000
export const DEFAULT_INTERVAL_MS = 15_000

export function defaultSyncSettings(): RepoSyncSettings {
  return {
    auto: true,
    intervalMs: DEFAULT_INTERVAL_MS,
    vault: { apiKeys: true, customProviders: true, mcp: true, memory: true },
  }
}

export function syncDirOf(root: string): string {
  return path.join(root, SYNC_DIR)
}

export function syncSettingsFile(root: string): string {
  return path.join(root, SYNC_DIR, 'repo.json')
}

export function vaultFileOf(root: string): string {
  return path.join(root, SYNC_DIR, 'vault.json')
}

/* ------------------------------ presence ------------------------------ */

/** device presence — the navbar's "◉ laptop" badge ("device lain sedang
 *  online"). Every running engine refreshes its own entry in the COMMITTED
 *  .tagent-sync/presence.json on a slow heartbeat (45s — a git commit per
 *  minute per device is the cheapest online-signal that needs no server);
 *  whoever writes also prunes stale entries, so the file stays tiny.
 *  Entries fresher than the TTL are online. Device ids live in the
 *  gitignored .tagent/ — every clone (= every device) mints its own. */
export const PRESENCE_EVERY_MS = 45_000

export interface PresenceEntry {
  id: string
  name: string
  at: number
}

/** in-memory fallback when .tagent/ is read-only — keeps the id stable for the run */
const DEVICE_IDS = new Map<string, string>()

/** stable per-clone device identity (8 hex chars). */
export function deviceIdOf(root: string): string {
  const key = path.resolve(root)
  const cached = DEVICE_IDS.get(key)
  if (cached) return cached
  const file = path.join(key, '.tagent', 'device-id')
  try {
    const cur = fs.readFileSync(file, 'utf8').trim()
    if (/^[a-f0-9]{6,16}$/.test(cur)) {
      DEVICE_IDS.set(key, cur)
      return cur
    }
  } catch {
    /* first run — mint below */
  }
  const id = createHash('sha256')
    .update(`${os.hostname()}|${key}|${Date.now()}|${Math.random()}`)
    .digest('hex')
    .slice(0, 10)
  try {
    ensureDir(path.dirname(file))
    fs.writeFileSync(file, id)
  } catch {
    /* read-only workspace — the map keeps this run's id stable */
  }
  DEVICE_IDS.set(key, id)
  return id
}

/** pretty device name — the hostname's first label ("laptop", "pixel-7"). */
export function deviceName(): string {
  return (os.hostname().split('.')[0] || 'device').slice(0, 16)
}

function presenceFileOf(root: string): string {
  return path.join(root, SYNC_DIR, 'presence.json')
}

/** how long a heartbeat stays "online" — slow projects (interval > 45s)
 *  ride their own ticks, so the TTL tracks the agreed interval (repo.json
 *  is committed — every device agrees). */
function presenceTtlMs(root: string): number {
  return Math.max(135_000, readSyncSettings(root).intervalMs * 3)
}

/** fresh presence entries (own + others) from the working tree. */
export function readPresence(root: string): PresenceEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(presenceFileOf(root), 'utf8')) as {
      devices?: Record<string, { name?: string; at?: number }>
    }
    const ttl = presenceTtlMs(root)
    const now = Date.now()
    return Object.entries(raw.devices ?? {})
      .filter(([, v]) => typeof v?.at === 'number' && now - (v.at as number) < ttl)
      .map(([id, v]) => ({
        id,
        name: typeof v.name === 'string' && v.name ? v.name : id.slice(0, 6),
        at: v.at as number,
      }))
  } catch {
    return []
  }
}

/** heartbeat: refresh this device's entry + prune stale ones. Returns
 *  true when the file changed (→ worth a commit this tick); false when
 *  the last heartbeat is still fresh. */
export function writePresence(root: string): boolean {
  const file = presenceFileOf(root)
  let devices: Record<string, { name: string; at: number }> = {}
  try {
    devices =
      (JSON.parse(fs.readFileSync(file, 'utf8')) as { devices?: Record<string, { name: string; at: number }> })
        .devices ?? {}
  } catch {
    /* fresh file */
  }
  const ttl = presenceTtlMs(root)
  const now = Date.now()
  for (const [id, v] of Object.entries(devices)) {
    if (now - (v?.at ?? 0) > ttl) delete devices[id]
  }
  const self = deviceIdOf(root)
  const prev = devices[self]
  if (prev && now - prev.at < PRESENCE_EVERY_MS) return false // not due yet
  devices[self] = { name: deviceName(), at: now }
  try {
    ensureDir(path.dirname(file))
    fs.writeFileSync(file, JSON.stringify({ devices }, null, 2))
    return true
  } catch {
    return false // read-only workspace — no presence, no crash
  }
}

/** OTHER devices with a fresh heartbeat — what the navbar shows. */
export function onlineOthers(root: string): PresenceEntry[] {
  const self = deviceIdOf(root)
  return readPresence(root).filter((d) => d.id !== self)
}

/* ------------------------------ history ------------------------------ */

/** what actually happened, per project — .tagent/sync-history.json
 *  (gitignored: each device keeps its own view of the timeline; /repo
 *  status renders it). Capped at the last 100 rounds. */
export interface SyncHistoryEntry {
  at: number
  action: 'pushed' | 'pulled' | 'error' | 'vault' | 'settings'
  detail: string
  repo?: string
  commit?: string
}

const HISTORY_CAP = 100

function historyFileOf(root: string): string {
  return path.join(root, '.tagent', 'sync-history.json')
}

export function recordSyncHistory(
  root: string,
  entry: Omit<SyncHistoryEntry, 'at'> & { at?: number },
): void {
  try {
    const full: SyncHistoryEntry = {
      at: entry.at ?? Date.now(),
      action: entry.action,
      detail: entry.detail.slice(0, 160),
      ...(entry.repo ? { repo: entry.repo } : {}),
      ...(entry.commit ? { commit: entry.commit } : {}),
    }
    let entries: SyncHistoryEntry[] = []
    try {
      entries =
        (JSON.parse(fs.readFileSync(historyFileOf(root), 'utf8')) as { entries?: SyncHistoryEntry[] })
          .entries ?? []
    } catch {
      /* fresh file */
    }
    entries.push(full)
    if (entries.length > HISTORY_CAP) entries = entries.slice(-HISTORY_CAP)
    ensureDir(path.dirname(historyFileOf(root)))
    fs.writeFileSync(historyFileOf(root), JSON.stringify({ entries }, null, 1))
  } catch {
    /* history is best-effort — never break a sync over it */
  }
}

/** newest-first sync rounds (default: the last 20). */
export function readSyncHistory(root: string, limit = 20): SyncHistoryEntry[] {
  try {
    const entries =
      (JSON.parse(fs.readFileSync(historyFileOf(root), 'utf8')) as { entries?: SyncHistoryEntry[] })
        .entries ?? []
    return entries.slice(-limit).reverse()
  } catch {
    return []
  }
}

export function readSyncSettings(root: string): RepoSyncSettings {
  const def = defaultSyncSettings()
  try {
    const raw = JSON.parse(fs.readFileSync(syncSettingsFile(root), 'utf8')) as Partial<RepoSyncSettings>
    const vault = (raw.vault ?? {}) as Partial<VaultSettings>
    return {
      auto: typeof raw.auto === 'boolean' ? raw.auto : def.auto,
      intervalMs:
        typeof raw.intervalMs === 'number' && raw.intervalMs > 0
          ? Math.min(Math.max(Math.floor(raw.intervalMs), MIN_INTERVAL_MS), MAX_INTERVAL_MS)
          : def.intervalMs,
      vault: {
        apiKeys: typeof vault.apiKeys === 'boolean' ? vault.apiKeys : def.vault.apiKeys,
        customProviders: typeof vault.customProviders === 'boolean' ? vault.customProviders : def.vault.customProviders,
        mcp: typeof vault.mcp === 'boolean' ? vault.mcp : def.vault.mcp,
        memory: typeof vault.memory === 'boolean' ? vault.memory : def.vault.memory,
      },
    }
  } catch {
    return def
  }
}

export function writeSyncSettings(root: string, s: RepoSyncSettings): void {
  const file = syncSettingsFile(root)
  ensureDir(path.dirname(file))
  const safe: RepoSyncSettings = {
    auto: s.auto === true,
    intervalMs: Math.min(Math.max(Math.floor(s.intervalMs || DEFAULT_INTERVAL_MS), MIN_INTERVAL_MS), MAX_INTERVAL_MS),
    vault: {
      apiKeys: s.vault?.apiKeys !== false,
      customProviders: s.vault?.customProviders !== false,
      mcp: s.vault?.mcp !== false,
      memory: s.vault?.memory !== false,
    },
  }
  fs.writeFileSync(file, JSON.stringify(safe, null, 2))
}

/** true when the project carries a vault this device cannot open yet. */
export function vaultNeedsPassphrase(root: string): boolean {
  return fs.existsSync(vaultFileOf(root)) && !getVaultPassphrase()
}

/* ------------------------------ payload ------------------------------ */

export interface VaultPayload {
  v: 1
  savedAt: number
  apiKeys?: Record<string, string>
  /** named multi-keys — rides with the apiKeys toggle (the keychain is keys) */
  keychain?: ProviderKeyEntry[]
  customProviders?: CustomProviderConfig[]
  mcpServers?: Record<string, McpServerConfig>
  memoryFacts?: MemoryFact[]
}

/** collect the selected parts of the live config → payload (undefined parts skipped). */
export function exportVaultPayload(root: string, cfg: TagentConfig, s: VaultSettings): VaultPayload {
  const p: VaultPayload = { v: 1, savedAt: Date.now() }
  if (s.apiKeys) {
    const keys: Record<string, string> = {}
    for (const [k, v] of Object.entries(cfg.apiKeys ?? {})) if (v) keys[k] = v
    if (Object.keys(keys).length) p.apiKeys = keys
    // the keychain travels with the keys — the drawer plus the active slot
    const chain = (cfg.keychain ?? []).filter((k) => k?.key)
    if (chain.length) p.keychain = chain
  }
  if (s.customProviders && cfg.customProviders?.length) p.customProviders = cfg.customProviders
  if (s.mcp && cfg.mcp?.servers && Object.keys(cfg.mcp.servers).length) p.mcpServers = cfg.mcp.servers
  if (s.memory) {
    const facts = listFacts(root)
    if (facts.length) p.memoryFacts = facts
  }
  return p
}

/** payload rendered + hashed — change detection between ticks. */
export function hashPayload(p: VaultPayload): string {
  const { savedAt, ...rest } = p
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex')
}

/** merge a decrypted payload into the LOCAL config + memory.
 *  Last writer wins per entry (the engine pushes before pulling in the same
 *  tick, so "remote wins" == the freshest device wins). Returns what moved. */
export function applyVaultPayload(
  root: string,
  payload: VaultPayload,
): { changed: string[] } {
  const changed: string[] = []
  let cfg: TagentConfig
  try {
    cfg = loadConfig(root)
  } catch {
    return { changed } // unreadable workspace — nothing to do
  }
  if (payload.apiKeys) {
    for (const [k, v] of Object.entries(payload.apiKeys)) {
      if (v && cfg.apiKeys[k] !== v) {
        cfg.apiKeys[k] = v
        changed.push(`apikey:${k}`)
      }
    }
  }
  if (payload.keychain?.length) {
    const fresh = mergeKeychain(payload.keychain)
    if (fresh.length) changed.push(`keys(${fresh.length})`)
  }
  if (payload.customProviders?.length) {
    cfg.customProviders ??= []
    for (const cp of payload.customProviders) {
      const i = cfg.customProviders.findIndex((x) => x.id === cp.id)
      if (i >= 0) {
        if (JSON.stringify(cfg.customProviders[i]) !== JSON.stringify(cp)) {
          cfg.customProviders[i] = cp
          changed.push(`provider:${cp.id}`)
        }
      } else {
        cfg.customProviders.push(cp)
        changed.push(`provider:${cp.id}`)
      }
    }
  }
  if (payload.mcpServers) {
    cfg.mcp ??= { servers: {} }
    cfg.mcp.servers ??= {}
    for (const [name, srv] of Object.entries(payload.mcpServers)) {
      if (!srv?.command) continue
      if (JSON.stringify(cfg.mcp.servers[name]) !== JSON.stringify(srv)) {
        cfg.mcp.servers[name] = srv
        changed.push(`mcp:${name}`)
      }
    }
  }
  if (changed.length) {
    try {
      saveConfig(root, cfg)
    } catch {
      /* read-only workspace — config merge reported but not persisted */
    }
  }
  // memory facts: union by id — never lose a fact, on any device
  let factsTouched = false
  if (payload.memoryFacts?.length) {
    const file = path.join(root, '.tagent', 'memory.json')
    let existing: MemoryFact[] = []
    try {
      existing = (JSON.parse(fs.readFileSync(file, 'utf8')) as { facts?: MemoryFact[] }).facts ?? []
    } catch {
      existing = []
    }
    const byId = new Map(existing.map((f) => [f.id, f]))
    for (const f of payload.memoryFacts) {
      if (!byId.has(f.id)) {
        byId.set(f.id, f)
        factsTouched = true
      }
    }
    if (factsTouched) {
      ensureDir(path.dirname(file))
      fs.writeFileSync(file, JSON.stringify({ facts: [...byId.values()] }, null, 2))
    }
  }
  if (factsTouched) changed.push('memory')
  return { changed }
}

/* ------------------------------ engine ------------------------------ */

export type SyncEvent =
  | { type: 'pushed'; repo: string; commit: string }
  | { type: 'pulled'; files: number; applied: string[] }
  | { type: 'vault-passphrase'; } // vault present, no passphrase on this device
  | { type: 'error'; message: string }

export interface SyncEngineStatus {
  running: boolean
  intervalMs: number
  lastSyncAt: number
  lastError: string
  lastAction: '' | 'pushed' | 'pulled'
  busy: boolean
  needsPassphrase: boolean
  /** other devices with a fresh presence heartbeat — the navbar badge */
  others: PresenceEntry[]
}

export interface SyncEngineOpts {
  root: string
  /** live config provider — engine reads current settings each tick */
  getConfig?: () => TagentConfig
  onEvent?: (e: SyncEvent) => void
  /** offline tests / self-hosted git */
  remoteBase?: string
}

async function gitOk(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: root, timeout: 60_000 })
  return stdout.trim()
}

export class SyncEngine {
  private timer: ReturnType<typeof setInterval> | undefined
  private busy = false
  private lastSyncAt = 0
  private lastError = ''
  private lastAction: '' | 'pushed' | 'pulled' = ''
  private passphraseNoticeSent = false
  private readonly root: string
  private readonly opts: SyncEngineOpts
  /** applied-vault bookkeeping file, local only (.tagent is gitignored) */
  private appliedFile: string

  constructor(opts: SyncEngineOpts) {
    this.opts = opts
    this.root = path.resolve(opts.root)
    this.appliedFile = path.join(this.root, '.tagent', 'vault-state.json')
  }

  private cfg(): TagentConfig {
    return this.opts.getConfig?.() ?? loadConfig(this.root)
  }

  private emit(e: SyncEvent): void {
    try {
      this.opts.onEvent?.(e)
    } catch {
      /* listener errors never break the engine */
    }
  }

  status(): SyncEngineStatus {
    return {
      running: !!this.timer,
      intervalMs: readSyncSettings(this.root).intervalMs,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      lastAction: this.lastAction,
      busy: this.busy,
      needsPassphrase: vaultNeedsPassphrase(this.root),
      others: onlineOthers(this.root),
    }
  }

  /** read + honor current settings. Safe to call repeatedly. */
  restart(): void {
    this.stop()
    const s = readSyncSettings(this.root)
    if (!s.auto) return
    const linked = getLinkedProject(this.root)
    const token = getCredential('github') || this.cfg().github?.token
    if (!linked || !token) return // never surprise-upload an unlinked project
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined)
    }, s.intervalMs)
    // run one tick soon after start (boot pulls remote work in ~2s)
    setTimeout(() => {
      void this.tick().catch(() => undefined)
    }, 2_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /* ---------------- the tick ---------------- */

  async tick(reason: 'timer' | 'manual' = 'timer'): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await this.tickInner(reason)
      this.lastError = ''
    } catch (err) {
      this.lastError = String((err as Error)?.message ?? err).split('\n')[0].slice(0, 200)
      recordSyncHistory(this.root, { action: 'error', detail: this.lastError })
      if (reason === 'manual') throw err
      this.emit({ type: 'error', message: this.lastError })
    } finally {
      this.busy = false
    }
  }

  private async tickInner(reason: 'timer' | 'manual'): Promise<void> {
    const s = readSyncSettings(this.root)
    if (reason === 'timer' && !s.auto) return

    // heartbeat — keeps this device "online" to the others even while the
    // tree is clean (a clean tree commits nothing). Write-before-dirty-check
    // so the heartbeat rides this tick's push instead of forcing an extra one
    let heartbeat = false
    try {
      heartbeat = writePresence(this.root)
    } catch {
      /* read-only — presence just doesn't happen */
    }

    // vault present but this device can't open it → one notice, then quiet
    if (vaultNeedsPassphrase(this.root)) {
      if (!this.passphraseNoticeSent || reason === 'manual') {
        this.passphraseNoticeSent = true
        this.emit({ type: 'vault-passphrase' })
      }
    }

    // first run in a linked project: persist the settings file into the
    // repo so every device agrees on interval + vault flags (.tagent-sync
    // is committed; .tagent is gitignored)
    if (!fs.existsSync(syncSettingsFile(this.root))) {
      try {
        writeSyncSettings(this.root, readSyncSettings(this.root))
      } catch {
        /* read-only workspace — settings stay default */
      }
    }

    // consume vault changes we haven't applied yet (fresh clone, pull),
    // then export — so the export carries the merged state, not stale one
    await this.applyVaultOnce()
    const vaultChanged = this.exportVault()

    // dirty tree? cheap check, no network
    const isRepo = fs.existsSync(path.join(this.root, '.git'))
    const dirty = !isRepo || heartbeat || (await gitOk(this.root, 'status', '--porcelain')) !== ''

    if (dirty || vaultChanged) {
      await this.doPush()
    } else {
      await this.pullIfMoved()
    }
    this.lastSyncAt = Date.now()
  }

  /** write the vault when the selected payload actually changed. The
   *  PLAINTEXT payload hash (not the file bytes — encryption is randomized)
   *  is remembered in .tagent/vault-state.json, so re-encryption churn never
   *  produces a phantom "changed" and a freshly cloned device that merely
   *  APPLIED a vault doesn't immediately re-push it. */
  private exportVault(): boolean {
    const s = readSyncSettings(this.root)
    const any = s.vault.apiKeys || s.vault.customProviders || s.vault.mcp || s.vault.memory
    if (!any) return false
    const payload = exportVaultPayload(this.root, this.cfg(), s.vault)
    const hash = hashPayload(payload)
    const state = this.readVaultState()
    if (hash === state.payloadHash) return false
    const empty =
      !payload.apiKeys && !payload.customProviders &&
      !payload.mcpServers && !payload.memoryFacts
    if (empty && fs.existsSync(vaultFileOf(this.root)) && !state.payloadHash) {
      // never clobber a vault another device wrote with an empty one
      return false
    }
    let passphrase = getVaultPassphrase()
    if (!passphrase) {
      // first run with no passphrase chosen: generate one, save it on THIS
      // device, and tell the user ONCE — they need it on other devices
      passphrase = generatePassphrase()
      setVaultPassphrase(passphrase)
      this.emit({
        type: 'error',
        message: `vault passphrase generated for this device: ${passphrase} — save it (other devices need it): /repo`,
      })
      this.passphraseNoticeSent = true
    }
    const file = vaultFileOf(this.root)
    ensureDir(path.dirname(file))
    const vault: VaultFile = encryptVaultJSON(payload, passphrase)
    fs.writeFileSync(file, JSON.stringify(vault, null, 2))
    this.writeVaultState({ payloadHash: hash })
    return true // vault content changed → worth a commit even on a clean tree
  }

  private async doPush(): Promise<void> {
    const before = await this.revParse().catch(() => '')
    const dev = `⧉${deviceName()}`
    const r: PushResult = await syncProject(this.root, this.cfg(), {
      message: `sync: auto ${new Date().toISOString().slice(11, 19)} ${dev}`,
      remoteBase: this.opts.remoteBase,
    })
    // a rebase inside syncProject may have integrated remote work too
    const after = await this.revParse().catch(() => '')
    let applied: string[] = []
    if (before && after && before !== after) applied = await this.applyVaultIfChanged(before, after)
    this.lastAction = 'pushed'
    recordSyncHistory(this.root, { action: 'pushed', detail: `auto ${dev}`, repo: r.repo, commit: r.commit })
    this.emit({ type: 'pushed', repo: r.repo, commit: r.commit })
    if (applied.length) this.emit({ type: 'pulled', files: 0, applied })
  }

  /** clean tree: fetch the remote, fast-forward if it moved, push if we're ahead. */
  private async pullIfMoved(): Promise<void> {
    const remoteBase = this.opts.remoteBase ?? DEFAULT_REMOTE_BASE
    const token = getCredential('github') || this.cfg().github?.token
    if (!token) return
    const linked = getLinkedProject(this.root)
    const repo = this.cfg().github?.repo || linked?.repo || defaultRepoName(this.root)
    const cleanRemote = `${remoteBase}${repo}.git`
    try {
      await exec('git', ['fetch', authUrl(cleanRemote, token), 'main'], {
        cwd: this.root,
        timeout: 60_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
    } catch {
      return // offline / remote gone — next tick retries
    }
    try {
      const remoteHead = await gitOk(this.root, 'rev-parse', 'FETCH_HEAD').catch(() => '')
      if (!remoteHead) return
      const head = await this.revParse()
      if (remoteHead === head) return // in sync
      const remoteMerged = await this
        .isAncestor(remoteHead, 'HEAD')
        .catch(() => false)
      if (remoteMerged) {
        // we're ahead (commits not pushed yet) → push them
        await exec('git', ['push', authUrl(cleanRemote, token), 'main'], {
          cwd: this.root,
          timeout: 120_000,
        })
        this.lastAction = 'pushed'
        this.lastSyncAt = Date.now()
        recordSyncHistory(this.root, {
          action: 'pushed',
          detail: `auto catch-up ⧉${deviceName()}`,
          repo,
          commit: head.slice(0, 7),
        })
        this.emit({ type: 'pushed', repo, commit: head.slice(0, 7) })
        return
      }
      // remote has work we don't — integrate (tree is clean, so this is safe)
      const before = head
      try {
        await exec('git', ['-C', this.root, 'rebase', remoteHead], { timeout: 60_000 })
      } catch {
        await exec('git', ['rebase', '--abort'], { cwd: this.root, timeout: 30_000 }).catch(() => undefined)
        throw new Error('sync conflict — resolve manually: git pull --rebase in the project folder')
      }
      const after = await this.revParse()
      const files = Number(
        (await exec('git', ['diff', '--name-only', before, after], { cwd: this.root, timeout: 30_000 })
          .then((x) => x.stdout.split('\n').filter(Boolean).length)
          .catch(() => 0)) || 0,
      )
      markSynced(this.root)
      const applied = await this.applyVaultIfChanged(before, after)
      this.lastAction = 'pulled'
      this.lastSyncAt = Date.now()
      recordSyncHistory(this.root, {
        action: 'pulled',
        detail: `${files} file${files === 1 ? '' : 's'}${applied.length ? ` + vault (${applied.join(', ')})` : ''}`,
        repo,
      })
      this.emit({ type: 'pulled', files, applied })
    } finally {
      // FETCH_HEAD records the fetch URL verbatim — including the one-shot
      // token. Scrub it, same as github.ts.
      try {
        fs.rmSync(path.join(this.root, '.git', 'FETCH_HEAD'), { force: true })
      } catch {
        /* best-effort */
      }
    }
  }

  /** boot-time catch-up: apply the synced vault when this device hasn't yet. */
  async applyVaultOnce(): Promise<string[]> {
    const file = vaultFileOf(this.root)
    if (!fs.existsSync(file)) return []
    const raw = fs.readFileSync(file, 'utf8')
    const hash = createHash('sha256').update(raw).digest('hex')
    const state = this.readVaultState()
    if (state.hash === hash) return []
    const passphrase = getVaultPassphrase()
    if (!passphrase) {
      this.emit({ type: 'vault-passphrase' })
      return []
    }
    const vault = parseVaultFile(JSON.parse(raw))
    if (!vault) return []
    const payload = decryptVaultJSON(vault, passphrase) as VaultPayload
    const { changed } = applyVaultPayload(this.root, payload)
    this.writeVaultState({ hash, payloadHash: hashPayload(payload) })
    if (changed.length) {
      recordSyncHistory(this.root, { action: 'vault', detail: `applied ${changed.join(', ')}` })
    }
    return changed
  }

  /* applied-vault bookkeeping, local only (.tagent is gitignored):
   *   hash        — bytes of the vault file this device has APPLIED
   *   payloadHash — plaintext payload this device has WRITTEN last
   * The two markers kill re-encryption churn and phantom pushes. */
  private readVaultState(): { hash?: string; payloadHash?: string } {
    try {
      return JSON.parse(fs.readFileSync(this.appliedFile, 'utf8')) as { hash?: string; payloadHash?: string }
    } catch {
      return {}
    }
  }

  private writeVaultState(patch: { hash?: string; payloadHash?: string }): void {
    try {
      ensureDir(path.dirname(this.appliedFile))
      const next = { ...this.readVaultState(), ...patch, at: Date.now() }
      fs.writeFileSync(this.appliedFile, JSON.stringify(next, null, 2))
    } catch {
      /* marker is an optimization — losing it only re-applies idempotently */
    }
  }

  /** rebase moved HEAD → re-apply the vault when its bytes changed. */
  private async applyVaultIfChanged(before: string, after: string): Promise<string[]> {
    if (before === after) return []
    let touched = false
    try {
      const out = await exec('git', ['diff', '--name-only', before, after], {
        cwd: this.root,
        timeout: 30_000,
      })
      const rel = path.relative(this.root, vaultFileOf(this.root)).split(path.sep).join('/')
      touched = out.stdout.split('\n').some((l) => l.trim() === rel)
    } catch {
      touched = false
    }
    if (!touched) return []
    return this.applyVaultOnce()
  }

  private async revParse(): Promise<string> {
    return gitOk(this.root, 'rev-parse', 'HEAD')
  }

  private async isAncestor(a: string, b: string): Promise<boolean> {
    try {
      await exec('git', ['merge-base', '--is-ancestor', a, b], { cwd: this.root, timeout: 30_000 })
      return true
    } catch {
      return false
    }
  }
}

/** convenience for hosts/CLI: run one full sync round right now. */
export async function manualSync(
  root: string,
  cfg: TagentConfig,
  opts?: { remoteBase?: string; onLog?: (l: string) => void },
): Promise<PushResult> {
  return syncProject(root, cfg, {
    message: `sync: manual ${new Date().toISOString().slice(11, 19)}`,
    remoteBase: opts?.remoteBase,
    onLog: opts?.onLog,
  })
}
