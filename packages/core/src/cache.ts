import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from './util'
import { workspaceDir } from './config'

/**
 * Tagent's caching layer — the "token economist".
 *
 * Three pieces:
 * 1. FileStateCache  — remembers (mtime, size) of every file the agent reads.
 *    A re-read of an UNCHANGED file returns a tiny stub instead of the full
 *    content, so the context never pays twice for the same bytes. Persisted
 *    per workspace in `.tagent/file-state.json` → survives restarts.
 * 2. webCache       — TTL cache for web_fetch / ddg_search (default 10 min).
 *    Same URL twice in one session = one network round-trip.
 * 3. stats          — hit/miss + chars-saved counters so `tagent cache` can
 *    prove the savings.
 */

export interface FileStamp {
  mtimeMs: number
  size: number
  at: number
  reads: number
}

export type Freshness = 'fresh' | 'changed' | 'new'

class WorkspaceFileState {
  private map = new Map<string, FileStamp>()
  private loaded = false
  private file: string

  constructor(private root: string) {
    this.file = path.join(workspaceDir(root), 'file-state.json')
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { files?: Record<string, FileStamp> }
      const cutoff = Date.now() - FILE_STATE_TTL_MS
      for (const [p, st] of Object.entries(raw.files ?? {})) {
        if (st && typeof st.mtimeMs === 'number' && (st.at ?? 0) > cutoff) this.map.set(p, st)
      }
    } catch {
      /* absent / corrupt — start empty */
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.file)
      ensureDir(dir)
      const files: Record<string, FileStamp> = {}
      const cutoff = Date.now() - FILE_STATE_TTL_MS
      for (const [p, st] of this.map) if (st.at > cutoff) files[p] = st
      fs.writeFileSync(this.file, JSON.stringify({ v: 1, files }, null, 2))
    } catch {
      /* best-effort — cache must never break the loop */
    }
  }

  /** Compare the on-disk file with the remembered stamp. */
  check(abs: string): Freshness {
    this.load()
    let st: fs.Stats
    try {
      st = fs.statSync(abs)
      if (!st.isFile()) return 'new'
    } catch {
      return 'new'
    }
    const prev = this.map.get(abs)
    if (!prev) return 'new'
    // mtime alone can lie (same-second writes); combine with size for safety
    return prev.mtimeMs === st.mtimeMs && prev.size === st.size ? 'fresh' : 'changed'
  }

  /** Remember the current stamp of a file the agent just read. */
  record(abs: string): void {
    this.load()
    try {
      const st = fs.statSync(abs)
      const prev = this.map.get(abs)
      this.map.set(abs, { mtimeMs: st.mtimeMs, size: st.size, at: Date.now(), reads: (prev?.reads ?? 0) + 1 })
    } catch {
      return
    }
    this.persist()
  }

  /** Drop a file from the cache (after we wrote/edited it). */
  invalidate(abs: string): void {
    if (!this.loaded) this.load()
    if (this.map.delete(abs)) this.persist()
  }

  entries(): number {
    this.load()
    return this.map.size
  }

  clear(): void {
    this.map.clear()
    try {
      fs.rmSync(this.file, { force: true })
    } catch {
      /* ignore */
    }
  }
}

/** Stamps expire after 30 min of session time — avoids stale "unchanged" answers. */
const FILE_STATE_TTL_MS = 30 * 60 * 1000

const instances = new Map<string, WorkspaceFileState>()

/** Per-workspace singleton (shared across loops, subagents, daemon runs). */
export function fileStateFor(root: string): WorkspaceFileState {
  const key = path.resolve(root)
  let inst = instances.get(key)
  if (!inst) {
    inst = new WorkspaceFileState(key)
    instances.set(key, inst)
  }
  return inst
}

/* ------------------------------------------------------------------ */
/* TTL cache — web_fetch / ddg_search                                   */
/* ------------------------------------------------------------------ */

interface TtlEntry {
  body: string
  at: number
}

const MAX_WEB_ENTRIES = 128
const webCache = new Map<string, TtlEntry>()

export function webCacheGet(key: string, ttlMs: number): string | undefined {
  const e = webCache.get(key)
  if (!e) return undefined
  if (Date.now() - e.at > ttlMs) {
    webCache.delete(key)
    return undefined
  }
  return e.body
}

export function webCacheSet(key: string, body: string): void {
  if (webCache.size >= MAX_WEB_ENTRIES) {
    // evict the oldest entry (Map preserves insertion order)
    const first = webCache.keys().next().value
    if (first !== undefined) webCache.delete(first)
  }
  webCache.set(key, { body, at: Date.now() })
}

/* ------------------------------------------------------------------ */
/* stats                                                                */
/* ------------------------------------------------------------------ */

export interface CacheStats {
  fileHits: number
  fileMisses: number
  fileCharsSaved: number
  webHits: number
  webMisses: number
  batchCalls: number
  fastPathReads: number
}

const stats: CacheStats = {
  fileHits: 0,
  fileMisses: 0,
  fileCharsSaved: 0,
  webHits: 0,
  webMisses: 0,
  batchCalls: 0,
  fastPathReads: 0,
}

export function bumpStat<K extends keyof CacheStats>(k: K, n = 1): void {
  stats[k] += n
}

export function cacheStats(): CacheStats {
  return { ...stats }
}

export function resetCacheStats(): void {
  stats.fileHits = 0
  stats.fileMisses = 0
  stats.fileCharsSaved = 0
  stats.webHits = 0
  stats.webMisses = 0
  stats.batchCalls = 0
  stats.fastPathReads = 0
}

/** Wipe everything: in-memory state + the persisted file-state.json. */
export function clearCaches(root?: string): { workspaces: number; webEntries: number } {
  const webEntries = webCache.size
  webCache.clear()
  let workspaces = 0
  if (root) {
    fileStateFor(root).clear()
    workspaces = 1
  } else {
    for (const [, inst] of instances) {
      inst.clear()
      workspaces++
    }
    instances.clear()
  }
  resetCacheStats()
  return { workspaces, webEntries }
}

/** Resolve effective TTL for web caching from config (minutes → ms). */
export function webTtlMs(webTtlMin?: number): number {
  return Math.max(0, webTtlMin ?? 10) * 60_000
}
