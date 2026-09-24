import type { FallbackEntry, TagentConfig } from './types'
import {
  acceptsImages,
  getAdapter,
  withoutImages,
  type CompletionRequest,
  type CompletionResult,
  type ProviderAdapter,
} from './providers'

/**
 * Provider fallback — an ordered failover chain.
 *
 * Users stack entries like:
 *   1. openrouter (key A, model X)
 *   2. openrouter (key B, model X)   ← same provider, different key
 *   3. openrouter (key C, model Y)
 *   4. groq       (key A, model Z)
 *
 * A per-entry `apiKey` overrides the stored key for that position, which is
 * how the same provider can appear multiple times under different accounts.
 * The primary (defaultProvider/defaultModel) always runs first; on a provider
 * error the next enabled entry takes over — mid-conversation, transparently.
 */

export interface ResolvedChainEntry {
  adapter: ProviderAdapter
  model: string
  label: string
}

/** the three failover lanes — main agent · subagents · the vision model */
export type FallbackRole = 'main' | 'subagent' | 'vision'

/** The raw list for a role: `fallbacks.<role>` when set; the MAIN role
 *  mirrors the legacy top-level `fallback` so old configs keep working. */
export function fallbackListFor(cfg: TagentConfig, role: FallbackRole): FallbackEntry[] {
  if (role === 'main') return cfg.fallbacks?.main ?? cfg.fallback ?? []
  return cfg.fallbacks?.[role] ?? []
}

/** Enabled fallback entries for a role only — the primary is prepended by the caller. */
function buildTail(list: FallbackEntry[], cfg: TagentConfig): ResolvedChainEntry[] {
  const tail: ResolvedChainEntry[] = []
  for (const f of list) {
    if (!f || f.enabled === false) continue
    if (!f.provider || !f.model) continue
    try {
      // per-entry key override — enables stacking one provider under many keys
      const eff: TagentConfig = f.apiKey
        ? {
            ...cfg,
            apiKeys: { ...cfg.apiKeys, [f.provider]: f.apiKey },
            customProviders: (cfg.customProviders ?? []).map((p) =>
              p.id === f.provider ? { ...p, apiKey: f.apiKey } : p,
            ),
          }
        : cfg
      tail.push({
        adapter: getAdapter(f.provider, eff),
        model: f.model,
        label: f.label || `${f.provider}/${f.model}`,
      })
    } catch { /* unresolvable entry (no key / unknown provider) — skip it */ }
  }
  return tail
}

/** Role-aware tail — subagent loops and the vision tool fail over on their OWN
 *  chains; the main agent keeps the legacy `fallback` list. */
export function fallbackTailFor(cfg: TagentConfig, role: FallbackRole = 'main'): ResolvedChainEntry[] {
  return buildTail(fallbackListFor(cfg, role), cfg)
}

/** Enabled fallback entries only — the primary is prepended by the caller.
 *  (Legacy spelling — the MAIN chain.) */
export function fallbackTail(cfg: TagentConfig): ResolvedChainEntry[] {
  return fallbackTailFor(cfg, 'main')
}

/** Full chain as shown by `/fallback` and `tagent fallback`. */
export function describeChain(cfg: TagentConfig): { label: string; model: string; primary: boolean }[] {
  const out: { label: string; model: string; primary: boolean }[] = [
    { label: `${cfg.defaultProvider} (primary)`, model: cfg.defaultModel, primary: true },
  ]
  for (const e of fallbackTail(cfg)) out.push({ label: e.label, model: e.model, primary: false })
  return out
}

/** All three chains as shown by /fallback — main · subagent · vision. The
 *  primary of each lane is what that role ACTUALLY runs on (role override
 *  when set, else the main model); the tail is the role's own list. */
export function describeChains(cfg: TagentConfig): Record<FallbackRole, { label: string; model: string; primary: boolean }[]> {
  const lane = (primaryLabel: string, primaryModel: string, tail: ResolvedChainEntry[]) => [
    { label: `${primaryLabel} (primary)`, model: primaryModel, primary: true },
    ...tail.map((e) => ({ label: e.label, model: e.model, primary: false })),
  ]
  const subRef = cfg.models?.subagent
  const visRef = cfg.models?.media?.vision
  const [subP, ...subM] = subRef ? subRef.split('/') : [cfg.defaultProvider]
  const [visP, ...visM] = visRef ? visRef.split('/') : [cfg.defaultProvider]
  return {
    main: lane(cfg.defaultProvider, cfg.defaultModel, fallbackTailFor(cfg, 'main')),
    subagent: lane(subP, subM.join('/') || cfg.defaultModel, fallbackTailFor(cfg, 'subagent')),
    vision: lane(visP, visM.join('/') || cfg.defaultModel, fallbackTailFor(cfg, 'vision')),
  }
}

/**
 * Run one completion through the chain. Adapter errors (network, 401/429/5xx,
 * timeouts) fail over to the next entry; an aborted signal rethrows
 * immediately so Ctrl+C never walks the chain.
 */
export async function completeWithFallback(
  chain: ResolvedChainEntry[],
  req: CompletionRequest,
  onFailover?: (info: { failed: string; error: string; next?: string }) => void,
): Promise<CompletionResult> {
  if (chain.length === 0) throw new Error('no usable provider — set an api key or fix the fallback chain')
  let lastErr: unknown
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i]
    try {
      // a fallback model without image input must not receive screenshot
      // parts — strip them so failover stays alive
      const effective = req.messages.some((m) => m.images?.length) && !acceptsImages(entry.adapter, entry.model)
        ? withoutImages({ ...req, model: entry.model })
        : { ...req, model: entry.model }
      return await entry.adapter.completeStream(effective)
    } catch (err) {
      if (req.signal?.aborted) throw err
      lastErr = err
      onFailover?.({
        failed: entry.label,
        error: (err as Error).message,
        next: chain[i + 1]?.label,
      })
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** Normalize/validate a fallback list coming from user input. */
export function sanitizeFallback(list: unknown): FallbackEntry[] {
  if (!Array.isArray(list)) return []
  const out: FallbackEntry[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const f = raw as Record<string, unknown>
    const provider = String(f.provider ?? '').trim()
    const model = String(f.model ?? '').trim()
    if (!provider || !model) continue
    out.push({
      provider,
      model,
      ...(typeof f.apiKey === 'string' && f.apiKey.trim() ? { apiKey: f.apiKey.trim() } : {}),
      enabled: f.enabled === false ? false : true,
      ...(typeof f.label === 'string' && f.label.trim() ? { label: f.label.trim() } : {}),
    })
  }
  return out.slice(0, 8)
}
