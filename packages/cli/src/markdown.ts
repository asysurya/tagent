/**
 * markdown.ts — zero-dependency terminal markdown renderer.
 *
 * Turns an assistant message (headings, **emphasis**, `code`, fenced
 * blocks, lists, blockquotes, rules, links, pipe tables) into ANSI-styled
 * lines that are ready for println(). Consumed by tui-app.ts:
 *
 *   import { renderMarkdown, mdStats } from './markdown'
 *   for (const line of renderMarkdown(text, this.termW)) this.println(line)
 *
 * Design notes:
 *  - self-contained: the tiny ANSI helpers + CJK-aware width math live
 *    here; nothing is imported from tui-app.ts (different owner)
 *  - single pass, linear time: no catastrophic regex, no O(n²) concat
 *  - every emitted line is guaranteed ≤ `width` visible columns
 *    (escape codes count 0), so the TUI's truncateStyled is a no-op
 *  - all raw ESC / C0 / C1 control chars are stripped from the input
 *    before styling — the only escapes in the output come from here
 *  - East-Asian wide chars count 2 columns, combining marks count 0
 *    (same cpWidth ranges as tui-app.ts so width accounting agrees)
 */

/* ================================================================== */
/* ANSI style helpers (self-contained)                                 */
/* ================================================================== */

/** color is disabled when NO_COLOR is present (same rule as tui-app.ts) */
const colorOn = (): boolean => process.env.NO_COLOR === undefined

/** wrap `s` in one SGR code; empty strings stay empty (no stray escapes) */
const sty = (code: string, s: string): string =>
  s === '' ? '' : colorOn() ? `\x1b[${code}m${s}\x1b[0m` : s

const S_BOLD = '1'
const S_DIM = '2'
/* theme-driven styles (v0.23.0) — read LIVE so /theme recolors the next
 * render without any reload; dark keeps the exact v0.22 palette */
const S_CODE = () => activeTheme().md.code
/** inline code chip — soft bg + contrasting text (reads as a chip on
 *  both dark and light themes; degrades to plain text under NO_COLOR) */
const S_URL = '2;4' // dim + underline — bare urls
const S_LINK_URL = '2' // dim — the (url) part of [text](url)
const S_SOFT = () => activeTheme().md.soft
const S_FENCE_LANG = () => activeTheme().md.fenceLang
const S_MARK = () => activeTheme().md.mark
/** h1–h3 get a hue, h4+ are plain bold */
const HEADING_STYLES = () => activeTheme().md.heading
const BULLETS = ['•', '◦', '▪', '·']

/** combine two SGR codes: joinStyle('1;36', '3') → '1;36;3' */
function joinStyle(a: string, b: string): string {
  if (!a) return b
  if (!b) return a
  const seen = new Set(a.split(';'))
  for (const t of b.split(';')) seen.add(t)
  return [...seen].join(';')
}

/* ================================================================== */
/* width math — routed through the shared ui kit (string-width):      */
/* CJK ext, emoji presentation, ZWJ clusters all count correctly       */
/* ================================================================== */

import { cpW } from './ui'
import { activeTheme } from './theme'

/** display width of one code point (string-width backed) */
const cpWidth = cpW

/** visible width of a plain (unstyled) string */
function strWidth(s: string): number {
  let w = 0
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i) ?? 32
    w += cpWidth(cp)
    i += cp < 0x10000 ? 1 : 2
  }
  return w
}

const ANSI_RE = /\x1b(?:\[[0-9;:<>?]*[A-Za-z~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g

/** visible width of a possibly ANSI-styled string (escapes count 0) */
function vwidthANSI(s: string): number {
  return strWidth(s.replace(ANSI_RE, ''))
}

/** hard-cut a plain string at a column budget → [head, rest] */
function cutPlain(s: string, maxW: number): [string, string] {
  let w = 0
  let i = 0
  while (i < s.length) {
    const cp = s.codePointAt(i) ?? 32
    const cw = cpWidth(cp)
    if (cw > 0 && w + cw > maxW) break
    w += cw
    i += cp < 0x10000 ? 1 : 2
  }
  return [s.slice(0, i), s.slice(i)]
}

/** last `maxW` columns of a plain string */
function tailPlain(s: string, maxW: number): string {
  let w = 0
  let i = s.length
  while (i > 0) {
    let start = i - 1
    if (start > 0 && s.charCodeAt(start) >= 0xdc00 && s.charCodeAt(start) <= 0xdfff) start -= 1
    const cp = s.codePointAt(start) ?? 32
    const cw = cpWidth(cp)
    if (cw > 0 && w + cw > maxW) break
    w += cw
    i = start
  }
  return s.slice(i)
}

/** middle truncation with '…' so the result fits a column budget */
function middleTrunc(s: string, maxW: number): string {
  if (strWidth(s) <= maxW) return s
  if (maxW <= 1) return '…'
  const keep = maxW - 1
  const headW = Math.ceil(keep / 2)
  const tailW = keep - headW
  return cutPlain(s, headW)[0] + '…' + tailPlain(s, tailW)
}

/** pad a plain string to an exact visible width */
function padPlain(s: string, w: number, align: 'l' | 'c' | 'r'): string {
  const gap = w - strWidth(s)
  if (gap <= 0) return s
  if (align === 'r') return ' '.repeat(gap) + s
  if (align === 'c') {
    const l = Math.floor(gap / 2)
    return ' '.repeat(l) + s + ' '.repeat(gap - l)
  }
  return s + ' '.repeat(gap)
}

/** ANSI-aware hard cut: guarantee a line never exceeds `width` columns */
function cutStyledLine(s: string, maxW: number): string {
  if (s === '' || vwidthANSI(s) <= maxW) return s
  let w = 0
  let out = ''
  let styled = false
  let i = 0
  while (i < s.length) {
    if (s[i] === '\x1b') {
      ANSI_RE.lastIndex = i
      const m = ANSI_RE.exec(s)
      if (m && m.index === i) {
        out += m[0]
        if (/^\x1b\[0*m$/.test(m[0])) styled = false
        else if (/m$/.test(m[0])) styled = true
        i += m[0].length
        continue
      }
    }
    const cp = s.codePointAt(i) ?? 32
    const cw = cpWidth(cp)
    if (w + cw > maxW) break
    out += String.fromCodePoint(cp)
    w += cw
    i += cp < 0x10000 ? 1 : 2
  }
  if (styled && !out.endsWith('\x1b[0m')) out += '\x1b[0m'
  return out
}

/* ================================================================== */
/* inline parsing — text → styled pieces                               */
/* ================================================================== */

interface Piece {
  text: string
  style: string
  /** url-ish piece: unbreakable, middle-truncated when too long */
  url?: boolean
  /** inline-code chip: never split at inner spaces — the padding is part
   *  of the look, and `git pull` must stay one unbreakable chip */
  chip?: boolean
}

const MAX_INLINE_DEPTH = 3
const ESCAPABLE = '\\`*_{}[]()<>#+.!|~'

/** find a run of exactly `count` occurrences of `ch` at/after `from` */
function findRun(s: string, from: number, ch: string, count: number): number {
  const target = ch.repeat(count)
  let j = s.indexOf(target, from)
  while (j > -1) {
    const before = j > 0 ? s[j - 1] : ''
    const after = s[j + count] ?? ''
    if (before !== ch && after !== ch) return j
    j = s.indexOf(target, j + 1)
  }
  return -1
}

/**
 * parse inline markdown into styled pieces — single pass, index-driven,
 * no backtracking. `budget` is the column budget used to decide whether
 * a [link](url) keeps its text or middle-truncates it.
 */
function parseInline(src: string, budget: number, depth = 0): Piece[] {
  const out: Piece[] = []
  let lit = ''
  const flushLit = () => {
    if (lit !== '') {
      out.push({ text: lit, style: '' })
      lit = ''
    }
  }
  const n = src.length
  let i = 0
  while (i < n) {
    const ch = src[i]

    // backslash escape: emit the escaped char literally
    if (ch === '\\' && i + 1 < n && ESCAPABLE.includes(src[i + 1])) {
      lit += src[i + 1]
      i += 2
      continue
    }

    // inline code: `code` / ``code`` (run-matched, no styling inside)
    if (ch === '`') {
      let run = 1
      while (run < 4 && src[i + run] === '`') run++
      const close = findRun(src, i + run, '`', run)
      if (close > -1) {
        const code = src.slice(i + run, close).replace(/\n/g, ' ').trim()
        flushLit()
        // a chip: padded when colored, plain under NO_COLOR (text identical)
        if (code !== '') {
          const pad = colorOn() ? ' ' : ''
          out.push({ text: `${pad}${code}${pad}`, style: S_CODE(), chip: true })
        }
        i = close + run
        continue
      }
      lit += '`'
      i += 1
      continue
    }

    // emphasis: *italic* / **bold** / ***both*** (and _ variants)
    if (ch === '*' || ch === '_') {
      let run = 1
      while (run < 4 && src[i + run] === ch) run++
      // long runs and intra-word underscores stay literal
      if (run >= 4 || (ch === '_' && i > 0 && /[A-Za-z0-9_]/.test(src[i - 1]))) {
        lit += ch.repeat(run)
        i += run
        continue
      }
      let matched = false
      for (let r = Math.min(run, 3); r >= 1; r--) {
        const close = findRun(src, i + r, ch, r)
        if (close === -1) continue
        const inner = src.slice(i + r, close)
        if (inner === '' || inner.includes('\n')) continue
        if (ch === '_' && close + r < n && /[A-Za-z0-9_]/.test(src[close + r])) continue
        flushLit()
        const style = r === 3 ? '1;3' : r === 2 ? '1' : '3'
        const innerPieces: Piece[] =
          depth < MAX_INLINE_DEPTH &&
          (inner.includes('*') || inner.includes('_') || inner.includes('`') || inner.includes('['))
            ? parseInline(inner, 0, depth + 1)
            : [{ text: inner, style: '' }]
        for (const ip of innerPieces) out.push({ text: ip.text, style: joinStyle(style, ip.style) })
        i = close + r
        matched = true
        break
      }
      if (matched) continue
      lit += ch
      i += 1
      continue
    }

    // link: [text](url) → "text (url)" — url dim; long text middle-truncated
    if (ch === '[') {
      const cbr = src.indexOf(']', i + 1)
      if (cbr > -1 && src[cbr + 1] === '(') {
        let j = cbr + 2
        while (j < n && src[j] !== ')' && src[j] !== '\n') j++
        if (j < n && src[j] === ')') {
          const rawText = src.slice(i + 1, cbr)
          let url = src.slice(cbr + 2, j)
          const sp = url.indexOf(' ')
          if (sp > -1) url = url.slice(0, sp)
          url = url.trim()
          if (url !== '' && !rawText.includes('\n') && !rawText.includes('[')) {
            if (lit.endsWith('!')) lit = lit.slice(0, -1) // ![img](url) → render like a link
            let text = rawText
            if (budget > 0) {
              const room = budget - strWidth(url) - 3 // " (" + ")"
              if (room < 1) {
                // even without text the url overflows: show a truncated url only
                flushLit()
                out.push({ text: middleTrunc(url, Math.max(1, budget - 1)), style: S_URL, url: true })
                i = j + 1
                continue
              }
              if (strWidth(text) > room) text = middleTrunc(text, room)
            }
            flushLit()
            if (text !== '') out.push({ text, style: '' }, { text: ' ', style: '' })
            out.push({ text: `(${url})`, style: S_LINK_URL, url: true })
            i = j + 1
            continue
          }
        }
      }
      lit += '['
      i += 1
      continue
    }

    // bare url → dim underline
    if (ch === 'h' && (src.startsWith('http://', i) || src.startsWith('https://', i))) {
      let j = i
      while (j < n && !' \t\n)>]"\'<'.includes(src[j])) j++
      let url = src.slice(i, j)
      while (url.length > 0 && '.,;:!?'.includes(url[url.length - 1])) url = url.slice(0, -1)
      if (url !== '') {
        flushLit()
        out.push({ text: url, style: S_URL, url: true })
        i += url.length
        continue
      }
    }

    lit += ch
    i += 1
  }
  flushLit()
  return out
}

/* ================================================================== */
/* word-wrap of styled pieces                                          */
/* ================================================================== */

/** append a piece to a line, merging into the previous one when possible */
function addPiece(line: Piece[], p: Piece): void {
  const last = line[line.length - 1]
  if (last && last.style === p.style && !!last.url === !!p.url) last.text += p.text
  else line.push(p)
}

/** split pieces into words at spaces (space runs collapse to one) */
function wordsOf(pieces: Piece[]): Piece[][] {
  const words: Piece[][] = []
  let cur: Piece[] = []
  const endWord = () => {
    if (cur.length > 0) {
      words.push(cur)
      cur = []
    }
  }
  for (const p of pieces) {
    if (p.text === '') continue
    // chips are single unbreakable words — their inner spaces are padding
    if (p.chip) {
      endWord()
      if (p.text !== '') words.push([{ ...p }])
      continue
    }
    const parts = p.text.split(' ')
    for (let k = 0; k < parts.length; k++) {
      if (parts[k] === '') {
        endWord()
        continue
      }
      if (k > 0) endWord()
      cur.push({ text: parts[k], style: p.style, url: p.url })
    }
  }
  endWord()
  return words
}

/** cut a word at a column budget → {head, rest} (null when nothing fits) */
function splitPiecesAt(word: Piece[], maxW: number): { head: Piece[]; rest: Piece[]; w: number } | null {
  const head: Piece[] = []
  let w = 0
  for (let pi = 0; pi < word.length; pi++) {
    const p = word[pi]
    const t = p.text
    let ci = 0
    while (ci < t.length) {
      const cp = t.codePointAt(ci) ?? 32
      const cw = cpWidth(cp)
      if (cw > 0 && w + cw > maxW) {
        if (head.length === 0 && ci === 0) return null
        // the part of this piece that fits goes to head, the rest continues
        if (ci > 0) head.push({ text: t.slice(0, ci), style: p.style, url: p.url })
        const rest: Piece[] = [{ text: t.slice(ci), style: p.style, url: p.url }]
        for (let q = pi + 1; q < word.length; q++) rest.push(word[q])
        return { head, rest, w }
      }
      w += cw
      ci += cp < 0x10000 ? 1 : 2
    }
    head.push(p)
  }
  return { head, rest: [], w }
}

function middleTruncPiece(p: Piece, maxW: number): Piece {
  return { text: middleTrunc(p.text, maxW), style: p.style, url: true }
}

/**
 * greedy word-wrap of styled pieces. CJK text (no spaces) is one word and
 * gets hard-broken by width; over-long urls are middle-truncated; every
 * emitted line is ≤ max(firstW, restW) visible columns.
 */
function layoutWords(words: Piece[][], firstW: number, restW: number): Piece[][] {
  const lines: Piece[][] = []
  let line: Piece[] = []
  let lineW = 0
  let curMax = Math.max(2, firstW)
  const flush = () => {
    if (line.length > 0) {
      lines.push(line)
      line = []
      lineW = 0
      curMax = Math.max(2, restW)
    }
  }
  for (const word of words) {
    let w = 0
    for (const p of word) w += strWidth(p.text)
    if (w === 0) continue
    if (lineW > 0 && lineW + 1 + w > curMax) flush()
    if (w <= curMax) {
      if (lineW > 0) {
        addPiece(line, { text: ' ', style: '' })
        lineW += 1
      }
      for (const p of word) addPiece(line, p)
      lineW += w
      continue
    }
    if (word.length === 1 && word[0].url) {
      // unbreakable url-ish word: own line, middle-truncated
      flush()
      addPiece(line, middleTruncPiece(word[0], curMax))
      flush()
      continue
    }
    // hard-split by width (CJK flow / very long words)
    let remaining = word
    while (remaining.length > 0) {
      const room = curMax - lineW
      if (room <= 0) {
        flush()
        continue
      }
      const cut = splitPiecesAt(remaining, room)
      if (!cut) {
        flush()
        continue
      }
      for (const p of cut.head) addPiece(line, p)
      lineW += cut.w
      remaining = cut.rest
      if (remaining.length > 0) flush()
    }
  }
  if (line.length > 0) lines.push(line)
  return lines
}

/** render a line of pieces to a styled string (merges same-style runs) */
function renderPieces(ps: Piece[]): string {
  let out = ''
  let i = 0
  while (i < ps.length) {
    const style = ps[i].style
    let text = ps[i].text
    let j = i + 1
    while (j < ps.length && ps[j].style === style) {
      text += ps[j].text
      j++
    }
    out += style ? sty(style, text) : text
    i = j
  }
  return out
}

/** parse + wrap + render in one go */
function wrapRender(pieces: Piece[], firstW: number, restW: number): string[] {
  return layoutWords(wordsOf(pieces), firstW, restW).map((l) => renderPieces(l))
}

/* ================================================================== */
/* block-level renderers                                               */
/* ================================================================== */

function headingBlock(text: string, level: number, width: number): string[] {
  const style = HEADING_STYLES()[Math.min(level, 6) - 1]
  const pieces = parseInline(text, width).map((p) => ({ text: p.text, style: joinStyle(style, p.style) }))
  return wrapRender(pieces, width, width)
}

/** fenced code block: dim border, cyan language tag, soft-hue content, verbatim lines */
function fenceBlock(body: string[], lang: string, width: number): string[] {
  const out: string[] = []
  const inner = Math.max(4, width - 2)
  // [lang] tag in cyan when present — the ─ fill stays dim
  const tag = lang !== '' ? `[${cutPlain(lang, Math.max(1, width - 10))[0]}]` : ''
  const tagW = strWidth(tag)
  const fill = Math.max(0, width - 3 - tagW)
  out.push(sty(S_DIM, `╭─`) + (tag !== '' ? sty(S_FENCE_LANG(), tag) : '') + sty(S_DIM, `${'─'.repeat(fill)}╮`))
  for (const bl of body) {
    if (bl.trim() === '') {
      out.push(sty(S_DIM, '│'))
      continue
    }
    let rest = bl
    while (rest !== '') {
      const cut = cutPlain(rest, inner)
      out.push(sty(S_DIM, '│ ') + sty(S_SOFT(), cut[0]))
      rest = cut[1]
    }
  }
  out.push(sty(S_DIM, '╰' + '─'.repeat(Math.max(0, width - 2)) + '╯'))
  return out
}

interface ListItem {
  level: number
  marker: string
  text: string
}

function listBlock(items: ListItem[], loose: boolean, width: number): string[] {
  const out: string[] = []
  for (let k = 0; k < items.length; k++) {
    const it = items[k]
    const indent = '  '.repeat(it.level)
    const ordered = /\d/.test(it.marker[0])
    const marker = ordered ? it.marker : BULLETS[Math.min(it.level, BULLETS.length - 1)]
    const markW = strWidth(marker)
    const textCol = Math.min(it.level * 2 + markW + 1, Math.max(0, width - 4))
    const avail = Math.max(4, width - textCol)
    const wrapped = layoutWords(wordsOf(parseInline(it.text, avail)), avail, avail)
    out.push(indent + sty(S_MARK(), marker) + ' ' + renderPieces(wrapped[0] ?? []))
    const hang = ' '.repeat(textCol)
    for (let r = 1; r < wrapped.length; r++) out.push(hang + renderPieces(wrapped[r]))
    if (loose && k < items.length - 1) out.push('')
  }
  return out
}

/** blockquote: dim-italic text with a dim left border; complex content recurses */
function quoteBlock(inner: string, width: number, depth: number): string[] {
  const qw = Math.max(8, width - 2)
  const border = (l: string): string => (l === '' ? sty(S_DIM, '│') : sty(S_DIM, '│ ') + l)
  const complex =
    /(^|\n)[ \t]{0,3}(```|~~~|>|#{1,6}[ \t]|[-*+] |\d{1,9}[.)] )/.test(inner) || inner.includes('|')
  const out: string[] = []
  if (!complex && depth < 3) {
    for (const para of inner.split(/\n[ \t]*\n+/)) {
      const flat = para.replace(/\n/g, ' ').trim()
      if (flat === '') continue
      // flatten inner styling, wrap the whole quote content in dim italic
      const pieces = parseInline(flat, qw).map((p) => ({ text: p.text, style: '' }))
      for (const l of wrapRender(pieces, qw, qw)) out.push(border(sty('2;3', l)))
    }
    if (out.length === 0) out.push(sty(S_DIM, '│'))
    return out
  }
  const rendered = depth < 4 ? renderCore(inner, qw, depth + 1) : [inner]
  for (const l of rendered) out.push(border(l))
  return out
}

/** split a table row on unescaped pipes */
function splitRow(s: string): string[] {
  let t = s.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let k = 0; k < t.length; k++) {
    if (t[k] === '\\' && t[k + 1] === '|') {
      cur += '|'
      k++
      continue
    }
    if (t[k] === '|') {
      cells.push(cur.trim())
      cur = ''
      continue
    }
    cur += t[k]
  }
  cells.push(cur.trim())
  return cells
}

/** validate a table separator line → per-column alignment (null = not a separator) */
function sepAligns(line: string): ('l' | 'c' | 'r')[] | null {
  const t = line.trim()
  if (t === '' || !t.includes('|') || !t.includes('-')) return null
  if (!/^[:| \t-]+$/.test(t)) return null
  const cells = splitRow(t)
  const aligns: ('l' | 'c' | 'r')[] = []
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null
    aligns.push(c.startsWith(':') && c.endsWith(':') ? 'c' : c.endsWith(':') ? 'r' : 'l')
  }
  return aligns.length > 0 ? aligns : null
}

/** pipe table → a rounded box table (╭┬╮ ├──┼──┤ ╰┴╯), emoji-safe padding;
 * null = malformed */
function tableBlock(tbl: string[], width: number): string[] | null {
  const header = splitRow(tbl[0])
  const alignsRaw = sepAligns(tbl[1]) ?? []
  if (header.length === 0) return null
  const rows: string[][] = []
  for (let k = 2; k < tbl.length; k++) rows.push(splitRow(tbl[k]))
  let ncols = Math.max(header.length, alignsRaw.length)
  for (const r of rows) ncols = Math.max(ncols, r.length)
  if (ncols === 0) return null
  const aligns: ('l' | 'c' | 'r')[] = []
  for (let c = 0; c < ncols; c++) aligns.push(alignsRaw[c] ?? 'l')
  const cellAt = (cells: string[], c: number): string => cells[c] ?? ''

  let widths: number[] = []
  for (let c = 0; c < ncols; c++) {
    let wmax = strWidth(cellAt(header, c))
    for (const r of rows) wmax = Math.max(wmax, strWidth(cellAt(r, c)))
    widths.push(wmax)
  }
  // each cell prints as " text " between rails: overhead = 2*ncols spaces
  // + (ncols+1) rails
  const overhead = 3 * ncols + 1
  // shrink to fit `width` (best-effort: cap every column equally)
  const total = widths.reduce((a, b) => a + b, 0) + overhead
  if (total > width) {
    const cap = Math.max(3, Math.floor((width - overhead) / ncols))
    widths = widths.map((w) => Math.min(w, cap))
  }

  const rowStr = (cells: string[], headerRow: boolean): string => {
    const parts: string[] = []
    for (let c = 0; c < ncols; c++) {
      let cell = cellAt(cells, c)
      const area = widths[c]
      if (strWidth(cell) > area) cell = middleTrunc(cell, area)
      if (headerRow) {
        // SGR wraps ONLY the cell text — padding stays outside the escape
        const gap = Math.max(0, area - strWidth(cell))
        const pre = aligns[c] === 'r' ? gap : aligns[c] === 'c' ? Math.floor(gap / 2) : 0
        parts.push(' ' + ' '.repeat(pre) + sty(S_BOLD, cell) + ' '.repeat(gap - pre) + ' ')
      } else {
        parts.push(' ' + padPlain(cell, area, aligns[c]) + ' ')
      }
    }
    return sty(S_DIM, '│') + parts.join(sty(S_DIM, '│')) + sty(S_DIM, '│')
  }

  const edge = (l: string, mid: string, r: string): string => {
    const parts = widths.map((w) => '─'.repeat(w + 2))
    return sty(S_DIM, l + parts.join(mid) + r)
  }

  const out: string[] = []
  out.push(edge('╭', '┬', '╮'))
  out.push(rowStr(header, true))
  out.push(edge('├', '┼', '┤'))
  for (const r of rows) out.push(rowStr(r, false))
  out.push(edge('╰', '┴', '╯'))
  return out
}

/* ================================================================== */
/* block parser + core renderer                                        */
/* ================================================================== */

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_ANY = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const HR_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/
const QUOTE_RE = /^ {0,3}>/
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/

/** strip \r, raw ESC sequences and control chars (the only escapes in
 * output are ours). Full ANSI sequences (CSI + OSC) are removed as a unit
 * so an injected "\x1b[31m" leaves no "[31m" debris behind. */
function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(ANSI_RE, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f\ufffe\uffff]/g, '')
}

function renderCore(text: string, width: number, depth: number): string[] {
  const lines = text.split('\n')
  const N = lines.length
  const expand = (s: string): string => s.replace(/\t/g, '    ')
  const isListLine = (l: string): boolean => {
    const m = l.match(LIST_RE)
    return m !== null && m[3] !== undefined
  }
  /** does line `idx` start a new block (used to end paragraphs/lists)? */
  const isBlockStart = (idx: number): boolean => {
    const l = expand(lines[idx])
    if (l.trim() === '') return true
    if (FENCE_OPEN.test(l) || HR_RE.test(l) || HEADING_RE.test(l) || QUOTE_RE.test(l)) return true
    if (isListLine(l)) return true
    if (l.includes('|') && idx + 1 < N && sepAligns(expand(lines[idx + 1]))) return true
    return false
  }

  const blocks: string[][] = []
  let i = 0
  while (i < N) {
    const line = expand(lines[i])
    if (line.trim() === '') {
      i++
      continue
    }

    // ---- fenced code block -----------------------------------------
    const fo = line.match(FENCE_OPEN)
    if (fo) {
      const mark = fo[1]
      const fenceIndent = line.length - line.trimStart().length
      const lang = (fo[2].trim().split(/\s+/)[0] ?? '').trim()
      i++
      const body: string[] = []
      while (i < N) {
        const l = expand(lines[i])
        const fc = l.match(FENCE_ANY)
        if (fc && fc[1][0] === mark[0] && fc[1].length >= mark.length) {
          i++
          break
        }
        const lead = l.length - l.trimStart().length
        body.push(fenceIndent > 0 && lead >= fenceIndent ? l.slice(fenceIndent) : l)
        i++
      }
      blocks.push(fenceBlock(body, lang, width))
      continue
    }

    // ---- horizontal rule --------------------------------------------
    if (HR_RE.test(line)) {
      blocks.push([sty(S_DIM, '─'.repeat(width))])
      i++
      continue
    }

    // ---- heading ----------------------------------------------------
    const hm = line.match(HEADING_RE)
    if (hm && hm[2] !== undefined) {
      const raw = hm[2].replace(/[ \t]+#+[ \t]*$/, '').trim()
      if (raw !== '') blocks.push(headingBlock(raw, hm[1].length, width))
      i++
      continue
    }

    // ---- blockquote ---------------------------------------------------
    if (QUOTE_RE.test(line)) {
      const inner: string[] = []
      while (i < N) {
        const l = expand(lines[i])
        if (!QUOTE_RE.test(l)) break
        inner.push(l.replace(/^ {0,3}>[ \t]?/, ''))
        i++
      }
      blocks.push(quoteBlock(inner.join('\n'), width, depth))
      continue
    }

    // ---- list ---------------------------------------------------------
    if (isListLine(line)) {
      const items: ListItem[] = []
      let loose = false
      while (i < N) {
        const l = expand(lines[i])
        const m2 = l.match(LIST_RE)
        if (m2 && m2[3] !== undefined) {
          items.push({
            level: Math.min(6, Math.floor(m2[1].length / 2)),
            marker: m2[2],
            text: m2[3].trim(),
          })
          i++
          continue
        }
        if (items.length > 0 && l.trim() === '') {
          // blank inside the run → loose list (blank line between items)
          if (i + 1 < N && isListLine(expand(lines[i + 1]))) {
            loose = true
            i++
            continue
          }
          break
        }
        if (items.length > 0 && l.trim() !== '' && !isBlockStart(i)) {
          // lazy continuation of the previous item
          items[items.length - 1].text += ' ' + l.trim()
          i++
          continue
        }
        break
      }
      blocks.push(listBlock(items, loose, width))
      continue
    }

    // ---- pipe table ----------------------------------------------------
    if (line.includes('|') && i + 1 < N && sepAligns(expand(lines[i + 1]))) {
      const tbl: string[] = []
      let j = i
      while (j < N) {
        const l = expand(lines[j])
        if (l.trim() === '' || !l.includes('|')) break
        if (FENCE_OPEN.test(l) || HEADING_RE.test(l) || QUOTE_RE.test(l) || isListLine(l)) break
        tbl.push(l)
        j++
      }
      const rendered = tableBlock(tbl, width)
      if (rendered) {
        blocks.push(rendered)
        i = j
        continue
      }
      // malformed → fall through to paragraph
    }

    // ---- paragraph ------------------------------------------------------
    const para: string[] = [line.trim()]
    i++
    while (i < N) {
      const nl = expand(lines[i])
      if (nl.trim() === '' || isBlockStart(i)) break
      para.push(nl.trim())
      i++
    }
    const pieces = parseInline(para.join(' '), width)
    const rendered = wrapRender(pieces, width, width)
    if (rendered.length > 0) blocks.push(rendered)
  }

  // join blocks with exactly one blank line, strip the outer blanks
  const out: string[] = []
  for (let b = 0; b < blocks.length; b++) {
    if (b > 0) out.push('')
    for (const l of blocks[b]) out.push(l)
  }
  while (out.length > 0 && out[0] === '') out.shift()
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

/* ================================================================== */
/* public API (BINDING contract — v0.13.0)                            */
/* ================================================================== */

/**
 * Render a markdown message to ANSI-styled terminal lines.
 * Every line is ≤ `width` visible columns (escape codes count 0).
 */
export function renderMarkdown(text: string, width?: number): string[] {
  // small floor keeps fences/tables drawable on degenerate widths; the
  // "every line ≤ width" contract still holds for any width ≥ 4
  const w = Math.max(4, Math.floor(width ?? 80))
  if (text === '') return []
  const out = renderCore(cleanText(text), w, 0)
  // safety net: guarantee the width contract even on weird inputs
  for (let i = 0; i < out.length; i++) out[i] = cutStyledLine(out[i], w)
  return out
}

/** cheap single-pass stats for the status bar */
export function mdStats(text: string): { words: number; lines: number; codeBlocks: number } {
  if (text === '') return { words: 0, lines: 0, codeBlocks: 0 }
  const lines = text.split('\n')
  let words = 0
  let codeBlocks = 0
  let inFence = false
  for (const l of lines) {
    if (/^\s{0,3}(`{3,}|~{3,})/.test(l)) {
      if (!inFence) {
        codeBlocks++
        inFence = true
      } else inFence = false
      continue
    }
    const m = l.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)
    if (m) words += m.length
  }
  return { words, lines: lines.length, codeBlocks }
}
