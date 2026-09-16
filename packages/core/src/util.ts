import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'

export function uid(): string {
  return randomUUID().slice(0, 8) + Date.now().toString(36).slice(-4)
}

/** Truncate long strings with a marker. */
export function trunc(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`
}

/**
 * Jail a user/tool-supplied path inside the workspace root.
 * Throws on escape attempts (absolute outside root, or `..` traversal).
 */
export function jailPath(root: string, p: string | undefined | null): string {
  if (!p || typeof p !== 'string') return root
  const normRoot = path.resolve(root)
  const joined = path.isAbsolute(p) ? path.resolve(p) : path.resolve(normRoot, p)
  if (joined === normRoot || joined.startsWith(normRoot + path.sep)) return joined
  throw new Error(`Path escapes workspace: ${p}`)
}

/** Relative display path (posix style) for messages / UI. */
export function relPath(root: string, abs: string): string {
  const r = path.resolve(root)
  if (abs === r) return '.'
  if (abs.startsWith(r + path.sep)) return abs.slice(r.length + 1).split(path.sep).join('/')
  return abs
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

export function nowMs(): number {
  return Date.now()
}

export function fileExists(p: string): boolean {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = 'operation',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Decode basic HTML entities (for web_fetch / ddg_search). */
export function decodeEntities(s: string): string {
  const map: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&#x27;': "'",
    '&nbsp;': ' ',
    '&mdash;': '—',
    '&ndash;': '–',
    '&hellip;': '…',
  }
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&[a-z]+;/gi, (e) => map[e.toLowerCase()] ?? e)
}

/** Strip tags / scripts → readable text (best-effort, no deps). */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

/** Simple front-matter parser for SKILL.md / AGENTS.md metadata. */
export function parseFrontMatter(
  raw: string,
): { data: Record<string, string>; body: string } {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/)
  if (!m) return { data: {}, body: raw }
  const data: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (kv) data[kv[1]] = kv[2].trim()
  }
  return { data, body: raw.slice(m[0].length).trim() }
}

export function deepMerge<T extends Record<string, unknown>>(base: T, over: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k]) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out as T
}
