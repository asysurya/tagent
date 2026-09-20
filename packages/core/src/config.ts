import fs from 'node:fs'
import path from 'node:path'
import type { TagentConfig } from './types'
import { deepMerge, ensureDir, homeDir } from './util'

export const GLOBAL_DIR = path.join(homeDir(), '.tagent')

export function workspaceDir(root: string): string {
  return path.join(root, '.tagent')
}

export function defaultConfig(): TagentConfig {
  return {
    version: 1,
    defaultProvider: 'zai',
    defaultModel: 'glm-4.7',
    apiKeys: {},
    customProviders: [],
    permissions: {
      defaultMode: 'ask',
      tools: {
        read_file: 'allow',
        read_files: 'allow',
        list_files: 'allow',
        grep: 'allow',
        write_file: 'ask',
        edit_file: 'ask',
        bash: 'ask',
        web_fetch: 'allow',
        ddg_search: 'allow',
        task: 'allow',
        todowrite: 'allow',
        worklog: 'allow',
        memory: 'allow',
        load_skill: 'allow',
        browser: 'ask',
        serve: 'ask',
        test_report: 'allow',
        mcp: 'ask',
        plugin: 'ask',
      },
    },
    tools: { bash: true, browser: true, serve: true },
    github: {},
    mega: { enabled: false },
    autoCheckpoint: true,
    maxTurns: 40,
    nativeTools: true,
    worklog: { enabled: true },
    caveman: false,
    webGui: false,
    mcp: { servers: {} },
    cache: { fileState: true, web: true, webTtlMin: 10 },
    fallback: [],
    diagnostics: { command: '' },
  }
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Load effective config: defaults ← global (~/.tagent/config.json)
 * ← workspace (<root>/.tagent/config.json).
 * `extra` (highest precedence) is used by hosts like the sandbox daemon.
 */
export function loadConfig(root: string, extra?: Partial<TagentConfig>): TagentConfig {
  const base = defaultConfig()
  const g = readJson(path.join(GLOBAL_DIR, 'config.json'))
  const w = readJson(path.join(workspaceDir(root), 'config.json'))
  let cfg = base
  if (g) cfg = deepMerge(cfg as unknown as Record<string, unknown>, g) as unknown as TagentConfig
  if (w) cfg = deepMerge(cfg as unknown as Record<string, unknown>, w) as unknown as TagentConfig
  if (extra) cfg = deepMerge(cfg as unknown as Record<string, unknown>, extra as Record<string, unknown>) as unknown as TagentConfig
  return cfg
}

/** Persist to the workspace config (keys stay local — the file is gitignored). */
export function saveConfig(root: string, cfg: TagentConfig): void {
  const dir = workspaceDir(root)
  ensureDir(dir)
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2))
}

/* ------------------------------------------------------------------ */
/* global config patching — powers `tagent config set -g` + auth        */
/* ------------------------------------------------------------------ */

/**
 * Merge a patch into the GLOBAL config (~/.tagent/config.json) and persist.
 * Workspace config still overrides global on load — use this for user-level
 * settings (webGui default, GitHub token, provider keys).
 */
export function updateGlobalConfig(patch: Partial<TagentConfig>): TagentConfig {
  const file = path.join(GLOBAL_DIR, 'config.json')
  const current = deepMerge(
    defaultConfig() as unknown as Record<string, unknown>,
    readJson(file) ?? {},
  ) as unknown as TagentConfig
  const next = deepMerge(current as unknown as Record<string, unknown>, patch as Record<string, unknown>) as unknown as TagentConfig
  ensureDir(GLOBAL_DIR)
  fs.writeFileSync(file, JSON.stringify(next, null, 2))
  return next
}

/** Read the global config (~/.tagent/config.json), defaults if absent. */
export function readGlobalConfig(): TagentConfig {
  return deepMerge(
    defaultConfig() as unknown as Record<string, unknown>,
    readJson(path.join(GLOBAL_DIR, 'config.json')) ?? {},
  ) as unknown as TagentConfig
}

/* ------------------------------------------------------------------ */
/* recent workspaces (global) — powers the workspace switcher          */
/* ------------------------------------------------------------------ */

export interface RecentWorkspace {
  path: string
  name: string
  exists: boolean
  at?: number
}

function recentFile(): string {
  return path.join(GLOBAL_DIR, 'workspaces.json')
}

/** Current workspace first, then the most recently used ones (deduped, capped). */
export function listRecentWorkspaces(current: string): RecentWorkspace[] {
  const cur = path.resolve(current)
  const seen = new Set([cur])
  const out: RecentWorkspace[] = [{ path: cur, name: path.basename(cur), exists: true }]
  const arr = readJson(recentFile()) as { path: string; at: number }[] | undefined
  for (const w of (arr ?? []).sort((a, b) => b.at - a.at)) {
    const p = path.resolve(w.path)
    if (seen.has(p)) continue
    seen.add(p)
    out.push({ path: p, name: path.basename(p), exists: fs.existsSync(p), at: w.at })
  }
  return out.slice(0, 12)
}

/** Remember a workspace as recently used (global, newest first, capped at 12). */
export function rememberWorkspace(root: string): void {
  try {
    const p = path.resolve(root)
    const arr = (readJson(recentFile()) as { path: string; at: number }[] | undefined) ?? []
    const next = [{ path: p, at: Date.now() }, ...arr.filter((w) => path.resolve(w.path) !== p)].slice(0, 12)
    ensureDir(GLOBAL_DIR)
    fs.writeFileSync(recentFile(), JSON.stringify(next, null, 2))
  } catch {
    /* best-effort — never break startup */
  }
}
