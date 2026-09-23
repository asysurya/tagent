/**
 * modelroles.ts — per-role model resolution (main agent · subagents · media).
 *
 * Config refs are "provider/model" (or legacy "provider:model"); a bare id
 * means "this model, on the main agent's provider". Everything resolves to
 * { provider, model } or null (= no override — use the caller's default).
 */
import type { MediaModality, ModelRoles, TagentConfig } from './types'
import { parseModelRef } from './providers/registry'

export interface ResolvedRef {
  provider: string
  model: string
}

/** Parse one config ref. Bare ids ride the main agent's provider. */
export function parseRoleRef(
  ref: string | undefined,
  cfg: TagentConfig,
): ResolvedRef | null {
  const raw = (ref ?? '').trim()
  if (!raw) return null
  const parsed = parseModelRef(raw, cfg)
  if (parsed) return parsed
  // no separator (or unknown prefix) → same provider as the main agent
  return { provider: cfg.defaultProvider, model: raw }
}

/**
 * The subagent model: cfg.models.subagent when set, else null (= the parent
 * agent's provider/model, the historical behavior).
 */
export function resolveSubagentModel(cfg: TagentConfig): ResolvedRef | null {
  return parseRoleRef(cfg.models?.subagent, cfg)
}

/**
 * The media model for a modality: cfg.models.media.<modality> when set.
 * Null → the caller decides (typically: the main model IF it accepts
 * images, otherwise a setup error).
 */
export function resolveMediaModel(
  modality: MediaModality,
  cfg: TagentConfig,
): ResolvedRef | null {
  return parseRoleRef(cfg.models?.media?.[modality], cfg)
}

/** Set (or clear, when ref is empty) a role override in-place on the config. */
export function setRoleRef(
  cfg: TagentConfig,
  role: 'subagent' | MediaModality,
  ref: string,
): void {
  if (role === 'subagent') {
    if (!ref) delete cfg.models?.subagent
    else {
      cfg.models ??= {}
      cfg.models.subagent = ref
    }
    if (cfg.models && !cfg.models.subagent && !cfg.models.media) delete cfg.models
    return
  }
  if (!ref) {
    delete cfg.models?.media?.[role]
    if (cfg.models?.media && Object.keys(cfg.models.media).length === 0) {
      delete cfg.models.media
      if (!cfg.models.subagent) delete cfg.models
    }
    return
  }
  cfg.models ??= {}
  cfg.models.media ??= {}
  cfg.models.media[role] = ref
}

/** One line per role for /model list & the GUI — "subagent: zai/glm-4.5-air". */
export function describeModelRoles(cfg: TagentConfig): { role: string; ref: string; set: boolean }[] {
  const rows: { role: string; ref: string; set: boolean }[] = [
    { role: 'main', ref: `${cfg.defaultProvider}/${cfg.defaultModel}`, set: true },
  ]
  const roles = cfg.models
  rows.push({
    role: 'subagent',
    ref: roles?.subagent ?? '(same as main)',
    set: !!roles?.subagent,
  })
  for (const m of ['vision', 'audio', 'video', 'pdf'] as MediaModality[]) {
    rows.push({
      role: `media · ${m}`,
      ref: roles?.media?.[m] ?? '(main model, if capable)',
      set: !!roles?.media?.[m],
    })
  }
  return rows
}
