/**
 * compact.ts — deterministic context compaction. 100% local code.
 *
 * Design contract (the "caveman rework"):
 *  - MERINGKAS, BUKAN MEMANGKAS: nothing is silently cut mid-thought. Big
 *    blobs are elided with an explicit marker showing exactly what was
 *    skipped; old turns become a structured digest that preserves every
 *    fact the agent could need (who asked what, which tools ran on which
 *    paths, what was decided).
 *  - NO AI, EVER: no model call, no invention. Everything in the digest is
 *    copied from the transcript, never generated. Token savings come from
 *    structure, not hallucination.
 *  - The user's tokens are the point: compaction must never cost a single
 *    model call.
 *
 * Two layers:
 *  1. `compressOutput(text, budget)` — smart tool-output diet used by the
 *     loop every turn: JSON minify (lossless), repeated-line collapse,
 *     blank-line collapse, then head+tail elision with a marker (the
 *     beginning and the end of an output are almost always what matters).
 *  2. `compactSession(session)` — whole-history compaction: turns older
 *     than a token budget are replaced by ONE digest message; recent turns
 *     stay verbatim. A 100k-token history typically lands near 10k.
 */
import type { ChatMessage, SessionData } from './types'
import { estimateTokens, estimateMessageTokens } from './context'

/* ------------------------------------------------------------------ */
/* layer 1 — tool-output diet                                           */
/* ------------------------------------------------------------------ */

/** Collapse runs of 3+ identical consecutive lines → "line  (×N)". */
function dedupeLines(lines: string[]): string[] {
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    let j = i
    while (j + 1 < lines.length && lines[j + 1] === lines[i]) j++
    const run = j - i + 1
    if (run >= 3) {
      out.push(`${lines[i]}  (×${run})`)
    } else {
      for (let k = i; k <= j; k++) out.push(lines[k])
    }
    i = j + 1
  }
  return out
}

/** 3+ blank lines → one blank line. Trailing whitespace per line trimmed. */
function collapseBlanks(lines: string[]): string[] {
  const out: string[] = []
  let blanks = 0
  for (const raw of lines) {
    const l = raw.replace(/\s+$/, '')
    if (!l.trim()) {
      blanks++
      if (blanks <= 1) out.push('')
    } else {
      blanks = 0
      out.push(l)
    }
  }
  return out
}

/** Minify JSON when the text parses (lossless ~20-30% saving). */
function minifyJson(text: string): string {
  const t = text.trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return text
  try {
    return JSON.stringify(JSON.parse(t))
  } catch {
    return text
  }
}

/**
 * Smart deterministic compression for tool output.
 * Never used for user text — only for machine-generated blobs.
 */
export function compressOutput(text: string, budget: number): string {
  if (budget <= 0) return text
  const min = Math.min(budget, 64)
  // 1) cheap normalizations first (lossless or marker-annotated). Dedupe runs
  //    always: a "(×N)" marker is information, never loss.
  let s = minifyJson(text)
  let lines = collapseBlanks(s.split('\n'))
  lines = dedupeLines(lines)
  s = lines.join('\n')
  if (s.length <= budget) return s

  // 2) head+tail elision — the marker states exactly what was skipped
  const head = Math.max(Math.floor(budget * 0.6), min)
  const tail = Math.max(budget - head - 64, Math.floor(budget * 0.2))
  const skipped = Math.max(0, s.length - head - tail)
  return (
    s.slice(0, head) +
    `\n…[compacted: ${skipped} chars elided — middle section removed, head+tail kept]…\n` +
    s.slice(s.length - tail)
  )
}

/**
 * Slim the echoed action input of OLD turns before re-sending history.
 * write_file/edit_file inputs carry whole file contents that the model
 * re-receives every turn forever — after a couple of turns they are pure
 * ballast (the file is on disk and can be re-read). Keep the path + a
 * short preview so the trail stays auditable.
 */
export function slimActionInput(
  tool: string,
  input: Record<string, unknown>,
  keepChars = 160,
): Record<string, unknown> {
  const BULKY = new Set(['content', 'new_string', 'old_string', 'text', 'body', 'output'])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input ?? {})) {
    if (BULKY.has(k) && typeof v === 'string' && v.length > keepChars) {
      out[k] = v.slice(0, keepChars) + `…[+${v.length - keepChars} chars elided — full version is on disk / in the tool]`
    } else if (typeof v === 'string' && v.length > 400) {
      out[k] = v.slice(0, 400) + `…[+${v.length - 400} chars elided]`
    } else {
      out[k] = v
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* layer 2 — session digest + compaction                               */
/* ------------------------------------------------------------------ */

/** Collapse internal whitespace for one-line digests (display only). */
function collapseWs(s: string, keep = 240): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > keep ? one.slice(0, keep) + '…' : one
}

/** @attachment bodies are pure bulk in a digest — keep the mention only. */
function stripAttachments(content: string): string {
  return content
    .replace(/===== @[^\n]+ =====[\s\S]*?(?=\n===== |\n*$)/g, '(@files attached)')
    .trim()
}

/** Short description of one executed tool call — facts only. */
function toolCallDigest(c: { tool: string; input?: unknown; status?: string }): string {
  const inp = (c.input ?? {}) as Record<string, unknown>
  const key =
    (typeof inp.path === 'string' && inp.path) ||
    (typeof inp.file === 'string' && inp.file) ||
    (typeof inp.command === 'string' && collapseWs(inp.command, 60)) ||
    (typeof inp.query === 'string' && collapseWs(inp.query, 60)) ||
    (typeof inp.url === 'string' && inp.url) ||
    (typeof inp.pattern === 'string' && inp.pattern) ||
    ''
  const mark = c.status === 'error' ? '✗' : c.status === 'denied' ? '⊘' : '✓'
  return `${c.tool}${key ? `(${key})` : ''} ${mark}`
}

/** One line per message — the deterministic digest body. */
function digestLine(m: ChatMessage): string {
  if (m.role === 'user') {
    if (m.meta?.toolResults) return '' // covered by the assistant turn above it
    return `USER: ${collapseWs(stripAttachments(m.content))}`
  }
  if (m.role === 'assistant') {
    const text = collapseWs(m.content, 200)
    const tools = (m.toolCalls ?? []).map(toolCallDigest).join(', ')
    if (!text && !tools) return ''
    return `AGENT: ${text}${tools ? ` [${tools}]` : ''}`
  }
  return ''
}

export interface CompactOptions {
  /** approx tokens of recent turns kept verbatim (default 10000) */
  keepTokens?: number
  /** never compact below this many messages, even if the budget is small */
  minKeepMessages?: number
  /** abort when the saving is below this fraction (default 0.25 = need 25%+) */
  minGain?: number
}

export interface CompactResult {
  before: number
  after: number
  removedMessages: number
  keptMessages: number
  /** true when the first message was already a digest (re-compaction) */
  recompacted: boolean
}

function sessionTokens(messages: ChatMessage[]): number {
  return messages.reduce(
    (n, m) => n + estimateMessageTokens(m.content, m.toolCalls),
    0,
  )
}

/**
 * Compact a session in place: turns older than the keep-budget become one
 * deterministic digest message; recent turns stay verbatim.
 * Returns null when compaction isn't worthwhile.
 */
export function compactSession(session: SessionData, opts: CompactOptions = {}): CompactResult | null {
  const keepTokens = opts.keepTokens ?? 10_000
  const minKeep = opts.minKeepMessages ?? 6
  const minGain = opts.minGain ?? 0.25
  const msgs = session.messages
  if (msgs.length <= minKeep) return null

  // walk from the end — keep the newest turns until the budget is spent,
  // but ALWAYS keep at least minKeep messages verbatim
  let kept = 0
  let keptTokens = 0
  for (let i = msgs.length - 1; i >= 0; i--) {
    const cost = estimateMessageTokens(msgs[i].content, msgs[i].toolCalls)
    if (kept >= minKeep && keptTokens + cost > keepTokens) break
    keptTokens += cost
    kept++
  }
  const keepFrom = msgs.length - kept
  const old = msgs.slice(0, keepFrom)
  if (!old.length) return null

  const before = sessionTokens(msgs)

  // build the digest — one line per turn, chronological
  const body: string[] = []
  let turn = 0
  let firstUserSkipped = false
  for (const m of old) {
    // a prior digest is carried wholesale via priorDigest — don't re-line it
    if (m.meta?.compacted === true) continue
    if (m.role === 'user' && !m.meta?.toolResults && !firstUserSkipped) {
      // the very first user message is the task — keep more of it (the first
      // 400 chars survive; @attachment bodies are dropped, mentions stay)
      firstUserSkipped = true
      turn++
      body.push(`${turn}. USER: ${collapseWs(stripAttachments(m.content), 400)}`)
      continue
    }
    const line = digestLine(m)
    if (!line) continue
    // merge tool-result-free lines that belong to the same exchange
    const last = body[body.length - 1] ?? ''
    if (last.startsWith(`${turn}.`) && !line.startsWith('USER:') && last.includes('AGENT:')) {
      body[body.length - 1] = `${last} · ${line}`
    } else {
      if (line.startsWith('USER:')) turn++
      body.push(`${turn}. ${line}`)
    }
  }

  // merge consecutive agent lines with the same turn number
  const merged: string[] = []
  for (const b of body) {
    const prev = merged[merged.length - 1]
    if (prev && prev.replace(/^[0-9]+\. /, '').startsWith('AGENT:') && b.replace(/^[0-9]+\. /, '').startsWith('AGENT:') && prev.split('.')[0] === b.split('.')[0]) {
      merged[merged.length - 1] = `${prev}; ${b.replace(/^[0-9]+\. /, '')}`
    } else {
      merged.push(b)
    }
  }

  const alreadyDigested = msgs[0]?.meta?.compacted === true
  const priorDigest = alreadyDigested
    ? msgs[0].content
        .replace(/^\[CONTEXT COMPACTED[^\]]*\]\s*/i, '')
        .replace(/The most recent turns follow verbatim\.\s*$/i, '')
        .trim()
    : ''

  const digestContent =
    '[CONTEXT COMPACTED — deterministic, no AI: older turns were summarized below. ' +
    'Facts, paths, tool outcomes and decisions are preserved; verbatim text was dropped. ' +
    'Files mentioned live on disk — re-read them if you need the exact bytes. ' +
    'The most recent turns follow verbatim.]\n\n' +
    (priorDigest ? priorDigest + '\n\n' : '') +
    merged.join('\n')

  const digestMsg: ChatMessage = {
    id: msgs[0].id, // keep a stable id when re-compacting
    role: 'user',
    content: digestContent,
    createdAt: msgs[0].createdAt,
    meta: { compacted: true },
  }

  const next = [digestMsg, ...msgs.slice(keepFrom)]
  const after = sessionTokens(next)
  if (after > before * (1 - minGain)) return null // not worth the churn

  session.messages = next
  return {
    before,
    after,
    removedMessages: old.length,
    keptMessages: next.length,
    recompacted: alreadyDigested,
  }
}
