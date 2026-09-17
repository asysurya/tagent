import fs from 'node:fs'
import path from 'node:path'
import type { ToolDefinition } from '../types'
import { jailPath, relPath, trunc, ensureDir } from '../util'

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.turbo', '.cache',
  '.tagent', 'coverage', '.venv', '__pycache__', '.DS_Store', 'vendor',
])

const MAX_READ = 200_000
const MAX_TREE_ENTRIES = 600
const MAX_GREP_RESULTS = 200

function walk(root: string, dir: string, out: string[], depth: number, maxDepth = 6): void {
  if (out.length >= MAX_TREE_ENTRIES || depth > maxDepth) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
  for (const e of entries) {
    if (out.length >= MAX_TREE_ENTRIES) return
    if (IGNORED_DIRS.has(e.name)) continue
    const abs = path.join(dir, e.name)
    const rel = relPath(root, abs)
    if (e.isDirectory()) {
      out.push(rel + '/')
      walk(root, abs, out, depth + 1, maxDepth)
    } else {
      try {
        const st = fs.statSync(abs)
        if (st.size <= 2_000_000) out.push(rel)
      } catch { /* ignore unreadable */ }
    }
  }
}

function walkFiles(root: string, dir: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (IGNORED_DIRS.has(e.name)) continue
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) walkFiles(root, abs, out)
    else if (e.isFile()) out.push(abs)
  }
}

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description:
    'Read a text file from the workspace. Returns the file content (up to ~200KB).',
  risk: 'low',
  params: { path: 'string (required) — file path relative to workspace root', limit: 'number — max characters (default 200000)' },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace root' },
      limit: { type: 'number', description: 'Max characters to return (default 200000)' },
    },
    required: ['path'],
  },
  async run(input, ctx) {
    const abs = jailPath(ctx.workspaceRoot, input.path as string)
    const st = fs.statSync(abs)
    if (st.isDirectory()) return `Error: ${input.path} is a directory (use list_files)`
    const raw = fs.readFileSync(abs, 'utf8')
    const limit = Number(input.limit ?? MAX_READ)
    const content = trunc(raw, limit)
    return `File: ${relPath(ctx.workspaceRoot, abs)} (${st.size} bytes)\n\n${content}`
  },
}

export const listFilesTool: ToolDefinition = {
  name: 'list_files',
  description:
    'List files in the workspace (or a subdirectory). Directories end with "/". Ignores node_modules/.git/etc.',
  risk: 'low',
  params: { path: 'string — directory to list (default ".")', maxDepth: 'number — recursion depth (default 6)' },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list (default ".")' },
      maxDepth: { type: 'number', description: 'Recursion depth (default 6)' },
    },
  },
  async run(input, ctx) {
    const base = jailPath(ctx.workspaceRoot, (input.path as string) || '.')
    const out: string[] = []
    walk(ctx.workspaceRoot, base, out, 0, Number(input.maxDepth ?? 6))
    if (out.length === 0) return 'No files found.'
    return out.slice(0, MAX_TREE_ENTRIES).join('\n')
  },
}

export const grepTool: ToolDefinition = {
  name: 'grep',
  description:
    'Search file contents with a regex pattern. Returns "path:line: text" matches. Only searches text files.',
  risk: 'low',
  params: {
    pattern: 'string (required) — JavaScript regex, e.g. "function\\\\s+\\\\w+"',
    path: 'string — directory or file to search (default workspace root)',
    glob: 'string — filter files by substring, e.g. ".ts"',
  },
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regex, e.g. "function\\s+\\w+"' },
      path: { type: 'string', description: 'Directory or file to search (default workspace root)' },
      glob: { type: 'string', description: 'Filter files by substring, e.g. ".ts"' },
    },
    required: ['pattern'],
  },
  async run(input, ctx) {
    const pattern = String(input.pattern ?? '')
    if (!pattern) return 'Error: pattern is required'
    let re: RegExp
    try {
      re = new RegExp(pattern, 'gi')
    } catch (e) {
      return `Error: invalid regex — ${(e as Error).message}`
    }
    const target = jailPath(ctx.workspaceRoot, (input.path as string) || '.')
    const glob = input.glob ? String(input.glob) : ''
    const files: string[] = []
    const st = fs.statSync(target)
    if (st.isFile()) files.push(target)
    else walkFiles(ctx.workspaceRoot, target, files)
    const results: string[] = []
    for (const f of files) {
      if (glob && !f.includes(glob)) continue
      let text: string
      try {
        const buf = fs.readFileSync(f)
        if (buf.includes(0)) continue // binary
        text = buf.toString('utf8')
      } catch { continue }
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0
        if (re.test(lines[i])) {
          results.push(`${relPath(ctx.workspaceRoot, f)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
          if (results.length >= MAX_GREP_RESULTS) {
            results.push(`…[stopped at ${MAX_GREP_RESULTS} matches]`)
            return results.join('\n')
          }
        }
      }
    }
    return results.length ? results.join('\n') : `No matches for /${pattern}/`
  },
}

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description:
    'Create or overwrite a file with full content. Parent directories are created automatically. Use for new files or full rewrites.',
  risk: 'medium',
  params: { path: 'string (required) — file path', content: 'string (required) — full file content' },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace root' },
      content: { type: 'string', description: 'Full file content to write' },
    },
    required: ['path', 'content'],
  },
  async run(input, ctx) {
    const abs = jailPath(ctx.workspaceRoot, input.path as string)
    if (typeof input.content !== 'string') return 'Error: content must be a string'
    ensureDir(path.dirname(abs))
    fs.writeFileSync(abs, input.content, 'utf8')
    const lines = input.content.split('\n').length
    ctx.events.onFilesChanged?.([relPath(ctx.workspaceRoot, abs)])
    return `Wrote ${relPath(ctx.workspaceRoot, abs)} (${input.content.length} bytes, ${lines} lines)`
  },
}

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description:
    'Edit a file by replacing an exact string. `old` must match the file exactly (including whitespace). Use write_file for full rewrites.',
  risk: 'medium',
  params: {
    path: 'string (required)',
    old: 'string (required) — exact text to find',
    new: 'string (required) — replacement text',
    replace_all: 'boolean — replace every occurrence (default false)',
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace root' },
      old: { type: 'string', description: 'Exact text to find (must match exactly, including whitespace)' },
      new: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
    },
    required: ['path', 'old', 'new'],
  },
  async run(input, ctx) {
    const abs = jailPath(ctx.workspaceRoot, input.path as string)
    if (typeof input.old !== 'string' || typeof input.new !== 'string') {
      return 'Error: old and new must be strings'
    }
    const text = fs.readFileSync(abs, 'utf8')
    if (!text.includes(input.old)) {
      // help the model recover
      const similar = text
        .split('\n')
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => l.trim() && (l.includes(input.old.trim().slice(0, 20)) || input.old.trim().slice(0, 20).includes(l.trim().slice(0, 20))))
        .slice(0, 5)
        .map(({ l, i }) => `${i + 1}: ${l.trim().slice(0, 120)}`)
        .join('\n')
      return `Error: old string not found in ${input.path}. Closest lines:\n${similar || '(none)'}\n\nRe-read the file and retry with the exact text.`
    }
    const replaceAll = input.replace_all === true
    const next = replaceAll ? text.split(input.old).join(input.new) : text.replace(input.old, input.new)
    fs.writeFileSync(abs, next, 'utf8')
    const n = replaceAll ? text.split(input.old).length - 1 : 1
    ctx.events.onFilesChanged?.([relPath(ctx.workspaceRoot, abs)])
    return `Edited ${relPath(ctx.workspaceRoot, abs)} — ${n} replacement(s) made`
  },
}
