import fs from 'node:fs'
import path from 'node:path'
import { GLOBAL_DIR } from './config'
import { ensureDir } from './util'

/**
 * Credentials store — secrets live in ~/.tagent/credentials.json, a file
 * dedicated to secrets (chmod 0600 on POSIX), separate from config.json so
 * the main config stays shareable/screenshot-safe.
 *
 * Resolution order everywhere in Tagent:
 *   credentials.json → config.json (legacy) → environment variable
 *
 * The parsed file is cached in memory (read once per process).
 */

interface CredentialFile {
  v: 1
  creds: Record<string, string>
}

function credFile(): string {
  return path.join(GLOBAL_DIR, 'credentials.json')
}

let memCache: Record<string, string> | null = null

function loadAll(): Record<string, string> {
  if (memCache) return memCache
  try {
    const raw = JSON.parse(fs.readFileSync(credFile(), 'utf8')) as CredentialFile
    memCache = { ...(raw.creds ?? {}) }
  } catch {
    memCache = {}
  }
  return memCache!
}

function persist(creds: Record<string, string>): void {
  const dir = GLOBAL_DIR
  ensureDir(dir)
  fs.writeFileSync(credFile(), JSON.stringify({ v: 1, creds }, null, 2))
  // lock it down on POSIX (Windows: the user profile dir already restricts)
  try {
    if (process.platform !== 'win32') fs.chmodSync(credFile(), 0o600)
  } catch {
    /* best-effort */
  }
  memCache = { ...creds }
}

/** Get a secret by name (provider id, 'github', 'mega', …). */
export function getCredential(name: string): string | undefined {
  return loadAll()[name]
}

/** Store/update a secret. Empty value deletes the entry. */
export function setCredential(name: string, value: string): void {
  const creds = { ...loadAll() }
  if (!value) delete creds[name]
  else creds[name] = value
  persist(creds)
}

export function deleteCredential(name: string): void {
  setCredential(name, '')
}

/** Secret lookup with legacy-config + env fallback. */
export function resolveSecret(name: string, legacy?: string, envVar?: string): string {
  return getCredential(name) || legacy || (envVar ? process.env[envVar] : '') || ''
}

/** Names only — never the values (for `tagent cache` / doctor / UI lists). */
export function listCredentialNames(): string[] {
  return Object.keys(loadAll()).sort()
}

/** Masked preview for safe display: 'ghp_ABCDEFGH…' → 'ghp_AB…' */
export function maskSecret(value: string): string {
  if (!value) return ''
  if (value.length <= 8) return '•'.repeat(value.length)
  return `${value.slice(0, 4)}${'•'.repeat(4)}${value.slice(-2)}`
}

/** Masked map — { name: 'ghp_AB••••YZ' } for UI/CLI. */
export function listCredentialsMasked(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(loadAll())) out[k] = maskSecret(v)
  return out
}

/** Drop the in-memory copy (used by tests / `tagent cache clear`). */
export function clearCredentialCache(): void {
  memCache = null
}
