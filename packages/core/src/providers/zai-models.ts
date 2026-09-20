/**
 * Built-in Z.ai model catalog — data, not code.
 *
 * The default list ships in ../data/zai-models.json (embedded in the binary
 * at build time). Users can override or extend it with the SAME shape at:
 *
 *   ~/.tagent/zai-models.json                  (global, wins over embedded)
 *   <workspace>/.tagent/zai-models.json         (per project, wins over global)
 *
 * Merging: entries with the same id replace the built-in entry in place,
 * unknown ids are appended at the end. A top-level `"replace": true` swaps
 * the whole list for the file's models (full user control).
 *
 * So when Z.ai ships a new model you don't wait for a tagent release:
 * drop it in your file and it shows up in every picker immediately.
 */
import fs from 'node:fs'
import path from 'node:path'
import EMBEDDED from '../data/zai-models.json'
import { homeDir } from '../util'
import { workspaceDir } from '../config'
import type { ModelInfo } from '../types'

/** raw shape of a model entry inside the JSON files */
export interface ZaiModelEntry {
  id: string
  label?: string
  vision?: boolean
  description?: string
}

/** top-level shape of zai-models.json */
export interface ZaiModelsFile {
  /** true → the file's models REPLACE the whole list instead of merging */
  replace?: boolean
  models?: ZaiModelEntry[]
}

const PROVIDER = 'zai'

/** embedded defaults — parsed once, immutable */
export const EMBEDDED_ZAI_MODELS: ModelInfo[] = ((EMBEDDED as unknown as ZaiModelsFile).models ?? [])
  .filter((m) => typeof m?.id === 'string' && m.id)
  .map((m) => ({
    id: m.id,
    label: m.label || m.id,
    provider: PROVIDER,
    ...(m.vision === undefined ? {} : { vision: m.vision }),
    ...(m.description ? { description: m.description } : {}),
  }))

function fromRaw(entries: ZaiModelEntry[]): ModelInfo[] {
  return entries
    .filter((m) => typeof m?.id === 'string' && m.id)
    .map((m) => ({
      id: m.id,
      label: m.label || m.id,
      provider: PROVIDER,
      ...(m.vision === undefined ? {} : { vision: m.vision }),
      ...(m.description ? { description: m.description } : {}),
    }))
}

/** read + validate one JSON file; never throws */
function readModelsFile(file: string): ZaiModelsFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const parsed = raw as ZaiModelsFile
    if (!Array.isArray(parsed.models)) return null
    return parsed
  } catch {
    return null
  }
}

/** merge by id: same-id entries replace in place, new ids append at the end */
function mergeModels(base: ModelInfo[], incoming: ZaiModelEntry[]): ModelInfo[] {
  const out = base.map((m) => ({ ...m }))
  for (const e of incoming) {
    if (typeof e?.id !== 'string' || !e.id) continue
    const idx = out.findIndex((m) => m.id === e.id)
    const norm: ModelInfo = {
      id: e.id,
      label: e.label || e.id,
      provider: PROVIDER,
      ...(e.vision === undefined ? {} : { vision: e.vision }),
      ...(e.description ? { description: e.description } : {}),
    }
    if (idx >= 0) out[idx] = norm
    else out.push(norm)
  }
  return out
}

function applyLayer(current: ModelInfo[], file: ZaiModelsFile): ModelInfo[] {
  const entries = (file.models ?? []).filter((m) => typeof m?.id === 'string' && m.id)
  if (file.replace === true) return fromRaw(entries)
  return mergeModels(current, entries)
}

/**
 * The effective built-in Z.ai model list:
 * embedded defaults ← global override ← workspace override.
 * `root` is optional — omit it when the workspace path isn't known (the
 * global + embedded layers still apply).
 */
export function zaiModels(root?: string): ModelInfo[] {
  let out = EMBEDDED_ZAI_MODELS
  const globalFile = readModelsFile(path.join(homeDir(), '.tagent', 'zai-models.json'))
  if (globalFile) out = applyLayer(out, globalFile)
  if (root) {
    const wsFile = readModelsFile(path.join(workspaceDir(root), 'zai-models.json'))
    if (wsFile) out = applyLayer(out, wsFile)
  }
  return out
}

/** Human path of the user-editable override file (for docs / error hints). */
export function zaiModelsUserPath(): string {
  return path.join(homeDir(), '.tagent', 'zai-models.json')
}
