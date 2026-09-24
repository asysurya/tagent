import fs from 'node:fs'
import path from 'node:path'
import type { ToolContext } from './types'
import { uid } from './util'

/**
 * Checkpoints — snapshot the workspace before agent writes, restore via undo.
 * Stored in <root>/.tagent/snapshots/<ts-label>/ (kept: last 10).
 */

const MAX_SNAPSHOTS = 10
const MAX_FILE_SIZE = 2_000_000
const IGNORED = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.turbo', '.cache', 'coverage'])

export interface CheckpointMeta {
  id: string
  label: string
  at: number
  files: number
}

function snapDir(root: string): string {
  return path.join(root, '.tagent', 'snapshots')
}

function copyTree(src: string, dest: string): number {
  let count = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(src, { withFileTypes: true })
  } catch {
    return 0
  }
  fs.mkdirSync(dest, { recursive: true })
  for (const e of entries) {
    if (IGNORED.has(e.name)) continue
    const s = path.join(src, e.name)
    const d = path.join(dest, e.name)
    try {
      if (e.isDirectory()) {
        count += copyTree(s, d)
      } else if (e.isFile()) {
        const st = fs.statSync(s)
        if (st.size > MAX_FILE_SIZE) continue
        fs.copyFileSync(s, d)
        count++
      }
    } catch { /* skip unreadable */ }
  }
  return count
}

export function createCheckpoint(root: string, label: string): CheckpointMeta {
  const id = `${Date.now()}-${uid()}`
  const dest = path.join(snapDir(root), id)
  const files = copyTree(root, dest)
  const meta: CheckpointMeta = { id, label, at: Date.now(), files }
  fs.writeFileSync(path.join(dest, '.checkpoint.json'), JSON.stringify(meta))
  prune(root)
  return meta
}

export function listCheckpoints(root: string): CheckpointMeta[] {
  let entries: string[]
  try {
    entries = fs.readdirSync(snapDir(root))
  } catch {
    return []
  }
  const metas: CheckpointMeta[] = []
  for (const e of entries) {
    try {
      const raw = fs.readFileSync(path.join(snapDir(root), e, '.checkpoint.json'), 'utf8')
      metas.push(JSON.parse(raw))
    } catch { /* skip */ }
  }
  return metas.sort((a, b) => b.at - a.at)
}

export function undoCheckpoint(root: string): CheckpointMeta | undefined {
  const [latest, ...rest] = listCheckpoints(root)
  if (!latest) return undefined
  const src = path.join(snapDir(root), latest.id)
  // restore: copy snapshot files back over the workspace
  copyTree(src, root)
  try {
    fs.rmSync(src, { recursive: true, force: true })
  } catch { /* noop */ }
  void rest
  return latest
}

function prune(root: string): void {
  const all = listCheckpoints(root)
  for (const m of all.slice(MAX_SNAPSHOTS)) {
    try {
      fs.rmSync(path.join(snapDir(root), m.id), { recursive: true, force: true })
    } catch { /* noop */ }
  }
}

/** Returns true if the turn should trigger a pre-write snapshot. */
export function shouldCheckpoint(
  toolName: string,
  alreadySnapshotted: boolean,
  ctx: ToolContext,
): boolean {
  if (alreadySnapshotted) return false
  if (!ctx.config.autoCheckpoint) return false
  return ['write_file', 'edit_file', 'bash'].includes(toolName)
}
