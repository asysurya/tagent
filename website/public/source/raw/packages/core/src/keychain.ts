/**
 * Provider keychain — "provider bisa multi apikey, jadi user nanti bisa
 * milih mau make yang mana, atau bisa jadi fallback juga".
 *
 * The keychain is a drawer of named API keys per provider, stored in the
 * GLOBAL config (~/.tagent/config.json) so the config repo carries it to
 * every device. The key actually used is ALWAYS cfg.apiKeys[provider] —
 * selecting an entry copies it there, which feeds every existing
 * resolveApiKey()/getAdapter() path without touching them.
 *
 * Fallback usage: the existing fallback chain already accepts a per-entry
 * apiKey, so "use this key as a fallback" = one chain entry referencing a
 * keychain key's value.
 */
import type { ProviderKeyEntry, TagentConfig } from './types'
import { readGlobalConfig, updateGlobalConfig } from './config'
import { maskSecret } from './credentials'

export type { ProviderKeyEntry }

/* ------------------------------ pure helpers ------------------------------ */

function sanitizeChain(raw: unknown): ProviderKeyEntry[] {
  if (!Array.isArray(raw)) return []
  const out: ProviderKeyEntry[] = []
  const seen = new Set<string>()
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue
    const e = x as Record<string, unknown>
    const id = typeof e.id === 'string' ? e.id : ''
    const provider = typeof e.provider === 'string' ? e.provider : ''
    const key = typeof e.key === 'string' ? e.key : ''
    if (!id || !provider || !key || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      provider,
      label: typeof e.label === 'string' && e.label ? e.label.slice(0, 40) : 'key',
      key,
      createdAt: typeof e.createdAt === 'number' ? e.createdAt : Date.now(),
    })
  }
  return out
}

function nextKeyId(keys: ProviderKeyEntry[]): string {
  let n = keys.length + 1
  const taken = new Set(keys.map((k) => k.id))
  while (taken.has(`k${n}`)) n++
  return `k${n}`
}

/** All keychain entries for one provider (oldest first). */
export function listProviderKeys(cfg: Pick<TagentConfig, 'keychain'>, provider: string): ProviderKeyEntry[] {
  return sanitizeChain(cfg.keychain).filter((k) => k.provider === provider)
}

/** Providers that own at least one keychain entry, with counts. */
export function keychainProviders(cfg: Pick<TagentConfig, 'keychain'>): { provider: string; keys: number }[] {
  const counts = new Map<string, number>()
  for (const k of sanitizeChain(cfg.keychain)) counts.set(k.provider, (counts.get(k.provider) ?? 0) + 1)
  return [...counts.entries()].map(([provider, keys]) => ({ provider, keys }))
}

/** Label of the keychain entry that matches the ACTIVE key, if any. */
export function activeKeyLabel(cfg: Pick<TagentConfig, 'keychain' | 'apiKeys'>, provider: string): string | undefined {
  const active = cfg.apiKeys?.[provider]
  if (!active) return undefined
  return sanitizeChain(cfg.keychain).find((k) => k.provider === provider && k.key === active)?.label
}

/* ------------------------- global-config mutations ------------------------- */

/** Add a named key for a provider to the GLOBAL keychain. When the provider
 *  has no active key yet, the new entry becomes active. Duplicate keys (same
 *  provider + same secret) return the existing entry instead. */
export function addProviderKey(
  provider: string,
  label: string,
  key: string,
): { entry: ProviderKeyEntry; duplicate: boolean } {
  const g = readGlobalConfig()
  const chain = sanitizeChain(g.keychain)
  const mine = chain.filter((k) => k.provider === provider)
  const hit = mine.find((k) => k.key === key)
  if (hit) return { entry: hit, duplicate: true }
  const entry: ProviderKeyEntry = {
    id: nextKeyId(chain),
    provider,
    label: label.trim().slice(0, 40) || 'key',
    key,
    createdAt: Date.now(),
  }
  chain.push(entry)
  const patch: Partial<TagentConfig> = { keychain: chain }
  const active = g.apiKeys?.[provider]
  if (!active) patch.apiKeys = { ...(g.apiKeys ?? {}), [provider]: key }
  updateGlobalConfig(patch)
  return { entry, duplicate: false }
}

/** Remove a keychain entry by id (GLOBAL config). When the removed entry was
 *  the active key, the next remaining key of that provider takes over. */
export function removeProviderKey(id: string): { removed: ProviderKeyEntry; nowActive?: string } | null {
  const g = readGlobalConfig()
  const chain = sanitizeChain(g.keychain)
  const i = chain.findIndex((k) => k.id === id)
  if (i < 0) return null
  const [removed] = chain.splice(i, 1)
  const patch: Partial<TagentConfig> = { keychain: chain }
  let nowActive: string | undefined
  if (g.apiKeys?.[removed.provider] === removed.key) {
    const next = chain.find((k) => k.provider === removed.provider)
    const apiKeys = { ...(g.apiKeys ?? {}) }
    if (next) {
      apiKeys[removed.provider] = next.key
      nowActive = next.key
    } else {
      delete apiKeys[removed.provider]
    }
    patch.apiKeys = apiKeys
  }
  updateGlobalConfig(patch)
  return { removed, nowActive }
}

/** Make a keychain entry the ACTIVE key for its provider (GLOBAL config):
 *  apiKeys[provider] = entry.key. Every existing key-resolution path picks
 *  it up on the next request. */
export function selectProviderKey(provider: string, id: string): ProviderKeyEntry | null {
  const g = readGlobalConfig()
  const entry = sanitizeChain(g.keychain).find((k) => k.provider === provider && k.id === id)
  if (!entry) return null
  updateGlobalConfig({ apiKeys: { ...(g.apiKeys ?? {}), [provider]: entry.key } })
  return entry
}

/** Show/inspect — masked, for UIs and logs. Never returns raw secrets. */
export function describeProviderKeys(cfg: Pick<TagentConfig, 'keychain' | 'apiKeys'>, provider: string): {
  id: string
  label: string
  masked: string
  active: boolean
}[] {
  const active = cfg.apiKeys?.[provider]
  return listProviderKeys(cfg, provider).map((k) => ({
    id: k.id,
    label: k.label,
    masked: maskSecret(k.key),
    active: !!active && k.key === active,
  }))
}

/** Merge pulled keychain entries into the GLOBAL config — union by key value
 *  per provider (a key that exists on any device survives), active keys win
 *  if they match an entry. Returns the labels that arrived new. */
export function mergeKeychain(entries: ProviderKeyEntry[]): string[] {
  const g = readGlobalConfig()
  const chain = sanitizeChain(g.keychain)
  const before = chain.length
  const known = new Set(chain.map((k) => `${k.provider}\u0000${k.key}`))
  const fresh: string[] = []
  for (const e of sanitizeChain(entries)) {
    const sig = `${e.provider}\u0000${e.key}`
    if (known.has(sig)) continue
    known.add(sig)
    chain.push({ ...e, id: nextKeyId(chain) })
    fresh.push(`${e.provider}:${e.label}`)
  }
  if (chain.length !== before) updateGlobalConfig({ keychain: chain })
  return fresh
}
