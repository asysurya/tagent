import fs from 'node:fs'
import path from 'node:path'

const IGNORED = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.turbo', '.cache', '.tagent'])

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
  children?: FileNode[]
}

/** Build a file tree (depth-limited) for the GUI. */
export function walkTree(root: string, rel: string, depth = 0): FileNode {
  const abs = path.resolve(root, rel)
  if (!abs.startsWith(path.resolve(root))) throw new Error('path escapes workspace')
  const st = fs.statSync(abs)
  const node: FileNode = {
    name: path.basename(abs) || '/',
    path: rel === '.' ? '.' : rel,
    type: st.isDirectory() ? 'dir' : 'file',
    size: st.isFile() ? st.size : undefined,
  }
  if (st.isDirectory() && depth < 8) {
    node.children = []
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      return node
    }
    entries.sort((a, b) =>
      a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1,
    )
    for (const e of entries.slice(0, 400)) {
      if (IGNORED.has(e.name)) continue
      try {
        node.children.push(walkTree(root, path.join(rel === '.' ? '' : rel, e.name), depth + 1))
      } catch { /* skip unreadable */ }
    }
  }
  return node
}

const MAX_READ = 400_000

export function readWorkspaceFile(root: string, rel: string): { path: string; content: string; size: number; binary?: boolean } {
  const abs = path.resolve(root, rel)
  if (!abs.startsWith(path.resolve(root))) throw new Error('path escapes workspace')
  const st = fs.statSync(abs)
  if (st.isDirectory()) throw new Error('is a directory')
  if (st.size > 2_000_000) throw new Error('file too large (max 2MB)')
  const buf = fs.readFileSync(abs)
  if (buf.includes(0)) {
    return { path: rel, content: '', size: st.size, binary: true }
  }
  const content = buf.toString('utf8')
  return { path: rel, content: content.length > MAX_READ ? content.slice(0, MAX_READ) + '\n…[truncated]' : content, size: st.size }
}

export function saveWorkspaceFile(root: string, rel: string, content: string): { ok: true; path: string; bytes: number } {
  const abs = path.resolve(root, rel)
  if (!abs.startsWith(path.resolve(root))) throw new Error('path escapes workspace')
  if (!fs.existsSync(path.dirname(abs))) fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
  return { ok: true, path: rel, bytes: Buffer.byteLength(content) }
}
