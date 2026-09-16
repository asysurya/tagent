import fs from 'node:fs'
import path from 'node:path'
import type { TagentConfig } from './types'
import { deepMerge, ensureDir } from './util'

export const GLOBAL_DIR = path.join(process.env.HOME || process.cwd(), '.tagent')

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
        list_files: 'allow',
        grep: 'allow',
        write_file: 'ask',
        edit_file: 'ask',
        bash: 'ask',
        web_fetch: 'allow',
        ddg_search: 'allow',
        task: 'allow',
        todowrite: 'allow',
        memory: 'allow',
        load_skill: 'allow',
        browser: 'ask',
      },
    },
    tools: { bash: true, browser: false },
    github: {},
    mega: { enabled: false },
    autoCheckpoint: true,
    maxTurns: 40,
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
