/**
 * ui.ts — the shared TUI beauty kit (v0.18.0).
 *
 * Backed by real libraries instead of hand-rolled approximations:
 *  - string-width   → true Unicode display width (CJK ext, emoji, combining)
 *  - strip-ansi     → ANSI escape handling
 *  - figures        → cross-platform symbols (auto ASCII fallback on legacy)
 *  - cli-boxes      → border presets (╭─╮ ╰─╯ round style)
 *  - picocolors     → colors
 *  - wrap-ansi      → ANSI-aware wrapping
 *
 * Every width in the TUIs flows through vw()/fitV()/padCol() so columns
 * stay RATA even when text mixes ASCII, CJK and emoji.
 */
import stringWidth from 'string-width'
import stripAnsi from 'strip-ansi'
import figs from 'figures'
import pc from 'picocolors'
import cliBoxes from 'cli-boxes'
import wrapAnsi from 'wrap-ansi'

/* ------------------------------------------------------------------ */
/* color gate                                                          */
/* ------------------------------------------------------------------ */

/** same convention as the TUIs: NO_COLOR env or the app test hook */
let UI_COLOR = true
export function setUiColor(enabled: boolean): void {
  UI_COLOR = enabled
  ;(pc as unknown as { enabled: boolean }).enabled = enabled
}
export const uiColorOn = (): boolean => UI_COLOR && process.env.NO_COLOR === undefined

/** color a border/glyph through picocolors, honoring the gate */
const col = (fn: (s: string) => string) => (s: string) => (uiColorOn() ? fn(s) : s)
export const cDim = col(pc.dim)
export const cBold = col(pc.bold)
export const cRed = col(pc.red)
export const cGreen = col(pc.green)
export const cYellow = col(pc.yellow)
export const cBlue = col(pc.blue)
export const cMagenta = col(pc.magenta)
export const cCyan = col(pc.cyan)
export const cOrange = col((s) => `\x1b[38;5;208m${s}\x1b[0m`)

/* ------------------------------------------------------------------ */
/* width — the alignment backbone                                     */
/* ------------------------------------------------------------------ */

const ANSI_G = /\x1b(?:\[[0-9;:<>?]*[A-Za-z~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g

/** tokenize into {a: ansi-escape} and {t: plain run} pieces */
function* tokens(s: string): Generator<{ a?: string; t?: string }> {
  let last = 0
  for (const m of s.matchAll(ANSI_G)) {
    const idx = m.index ?? 0
    if (idx > last) yield { t: s.slice(last, idx) }
    yield { a: m[0] }
    last = idx + m[0].length
  }
  if (last < s.length) yield { t: s.slice(last) }
}

/** visible width of a (possibly ANSI-styled) string — emoji, CJK, combining aware */
export function vw(s: string): number {
  if (!s) return 0
  let w = 0
  for (const tok of tokens(s)) if (tok.t) w += stringWidth(tok.t)
  return w
}

/** plain-text width (no ANSI expected) */
export const plainW = (s: string): number => (s ? stringWidth(s) : 0)

/** display width of a single code point (string-width backed) */
export function cpW(cp: number): number {
  return stringWidth(String.fromCodePoint(cp))
}

/** strip ANSI escapes */
export const strip = (s: string): string => stripAnsi(s)

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

/** ANSI-preserving truncation to a visible width, grapheme-cluster aware */
export function truncateV(s: string, maxW: number): string {
  if (maxW <= 0) return ''
  if (vw(s) <= maxW) return s
  let w = 0
  let out = ''
  for (const tok of tokens(s)) {
    if (tok.a) {
      out += tok.a
      continue
    }
    if (!tok.t) continue
    for (const g of segmenter.segment(tok.t)) {
      const gc = g.segment
      const gw = stringWidth(gc)
      if (w + gw > maxW) return out
      out += gc
      w += gw
    }
  }
  return out
}

/** truncate + space-pad to an EXACT visible width (box rows, table cells) */
export function fitV(s: string, w: number): string {
  const t = truncateV(s, w)
  return t + ' '.repeat(Math.max(0, w - vw(t)))
}

/** align a (styled) string inside a column: 'l' | 'c' | 'r' */
export function padCol(s: string, w: number, align: 'l' | 'c' | 'r' = 'l'): string {
  const sw = vw(s)
  if (sw >= w) return s
  const pad = w - sw
  if (align === 'r') return ' '.repeat(pad) + s
  if (align === 'c') {
    const l = Math.floor(pad / 2)
    return ' '.repeat(l) + s + ' '.repeat(pad - l)
  }
  return s + ' '.repeat(pad)
}

/** ANSI-aware word wrap (hard-splits words longer than the width) */
export function wrapV(s: string, w: number): string[] {
  if (w <= 0 || vw(s) <= w) return [s]
  // wrap-ansi keeps SGR state across breaks and hard-splits long words
  return wrapAnsi(s, w, { hard: true, trim: false }).split('\n')
}

/* ------------------------------------------------------------------ */
/* symbols — figures with automatic legacy fallbacks                   */
/* ------------------------------------------------------------------ */

export const F = figs as unknown as Record<string, string>
export const SYM = {
  tick: figs.tick ?? '✔',
  cross: figs.cross ?? '✗',
  pointer: figs.pointer ?? '❯',
  arrowUp: figs.arrowUp ?? '↑',
  arrowDown: figs.arrowDown ?? '↓',
  arrowLeft: figs.arrowLeft ?? '←',
  arrowRight: figs.arrowRight ?? '→',
  play: figs.play ?? '▶',
  bullet: figs.bullet ?? '●',
  dot: '·',
  ellipsis: '…',
  radioOn: figs.radioOn ?? '◉',
  radioOff: figs.radioOff ?? '○',
  checkboxOn: figs.checkboxOn ?? '☒',
  checkboxOff: figs.checkboxOff ?? '☐',
}

/* ------------------------------------------------------------------ */
/* emoji icon sets (default emoji-presentation only — always width 2)  */
/* ------------------------------------------------------------------ */

export const TOOL_ICONS: Record<string, string> = {
  read_file: '📖',
  write_file: '📝',
  edit_file: '🔧',
  list_files: '📂',
  search_files: '🔍',
  grep: '🔎',
  bash: '💻',
  run_command: '💻',
  exec: '💻',
  web_fetch: '🌐',
  fetch_url: '🌐',
  web_search: '🔎',
  ask_user: '💬',
  todos: '📋',
  todo_write: '📋',
  read_todos: '📋',
  memory: '🧠',
  facts: '🧠',
  skills: '🎯',
  skill_run: '🎯',
  checkpoint: '💾',
  test: '🧪',
  browser: '🌍',
  subagent: '🤖',
  agent: '🤖',
  plan: '🗺️',
}

/** emoji for a tool call; fuzzy match on name prefixes */
export function toolIcon(tool: string | undefined): string {
  if (!tool) return '⚙'
  const t = tool.replace(/^mcp_[a-z0-9]*_/, '')
  if (TOOL_ICONS[t]) return TOOL_ICONS[t]
  for (const [k, v] of Object.entries(TOOL_ICONS)) {
    if (t.startsWith(k) || k.startsWith(t)) return v
  }
  return '⚙'
}

export const ROW_ICONS = {
  workspace: '📂',
  model: '🤖',
  mcp: '🔌',
  web: '🌐',
  session: '💬',
  skills: '🎯',
  memory: '🧠',
  git: '⎇',
}

export const STATUS_ICONS = {
  thinking: '🤔',
  acting: '⚡',
  streaming: '🌊',
  permission: '🔑',
  done: '✅',
  error: '❌',
  aborted: '🛑',
  denied: '🚫',
}

/* ------------------------------------------------------------------ */
/* boxes — cli-boxes round preset                                     */
/* ------------------------------------------------------------------ */

const B = cliBoxes.round

export interface BoxOpts {
  /** drawn into the top border:  ╭─ title ────╮ */
  title?: string
  /** drawn into the bottom border: ╰─ footer ──╯ */
  footer?: string
  /** body rows (already styled); each is fitted to the inner width */
  rows: string[]
  /** OUTER width (border-to-border) */
  width: number
  /** border color fn (defaults to dim) */
  color?: (s: string) => string
  /** row indexes AFTER which a ├──────┤ divider is drawn */
  dividers?: number[]
}

/** rounded box (╭─╮ │ ╰─╯) with title/footer in the border, emoji-safe widths */
export function roundBox(o: BoxOpts): string[] {
  const color = o.color ?? cDim
  const innerW = Math.max(2, o.width - 2)
  const cellW = Math.max(0, innerW - 2)
  const rows: string[] = []

  const edgeRow = (cornerL: string, cornerR: string, label?: string): string => {
    if (label === undefined || label === '') {
      return color(cornerL + B.top.repeat(innerW) + cornerR)
    }
    const text = ` ${truncateV(label, Math.max(1, innerW - 4))} `
    const fill = Math.max(0, innerW - vw(text) - 1)
    return color(cornerL + B.top + text + B.top.repeat(fill) + cornerR)
  }

  rows.push(edgeRow(B.topLeft, B.topRight, o.title))
  o.rows.forEach((r, i) => {
    rows.push(color(B.left) + ' ' + fitV(r, cellW) + ' ' + color(B.right))
    if (o.dividers?.includes(i)) rows.push(color('├' + B.top.repeat(innerW) + '┤'))
  })
  rows.push(edgeRow(B.bottomLeft, B.bottomRight, o.footer))
  return rows
}

/** horizontal rule of box-drawing dashes (plain, no box) */
export function rule(width: number, color: (s: string) => string = cDim): string {
  return color(B.top.repeat(Math.max(0, width)))
}

/** aligned icon + label + value banner row:  `│ 📂 workspace  value…` */
export function labelRow(icon: string, label: string, value: string, labelW: number): string {
  return `${icon} ${cDim(padCol(label, labelW))} ${value}`
}

/** an aligned two-column help row: key column then description */
export function kvRow(key: string, desc: string, keyW: number): string {
  return `  ${padCol(key, keyW)} ${cDim(desc)}`
}
