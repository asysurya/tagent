/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * tui-app.ts — the TUI (Claude Code / opencode style).
 *
 * `tagent start` takes over the bottom of the terminal: an INLINE app —
 * no alternate screen. Completed lines (markdown, tools, results) flow into
 * the terminal's own scrollback, and a small sticky region is redrawn in
 * place at the bottom:
 *
 *      [ live stream tail / overlay boxes / palette ]
 *      [ status row — spinner · elapsed · esc to interrupt ]
 *      [ rounded editor box — the block cursor lives here ]
 *      [ hint row — ? shortcuts · model · tokens · ⎇ repo ]
 *
 * Why inline (Claude Code's model, Ink-style) instead of a full-screen
 * alt-buffer app: the terminal's NATIVE scrollback keeps working — mouse
 * wheel, touch scroll on a phone (Termux/UserLAnd), shift+pgup, tmux copy
 * mode. Full-screen TUIs kill exactly that, and on Android there is no
 * PageUp to rescue you. So: the transcript IS the scrollback.
 *
 *  - every slash command of tui.ts, with a `/` palette overlay while typing
 *  - ctrl+x main menu · `?` shortcuts overlay (Claude Code parity)
 *  - @file mentions with an inline file completion overlay
 *  - permission prompts, plan approvals, model / session / MCP / plugin
 *    pickers as overlay boxes drawn above the editor
 *  - live streaming (the message tail rides the sticky region, the final
 *    markdown render is flushed into the scrollback exactly once)
 *  - CJK-aware wrapping, terminal resize support (SIGWINCH)
 *
 * Rendering model (performance discipline):
 *  - transcript lines are wrapped once at flush time and APPENDED to the
 *    scrollback — they are never redrawn
 *  - the sticky region is rebuilt only when dirty, coalesced on a ~33ms
 *    timer, and rewritten with one cursor-up + \x1b[J + write
 *
 * The whole lifecycle is wrapped in try/finally: a crashed app still restores
 * the terminal (cursor visible, raw mode off).
 *
 * Non-TTY terminals fall back to the classic readline TUI — check appCapable()
 * before calling runApp() (index.ts wiring).
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  listProviderInfos,
  parseModelRef,
  describeModelRoles,
  renderSubsTable,
  listCheckpoints,
  listFacts,
  listSkills,
  CURRENT_VERSION,
  SUBAGENT_TEMPLATE,
  checkUpdate,
  syncProject,
  getLinkedProject,
  unlinkProject,
  authStatus,
  getCredential,
  loadConfig,
  readGlobalConfig,
  updateGlobalConfig,
  renderContextBar,
  contextPct,
  SyncEngine,
  readSyncSettings,
  writeSyncSettings,
  vaultNeedsPassphrase,
  setVaultPassphrase,
  getVaultPassphrase,
  defaultSyncSettings,
  MIN_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  readSyncHistory,
  recordSyncHistory,
  onlineOthers,
  PRESENCE_EVERY_MS,
  smartConfigSync,
  pushConfigSync,
  pullConfigSync,
  checkConfigRepo,
  readConfigSyncState,
  CONFIG_REPO_NAME,
  listProviderKeys,
  keychainProviders,
  activeKeyLabel,
  addProviderKey,
  removeProviderKey,
  selectProviderKey,
  describeProviderKeys,
  type LoopSummary,
  type PermissionRequest,
  type AskFormRequest,
  type AskFormResponse,
  type SessionData,
  type SubagentInfo,
  type TodoItem,
  type ToolCallRecord,
  type UpdateInfo,
  type AgentMode,
  type SyncEvent,
  type SyncEngineStatus,
  type RepoSyncSettings,
  type TranscriptEntry,
} from '@tagent/core'

import type { AgentHost } from './host'
import type { DaemonHandle } from './daemon'
import { selfUpdate } from './updater'
import {
  vw, truncateV, fitV, padCol, roundBox, labelRow, kvRow, toolIcon,
  setUiColor, STATUS_ICONS, SYM, F, cpW, wrapV, boxTop, boxRow, boxBottom, chip,
} from './ui'
import { activeTheme, setTheme, THEMES, themeLabel, themeSwatch, type BadgeSlot } from './theme'

/** per-tool-category slots (v0.23.1) — the SAME mapping drives the border
 *  color (toolColor) and the title chip (chip(…, toolSlot(tool))): bash
 *  tomato, mcp red, reads blue, writes green, search magenta… */
export function toolSlot(tool: string | undefined): BadgeSlot {
  if ((tool ?? '').startsWith('mcp_')) return 'red'
  const t = (tool ?? '').toLowerCase()
  if (/^(bash|exec|run_command|sh$|shell|diag)/.test(t)) return 'orange'
  if (/^(write_file|edit_file|apply_patch|save|todos|todo_write|read_todos)/.test(t)) return 'green'
  if (/^(read_file|list_files|files|read$|glob|checkpoint|memory|facts|skills|skill_run|load_skill|worklog)/.test(t)) return 'blue'
  if (/^(grep|search_files|search|find|web_search|ddg)/.test(t)) return 'magenta'
  if (/^(web_fetch|fetch_url|browser|open_url|serve|report|test_report|test$)/.test(t)) return 'cyan'
  if (/^(ask_user|ask$|plan$)/.test(t)) return 'yellow'
  if (/^(task|subagent|agent)/.test(t)) return 'magenta'
  return 'dim'
}
function toolColor(tool: string | undefined): (s: string) => string {
  const slot = toolSlot(tool)
  return (s: string) => c(T()[slot], s)
}
/* ------------------------------------------------------------------ */
/* ansi + format helpers                                                */
/* ------------------------------------------------------------------ */

let USE_COLOR = true
/** test hook — the app sets this in its constructor */
export function setAppColor(enabled: boolean): void {
  USE_COLOR = enabled
  setUiColor(enabled)
}
const c = (code: string, s: string) => (USE_COLOR && process.env.NO_COLOR === undefined ? `\x1b[${code}m${s}\x1b[0m` : s)
/** theme slots, read LIVE — /theme recolors the very next frame */
const T = () => activeTheme().sgr
const bold = (s: string) => c(T().bold, s)
const dim = (s: string) => c(T().dim, s)
const red = (s: string) => c(T().red, s)
const green = (s: string) => c(T().green, s)
const yellow = (s: string) => c(T().yellow, s)
const blue = (s: string) => c(T().blue, s)
const magenta = (s: string) => c(T().magenta, s)
const cyan = (s: string) => c(T().cyan, s)
const orange = (s: string) => c(T().orange, s)
const accent = (s: string) => c(T().accent, s)

/* v0.23.1 status pills — ONE bg-chip vocabulary for every result line in
 * the transcript. okPill/errPill/warnPill take an optional short verb;
 * plain icon pills keep the compact confirmations quiet. All of them ride
 * ui.ts chip(), so /theme recolors them and NO_COLOR degrades the padding. */
const okPill = (s = '') => chip(`${SYM.tick}${s ? ` ${s}` : ''}`, 'green')
const errPill = (s = '') => chip(`${SYM.cross}${s ? ` ${s}` : ''}`, 'red')
const warnPill = (s = '') => chip(`⚠${s ? ` ${s}` : ''}`, 'yellow')
const pushPill = () => chip(`${SYM.arrowUp} pushed`, 'green')
const pullPill = () => chip(`${SYM.arrowDown} pulled`, 'cyan')

const SPINNER = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘']

/** display width of a possibly ANSI-styled string — routed through the
 * ui kit (string-width): CJK ext, emoji presentation, ZWJ clusters and
 * combining marks all count correctly, so every column stays rata. */
function vwidthANSI(s: string): number {
  return vw(s)
}

const ANSI_RE = /^\x1b(?:\[[0-9;:<>?]*[A-Za-z~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g

/** ANSI-aware truncation to a visible width — cluster-aware via the ui kit */
function truncateStyled(s: string, maxW: number): string {
  return truncateV(s, maxW)
}

/** truncate + pad with spaces to an exact visible width (box rows) */
function fitStyled(s: string, w: number): string {
  return fitV(s, w)
}

/** append a reset when a row carries SGR state (bleed protection) */
function safeRow(s: string): string {
  return s.includes('\x1b[') ? s + '\x1b[0m' : s
}

/**
 * Word-wrap a styled transcript line to `w` visible columns. ANSI codes are
 * zero width and carry over to continuation lines (open SGR state is
 * re-emitted after a break). Words longer than the width are hard-split.
 */
function wrapStyled(s: string, w: number): string[] {
  if (w <= 0) return [s]
  if (vwidthANSI(s) <= w) return [s]

  // tokenize into word / space runs (ANSI codes attach to the current run)
  const units: { text: string; space: boolean; vw: number }[] = []
  let cur = ''
  let curW = 0
  let curSpace: boolean | null = null
  const flush = () => {
    if (cur.length > 0) units.push({ text: cur, space: curSpace === true, vw: curW })
    cur = ''
    curW = 0
    curSpace = null
  }
  let i = 0
  while (i < s.length) {
    if (s[i] === '\x1b') {
      ANSI_RE.lastIndex = i
      const m = ANSI_RE.exec(s)
      if (m && m.index === i) {
        cur += m[0]
        i += m[0].length
        continue
      }
    }
    const cp = s.codePointAt(i) ?? 32
    const ch = String.fromCodePoint(cp)
    const isSpace = ch === ' ' || ch === '\t'
    if (curSpace === null) curSpace = isSpace
    else if (isSpace !== curSpace) flush()
    cur += ch
    curW += ch === '\t' ? 2 : cpW(cp)
    i += ch.length
  }
  flush()

  // greedy assembly with SGR carry-over
  const lines: string[] = []
  let line = ''
  let lineW = 0
  let open = ''
  const pushLine = () => {
    lines.push(safeRow(line))
    line = open
    lineW = 0
  }
  for (const u of units) {
    if (u.space) {
      const first = lines.length === 0
      if (lineW + u.vw <= w) {
        if (!(lineW === 0 && !first)) {
          line += u.text
          lineW += u.vw
        }
      } else if (lineW > 0) pushLine()
      // leading spaces on continuation lines are dropped
    } else if (lineW + u.vw <= w) {
      line += u.text
      lineW += u.vw
    } else {
      if (lineW > 0) pushLine()
      let rest = u.text
      let restW = u.vw
      while (restW > w) {
        // hard-split the long word at the exact width (ANSI-aware)
        let hw = 0
        let cut = 0
        let j = 0
        while (j < rest.length) {
          if (rest[j] === '\x1b') {
            ANSI_RE.lastIndex = j
            const m = ANSI_RE.exec(rest)
            if (m && m.index === j) {
              j += m[0].length
              continue
            }
          }
          const cp = rest.codePointAt(j) ?? 32
          const ch = String.fromCodePoint(cp)
          const cw = cpW(cp)
          if (hw + cw > w) break
          hw += cw
          cut += ch.length
          j += ch.length
        }
        lines.push(safeRow(open + rest.slice(0, cut)))
        rest = rest.slice(cut)
        restW = vwidthANSI(rest)
      }
      line = open + rest
      lineW = restW
    }
    // track open SGR state
    const gr = /\x1b\[([0-9;]*)m/g
    let gm: RegExpExecArray | null
    while ((gm = gr.exec(u.text)) !== null) {
      if (gm[1] === '' || gm[1] === '0') open = ''
      else open += gm[0]
    }
  }
  if (lineW > 0 || lines.length === 0) lines.push(safeRow(line))
  return lines
}

/* ---------------- plain-text wrapping (editor) ---------------- */

interface Seg {
  s: string
  colStart: number
}

/** hard-wrap a plain (unstyled) line into exact substrings with their offsets */
function wrapSegments(line: string, w: number): Seg[] {
  if (w <= 0) return [{ s: line, colStart: 0 }]
  const segs: Seg[] = []
  let cur = ''
  let curW = 0
  let start = 0
  let i = 0
  while (i < line.length) {
    const cp = line.codePointAt(i) ?? 32
    const ch = String.fromCodePoint(cp)
    const cw = cpW(cp)
    if (curW + cw > w && curW > 0) {
      segs.push({ s: cur, colStart: start })
      cur = ''
      curW = 0
      start = i
    }
    cur += ch
    curW += cw
    i += ch.length
  }
  segs.push({ s: cur, colStart: start })
  return segs
}

/** map a UTF-16 column to a visual {row, vcol} inside wrapped segments */
function cursorPos(segs: Seg[], col: number): { row: number; vcol: number } {
  for (let r = 0; r < segs.length; r++) {
    const s = segs[r]
    if (col < s.colStart + s.s.length) return { row: r, vcol: Math.max(0, col - s.colStart) }
  }
  const last = segs[segs.length - 1]
  return { row: segs.length - 1, vcol: last ? last.s.length : 0 }
}

const isHigh = (s: string, i: number) => i >= 0 && i < s.length && s.charCodeAt(i) >= 0xd800 && s.charCodeAt(i) <= 0xdbff
const isLow = (s: string, i: number) => i >= 0 && i < s.length && s.charCodeAt(i) >= 0xdc00 && s.charCodeAt(i) <= 0xdfff

/** length (in UTF-16 units) of the code point before `col` */
function prevLen(s: string, col: number): number {
  return isLow(s, col - 1) && isHigh(s, col - 2) ? 2 : 1
}
/** length of the code point at `col` */
function nextLen(s: string, col: number): number {
  if (isHigh(s, col) && isLow(s, col + 1)) return 2
  return 1
}

/* ------------------------------------------------------------------ */
/* key events                                                          */
/* ------------------------------------------------------------------ */

export type Key =
  | { t: 'print'; ch: string }
  | { t: 'enter'; mod?: 'shift' | 'alt' | 'ctrl' }
  | { t: 'tab' }
  | { t: 'esc' }
  | { t: 'backspace' }
  | { t: 'delete' }
  | { t: 'up' }
  | { t: 'down' }
  | { t: 'left' }
  | { t: 'right' }
  | { t: 'home' }
  | { t: 'end' }
  | { t: 'pgup' }
  | { t: 'pgdn' }
  | { t: 'wheel'; dy: number }
  | { t: 'ctrl'; ch: string }
  | { t: 'click'; x: number; y: number }

interface Parsed {
  key?: Key
  skip: number
  wait?: boolean
}

/* ------------------------------------------------------------------ */
/* the input editor                                                    */
/* ------------------------------------------------------------------ */

/** insert-mode line editor: multi-line, code-point safe, with history */
class Editor {
  lines: string[] = ['']
  row = 0
  col = 0
  history: string[] = []
  histPos: number | null = null
  draft = ''

  get text(): string {
    return this.lines.join('\n')
  }
  get isEmpty(): boolean {
    return this.lines.length === 1 && this.lines[0] === ''
  }
  setText(t: string): void {
    this.lines = t.length === 0 ? [''] : t.split('\n')
    this.row = Math.min(this.row, this.lines.length - 1)
    this.row = Math.max(0, this.row)
    this.col = Math.min(this.col, this.lines[this.row].length)
    this.histPos = null
  }
  clear(): void {
    this.lines = ['']
    this.row = 0
    this.col = 0
    this.histPos = null
  }
  pushHistory(text: string): void {
    if (!text.trim()) return
    if (this.history[this.history.length - 1] !== text) this.history.push(text)
    if (this.history.length > 100) this.history.splice(0, this.history.length - 100)
    this.histPos = null
    this.draft = ''
  }
  insert(ch: string): void {
    const l = this.lines[this.row]
    this.lines[this.row] = l.slice(0, this.col) + ch + l.slice(this.col)
    this.col += ch.length
    this.histPos = null
  }
  insertText(t: string): void {
    // multi-line aware: each \n splits into a real editor line (pastes!)
    const parts = t.split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) this.newline()
      if (parts[i] !== '') this.insert(parts[i])
    }
  }
  newline(): void {
    const l = this.lines[this.row]
    this.lines[this.row] = l.slice(0, this.col)
    this.lines.splice(this.row + 1, 0, l.slice(this.col))
    this.row += 1
    this.col = 0
    this.histPos = null
  }
  left(): void {
    if (this.col > 0) this.col -= prevLen(this.lines[this.row], this.col)
    else if (this.row > 0) {
      this.row -= 1
      this.col = this.lines[this.row].length
    }
  }
  right(): void {
    const l = this.lines[this.row]
    if (this.col < l.length) this.col += nextLen(l, this.col)
    else if (this.row < this.lines.length - 1) {
      this.row += 1
      this.col = 0
    }
  }
  up(): boolean {
    if (this.row > 0) {
      this.row -= 1
      this.col = Math.min(this.col, this.lines[this.row].length)
      return true
    }
    return false
  }
  down(): boolean {
    if (this.row < this.lines.length - 1) {
      this.row += 1
      this.col = Math.min(this.col, this.lines[this.row].length)
      return true
    }
    return false
  }
  home(): void {
    this.col = 0
  }
  end(): void {
    this.col = this.lines[this.row].length
  }
  backspace(): boolean {
    const l = this.lines[this.row]
    if (this.col > 0) {
      const n = prevLen(l, this.col)
      this.lines[this.row] = l.slice(0, this.col - n) + l.slice(this.col)
      this.col -= n
      return true
    }
    if (this.row > 0) {
      const prev = this.lines[this.row - 1]
      this.col = prev.length
      this.lines[this.row - 1] = prev + l
      this.lines.splice(this.row, 1)
      this.row -= 1
      return true
    }
    return false
  }
  del(): void {
    const l = this.lines[this.row]
    if (this.col < l.length) {
      const n = nextLen(l, this.col)
      this.lines[this.row] = l.slice(0, this.col) + l.slice(this.col + n)
    } else if (this.row < this.lines.length - 1) {
      this.lines[this.row] = l + this.lines[this.row + 1]
      this.lines.splice(this.row + 1, 1)
    }
  }
  /** delete from line start to cursor (ctrl+u) */
  killToStart(): void {
    const l = this.lines[this.row]
    this.lines[this.row] = l.slice(this.col)
    this.col = 0
  }
  /** delete from cursor to line end (ctrl+k) */
  killToEnd(): void {
    this.lines[this.row] = this.lines[this.row].slice(0, this.col)
  }
  /** delete the word before the cursor (ctrl+w) */
  killWord(): void {
    const l = this.lines[this.row]
    let i = this.col
    while (i > 0 && l[i - 1] === ' ') i -= 1
    while (i > 0 && l[i - 1] !== ' ') i -= 1
    this.lines[this.row] = l.slice(0, i) + l.slice(this.col)
    this.col = i
  }
  /** single-line history navigation; returns true when it moved.
   *  (histPos is set AFTER setText — setText resets it, so the navigation
   *  must re-stamp it or every ↑ recalls the same entry forever) */
  histPrev(): boolean {
    if (this.lines.length > 1 || this.history.length === 0) return false
    let pos: number
    if (this.histPos === null) {
      this.draft = this.text
      pos = this.history.length - 1
    } else if (this.histPos > 0) pos = this.histPos - 1
    else return false
    this.setText(this.history[pos] ?? '')
    this.histPos = pos
    return true
  }
  histNext(): boolean {
    if (this.lines.length > 1 || this.histPos === null) return false
    let pos: number
    if (this.histPos < this.history.length - 1) pos = this.histPos + 1
    else {
      this.setText(this.draft)
      this.histPos = null
      return true
    }
    this.setText(this.history[pos] ?? '')
    this.histPos = pos
    return true
  }
}

/* ------------------------------------------------------------------ */
/* overlays                                                            */
/* ------------------------------------------------------------------ */

export interface PickItem<T> {
  label: string
  hint?: string
  detail?: string
  value: T
  disabled?: boolean
  /** section header in the ctrl+x menu */
  group?: string
  /** pinned — always visible even when the filter matches nothing ("+ add custom…" CTAs) */
  keep?: boolean
  /** 'e' on this row opens an inline editor (provider API keys) — the item
   * is passed so the hint can be refreshed after the edit */
  onEdit?: (item: PickItem<T>) => void | Promise<void>
}

type Overlay =
  | {
      kind: 'list'
      title: string
      items: PickItem<any>[]
      cursor: number
      offset: number
      filter: string
      filterable: boolean
      footer?: string
      maxVisible: number
      resolve: (v: any) => void
    }
  | { kind: 'input'; title: string; masked: boolean; editor: Editor; resolve: (v: string | undefined) => void }
  | { kind: 'confirm'; title: string; value: boolean; resolve: (v: boolean | undefined) => void }
  | { kind: 'permission'; req: PermissionRequest; cursor: number; resolve: (v: 'once' | 'always' | 'session' | 'deny') => void }
  | { kind: 'plan'; plan: string[]; scroll: number; cursor: number; resolve: (v: 'execute' | 'keep' | 'dismiss') => void }
  | { kind: 'text'; title: string; lines: string[]; scroll: number; resolve: () => void }
  | {
      kind: 'askform'
      form: AskFormRequest
      /** flat list of focusable rows (options, add-option CTAs, inputs, notes, submit) */
      rows: AskRow[]
      cursor: number
      scroll: number
      /** field id → selected option values (0/1 for option, 0..n for multi) */
      selected: Record<string, string[]>
      /** field id → working option list (user additions append here) */
      options: Record<string, string[]>
      /** one Editor per input-type field, indexed by field position */
      editors: Editor[]
      /** the optional notes textarea under the fields */
      notes: Editor
      /** required-but-unanswered labels (set on submit attempt) */
      missing: string[]
      resolve: (v: AskFormResponse | null) => void
    }

/** one focusable row of the ask form overlay */
interface AskRow {
  kind: 'option' | 'add' | 'input' | 'notes' | 'submit'
  /** index into form.fields (-1 for notes/submit) */
  fieldIndex: number
  /** index into the field's options (-1 otherwise) */
  optionIndex: number
}

/** the flat focusable-row list of an ask form (rebuilt when options grow) */
function askFormRows(form: AskFormRequest, options: Record<string, string[]>): AskRow[] {
  const rows: AskRow[] = []
  form.fields.forEach((f, i) => {
    if (f.type === 'input') {
      rows.push({ kind: 'input', fieldIndex: i, optionIndex: -1 })
    } else {
      for (let oi = 0; oi < (options[f.id] ?? []).length; oi++) {
        rows.push({ kind: 'option', fieldIndex: i, optionIndex: oi })
      }
      if (f.allowAddOption !== false) rows.push({ kind: 'add', fieldIndex: i, optionIndex: -1 })
    }
  })
  if (form.allowNotes !== false) rows.push({ kind: 'notes', fieldIndex: -1, optionIndex: -1 })
  rows.push({ kind: 'submit', fieldIndex: -1, optionIndex: -1 })
  return rows
}

/** reverse-video block cursor spliced into a single line at `col` */
function blockCursorLine(text: string, col: number): string {
  const before = text.slice(0, col)
  const at = text.slice(col, col + nextLen(text, col)) || ' '
  const after = text.slice(col + (at === ' ' && col >= text.length ? 0 : at.length))
  return before + (USE_COLOR ? `\x1b[7m${at}\x1b[27m` : at) + after
}

/* ------------------------------------------------------------------ */
/* slash command table (palette + help)                                */
/* ------------------------------------------------------------------ */

const SLASH_COMMANDS: { name: string; desc: string }[] = [
  { name: 'help', desc: 'list every command' },
  { name: 'new', desc: 'new session [plan|build|test]' },
  { name: 'sessions', desc: 'list sessions' },
  { name: 'open', desc: 'open a session' },
  { name: 'delete', desc: 'delete session <id-prefix>' },
  { name: 'share', desc: 'export a session as HTML' },
  { name: 'relay', desc: 'live share [id|list|stop <code>]' },
  { name: 'timeline', desc: 'subagent runs of this session' },
  { name: 'mode', desc: 'build ↔ plan ↔ test' },
  { name: 'test', desc: 'run test mode [url]' },
  { name: 'model', desc: 'pick a model [custom]' },
  { name: 'caveman', desc: 'terse replies [on|off]' },
  { name: 'theme', desc: 'colors: dark · light · tokyo-night…' },
  { name: 'compact', desc: 'ringkas memory lama [keep-tok]' },
  { name: 'worklog', desc: 'journal + todos [on|off]' },
  { name: 'webgui', desc: 'start gui with tagent [on|off]' },
  { name: 'todos', desc: 'the live plan checklist' },
  { name: 'log', desc: 'WORKLOG.md tail [n]' },
  { name: 'maxturns', desc: 'turn budget <1-80>' },
  { name: 'agents', desc: 'subagents · new <name>' },
  { name: 'subs', desc: 'background subagents — live status' },
  { name: 'diag', desc: 'diagnostics gate [cmd|off|test]' },
  { name: 'fallback', desc: 'failover chains: main · sub · vision' },
  { name: 'apikey', desc: 'set a provider key' },
  { name: 'mcp', desc: 'MCP servers' },
  { name: 'plugins', desc: 'plugin manager · new' },
  { name: 'update', desc: 'check + self-update' },
  { name: 'permissions', desc: 'tool permission table' },
  { name: 'allow', desc: 'allow <tool>' },
  { name: 'ask', desc: 'ask before <tool>' },
  { name: 'deny', desc: 'deny <tool>' },
  { name: 'files', desc: 'workspace tree [path]' },
  { name: 'read', desc: 'read a file' },
  { name: 'grep', desc: 'search the workspace' },
  { name: 'sh', desc: 'run a shell command' },
  { name: 'auth', desc: 'GitHub login' },
  { name: 'config', desc: 'add · apply · fallback · keys · sync' },
  { name: 'repo', desc: 'auto-sync · status · interval · vault' },
  { name: 'push', desc: 'push to GitHub [msg]' },
  { name: 'checkpoints', desc: 'snapshot list' },
  { name: 'undo', desc: 'rollback last snapshot' },
  { name: 'memory', desc: 'saved memory facts' },
  { name: 'skills', desc: 'installed skills' },
  { name: 'skill', desc: 'read a skill <name>' },
  { name: 'stats', desc: 'sessions · ctx · snapshots' },
  { name: 'settings', desc: 'config dump' },
  { name: 'stop', desc: 'interrupt the run' },
  { name: 'clear', desc: 'wipe text [n|all] — memory stays' },
  { name: 'exit', desc: 'quit tagent' },
]

const HELP_ROWS: [string, string][] = [
  ['sessions · new [plan] · open <id> · delete <id>', 'session management'],
  ['share [id] · relay [id|list|stop <code>] · timeline', 'HTML export · live share · subagent runs'],
  ['mode [plan|build|test] · test [url] · model [p[:m]|custom]', 'planning vs build vs QA · pick llm · add your own endpoint'],
  ['agents · mcp · plugins', 'custom subagents · MCP servers · plugin manager'],
  ['fallback [add <p> <m> [key]|rm <n>|clear]', 'provider failover chain'],
  ['diag [cmd|off|test]', 'auto-diagnostics gate (lint/typecheck loop)'],
  ['caveman [on|off] · theme [name] · compact [keep-tok] · maxturns <n>', 'agent behavior · colors · context'],
  ['todos · log [n]', 'live plan · journal tail'],
  ['apikey <provider> · permissions · allow/deny/ask <tool>', 'access'],
  ['files [path] · read <f> · grep <pat> · sh <cmd>', 'workspace'],
  ['auth · repo [status] · push [msg]', 'GitHub · auto-sync · sync history'],
  ['checkpoints · undo · memory · skills · skill <n>', 'memory & history'],
  ['stats · settings · update · webgui [on|off]', 'info · self-update'],
  ['stop · clear [n|all] · exit', 'run control · text-only wipe'],
]

/* ------------------------------------------------------------------ */
/* io injection                                                        */
/* ------------------------------------------------------------------ */

export interface AppInputStream {
  on(event: 'data', listener: (b: Buffer) => void): unknown
  resume?(): unknown
  isTTY?: boolean
  setRawMode?(mode: boolean): unknown
  isRaw?: boolean
}
export interface AppOutputStream {
  write(s: string): unknown
  isTTY?: boolean
  columns?: number
  rows?: number
  on?(event: 'resize', listener: () => void): unknown
}
export interface AppIO {
  input: AppInputStream
  output: AppOutputStream
}

export interface TuiAppOptions {
  workspaceRoot: string
  webUrl?: string
  /** skip the startup update check (tests) */
  updateCheck?: boolean
  /** injected streams (tests). defaults to process.stdin/stdout */
  io?: AppIO
  /** boot mode override — `tagent test` boots straight into QA mode */
  initialMode?: AgentMode
  /** first message auto-sent after boot (e.g. the test target from --url) */
  autoSend?: string
  /** opencode-style full-screen mode (alternate screen + mouse wheel +
   *  built-in scrollback viewer). index.ts defaults this on for capable
   *  terminals; `tagent start --inline` keeps the classic inline app. */
  fullscreen?: boolean
  /** `tagent start --fresh` — boot with an empty screen: the previous
   *  chat's TEXT is not replayed (memory still loads). */
  noResume?: boolean
}

const EDITOR_PLACEHOLDER = 'Message tagent… (enter send · shift+enter newline · / @ ?)'
const HINT_KEYS = `? shortcuts · / commands · @ files`

/* ------------------------------------------------------------------ */
/* the app                                                             */
/* ------------------------------------------------------------------ */

interface LogLine {
  raw: string
  /** wrapped (at flush time) lines already written into the scrollback */
  wrapped?: string[]
  /** first line of a chat message (user box / assistant reply) — the unit
   *  /clear <count> trims */
  m?: 1
  /** display-only line (banner, system notes) — never persisted */
  sys?: 1
}

export class TuiApp {
  private host: AgentHost
  private opts: TuiAppOptions
  private io: AppIO
  private webUrl?: string
  private color: boolean

  private begun = false
  private exited = false
  private doneResolve: (() => void) | undefined

  /* input */
  private inBuf = ''
  private escTimer: ReturnType<typeof setTimeout> | undefined
  private prevRaw: boolean | undefined
  private onData?: (b: Buffer) => void

  /* render */
  private dirty = true
  private frameTimer: ReturnType<typeof setTimeout> | undefined
  lastFrame: string[] = []
  /** sticky rows currently on screen — the cursor sits on the last one */
  private stickyDrawn = 0

  /* transcript */
  private log: LogLine[] = []
  /** log entries already flushed into the terminal scrollback */
  private flushed = 0
  private frozen: string[] = []
  private permissionFrozen = false

  /* editor + overlays */
  private editor = new Editor()
  private edScroll = 0
  private overlayStack: Overlay[] = []
  private palCursor = 0
  private palToken: string | null = null
  private palDismissed: string | null = null
  private fileCursor = 0
  private fileDismissed: string | null = null
  private filesCache: { at: number; files: string[] } | undefined

  /* run state */
  private running = false
  private queued: string[] = []
  private runStartedAt = 0
  private todos: TodoItem[] = []
  private lastSubagentTurn = new Map<string, number>()
  /** the assistant message while it streams — rendered in the sticky region;
   * flushed into the scrollback as markdown once the message completes */
  private streamText = ''
  /** markdown-render cache of the streaming tail — keyed by length, cleared
   *  whenever the stream restarts or completes */
  private streamCache: { len: number; lines: string[] } | undefined
  private lastCtrlC = 0
  private notice = ''
  private lastDoneLabel = ''
  /** session clock + slow ticker for the persistent stats row */
  private startedAt = Date.now()
  private statsTimer: ReturnType<typeof setInterval> | undefined
  /** markdown renderer (A2's module, v0.13.0 contract) — loaded at boot;
   * undefined while (or if) it is unavailable, raw text still renders */
  private mdRender: ((text: string, width?: number) => string[]) | undefined
  /** GitHub sync badge for the stats row — '⎇ owner/repo' while the project is
   * linked AND logged in, empty otherwise. Cached: the registry is file I/O,
   * so it is only refreshed at boot, after /push and after the auth wizard —
   * never per-frame. */
  private syncBadge = ''

  /* ticker */
  private statusKind: 'none' | 'status' | 'stream' = 'none'
  private statusLabel = ''
  private streamChars = 0
  private spinnerFrame = 0
  private spinnerTimer: ReturnType<typeof setInterval> | undefined

  /* header */
  private sessionTitle = 'New session'
  private mode: AgentMode = 'build'
  private tokensIn = 0
  private tokensOut = 0
  /** live context-window state (from the loop) — the bar under the input */
  private ctxUsed = 0
  private ctxLimit = 0
  /** crossed the compact threshold this run — offer /compact when it ends */
  private ctxOfferPending = false

  /* fullscreen mode + the built-in scrollback viewer */
  private fullscreen: boolean
  /** history view is open (ctrl+u / pgup / wheel up) — false = live */
  private viewing = false
  /** first flat line shown by the viewer (0 = oldest) */
  private viewOffset = 0
  /** flat-cache of the lines already flushed — rebuilt incrementally */
  private flatCache: { upto: number; lines: string[] } = { upto: 0, lines: [] }
  /** 1s navbar ticker — model/mcp/context/time facts refresh without a keypress */
  private navTimer: ReturnType<typeof setInterval> | undefined

  /* bracketed paste state — feed() switches on \x1b[200~ / \x1b[201~ */
  private pasting = false
  private pasteBuf = ''

  /* relay endpoint (/relay without a running web gui) */
  private relayServer?: DaemonHandle
  private relayBase?: string

  /* tap targets (v0.23.0, fullscreen only) — the LAST built frame's
   * clickable rows: menus, permission options, ask-form rows. Built fresh
   * in buildFrame; clicks are matched against them in onClick. */
  private clickZones: { y: number; hit: () => void }[] = []
  /** zones collected while an overlay renders — row index WITHIN the
   * overlay's returned rows; buildFrame converts to absolute screen rows */
  private ovZones: { i: number; hit: () => void }[] = []

  /* project auto-sync engine (/repo — push + pull every few seconds) */
  private sync?: SyncEngine
  private syncHint = ''
  /** status() reads files (settings + presence) — cached ~500ms so the 1s
   *  navbar tick and the per-frame hint row share one read */
  private syncStatusCache: { at: number; val: SyncEngineStatus | undefined } = { at: 0, val: undefined }

  /* transcript persistence — "memory chat gak hilang saat ditutup":
   *  everything println'd rides a debounced append into the session's
   *  sidecar; boot replays it so the chat is simply back. */
  private tPending: { sid: string; e: TranscriptEntry }[] = []
  private tTimer: ReturnType<typeof setTimeout> | undefined

  private busCleanup: (() => void)[] = []
  private resizeBound = false
  private destroyed = false
  private cfgCache: { at: number; val: ReturnType<AgentHost['sanitizeConfig']> } | undefined

  constructor(host: AgentHost, opts: TuiAppOptions) {
    this.host = host
    this.opts = opts
    this.io = opts.io ?? { input: process.stdin as unknown as AppInputStream, output: process.stdout as unknown as AppOutputStream }
    this.webUrl = opts.webUrl
    this.fullscreen = opts.fullscreen === true
    this.color = this.io.output.isTTY !== false && process.env.NO_COLOR === undefined
    USE_COLOR = this.color
    this.mode = host.session?.mode ?? 'build'
    this.sessionTitle = host.session?.title ?? 'New session'
    // theme (v0.23.0) — a personal preference from the GLOBAL config; the
    // workspace config (host.cfg.theme) still overrides per-project. Every
    // paint reads the live palette, so this is the only application point.
    try {
      const want = (host as { cfg?: { theme?: string } }).cfg?.theme
        ?? (() => { try { return readGlobalConfig().theme } catch { return undefined } })()
      setTheme(want || 'dark')
    } catch {
      setTheme('dark')
    }
  }

  /* ---------------- lifecycle ---------------- */

  /** mirror of Tui.start(): resolves when the app exits */
  async start(): Promise<void> {
    if (!this.begun) await this.init()
    await new Promise<void>((resolve) => {
      this.doneResolve = resolve
    })
  }

  async init(): Promise<void> {
    if (this.begun) return
    this.begun = true
    this.enterScreen()
    try {
      this.wireHost()
      this.wireInput()
      this.preloadMarkdown()
      this.refreshSyncBadge()
      this.startStatsTicker()
      this.startNavTicker()
      this.startSyncEngine()
      // global config repo: warn when it's gone, apply/pull silently otherwise
      // ("config sama meskipun beda device" — checked at every `tagent start`)
      void this.startupConfigSync()
      this.banner()
      // MCP servers connect at BOOT now (they used to wait for the first
      // chat — the navbar reads their live state every second, so "connecting"
      // actually means connecting, and ready servers show their tool count
      // the moment the handshake lands)
      void this.host.mcpEnsure().catch(() => undefined)
      if (this.opts.updateCheck !== false) await this.startupUpdate()
      // the most recent session is one /open away — its MEMORY loads now,
      // and (unless --fresh) its TEXT replays right under the banner: the
      // chat is simply back, like tagent was never closed
      const sessions = this.host.listSessions()
      if (sessions.length > 0) {
        const loaded = this.host.loadSession(sessions[0].id)
        if (loaded) {
          this.sessionTitle = loaded.title
          this.mode = loaded.mode
        }
        if (!this.opts.noResume) this.replayTranscript()
      }
      // `tagent test` — boot straight into QA mode (optionally with a target)
      if (this.opts.initialMode === 'test') {
        this.host.setSessionMode('test')
        this.printModeBanner('test')
      }
      this.renderNow()
      if (this.opts.autoSend) {
        const text = this.opts.autoSend
        setTimeout(() => void this.send(text), 120)
      }
    } catch (e) {
      this.destroy()
      throw e
    }
  }

  private enterScreen(): void {
    this.prevRaw = (this.io.input as { isRaw?: boolean }).isRaw
    try {
      this.io.input.setRawMode?.(true)
    } catch { /* not a tty — appCapable() gates this */ }
    this.io.input.resume?.()
    // bracketed paste on: multi-line pastes arrive as text, not Enter-key spam
    this.writeOut('\x1b[?2004h')
    if (this.fullscreen) {
      // opencode-style app: a clean alternate screen + mouse-wheel tracking
      // (the built-in viewer scrolls; shift+wheel still reaches the terminal's
      // own scrollback where supported)
      this.writeOut('\x1b[?1049h\x1b[H\x1b[2J\x1b[?1006h\x1b[?1002h')
    }
    // hide the terminal cursor — the editor draws its own block cursor, and
    // the sticky rewrite would make a real cursor dance around otherwise
    this.writeOut('\x1b[?25l')
  }

  /** restore the terminal — idempotent, safe from crashes */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.hideStatus()
    // persist whatever text hadn't hit the debounce yet — closing tagent
    // must never lose the chat
    try {
      this.transcriptFlush()
    } catch {
      /* read-only — nothing to do */
    }
    if (this.frameTimer) {
      clearTimeout(this.frameTimer)
      this.frameTimer = undefined
    }
    if (this.navTimer) {
      clearInterval(this.navTimer)
      this.navTimer = undefined
    }
    if (this.statsTimer) {
      clearInterval(this.statsTimer)
      this.statsTimer = undefined
    }
    if (this.sync) {
      this.sync.stop()
      this.sync = undefined
    }
    if (this.escTimer) {
      clearTimeout(this.escTimer)
      this.escTimer = undefined
    }
    if (this.onData) {
      try {
        (this.io.input as { removeListener?: (e: string, f: (b: Buffer) => void) => unknown }).removeListener?.('data', this.onData)
      } catch { /* ignore */ }
      this.onData = undefined
    }
    for (const off of this.busCleanup) {
      try {
        off()
      } catch { /* ignore */ }
    }
    this.busCleanup = []
    if (this.resizeBound) {
      try {
        (this.io.output as { removeListener?: (e: string, f: () => void) => unknown }).removeListener?.('resize', this.onResize)
      } catch { /* ignore */ }
      this.resizeBound = false
    }
    // clear the sticky region — the transcript stays in the scrollback
    // (fullscreen mode never used one: the whole screen IS the app)
    if (!this.fullscreen && this.stickyDrawn > 0) {
      try {
        this.io.output.write(`\x1b[${this.stickyDrawn - 1}A\x1b[J`)
      } catch { /* EPIPE */ }
      this.stickyDrawn = 0
    }
    if (this.fullscreen) {
      // mouse off, then hand the screen back — the terminal restores the
      // pre-app scrollback from its own buffer
      this.writeOut('\x1b[?1002l\x1b[?1006l\x1b[?1049l')
    }
    this.writeOut('\x1b[?2004l\x1b[?25h')
    try {
      if (this.prevRaw === undefined) this.io.input.setRawMode?.(false)
      else this.io.input.setRawMode?.(this.prevRaw)
    } catch { /* stdin gone */ }
    this.prevRaw = undefined
    // a resumed stdin keeps Bun's event loop alive after /exit — pause it so
    // the process can end naturally (matches the classic TUI's readline close)
    try {
      ;(this.io.input as { pause?: () => unknown }).pause?.()
    } catch { /* ignore */ }
  }

  exit(): void {
    if (this.exited) return
    this.exited = true
    this.hideStatus()
    this.host.interrupt()
    void this.relayServer?.close().catch(() => undefined)
    this.doneResolve?.()
  }

  private writeOut(s: string): void {
    try {
      this.io.output.write(s)
    } catch { /* EPIPE — terminal gone */ }
  }
  onResize = (): void => {
    this.requestRender()
  }

  /* ---------------- host events (port of tui.ts wireHost) ---------------- */

  private wireHost(): void {
    const bus = this.host.bus
    const add = (event: string, fn: (d: any) => void) => {
      bus.on(event, fn)
      this.busCleanup.push(() => bus.removeListener(event, fn))
    }
    add('agent:status', (s: { phase: string; detail?: string }) => this.onStatus(s.phase, s.detail))
    add('agent:chunk', (d: { text: string }) => this.onChunk(d.text))
    add('tool:start', (d: { call: ToolCallRecord }) => this.onToolStart(d.call))
    add('tool:end', (d: { call: ToolCallRecord }) => this.onToolEnd(d.call))
    add('message:new', (d: { message: { role: string; content: string } }) => {
      if (d.message.role === 'assistant') this.onAssistantMessage(d.message.content)
    })
    add('todos:update', (d: { todos: TodoItem[] }) => this.onTodos(d.todos))
    add('subagent:update', (d: { info: SubagentInfo }) => this.onSubagent(d.info))
    add('notify', (d: { level: string; message: string }) => {
      // v0.23.1 — errors and warnings ride bg pills so they pop in scrollback;
      // info stays a quiet blue dot (chips everywhere would be noise)
      const pill = d.level === 'error' ? errPill() : d.level === 'warn' ? warnPill() : blue('·')
      this.println(`  ${pill} ${d.message}`)
      if (d.level === 'error') {
        this.notice = truncateStyled(d.message, this.termW - 8)
      }
    })
    add('permission:request', (req: PermissionRequest) => void this.onPermission(req))
    add('ask:request', (form: AskFormRequest) => void this.onAskUserHost(form))
    add('chat:done', (d: { summary: LoopSummary }) => this.onChatDone(d.summary))
    // /open · /new · boot — the navbar's title + mode follow the active session
    add('session:active', (s: SessionData) => {
      if (this.sessionTitle !== s.title) this.sessionTitle = s.title
      if (this.mode !== s.mode) this.mode = s.mode
    })
    add('context:update', (d: { used: number; limit: number }) => {
      const was = this.ctxLimit > 0 ? contextPct(this.ctxUsed, this.ctxLimit) : 0
      this.ctxUsed = d.used
      this.ctxLimit = d.limit
      const pct = d.limit > 0 ? contextPct(d.used, d.limit) : 0
      const threshold = this.host.compactThreshold()
      if (threshold > 0 && pct >= threshold && was < threshold) {
        this.ctxOfferPending = true
      }
      this.requestRender()
    })
    add('session:active', (s: SessionData) => {
      this.todos = s.todos ?? []
      if (s.title) this.sessionTitle = s.title
      if (s.mode) this.mode = s.mode
      // fresh session — the old run's context numbers no longer apply
      this.ctxUsed = 0
      this.ctxLimit = 0
      this.ctxOfferPending = false
      this.requestRender()
    })
  }

  private onStatus(phase: string, detail?: string): void {
    if (phase === 'thinking') {
      const turn = detail?.match(/turn (\d+)/)?.[1] ?? ''
      this.showStatus(`thinking${turn ? ` · turn ${turn}` : ''}`)
    } else if (phase === 'acting') {
      const d = detail ?? 'acting'
      this.showStatus(/^[a-z_][a-z0-9_]*$/.test(d) ? `calling ${d}…` : d)
    } else if (phase === 'waiting-permission') {
      this.showStatus(`permission needed · ${detail ?? ''}`)
    } else if (phase === 'done' || phase === 'error' || phase === 'aborted') {
      this.hideStatus()
    }
  }

  /** live token streaming — the message accumulates in streamText and its
   * tail rides the sticky region; the final markdown render is flushed into
   * the scrollback once the message completes (onAssistantMessage) */
  private onChunk(full: string): void {
    this.streamText = full
    this.streamChars = full.length
    this.showStream()
  }

  /**
   * Final assistant text. While streaming the user watched the tail live in
   * the sticky region; now that the whole message is known, it is rendered
   * exactly once — as markdown (A2's renderMarkdown, v0.13.0 contract) — and
   * appended to the scrollback. Nothing is ever rolled back: flushed lines
   * are immutable, the raw stream never reaches the scrollback.
   */
  private onAssistantMessage(content: string): void {
    this.hideStatus()
    this.streamText = ''
    this.streamCache = undefined
    if (!content.trim()) return
    const lines = this.mdRender ? this.mdRender(content, this.transcriptW()) : content.split('\n')
    lines.forEach((l, i) => this.println(i === 0 ? `${orange('\u25CF')} ${l}` : l, i === 0 ? 1 : undefined))
  }

  private onToolStart(call: ToolCallRecord): void {
    // a colored rounded BOX per tool call (v0.23.0) whose TITLE rides a
    // bg chip (v0.23.1) — the category color frames the call, the chip
    // carries the icon + name so tools read at a glance while scrolling:
    //   ╭─[💻 bash]───────────────────╮
    //   │ bash setup.sh --with-flags      │
    //   │ [✔ done] 1.2s — 3 lines          │   ← onToolEnd
    //   ╰────────────────────────────╯
    // the transcript is append-only, so the box is drawn open and closed
    // by its two events — the same immutability contract as every line
    const slot = toolSlot(call.tool)
    const colFn = toolColor(call.tool)
    const boxW = Math.min(this.transcriptW() - 2, 78)
    this.println(boxTop(`${toolIcon(call.tool)} ${call.tool}`, boxW, colFn, (s) => chip(s, slot)))
    const summary = summarizeInput(call)
    if (summary) {
      for (const l of wrapV(summary, Math.max(4, boxW - 4))) this.println(boxRow(l, boxW, colFn))
    }
  }

  private onToolEnd(call: ToolCallRecord): void {
    const colFn = toolColor(call.tool)
    const boxW = Math.min(this.transcriptW() - 2, 78)
    const status = call.status === 'done' ? 'done' : call.status === 'error' ? 'error' : call.status === 'denied' ? 'denied' : call.status
    // v0.23.1 — the verdict rides a status pill: green done, red error,
    // yellow denied; icon + word travel together in ONE chip
    const pill =
      call.status === 'done' ? okPill(status)
      : call.status === 'error' ? errPill(status)
      : call.status === 'denied' ? warnPill(status)
      : chip(`· ${status}`, 'dim')
    const dur = call.startedAt && call.endedAt ? `${((call.endedAt - call.startedAt) / 1000).toFixed(1)}s` : ''
    const out = (call.output ?? '').split('\n').find((l) => l.trim()) ?? ''
    const bits = [pill]
    if (dur) bits.push(dim(dur))
    if (out) bits.push(dim(`— ${out}`))
    this.println(boxRow(bits.join(' '), boxW, colFn))
    this.println(boxBottom('', boxW, colFn))
  }

  /** two-line banner box — the frame for non-chat system events (run
   *  stats, sync pushes) that deserve to stand out in the scrollback:
   *    ╭─[✔ done]──────────────────╮
   *    ╰─ 3 turns · 12.3s ─────────╯ */
  private bannerBox(title: string, foot: string, color: (s: string) => string, slot: BadgeSlot = 'dim'): void {
    const boxW = Math.min(this.transcriptW() - 2, 78)
    this.println(boxTop(title, boxW, color, (s) => chip(s, slot)))
    this.println(boxBottom(foot, boxW, color))
  }

  private onTodos(todos: TodoItem[]): void {
    const prev = JSON.stringify(this.todos)
    this.todos = todos
    if (prev === JSON.stringify(todos) || todos.length === 0) return
    const done = todos.filter((t) => t.status === 'completed').length
    this.println(`  ${bold(`⎿ todos ${done}/${todos.length}`)}`)
    for (const t of todos.slice(0, 12)) {
      const icon = t.status === 'completed' ? green(SYM.tick) : t.status === 'in_progress' ? cyan('▸') : dim(SYM.checkboxOff)
      const body = t.status === 'completed' ? dim(t.content) : t.content
      this.println(`    ${icon} ${body}`)
    }
  }

  private onSubagent(info: SubagentInfo): void {
    const last = this.lastSubagentTurn.get(info.id) ?? -1
    if (info.turns === last) return
    this.lastSubagentTurn.set(info.id, info.turns)
    this.println(`  ${magenta('⎿')} ${dim(`subagent · ${info.description} — turn ${info.turns}`)}`)
  }

  /**
   * ask_user tool — render the agent's question form as an interactive
   * overlay. The user fills it (choices, custom options, notes) and the
   * answers flow back to the model; esc dismisses the form as unanswered.
   */
  private async onAskUserHost(form: AskFormRequest): Promise<void> {
    this.permissionFrozen = true
    this.hideStatus()
    const options: Record<string, string[]> = {}
    for (const f of form.fields) {
      if (f.type !== 'input') options[f.id] = [...(f.options ?? [])]
    }
    const editors: Editor[] = form.fields.map((f) => (f.type === 'input' ? new Editor() : (undefined as never)))
    const rows = askFormRows(form, options)
    const res = await new Promise<AskFormResponse | null>((resolve) => {
      this.overlayStack.push({
        kind: 'askform',
        form,
        rows,
        cursor: 0,
        scroll: 0,
        selected: {},
        options,
        editors,
        notes: new Editor(),
        missing: [],
        resolve,
      })
      this.requestRender()
    })
    this.permissionFrozen = false
    this.flushFrozen()
    this.host.askRespond(form.id, res)
    // answer trail in the scrollback — the questions were material
    const q = form.title ?? (form.fields[0]?.label ?? 'questions')
    if (res) {
      const parts = form.fields.map((f) => {
        const a = res.answers?.[f.id]
        const v = Array.isArray(a) ? a.join(', ') : (a ?? '')
        return `${dim(`${f.label}:`)} ${v || dim('—')}`
      })
      this.println(`  ${dim('⎿')} ${green('answered')} ${dim(`· ${q}`)}`)
      for (const p of parts) this.println(`    ${p}`)
      if (res.notes?.trim()) this.println(`    ${dim(`note: ${res.notes.trim().split('\n')[0]}`)}`)
    } else {
      this.println(`  ${dim('⎿')} ${yellow('⊘')} ${dim(`form dismissed · ${q}`)}`)
    }
  }

  private async onPermission(req: PermissionRequest): Promise<void> {
    this.permissionFrozen = true
    this.hideStatus()
    const choice = await new Promise<'once' | 'always' | 'session' | 'deny'>((resolve) => {
      this.overlayStack.push({ kind: 'permission', req, cursor: 0, resolve })
      this.requestRender()
    })
    const a = choice ?? 'deny'
    const approved = a === 'once' || a === 'always' || a === 'session'
    const remember = a === 'always' ? 'always' : a === 'session' ? 'session' : 'once'
    this.host.permissionRespond(req.id, approved, remember)
    this.permissionFrozen = false
    this.flushFrozen()
    this.println(approved ? `  ${okPill('allowed')}` : `  ${warnPill('denied')}`)
  }

  private onChatDone(summary: LoopSummary): void {
    const secs = ((Date.now() - this.runStartedAt) / 1000).toFixed(1)
    this.hideStatus()
    // an aborted/error run can end mid-stream — the partial text was never
    // flushed; keep what the user watched instead of losing it
    if (this.streamText.trim()) {
      const raw = this.streamText
      this.streamText = ''
      this.streamCache = undefined
      raw.split('\n').forEach((l, i) => this.println(i === 0 ? `${orange('\u25CF')} ${l}` : l, i === 0 ? 1 : undefined))
    }
    // the run's verdict rides a banner box (v0.23.0) whose title is a
    // chip (v0.23.1) — green when complete, yellow aborted, red failed;
    // the stats sit in the bottom rail
    const done = summary.finished === 'complete'
    const mark = done ? `${SYM.tick} done` : summary.finished === 'aborted' ? `■ stopped` : `${SYM.cross} error`
    const slot: BadgeSlot = done ? 'green' : summary.finished === 'aborted' ? 'yellow' : 'red'
    const colFn = done ? green : summary.finished === 'aborted' ? yellow : red
    const u = summary.usage
    if (u) {
      this.tokensIn += u.input
      this.tokensOut += u.output
    }
    const tok = u ? ` · ${fmtTok(u.input)} in / ${fmtTok(u.output)} out${u.cacheRead ? ` (${fmtTok(u.cacheRead)} cache-hit)` : ''}` : ''
    this.lastDoneLabel = `${summary.turns} turns · ${summary.toolCalls} tool calls · ${secs}s${tok}`
    this.bannerBox(mark, this.lastDoneLabel, colFn, slot)
    if (summary.error) this.println(`  ${errPill()} ${red(summary.error)}`)
    this.running = false
    // the run's text is complete — persist it right now (crash-safe, and
    // /clear counts must see the whole message)
    this.transcriptFlush()
    if (summary.plan) void this.offerPlan(summary.plan)
    const next = this.queued.shift()
    if (next) {
      this.println(dim('  ↩ sending queued message…'))
      this.logUser(next)
      void this.send(next)
    } else if (this.ctxOfferPending) {
      // the context bar crossed the threshold during this run — offer the
      // deterministic compaction now that the terminal is free
      void this.offerCompact()
    }
  }

  /** 80% context prompt — summarize old turns? (deterministic, zero AI) */
  private async offerCompact(): Promise<void> {
    this.ctxOfferPending = false
    const ci = this.host.contextInfo()
    if (ci.limit <= 0 || ci.pct < this.host.compactThreshold()) return
    await new Promise((r) => setTimeout(r, 150))
    const yes = await this.askYesNo(
      `context ${ci.pct}% (${ci.bar}) — ringkas memory sekarang? (deterministik, tanpa AI)`,
      true,
    )
    if (yes) {
      this.runCompact(undefined)
    } else {
      this.println(dim('  — /compact kapan saja'))
    }
  }

  /** run the compaction + print the result trail */
  private runCompact(keepTokens?: number): void {
    const r = this.host.compactSession(keepTokens)
    if (!r.ok) {
      this.println(`  ${warnPill()} ${yellow(`${r.error}`)}`)
      return
    }
    this.println(
      `  ${okPill('compacted')} ${dim(`· ~${fmtTok(r.before)} → ~${fmtTok(r.after)} tokens · ${r.removedMessages} old turn(s) → digest · no AI used`)}`,
    )
    const ci = this.host.contextInfo()
    this.ctxUsed = ci.used
    this.ctxLimit = ci.limit
    if (ci.bar) this.println(`  ${dim('⎿ context now')} ${dim(ci.bar)}`)
    this.requestRender()
  }

  /** plan approval — overlay; execute writes PRD.md and starts the build */
  private async offerPlan(_plan: string): Promise<void> {
    await new Promise((r) => setTimeout(r, 150))
    const choice = await new Promise<'execute' | 'keep' | 'dismiss'>((resolve) => {
      this.overlayStack.push({ kind: 'plan', plan: _plan.split('\n'), scroll: 0, cursor: 0, resolve })
      this.requestRender()
    })
    if (choice === 'dismiss') return this.println(dim('  — ask again anytime, or /mode build to switch manually'))
    const r = this.host.approvePlan(choice === 'execute')
    if (!r.ok && r.error) this.println(`  ${errPill()} ${red(`${r.error}`)}`)
  }

  /* ---------------- ticker (status row) ---------------- */

  private showStatus(label: string): void {
    this.statusKind = 'status'
    this.statusLabel = label
    this.startSpinner()
    this.requestRender()
  }

  private showStream(): void {
    this.statusKind = 'stream'
    this.startSpinner()
    this.requestRender()
  }

  private hideStatus(): void {
    this.statusKind = 'none'
    this.statusLabel = ''
    this.streamChars = 0
    // NOTE: streamText is NOT cleared here — 'agent:status done' fires before
    // chat:done / message:new, and those handlers flush the partial text
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer)
      this.spinnerTimer = undefined
    }
    this.requestRender()
  }

  private startSpinner(): void {
    if (!this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length
        this.requestRender()
      }, 100)
    }
  }

  /* ---------------- output primitives ---------------- */

  /** append a (possibly multi-line) styled string to the transcript — it is
   * wrapped at flush time and written into the terminal scrollback. `mark`
   * flags the first line of a chat message (the /clear <count> unit). */
  println(s: string, mark?: 1): void {
    if (this.permissionFrozen) {
      this.frozen.push(s)
      return
    }
    this.addLine(s, mark)
  }

  /** display-only println — banner + system notes. Same scrollback path,
   *  but never persisted to the transcript sidecar (they're re-printed
   *  fresh on every boot). */
  private sysPrintln(s: string): void {
    if (this.permissionFrozen) {
      this.frozen.push(s)
      return
    }
    this.addLine(s, undefined, 1)
  }

  private addLine(s: string, mark?: 1, sys?: 1): void {
    for (const l of s.split('\n')) {
      this.log.push({ raw: l, ...(mark ? { m: 1 } : {}), ...(sys ? { sys: 1 } : {}) })
      // text persistence — everything the user read comes back after a
      // restart (system lines excluded: banners print themselves). A line
      // printed before the session exists (the FIRST user box, before
      // chatSend mints the session) is attributed at flush time — by then
      // the session exists and the box belongs to it.
      if (!sys) this.tPending.push({ sid: this.host.session?.id ?? '', e: { t: l, ...(mark ? { m: 1 } : {}) } })
    }
    // the scrollback itself is the transcript history — 4000 entries is only
    // a safety valve against unbounded memory in an endless session
    if (this.log.length > 4000) {
      const cut = this.log.length - 4000
      this.log.splice(0, this.log.length - 4000)
      this.flushed = Math.max(0, this.flushed - cut)
      // the viewer cache indexes into the flat line list — drop it and let
      // flatLines() rebuild from the wrapped caches (cheap, they persist)
      this.flatCache = { upto: 0, lines: [] }
    }
    this.scheduleTranscriptFlush()
    this.requestRender()
  }

  private flushFrozen(): void {
    const buf = this.frozen
    this.frozen = []
    for (const b of buf) this.addLine(b)
  }

  /* ---------------- transcript persistence ---------------- */

  /** debounced write — the sidecar is the chat TEXT; flushing every single
   *  line would hammer the disk for nothing. */
  private scheduleTranscriptFlush(): void {
    if (this.tTimer || this.tPending.length === 0) return
    this.tTimer = setTimeout(() => {
      this.tTimer = undefined
      this.transcriptFlush()
    }, 1_500)
  }

  /** write the pending lines into their sessions' sidecars (grouped by
   *  session id — lines recorded before a /open switch belong to the OLD
   *  session, and stay there). */
  private transcriptFlush(): void {
    if (this.tTimer) {
      clearTimeout(this.tTimer)
      this.tTimer = undefined
    }
    if (this.tPending.length === 0) return
    const bySid = new Map<string, TranscriptEntry[]>()
    const nowSid = this.host.session?.id ?? ''
    for (const p of this.tPending) {
      const sid = p.sid || nowSid // pre-session lines → the session that followed
      if (!sid) continue // no session ever appeared — nothing to attach to
      const arr = bySid.get(sid) ?? []
      arr.push(p.e)
      bySid.set(sid, arr)
    }
    this.tPending = []
    for (const [sid, entries] of bySid) {
      try {
        this.host.sessionTranscriptAppend(sid, entries)
      } catch {
        /* read-only workspace — the run keeps going, only the text
         *  restore is lost */
      }
    }
  }

  /** boot resume — the previous chat's TEXT back on screen. The memory
   *  (session messages) already loaded; this restores what the user was
   *  reading. /clear [count|all] wipes it (memory stays). */
  private replayTranscript(): void {
    const s = this.host.session
    if (!s) return
    const all = this.host.sessionTranscript(s.id)
    if (all.length === 0) return
    const CAP = 800
    const show = all.length > CAP ? all.slice(-CAP) : all
    this.sysPrintln(
      dim(
        `  ↩ resumed "${truncateStyled(s.title, 40)}" · ${s.messages.length} messages in memory` +
          (all.length > CAP ? ` · showing the last ${CAP} of ${all.length} lines` : '') +
          ' — /clear [n|all] wipes the text only',
      ),
    )
    for (const e of show) this.log.push({ raw: e.t, ...(e.m ? { m: 1 } : {}) })
    this.requestRender()
  }

  /** /open + /new — the display follows the session switch: flush what the
   *  old session recorded, wipe the screen, print a fresh banner, replay
   *  the new session's text. */
  private swapTranscript(loaded: SessionData | null): void {
    this.transcriptFlush()
    this.wipeScreen()
    this.log = []
    this.flushed = 0
    this.flatCache = { upto: 0, lines: [] }
    this.viewing = false
    this.viewOffset = 0
    this.streamText = ''
    this.streamCache = undefined
    this.lastDoneLabel = ''
    if (loaded) {
      this.sessionTitle = loaded.title
      this.mode = loaded.mode
    }
    this.banner()
    this.replayTranscript()
  }

  /** clear the screen AND the native scrollback, reset the sticky region. */
  private wipeScreen(): void {
    this.writeOut(
      this.fullscreen
        ? '\x1b[H\x1b[2J\x1b[3J'
        : `\x1b[${Math.max(0, this.stickyDrawn - 1)}A\x1b[J\x1b[H\x1b[2J\x1b[3J`,
    )
    if (!this.fullscreen) this.stickyDrawn = 0
  }

  private banner(): void {
    // the boot intro — two border rows of a rounded card. The live facts
    // (model · mcp · context · mode · time) moved to the sticky navbar
    // (headerRows) which refreshes every second instead of scrolling away.
    // never wider than the transcript — a hard 44-col floor overflows narrow
    // terminals (phone terms, split panes) and the viewport then wraps the
    // box mid-rail. roundBox truncates the title itself when tight.
    const boxW = Math.min(this.transcriptW() - 2, 78)
    const web = this.webUrl
      ? `🌐 ${this.webUrl} ${dim('(sharing this session)')}`
      : `🌐 web gui off — ${dim('/webgui on · start with --web-gui')}`
    const foot = truncateV(`📂 ${this.host.root} · ${web}`, Math.max(8, boxW - 4))
    this.sysPrintln('')
    for (const r of roundBox({
      title: `${orange('✻')} ${bold('Tagent')} ${dim(`v${CURRENT_VERSION} · terminal-native coding agent`)}`,
      footer: foot,
      rows: [],
      width: boxW,
    })) this.sysPrintln(r)
    this.sysPrintln('')
    this.sysPrintln(dim('  type to talk to the agent · / commands · @ files · ? shortcuts · ctrl+x menu'))
    this.sysPrintln('')
  }

  /* ---------------- input plumbing ---------------- */

  private wireInput(): void {
    this.onData = (buf: Buffer) => this.feed(buf.toString('utf8'))
    this.io.input.on('data', this.onData)
    const out = this.io.output as { on?: (e: string, f: () => void) => unknown }
    if (typeof out.on === 'function') {
      out.on('resize', this.onResize)
      this.resizeBound = true
    }
  }

  /** test hook + stdin data handler: parse keys from a raw string.
   *  Bracketed paste (\x1b[?2004h is enabled in enterScreen) is intercepted
   *  here: pasted bytes NEVER become keypresses — a multi-line paste lands
   *  as text with its newlines intact instead of an Enter-submit per line. */
  feed(data: string): void {
    if (process.env.TAGENT_FEED_LOG) {
      try { fs.appendFileSync(process.env.TAGENT_FEED_LOG, `FEED ${Date.now()} ${JSON.stringify(data)}\n`) } catch { /* dbg */ }
    }
    if (this.pasting) {
      // inside a paste: everything is literal until the end marker
      const combined = this.pasteBuf + data
      const end = combined.indexOf('\x1b[201~')
      if (end === -1) {
        this.pasteBuf = combined
        return
      }
      const body = combined.slice(0, end)
      this.pasting = false
      this.pasteBuf = ''
      this.pasteText(body)
      const rest = combined.slice(end + 6)
      if (rest.length > 0) this.feed(rest)
      this.requestRender()
      return
    }
    const combined = this.inBuf + data
    const start = combined.indexOf('\x1b[200~')
    if (start === -1) {
      // no bracketed markers — but a terminal without 2004 support sends a
      // pasted multi-line blob as raw keystrokes (one bare \r per line),
      // which under enter-to-send would submit once per line. detectRawPaste
      // recognizes that burst and reroutes it as text.
      const pasted = this.detectRawPaste(combined)
      if (pasted !== null) {
        this.inBuf = ''
        this.pasteText(pasted)
        this.requestRender()
        return
      }
      this.inBuf = combined
      this.pump()
      this.requestRender()
      return
    }
    // keys typed before the paste flush first; a partial-escape residue at
    // the cut can only be the marker's own split half — drop it
    this.inBuf = combined.slice(0, start)
    this.pump()
    this.inBuf = ''
    this.pasting = true
    this.pasteBuf = ''
    const rest = combined.slice(start + 6)
    if (rest.length > 0) this.feed(rest)
  }

  /** raw-keystroke paste heuristic — the no-bracketed-paste fallback.
   *
   *  Bracketed paste (\x1b[?2004h, enabled in enterScreen) protects pastes
   *  in every terminal that honors it. Terminals that don't send raw bytes
   *  instead: a pasted multi-line blob arrives as one burst of keystrokes
   *  with a bare \r at each line end — under the enter-to-send convention
   *  each of those would SUBMIT the composer. Typed input can never look
   *  like that: the app pumps each Enter as it arrives, so a bare enter
   *  followed by more complete keys in the SAME chunk can only be pasted
   *  text. When we see exactly that, rebuild the chunk as text — print and
   *  tab tokens pass through, a \r\n pair collapses to one newline, other
   *  enter tokens become single newlines, and non-text keys (esc, arrows,
   *  CSI garbage a paste picked up from terminal output) drop out — then
   *  insert it like a bracketed paste instead of parsing keys. */
  private detectRawPaste(s: string): string | null {
    if (s.length < 2 || (s.indexOf('\r') === -1 && s.indexOf('\n') === -1)) return null
    const keys: Key[] = []
    let i = 0
    while (i < s.length) {
      const r = this.parseKeyAt(s.slice(i))
      if (r.wait) break // dangling tail — incomplete, doesn't count as content
      i += r.skip
      if (r.key) keys.push(r.key)
    }
    // a bare enter with at least one complete key after it = a paste burst
    let paste = false
    for (let j = 0; j < keys.length; j++) {
      const k = keys[j]
      if (k.t === 'enter' && k.mod === undefined && j < keys.length - 1) {
        paste = true
        break
      }
    }
    if (!paste) return null
    let text = ''
    for (let j = 0; j < keys.length; j++) {
      const k = keys[j]
      if (k.t === 'print') text += k.ch
      else if (k.t === 'tab') text += '\t'
      else if (k.t === 'enter') {
        // a \r\n pair is ONE line ending, not two — consume the pair whole
        const nxt = keys[j + 1]
        if (k.mod === undefined && nxt?.t === 'enter' && nxt.mod === 'ctrl') j++
        text += '\n'
      }
      // esc / arrows / backspace / delete / ctrl-x / wheel… — not text, drop
    }
    return text
  }

  /** a paste body lands in whatever editor currently owns input — the main
   *  editor or an open dialog's — as text, never as a submit. A single
   *  trailing newline is dropped: terminals add it on every select-copy. */
  private pasteText(body: string): void {
    let text = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    if (text.endsWith('\n')) text = text.slice(0, -1)
    if (text === '') return
    // resolve the focused editor the same way askFormKey does
    let ed: Editor | undefined
    const top = this.overlayStack[this.overlayStack.length - 1]
    if (top?.kind === 'input') ed = top.editor
    else if (top?.kind === 'askform') {
      const row = top.rows[Math.min(top.cursor, top.rows.length - 1)]
      ed = row.kind === 'input' ? top.editors[row.fieldIndex] : row.kind === 'notes' ? top.notes : undefined
    }
    ;(ed ?? this.editor).insertText(text)
    this.palDismissed = null
    this.fileDismissed = null
  }

  private pump(): void {
    let i = 0
    const s = this.inBuf
    while (i < s.length) {
      const r = this.parseKeyAt(s.slice(i))
      if (r.wait) break
      i += r.skip
      if (r.key) this.onKey(r.key)
    }
    this.inBuf = s.slice(i)
    if (this.escTimer !== undefined && !(this.inBuf.length > 0 && this.parseKeyAt(this.inBuf).wait)) {
      clearTimeout(this.escTimer)
      this.escTimer = undefined
    }
    if (this.inBuf.length > 0 && this.parseKeyAt(this.inBuf).wait && this.escTimer === undefined) {
      this.escTimer = setTimeout(() => {
        this.escTimer = undefined
        if (this.inBuf.length > 0 && this.parseKeyAt(this.inBuf).wait) {
          this.inBuf = this.inBuf.slice(1)
          this.onKey({ t: 'esc' })
          this.pump()
          this.requestRender()
        }
      }, 50)
    }
  }

  /** parse the key at the start of `s`; wait = sequence may be incomplete */
  private parseKeyAt(s: string): Parsed {
    const ch = s[0]
    if (ch === undefined) return { skip: 0, wait: true }
    if (ch === '\x1b') {
      if (s.length === 1) return { skip: 0, wait: true }
      const n = s[1]
      if (n === '\r' || n === '\n') return { key: { t: 'enter', mod: 'alt' }, skip: 2 }
      if (n === '\x03') return { key: { t: 'ctrl', ch: 'c' }, skip: 2 }
      // esc esc (or an esc-prefixed sequence that is itself an escape) — emit
      // the esc instead of swallowing BOTH: users mash esc to close things,
      // and '\x1b\x1b[A' used to eat the arrow and TYPE the leftover bytes
      if (n === '\x1b') return { key: { t: 'esc' }, skip: 1 }
      if (n === 'O') {
        if (s.length < 3) return { skip: 0, wait: true }
        if (s[2] === 'H') return { key: { t: 'home' }, skip: 3 }
        if (s[2] === 'F') return { key: { t: 'end' }, skip: 3 }
        return { skip: 3 }
      }
      if (n === '[') {
        // SGR mouse (\x1b[?1006h): wheel = buttons 64/65, press = 0..2, release = m
        if (s[2] === '<') {
          const m = /^\x1b\[<([0-9;]*)([Mm])/.exec(s)
          if (!m) return /^\x1b\[<[0-9;]*$/.test(s) ? { skip: 0, wait: true } : { skip: 3 }
          const btn = Number(m[1].split(';')[0] ?? '0')
          if (m[2] === 'M' && btn === 64) return { key: { t: 'wheel', dy: -1 }, skip: m[0].length }
          if (m[2] === 'M' && btn === 65) return { key: { t: 'wheel', dy: 1 }, skip: m[0].length }
          // left-press = a TAP (v0.23.0) — the frame's click zones carry the
          // target; fullscreen menus become touch-friendly
          if (m[2] === 'M' && btn === 0) {
            const [, x, y] = m[1].split(';').map(Number)
            return { key: { t: 'click', x, y }, skip: m[0].length }
          }
          return { skip: m[0].length } // releases + other buttons — unused
        }
        const m = /^\x1b\[([0-9;:<>?]*)([A-Za-z~])/.exec(s)
        if (!m) {
          if (/^\x1b\[[0-9;:<>?]*$/.test(s)) return { skip: 0, wait: true }
          return { skip: 2 }
        }
        const params = m[1]
        const fin = m[2]
        const skip = m[0].length
        if (fin === 'A') return { key: { t: 'up' }, skip }
        if (fin === 'B') return { key: { t: 'down' }, skip }
        if (fin === 'C') return { key: { t: 'right' }, skip }
        if (fin === 'D') return { key: { t: 'left' }, skip }
        if (fin === 'H') return { key: { t: 'home' }, skip }
        if (fin === 'F') return { key: { t: 'end' }, skip }
        if (fin === '~') {
          const p = params.split(';')[0]
          if (p === '1' || p === '7') return { key: { t: 'home' }, skip }
          if (p === '4' || p === '8') return { key: { t: 'end' }, skip }
          if (p === '3') return { key: { t: 'delete' }, skip }
          if (p === '5') return { key: { t: 'pgup' }, skip }
          if (p === '6') return { key: { t: 'pgdn' }, skip }
          return { skip }
        }
        if (fin === 'u') {
          const parts = params.split(';')
          if (parts[0] === '13') {
            // kitty keyboard protocol: shift+enter / ctrl+enter → newline
            const mod = parts[1]
            return { key: { t: 'enter', mod: mod === '2' || mod === '5' ? 'shift' : undefined }, skip }
          }
          return { skip }
        }
        return { skip }
      }
      // ESC + printable — a human pressed esc and typed on (or the bytes
      // coalesced in one read while the app was busy). Swallowing the pair
      // (the old `skip: 2` fallback) made menus "not close" and ate the
      // first letter of whatever was typed next. Emit the esc, let the
      // printable re-parse as its own keypress. alt+letter is unused here,
      // and pastes ride the bracketed-paste path instead.
      {
        const cp = n.codePointAt(0) ?? 32
        if (cp >= 0x20 && cp !== 0x7f) return { key: { t: 'esc' }, skip: 1 }
      }
      // alt + other (control bytes we don't know) → unsupported combo, drop
      return { skip: 2 }
    }
    if (ch === '\r') return { key: { t: 'enter' }, skip: 1 }
    // \n is what many terminals send for ctrl+enter — under the
    // enter=submit convention it inserts a newline, never a second submit
    if (ch === '\n') return { key: { t: 'enter', mod: 'ctrl' }, skip: 1 }
    if (ch === '\t') return { key: { t: 'tab' }, skip: 1 }
    if (ch === '\x7f' || ch === '\b') return { key: { t: 'backspace' }, skip: 1 }
    const cp = ch.codePointAt(0) ?? 32
    if (cp < 0x20 || cp === 0x7f) return { key: { t: 'ctrl', ch: String.fromCharCode(cp + 96) }, skip: 1 }
    if (cp >= 0xd800 && cp <= 0xdbff && s.length === 1) return { skip: 0, wait: true }
    return { key: { t: 'print', ch }, skip: ch.length }
  }

  /* ---------------- key routing ---------------- */

  private onKey(k: Key): void {
    this.notice = ''
    if (k.t === 'ctrl' && k.ch === 'c') return this.onCtrlC()
    // a tap lands wherever it lands — overlays, editor, transcript
    if (k.t === 'click') return this.onClick(k.x, k.y)
    const top = this.overlayStack[this.overlayStack.length - 1]
    if (top) {
      this.overlayKey(top, k)
      return
    }
    if (k.t === 'ctrl' && k.ch === 'x') {
      this.openMainMenu()
      return
    }
    this.editorKey(k)
  }

  /** SGR mouse tap (fullscreen — mouse tracking runs on the alt screen).
   *  Coordinates are 1-based; zones were registered at build time with
   *  0-based frame rows. A tap outside every zone is a friendly no-op. */
  private onClick(x: number, y: number): void {
    if (!this.fullscreen) return
    const z = this.clickZones.find((z) => z.y === y - 1)
    if (z) {
      this.notice = ''
      z.hit()
      this.requestRender()
    }
  }

  private onCtrlC(): void {
    const top = this.overlayStack[this.overlayStack.length - 1]
    if (top && top.kind === 'permission') {
      // mirrors tui.ts: ctrl+c during a permission prompt denies the call
      this.settle(top, 'deny')
      return
    }
    if (top && top.kind === 'askform') {
      // ctrl+c during a form dismisses it (null answers, not a hang)
      this.settle(top, null)
      return
    }
    if (top) {
      this.settle(top, undefined)
      return
    }
    if (this.running) return this.interruptRun()
    const now = Date.now()
    if (now - this.lastCtrlC < 2000) {
      this.exit()
    } else {
      this.lastCtrlC = now
      this.notice = 'press ctrl+c again to exit'
      this.requestRender()
    }
  }

  /**
   * interrupt the running agent and drop the queued messages — they were
   * promised "after this run", and that run is now cancelled
   * (esc, ctrl+c, /stop all land here)
   */
  private interruptRun(): void {
    const dropped = this.queued.length
    this.queued = []
    const tail = dropped > 0 ? ` ${dim(`· ${dropped} queued message${dropped > 1 ? 's' : ''} dropped`)}` : ''
    this.println(yellow('  ■ interrupting…') + tail)
    this.host.interrupt()
  }

  private editorKey(k: Key): void {
    const pal = this.slashPalette()
    const file = this.fileCompletion()
    switch (k.t) {
      case 'print': {
        // Claude Code parity: `?` on an empty editor opens the shortcuts
        // overlay (so "what?" or URLs with ? still type normally)
        if (k.ch === '?' && this.editor.isEmpty && !pal && !file) return this.shortcutsOverlay()
        // 'x' while reading history → back to live
        if (this.viewing && k.ch === 'x' && this.editor.isEmpty) {
          this.viewing = false
          this.viewOffset = 0
          return this.requestRender()
        }
        this.editor.insert(k.ch)
        this.palDismissed = null
        this.fileDismissed = null
        return
      }
      case 'enter': {
        // the natural convention: bare enter SUBMITS (chat muscle memory
        // everywhere); modified enters (shift/alt/ctrl) make a NEWLINE for
        // long messages. Completion menus keep bare-enter accept — menu muscle
        // memory.
        if (file) {
          this.insertFileCandidate()
          return
        }
        if (pal) return this.paletteEnter()
        if (k.mod === 'shift' || k.mod === 'alt' || k.mod === 'ctrl') return this.editor.newline()
        return this.submit()
      }
      case 'tab': {
        if (file) return this.insertFileCandidate()
        if (pal) return this.paletteComplete()
        this.editor.insert('  ')
        return
      }
      case 'backspace':
        this.editor.backspace()
        return
      case 'delete':
        this.editor.del()
        return
      case 'left':
        this.editor.left()
        return
      case 'right':
        this.editor.right()
        return
      case 'home':
        this.editor.home()
        return
      case 'end':
        this.editor.end()
        return
      case 'up': {
        if (pal) {
          this.palCursor = Math.max(0, this.palCursor - 1)
          return
        }
        if (file) {
          this.fileCursor = Math.max(0, this.fileCursor - 1)
          return
        }
        // reading history: arrows scroll the viewer (opencode-style)
        if (this.viewing) return this.scrollBy(-1)
        // single-line editor: ↑ walks the input history (Claude Code / shell)
        if (!this.editor.up()) this.editor.histPrev()
        return
      }
      case 'down': {
        if (pal) {
          this.palCursor = Math.min(pal.items.length - 1, this.palCursor + 1)
          return
        }
        if (file) {
          this.fileCursor = Math.min(file.items.length - 1, this.fileCursor + 1)
          return
        }
        if (this.viewing) return this.scrollBy(1)
        if (!this.editor.down()) this.editor.histNext()
        return
      }
      case 'pgup':
      case 'pgdn':
        // fullscreen history viewer — one page at a time
        return this.scrollBy(k.t === 'pgup' ? -this.viewerPage() : this.viewerPage())
      case 'wheel':
        return this.scrollBy(k.dy * 3)
      case 'esc': {
        if (this.viewing) {
          // the history viewer closes first — like every other overlay
          this.viewing = false
          this.viewOffset = 0
          return
        }
        if (file) {
          this.fileDismissed = '@' + file.token
          return
        }
        if (pal) {
          this.palDismissed = '/' + pal.token
          return
        }
        // opencode-style esc priority: overlay → close (handled above),
        // running → interrupt, text → clear, idle → a visible no-op so esc
        // never feels dead
        if (this.running) return this.interruptRun()
        if (!this.editor.isEmpty) {
          this.editor.clear()
          return
        }
        this.notice = 'esc — nothing to cancel'
        this.requestRender()
        return
      }
      case 'ctrl': {
        if (k.ch === 'u' && this.editor.isEmpty) {
          // empty editor + ctrl+u → jump into the history viewer (half page);
          // with text it stays the classic kill-to-start
          return this.scrollBy(-Math.max(3, Math.floor(this.viewerPage() / 2)))
        }
        if (k.ch === 'u') return this.editor.killToStart()
        if (k.ch === 'w') return this.editor.killWord()
        if (k.ch === 'a') return this.editor.home()
        if (k.ch === 'e') return this.editor.end()
        if (k.ch === 'k') return this.editor.killToEnd()
        if (k.ch === 'n') {
          this.editor.down()
          return
        }
        if (k.ch === 'p') {
          this.editor.up()
          return
        }
        if (k.ch === 'd') {
          if (this.editor.isEmpty) this.exit()
          else this.editor.del()
          return
        }
        return
      }
    }
  }

  /* ---------------- submit / send (port of handleLine + send) ---------------- */

  private submit(): void {
    const text = this.editor.text.trim()
    if (!text) return
    this.editor.pushHistory(text)
    this.editor.clear()
    this.palDismissed = null
    this.fileDismissed = null
    this.logUser(text)
    void this.handleLine(text)
  }

  /** user-message echo — opencode-style rounded box (`╭─ ❯ you ──╮`):
   *  the text is bold-wrapped inside, widths handled by the ui kit so the
   *  right rail stays RATA even with CJK/emoji in the message */
  private logUser(text: string): void {
    const boxW = Math.min(this.transcriptW() - 2, 78)
    const cellW = boxW - 4
    const rows: string[] = []
    for (const l of text.split('\n')) {
      if (!l.trim()) {
        rows.push('')
        continue
      }
      rows.push(...wrapV(l, cellW))
    }
    // the leading blank line carries the message mark — /clear <count>
    // trims from here, box and all
    this.println('', 1)
    for (const r of roundBox({ title: '❯ you', titleChip: (s) => chip(s, 'accent'), rows, width: boxW, color: cyan })) this.println(r)
  }

  private async handleLine(text: string): Promise<void> {
    if (text.startsWith('/')) {
      try {
        await this.command(text)
      } catch (e) {
        // a broken menu/command must never kill the app — the user just
        // sees the error line and keeps going
        this.println(`  ${errPill()} ${red(`${(e as Error)?.message ?? e}`)}`)
        this.println(dim('    /help lists every command · report the broken one'))
      }
      return
    }
    if (this.running) {
      this.queued.push(text)
      this.println(dim('  · queued — sending after this run (/stop to interrupt)'))
      return
    }
    await this.send(text)
  }

  private async send(text: string): Promise<void> {
    this.running = true
    this.runStartedAt = Date.now()
    this.lastSubagentTurn.clear()
    try {
      await this.host.chatSend(text)
    } catch (e) {
      this.println(`  ${errPill()} ${red(`${(e as Error).message}`)}`)
      this.running = false
    }
  }

  /* ---------------- slash palette ---------------- */

  private slashPalette(): { token: string; items: { name: string; desc: string }[] } | undefined {
    const first = this.editor.lines[0] ?? ''
    if (!first.startsWith('/') || this.editor.lines.length > 1) {
      this.palToken = null
      return undefined
    }
    const token = first.split(' ')[0].slice(1)
    if (this.palDismissed === '/' + token) return undefined
    // a fresh token (or a re-opened palette) restarts the cursor at the top —
    // otherwise the selection lingers on an item that no longer exists
    if (this.palToken !== token) {
      this.palToken = token
      this.palCursor = 0
    }
    const items = SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(token))
    if (items.length === 0) return undefined
    return { token, items }
  }

  private paletteEnter(): void {
    const pal = this.slashPalette()
    if (!pal) return this.submit()
    const sel = pal.items[Math.min(this.palCursor, pal.items.length - 1)]
    const first = this.editor.lines[0] ?? ''
    const firstWord = first.split(' ')[0]
    const rest = first.slice(firstWord.length) // leading space + args, kept as typed
    // ALWAYS apply the highlighted command — the user picked it with the arrows.
    // (the old "already complete" check could never be true and made Enter a no-op)
    const line = sel && firstWord !== '/' + sel.name ? '/' + sel.name + rest : first
    const tail = this.editor.lines.slice(1).join('\n')
    const text = (tail ? line + '\n' + tail : line).trim()
    this.editor.pushHistory(text)
    this.editor.clear()
    this.palToken = null
    void this.handleLine(text)
  }

  private paletteComplete(): void {
    const pal = this.slashPalette()
    if (!pal) return
    const sel = pal.items[Math.min(this.palCursor, pal.items.length - 1)]
    if (!sel) return
    const first = this.editor.lines[0] ?? ''
    const rest = first.slice(1 + pal.token.length)
    this.editor.lines[0] = '/' + sel.name + ' ' + rest.trimStart()
    this.editor.row = 0
    this.editor.col = this.editor.lines[0].length
  }

  /* ---------------- @file completion ---------------- */

  private listWorkspaceFiles(): string[] {
    const now = Date.now()
    if (this.filesCache && now - this.filesCache.at < 30_000) return this.filesCache.files
    const skip = new Set([
      'node_modules', '.git', '.next', 'dist', 'build', '.tagent', 'gui-dist', 'tool-results',
      '.turbo', '.cache', 'out', 'coverage', '.vercel', '.venv', 'venv',
    ])
    const files: string[] = []
    const walk = (dir: string, rel: string, depth: number) => {
      if (files.length >= 3000 || depth > 6) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (skip.has(e.name) || (e.name.startsWith('.') && e.name !== '.')) continue
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) walk(path.join(dir, e.name), r, depth + 1)
        else if (e.isFile() && !r.includes(' ') && !r.includes('\n')) files.push(r)
      }
    }
    try {
      walk(this.host.root, '', 0)
    } catch { /* unreadable workspace */ }
    this.filesCache = { at: now, files }
    return files
  }

  /** the @token at the cursor, if any */
  private atToken(): { token: string; start: number } | undefined {
    const line = this.editor.lines[this.editor.row] ?? ''
    const col = this.editor.col
    let start = col
    while (start > 0 && !' \t'.includes(line[start - 1] ?? ' ')) start -= 1
    if (line[start] !== '@') return undefined
    return { token: line.slice(start + 1, col), start }
  }

  private fileCompletion(): { token: string; items: string[] } | undefined {
    const at = this.atToken()
    if (!at || at.token.length < 1) return undefined
    if (this.fileDismissed === '@' + at.token) return undefined
    const q = at.token.toLowerCase()
    const all = this.listWorkspaceFiles()
    const startsWith = all.filter((f) => f.toLowerCase().startsWith(q))
    const contains = all.filter((f) => !f.toLowerCase().startsWith(q) && f.toLowerCase().includes(q))
    const items = [...startsWith, ...contains].slice(0, 8)
    if (items.length === 0) return undefined
    this.fileCursor = Math.min(this.fileCursor, items.length - 1)
    return { token: at.token, items }
  }

  private insertFileCandidate(): void {
    const file = this.fileCompletion()
    const at = this.atToken()
    if (!file || !at) return
    const p = file.items[Math.min(this.fileCursor, file.items.length - 1)]
    if (!p) return
    const line = this.editor.lines[this.editor.row] ?? ''
    this.editor.lines[this.editor.row] = line.slice(0, at.start) + '@' + p + ' ' + line.slice(this.editor.col)
    this.editor.col = at.start + p.length + 2
    this.fileDismissed = null
  }

  /* ---------------- overlay primitives ---------------- */

  private pick<T>(
    items: PickItem<T>[],
    title: string,
    opts: { selected?: number; filterable?: boolean; footer?: string; maxVisible?: number } = {},
  ): Promise<T | undefined> {
    if (items.length === 0) return Promise.resolve(undefined)
    return new Promise<T | undefined>((resolve) => {
      this.overlayStack.push({
        kind: 'list',
        title,
        items: items as PickItem<any>[],
        cursor: Math.min(Math.max(opts.selected ?? 0, 0), items.length - 1),
        offset: 0,
        filter: '',
        filterable: opts.filterable ?? items.length > 12,
        footer: opts.footer,
        maxVisible: opts.maxVisible ?? 12,
        resolve: resolve as (v: any) => void,
      })
      this.requestRender()
    })
  }

  private ask(title: string, opts: { masked?: boolean } = {}): Promise<string | undefined> {
    return new Promise((resolve) => {
      this.overlayStack.push({ kind: 'input', title, masked: opts.masked === true, editor: new Editor(), resolve })
      this.requestRender()
    })
  }

  private askHidden(title: string): Promise<string> {
    return this.ask(title, { masked: true }).then((v) => v ?? '')
  }

  private askYesNo(title: string, def = false): Promise<boolean | undefined> {
    return new Promise((resolve) => {
      this.overlayStack.push({ kind: 'confirm', title, value: def, resolve })
      this.requestRender()
    })
  }

  private settle(ov: Overlay, value: unknown): void {
    const i = this.overlayStack.indexOf(ov)
    // already settled (a stale tap zone after a re-render) — never resolve
    // twice: the second call would re-fire the menu action
    if (i < 0) return
    this.overlayStack.splice(i, 1)
    this.requestRender()
    switch (ov.kind) {
      case 'list':
      case 'input':
      case 'confirm':
      case 'permission':
      case 'askform':
      case 'plan':
        ov.resolve(value as never)
        break
      case 'text':
        ov.resolve()
        break
    }
  }

  private overlayKey(ov: Overlay, k: Key): void {
    switch (ov.kind) {
      case 'list':
        return this.listKey(ov, k)
      case 'input':
        return this.inputKey(ov, k)
      case 'confirm':
        return this.confirmKey(ov, k)
      case 'permission':
        return this.permissionKey(ov, k)
      case 'askform':
        return this.askFormKey(ov, k)
      case 'plan':
        return this.planKey(ov, k)
      case 'text':
        return this.textKey(ov, k)
    }
  }

  private listVisible(ov: Extract<Overlay, { kind: 'list' }>): PickItem<any>[] {
    if (!ov.filter) return ov.items
    const q = ov.filter.toLowerCase()
    const hay = (it: PickItem<any>) => (it.label + ' ' + (it.hint ?? '') + ' ' + (it.detail ?? '')).toLowerCase()
    const matched = ov.items.filter((it) => hay(it).includes(q))
    // pinned CTAs survive every filter — "search found nothing? add a custom one"
    const kept = ov.items.filter((it) => it.keep && !matched.includes(it))
    return [...matched, ...kept]
  }

  /** how many items actually match the filter (CTAs excluded) — for the empty state */
  private listMatchCount(ov: Extract<Overlay, { kind: 'list' }>): number {
    if (!ov.filter) return ov.items.length
    const q = ov.filter.toLowerCase()
    return ov.items.filter((it) => !it.keep && (it.label + ' ' + (it.hint ?? '') + ' ' + (it.detail ?? '')).toLowerCase().includes(q)).length
  }

  private listMove(ov: Extract<Overlay, { kind: 'list' }>, delta: number): void {
    const vis = this.listVisible(ov)
    const n = vis.length
    if (n === 0) return
    let next = ov.cursor
    for (let step = 0; step < n; step++) {
      next = (next + delta + n) % n
      if (!vis[next].disabled) break
    }
    ov.cursor = next
    const max = Math.min(ov.maxVisible, 12)
    if (ov.cursor < ov.offset) ov.offset = ov.cursor
    if (ov.cursor >= ov.offset + max) ov.offset = ov.cursor - max + 1
    ov.offset = Math.min(ov.offset, Math.max(0, n - max))
  }

  private listKey(ov: Extract<Overlay, { kind: 'list' }>, k: Key): void {
    switch (k.t) {
      case 'esc': {
        if (ov.filter) {
          ov.filter = ''
          ov.cursor = 0
          ov.offset = 0
          return
        }
        return this.settle(ov, undefined)
      }
      case 'up':
        return this.listMove(ov, -1)
      case 'down':
        return this.listMove(ov, 1)
      case 'home':
        ov.cursor = 0
        ov.offset = 0
        return
      case 'end': {
        const vis = this.listVisible(ov)
        ov.cursor = Math.max(0, vis.length - 1)
        this.listMove(ov, 0)
        return
      }
      case 'pgup':
      case 'pgdn': {
        // full-page jump, clamped — no wrap-around (wrapping made the last
        // items unreachable when the render window is smaller than the stride)
        const vis = this.listVisible(ov)
        const n = vis.length
        if (n === 0) return
        const page = Math.max(1, Math.min(ov.maxVisible, 12))
        ov.cursor = k.t === 'pgup' ? Math.max(0, ov.cursor - page) : Math.min(n - 1, ov.cursor + page)
        return this.listMove(ov, 0)
      }
      case 'enter': {
        const vis = this.listVisible(ov)
        const it = vis[ov.cursor]
        if (it && !it.disabled) this.settle(ov, it.value)
        return
      }
      case 'print': {
        // number-row quick pick (v0.23.0) — the badges on screen select
        // directly: one tap on a phone instead of arrows + enter. Only on
        // non-searchable lists, so digits stay free for filtering elsewhere
        if (!ov.filter && !ov.filterable && k.ch >= '1' && k.ch <= '9') {
          const vis = this.listVisible(ov)
          const it = vis[ov.offset + (k.ch.charCodeAt(0) - 49)]
          if (it && !it.disabled) this.settle(ov, it.value)
          return
        }
        // quick-quit ONLY on non-searchable lists — 'q' is a search letter
        // (try typing "qwen" in a filterable picker otherwise…)
        if (k.ch === 'q' && !ov.filter && !ov.filterable) return this.settle(ov, undefined)
        // 'e' edits the highlighted row (provider API keys) — only while no
        // filter is active, so searching still works after other letters
        if (k.ch === 'e' && !ov.filter) {
          const cur = this.listVisible(ov)[ov.cursor]
          if (cur?.onEdit) {
            void Promise.resolve(cur.onEdit(cur)).then(
              () => this.requestRender(),
              (e) => this.println(`  ${errPill()} ${red(`${(e as Error).message}`)}`),
            )
            return
          }
        }
        if (ov.filterable && k.ch.length > 0 && (k.ch.codePointAt(0) ?? 0) >= 0x20) {
          ov.filter += k.ch.toLowerCase()
          ov.cursor = 0
          ov.offset = 0
        }
        return
      }
      case 'backspace': {
        if (ov.filter) {
          ov.filter = ov.filter.slice(0, -1)
          ov.cursor = 0
          ov.offset = 0
        }
        return
      }
      default:
        return
    }
  }

  private inputKey(ov: Extract<Overlay, { kind: 'input' }>, k: Key): void {
    const ed = ov.editor
    switch (k.t) {
      case 'enter':
        return this.settle(ov, ed.text)
      case 'esc':
        return this.settle(ov, undefined)
      case 'print':
        ed.insert(k.ch)
        return
      case 'backspace':
        ed.backspace()
        return
      case 'delete':
        ed.del()
        return
      case 'left':
        ed.left()
        return
      case 'right':
        ed.right()
        return
      case 'home':
        ed.home()
        return
      case 'end':
        ed.end()
        return
      case 'ctrl': {
        if (k.ch === 'u') ed.killToStart()
        else if (k.ch === 'w') ed.killWord()
        else if (k.ch === 'a') ed.home()
        else if (k.ch === 'e') ed.end()
        else if (k.ch === 'k') ed.killToEnd()
        return
      }
      default:
        return
    }
  }

  private confirmKey(ov: Extract<Overlay, { kind: 'confirm' }>, k: Key): void {
    if (k.t === 'esc') return this.settle(ov, undefined)
    if (k.t === 'left' || (k.t === 'print' && (k.ch === 'y' || k.ch === 'h'))) {
      ov.value = true
      return
    }
    if (k.t === 'right' || (k.t === 'print' && (k.ch === 'n' || k.ch === 'l'))) {
      ov.value = false
      return
    }
    if (k.t === 'enter') return this.settle(ov, ov.value)
  }

  private permissionKey(ov: Extract<Overlay, { kind: 'permission' }>, k: Key): void {
    const count = 4
    if (k.t === 'esc') return this.settle(ov, 'deny')
    if (k.t === 'up') {
      ov.cursor = (ov.cursor - 1 + count) % count
      return
    }
    if (k.t === 'down') {
      ov.cursor = (ov.cursor + 1) % count
      return
    }
    if (k.t === 'enter') {
      const choice = (['once', 'always', 'session', 'deny'] as const)[ov.cursor]
      return this.settle(ov, choice)
    }
    if (k.t === 'print') {
      // number-row picks match the on-screen badges (mobile friendly)
      if (k.ch >= '1' && k.ch <= '4') {
        return this.settle(ov, (['once', 'always', 'session', 'deny'] as const)[k.ch.charCodeAt(0) - 49])
      }
      const ch = k.ch.toLowerCase()
      if (ch === 'y') return this.settle(ov, 'once')
      if (ch === 'a') return this.settle(ov, 'always')
      if (ch === 's') return this.settle(ov, 'session')
      if (ch === 'n') return this.settle(ov, 'deny')
    }
  }

  /* ---------------- ask form overlay (ask_user tool) ---------------- */

  private askFormKey(ov: Extract<Overlay, { kind: 'askform' }>, k: Key): void {
    const rows = ov.rows
    if (!rows.length) return this.settle(ov, null)
    if (k.t === 'esc') return this.settle(ov, null)

    const row = rows[Math.min(ov.cursor, rows.length - 1)]
    const field = row.fieldIndex >= 0 ? ov.form.fields[row.fieldIndex] : undefined
    const ed = row.kind === 'input' ? ov.editors[row.fieldIndex] : row.kind === 'notes' ? ov.notes : undefined
    const move = (d: number) => {
      ov.cursor = Math.max(0, Math.min(rows.length - 1, ov.cursor + d))
    }
    const clearMissing = () => {
      if (ov.missing.length) ov.missing = []
    }

    switch (k.t) {
      case 'up':
        clearMissing()
        move(-1)
        return
      case 'down':
        clearMissing()
        move(1)
        return
      case 'tab': {
        // jump to the next field boundary (input / notes / submit)
        clearMissing()
        for (let i = ov.cursor + 1; i < rows.length; i++) {
          const r = rows[i]
          if (r.kind === 'input' || r.kind === 'notes' || r.kind === 'submit') {
            ov.cursor = i
            return
          }
        }
        ov.cursor = rows.length - 1
        return
      }
      case 'enter': {
        // the notes box is multi-line — bare enter inserts a newline there
        // (the chat convention); modified enters (and every enter on input
        // rows) move on to the next field
        if (row.kind === 'notes' && ed) {
          if (k.mod === 'shift' || k.mod === 'alt' || k.mod === 'ctrl') {
            clearMissing()
            move(1)
            return
          }
          ed.newline()
          return
        }
        if (row.kind === 'submit') return this.askFormSubmit(ov)
        if (row.kind === 'option' && field) {
          const opt = ov.options[field.id]?.[row.optionIndex]
          if (opt === undefined) return
          if (field.type === 'multi') {
            const cur = ov.selected[field.id] ?? []
            ov.selected[field.id] = cur.includes(opt) ? cur.filter((o) => o !== opt) : [...cur, opt]
            return
          }
          // single choice: select and advance to the next field
          ov.selected[field.id] = [opt]
          const next = rows.findIndex((r) => r.fieldIndex > row.fieldIndex)
          ov.cursor = next >= 0 ? next : rows.length - 1
          return
        }
        if (row.kind === 'add') return this.askFormAddOption(ov, row.fieldIndex)
        // input rows: enter moves on
        clearMissing()
        move(1)
        return
      }
      case 'print': {
        // space on an option = select/toggle; 'a' on the add row opens the prompt
        if (row.kind === 'option' && k.ch === ' ') return this.askFormKey(ov, { t: 'enter' })
        if (row.kind === 'add' && (k.ch === 'a' || k.ch === 'A')) return this.askFormAddOption(ov, row.fieldIndex)
        if (ed) {
          clearMissing()
          ed.insert(k.ch)
        }
        return
      }
      case 'backspace':
        if (ed) ed.backspace()
        return
      case 'delete':
        if (ed) ed.del()
        return
      case 'left':
        if (ed) ed.left()
        return
      case 'right':
        if (ed) ed.right()
        return
      case 'home':
        if (ed) ed.home()
        return
      case 'end':
        if (ed) ed.end()
        return
      default:
        return
    }
  }

  /** "+ add option…" — nested input overlay, appends a user option and selects it */
  private askFormAddOption(ov: Extract<Overlay, { kind: 'askform' }>, fieldIndex: number): void {
    const f = ov.form.fields[fieldIndex]
    if (!f || f.type === 'input') return
    if ((ov.options[f.id] ?? []).length >= 12) {
      this.notice = 'option limit reached (12)'
      return
    }
    void this.ask(`new option — ${f.label}`).then((text) => {
      const t = (text ?? '').trim()
      if (!t) return
      const list = ov.options[f.id] ?? []
      if (list.some((o) => o.toLowerCase() === t.toLowerCase())) {
        this.notice = 'that option already exists'
      } else {
        list.push(t)
        ov.options[f.id] = list
        const cur = ov.selected[f.id] ?? []
        ov.selected[f.id] = f.type === 'option' ? [t] : [...cur, t]
      }
      ov.rows = askFormRows(ov.form, ov.options)
      const idx = ov.rows.findIndex(
        (r) => r.kind === 'option' && r.fieldIndex === fieldIndex && ov.options[f.id]?.[r.optionIndex] === t,
      )
      ov.cursor = idx >= 0 ? idx : ov.cursor
      this.requestRender()
    })
  }

  /** validate required fields, collect answers, resolve the form */
  private askFormSubmit(ov: Extract<Overlay, { kind: 'askform' }>): void {
    const answers: Record<string, string | string[]> = {}
    const missing: string[] = []
    ov.form.fields.forEach((f, i) => {
      if (f.type === 'input') {
        const t = (ov.editors[i]?.text ?? '').trim()
        answers[f.id] = t
        if (f.required && !t) missing.push(f.label)
      } else {
        const sel = ov.selected[f.id] ?? []
        answers[f.id] = f.type === 'option' ? (sel[0] ?? '') : sel
        if (f.required && sel.length === 0) missing.push(f.label)
      }
    })
    if (missing.length) {
      ov.missing = missing
      const firstIdx = ov.form.fields.findIndex((f) => missing.includes(f.label))
      if (firstIdx >= 0) {
        const rowIdx = ov.rows.findIndex((r) => r.fieldIndex === firstIdx && r.kind !== 'add')
        if (rowIdx >= 0) ov.cursor = rowIdx
      }
      this.requestRender()
      return
    }
    const notes = ov.notes.text.trim()
    this.settle(ov, { answers, ...(notes ? { notes } : {}) })
  }

  private planKey(ov: Extract<Overlay, { kind: 'plan' }>, k: Key): void {
    if (k.t === 'esc') return this.settle(ov, 'dismiss')
    if (k.t === 'up' || k.t === 'down') {
      ov.cursor = ov.cursor === 0 ? 1 : 0
      return
    }
    if (k.t === 'enter') return this.settle(ov, ov.cursor === 0 ? 'execute' : 'keep')
    if (k.t === 'pgup' || k.t === 'pgdn') {
      const h = Math.max(1, Math.min(12, this.termH - 12))
      ov.scroll = Math.max(0, Math.min(Math.max(0, ov.plan.length - h), ov.scroll + (k.t === 'pgup' ? -h : h)))
    }
  }

  private textKey(ov: Extract<Overlay, { kind: 'text' }>, k: Key): void {
    if (k.t === 'esc' || k.t === 'enter' || (k.t === 'print' && k.ch === 'q')) return this.settle(ov, undefined)
    const h = Math.max(1, this.termH - 8)
    if (k.t === 'up') ov.scroll = Math.max(0, ov.scroll - 1)
    else if (k.t === 'down') ov.scroll = Math.min(Math.max(0, ov.lines.length - h), ov.scroll + 1)
    else if (k.t === 'pgup') ov.scroll = Math.max(0, ov.scroll - h)
    else if (k.t === 'pgdn') ov.scroll = Math.min(Math.max(0, ov.lines.length - h), ov.scroll + h)
  }

  /* ---------------- ctrl+x main menu ---------------- */

  private openMainMenu(): void {
    const inPlan = this.mode === 'plan'
    const items: PickItem<string>[] = [
      { label: 'Continue', hint: 'send "continue"', value: 'continue', group: 'actions' },
      { label: 'Explain last change', hint: 'what was just done and why', value: 'explain', group: 'actions' },
      { label: 'Run diagnostics', hint: '/diag test', value: 'diag', group: 'actions' },
      { label: 'Summarize session', hint: 'recap so far', value: 'summarize', group: 'actions' },
      ...(inPlan ? [{ label: 'Write a plan', hint: 'draft the implementation plan', value: 'plan-write', group: 'actions' }] : []),
      { label: inPlan ? 'Switch to build mode' : 'Switch to plan mode', hint: inPlan ? 'full write access' : 'read-only planning', value: 'mode', group: 'mode' },
      { label: 'New session…', hint: 'fresh start', value: 'new', group: 'session' },
      { label: 'Session list…', hint: 'switch sessions', value: 'sessions', group: 'session' },
      { label: 'Pick model…', hint: 'provider + model', value: 'model', group: 'session' },
      { label: 'Undo checkpoint', hint: 'rollback last snapshot', value: 'undo', group: 'session' },
      { label: 'Toggle caveman mode', hint: 'terse replies', value: 'caveman', group: 'more' },
      { label: 'Theme…', hint: 'dark · light · tokyo night · dracula…', value: 'theme', group: 'more' },
      { label: 'Compact memory…', hint: 'summarize old turns (no AI)', value: 'compact', group: 'more' },
      { label: 'Skills…', hint: 'installed skills', value: 'skills', group: 'more' },
      { label: 'Subagents…', hint: 'custom subagents', value: 'agents', group: 'more' },
      { label: 'Fallback chain…', hint: 'provider failover', value: 'fallback', group: 'more' },
      { label: 'MCP…', hint: 'MCP servers', value: 'mcp', group: 'more' },
      { label: 'Plugins…', hint: 'plugin manager', value: 'plugins', group: 'more' },
      { label: 'Share / Relay…', hint: 'export or live-share', value: 'share', group: 'more' },
      { label: 'Help', hint: 'every command', value: 'help', group: 'more' },
      { label: 'Exit', hint: 'quit tagent', value: 'exit', group: 'exit' },
    ]
    void this.pick(items, 'menu — ctrl+x', { filterable: false, footer: '1-9 pick · tap a row · esc close' }).then((v) => {
      if (v === undefined) return
      void this.menuAction(String(v))
    })
  }

  private async menuAction(action: string): Promise<void> {
    try {
      await this.menuActionInner(action)
    } catch (e) {
      // menus must never crash the app — same contract as slash commands
      this.println(`  ${errPill()} ${red(`${(e as Error)?.message ?? e}`)}`)
      this.println(dim('    pick another option, or report the broken one'))
    }
  }

  private async menuActionInner(action: string): Promise<void> {
    switch (action) {
      case 'continue':
        return this.sendViaQueue('continue')
      case 'explain':
        return this.sendViaQueue('explain the last change you made — which files you touched, what you did, and why')
      case 'summarize':
        return this.sendViaQueue('summarize this session so far — decisions made, current state, and suggested next steps')
      case 'plan-write':
        return this.sendViaQueue('write an implementation plan for the current task')
      case 'diag': {
        this.println(dim('  running diagnostics…'))
        const r = await this.host.diagnosticsRun()
        this.println(r.ok ? `  ${okPill()} pass · ${(r.ms / 1000).toFixed(1)}s` : `  ${errPill()} ${red(`fail · ${(r.ms / 1000).toFixed(1)}s${r.timedOut ? ' (timed out)' : ''}`)}`)
        if (r.output) for (const l of r.output.split('\n').slice(0, 15)) this.println(dim(`  ${l}`))
        return
      }
      case 'mode': {
        const next: AgentMode = this.mode === 'build' ? 'plan' : this.mode === 'plan' ? 'test' : 'build'
        this.host.setSessionMode(next)
        this.printModeBanner(next)
        return
      }
      case 'new':
        return this.newSessionFlow()
      case 'sessions':
        return this.openSessionPicker()
      case 'model':
        return this.modelRoleFlow()
      case 'undo': {
        const r = this.host.undoCheckpoint() as { ok: boolean; checkpoint: { reason?: string } | null }
        if (r.ok) this.println(`  ${okPill()} rolled back · ${r.checkpoint?.reason ?? ''}`)
        else this.println(dim('  nothing to undo'))
        return
      }
      case 'caveman': {
        const v = !(this.host.cfg.caveman === true)
        this.host.settingsSave({ caveman: v })
        this.println(`  ${okPill()} caveman mode ${v ? 'ON — outputs summarized (head+tail digests), old action echoes slimmed, terse replies' : 'off'}`)
        return
      }
      case 'theme':
        return this.themeFlow()
      case 'compact': {
        this.runCompact(undefined)
        return
      }
      case 'skills':
        return this.skillsMenu()
      case 'agents':
        return this.agentsMenu()
      case 'fallback':
        return this.fallbackMenu()
      case 'mcp':
        return this.mcpManager('')
      case 'plugins':
        return this.pluginManager('')
      case 'share':
        return this.shareRelayMenu()
      case 'help':
        return this.helpOverlay()
      case 'exit':
        this.exit()
        return
    }
  }

  private sendViaQueue(text: string): void {
    if (this.running) {
      this.queued.push(text)
      this.println(dim('  · queued — sending after this run (/stop to interrupt)'))
      return
    }
    this.logUser(text)
    void this.send(text)
  }

  /* ---------------- smaller menus ---------------- */

  /** /theme [name] — the TUI color system (v0.23.0). Switching applies
   *  LIVE: every paint reads the active palette (navbar, editor, tool
   *  boxes, markdown) so the next frame is already the new theme, and the
   *  choice persists in the GLOBAL config — a personal preference, not a
   *  workspace fact. */
  private async themeFlow(arg?: string): Promise<void> {
    const names = THEMES.map((t) => t.name).join(' · ')
    if (arg) {
      if (!setTheme(arg)) {
        this.println(`  ${errPill()} ${red(`no theme "${arg}" — themes: ${names}`)}`)
        return
      }
      try {
        updateGlobalConfig({ theme: activeTheme().name })
      } catch {
        /* read-only home — the live switch still holds for this run */
      }
      this.println(`  ${okPill()} theme → ${bold(activeTheme().label)} ${dim('· every surface recolors now · saved')}`)
      this.requestRender()
      return
    }
    const cur = activeTheme().name
    const items = THEMES.map((t) => ({
      label: t.label,
      hint: t.dark ? 'dark bg' : 'light bg',
      value: t.name,
      detail: themeSwatch(t, USE_COLOR),
    }))
    const pick = await this.pick(items, 'theme', {
      selected: THEMES.findIndex((t) => t.name === cur),
      filterable: false,
      footer: '1-6 pick · tap a row · live switch',
    })
    if (!pick) return this.println(dim('  theme unchanged'))
    setTheme(pick)
    try {
      updateGlobalConfig({ theme: pick })
    } catch {
      /* read-only home — live still holds */
    }
    this.println(`  ${okPill()} theme → ${bold(themeLabel(pick) ?? pick)} ${dim('· every surface recolors now · saved')}`)
    this.requestRender()
  }

  private async newSessionFlow(): Promise<void> {
    const pick = await this.pick(
      [
        { label: 'build', hint: 'the agent can write files & run commands', value: 'build' as const },
        { label: 'plan', hint: 'read-only — interview → plan → PRD approval', value: 'plan' as const },
        { label: 'test', hint: 'QA — run the app, click through it, report', value: 'test' as const },
      ],
      'new session — mode',
    )
    if (!pick) return this.println(dim('  cancelled'))
    const s = this.host.newSession(pick)
    // fresh session → fresh screen: the old session's text stays saved in
    // ITS sidecar (/open brings it back), this one starts clean
    this.swapTranscript(s)
    this.sysPrintln(`  ${okPill()} new ${pick} session · ${s.id.slice(0, 8)}`)
    if (pick === 'test') this.printModeBanner('test')
  }

  private async openSessionPicker(): Promise<void> {
    const list = this.host.listSessions()
    if (list.length === 0) return this.println(dim('  no sessions yet — just start typing'))
    const id = await this.pick(
      list.slice(0, 50).map((s) => ({
        label: s.title,
        hint: `${s.mode} · ${s.messageCount} msgs · ${fmtWhen(s.updatedAt)}`,
        detail: `id ${s.id.slice(0, 8)}${this.host.session?.id === s.id ? ' · active' : ''}`,
        value: s.id,
      })),
      'open session',
      { filterable: true },
    )
    if (!id) return this.println(dim('  cancelled'))
    const loaded = this.host.loadSession(id)
    // display follows the switch — the picked session's text replays
    this.swapTranscript(loaded)
  }

  private async skillsMenu(): Promise<void> {
    const skills = listSkills(this.host.root)
    if (skills.length === 0) {
      this.println(dim('  no skills installed'))
      return
    }
    const name = await this.pick(
      skills.map((s) => ({ label: s.name, hint: s.source, detail: s.description, value: s.name })),
      'skills',
      { filterable: true },
    )
    if (!name) return
    try {
      const r = this.host.skillRead(name) as { content: string }
      for (const l of r.content.split('\n').slice(0, 60)) this.println(`  ${l}`)
    } catch (e) {
      this.println(`  ${errPill()} ${red(`${(e as Error).message}`)}`)
    }
  }

  private async agentsMenu(): Promise<void> {
    const items: PickItem<string>[] = [
      { label: 'new subagent…', hint: 'scaffold .tagent/agents/<name>.md', value: 'new', group: 'create' },
    ]
    const { agents } = this.host.subagentsView()
    for (const a of agents) {
      items.push({
        label: a.name,
        hint: `${a.source} · ${a.mode} · ≤${a.maxTurns} turns`,
        detail: a.description,
        value: `agent:${a.name}`,
        group: 'installed',
      })
    }
    const pick = await this.pick(items, 'subagents', { filterable: true })
    if (!pick) return
    if (pick === 'new') {
      const name = await this.ask('subagent name')
      if (!name?.trim()) return this.println(dim('  cancelled'))
      const file = path.join(this.host.root, '.tagent', 'agents', `${name.trim().replace(/\.md$/, '')}.md`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      if (fs.existsSync(file)) return this.println(yellow(`  ${name}.md already exists`))
      fs.writeFileSync(file, SUBAGENT_TEMPLATE)
      this.println(`  ${okPill()} created .tagent/agents/${name.trim()}.md — edit it, it hot-loads next run`)
      return
    }
    if (pick.startsWith('agent:')) {
      const a = agents.find((x) => `agent:${x.name}` === pick)
      if (a) {
        this.println(bold(`  ${a.name}`) + dim(` · ${a.source} · ${a.mode} · ≤${a.maxTurns} turns${a.model ? ` · ${a.model}` : ''}`))
        this.println(dim(`    ${a.description}`))
        if (a.tools?.length) this.println(dim(`    tools: ${a.tools.join(',')}`))
      }
      return
    }
  }

  private async fallbackMenu(): Promise<void> {
    for (;;) {
      const { chain } = this.host.fallbackChainView()
      const items: PickItem<string>[] = chain.map((c, i) => ({
        label: c.primary ? `${c.label} (primary)` : c.label,
        hint: c.model,
        value: `rm:${i}`,
        group: 'chain (try top → bottom)',
      }))
      items.push({ label: 'add fallback…', hint: 'provider + model + optional key', value: 'add', group: 'edit' })
      if (chain.length > 0) items.push({ label: 'clear chain', hint: 'remove every fallback', value: 'clear', group: 'edit' })
      items.push({ label: 'done', hint: 'esc', value: 'done', group: 'edit' })
      const pick = await this.pick(items, 'provider fallback chain')
      if (!pick || pick === 'done') return
      if (pick === 'add') {
        const provider = (await this.ask('provider (e.g. groq)'))?.trim()
        if (!provider) continue
        const model = (await this.ask('model (e.g. llama-3.3-70b-versatile)'))?.trim()
        if (!model) continue
        const key = (await this.ask('api key (enter to reuse the stored key)', { masked: true }))?.trim()
        const list = [...(this.host.cfg.fallback ?? []), { provider, model, ...(key ? { apiKey: key } : {}), enabled: true }]
        this.host.settingsSave({ fallback: list })
        this.println(`  ${okPill()} fallback #${list.length}: ${provider}/${model}${key ? ' (own key)' : ''}`)
        continue
      }
      if (pick === 'clear') {
        this.host.settingsSave({ fallback: [] })
        this.println(`  ${okPill()} fallback chain cleared`)
        continue
      }
      if (pick.startsWith('rm:')) {
        const i = Number(pick.slice(3))
        const list = [...(this.host.cfg.fallback ?? [])]
        const [gone] = list.splice(i, 1)
        this.host.settingsSave({ fallback: list })
        this.println(`  ${okPill()} removed ${gone.provider}/${gone.model}`)
      }
    }
  }

  private async shareRelayMenu(): Promise<void> {
    const pick = await this.pick(
      [
        { label: 'export HTML share', hint: 'standalone file of this session', value: 'share' },
        { label: 'start live relay', hint: 'read-only live view', value: 'relay' },
        { label: 'live relay list', hint: 'running relays', value: 'list' },
        { label: 'stop a relay…', hint: 'by code', value: 'stop' },
      ],
      'share / relay',
    )
    if (!pick) return
    if (pick === 'share') return this.command('/share')
    if (pick === 'relay') return this.command('/relay')
    if (pick === 'list') return this.command('/relay list')
    if (pick === 'stop') {
      const code = await this.ask('relay code to stop')
      if (code?.trim()) return this.command(`/relay stop ${code.trim()}`)
    }
  }

  private helpOverlay(): void {
    const lines: string[] = ['', bold('  Tagent commands'), '']
    for (const [k, v] of HELP_ROWS) lines.push(`    ${'/' + padCol(k, 46)} ${dim(v)}`)
    lines.push('')
    lines.push(dim('    type to talk · enter send · shift+enter newline · ctrl+x menu'))
    this.overlayStack.push({ kind: 'text', title: 'help', lines, scroll: 0, resolve: () => undefined })
    this.requestRender()
  }

  /** the `?` overlay — Claude Code's shortcuts panel */
  private shortcutsOverlay(): void {
    const k = (key: string, what: string) => `    ${bold(padCol(key, 16))} ${dim(what)}`
    const lines: string[] = [
      '',
      bold('  keyboard'), '',
      k('? / esc', 'close this panel'),
      k('/', 'command palette'),
      k('@', 'file mention + completion'),
      k('↑ / ↓', 'input history (single line)'),
      k('enter', 'send'),
      k('shift+enter', 'newline — write multi-line messages (alt/ctrl+enter too)'),
      k('paste', 'paste lands as text (multi-line too), never submits'),
      k('ctrl+a/e/u/k/w', 'line editing (home/end/kill)'),
      k('ctrl+x', 'main menu'),
      k('tab', 'complete the / command or @ file'),
      '',
      bold('  while running'), '',
      k('esc', 'interrupt the run'),
      k('ctrl+c', 'interrupt · twice = exit'),
      '',
      bold('  scrolling'), '',
      k('mouse / touch', 'the transcript is the terminal scrollback —'),
      k('shift+pgup', 'scroll it however your terminal does.'),
      '',
    ]
    this.overlayStack.push({ kind: 'text', title: 'shortcuts', lines, scroll: 0, resolve: () => undefined })
    this.requestRender()
  }

  /* ---------------- startup update check (overlay version) ---------------- */

  private async startupUpdate(): Promise<void> {
    if (this.io.output.isTTY === false || this.io.input.isTTY === false) return
    let info: UpdateInfo | null = null
    try {
      info = await checkUpdate()
    } catch {
      return
    }
    if (!info?.outdated) return
    this.println('')
    this.println(`  ${bold('update available')} ${dim(`v${info.current} → v${info.latest}${info.notes ? ` — ${info.notes}` : ''}`)}`)
    const yes = await this.askYesNo('  update now?', false)
    if (yes === undefined) {
      this.println(dim('  · skipped — /update checks again any time'))
      return
    }
    if (!yes) {
      this.println(dim(`  · staying on v${info.current} — /update any time`))
      return
    }
    const lines = await this.captureConsole(() => selfUpdate(info as UpdateInfo))
    for (const l of lines) this.println(`  ${l}`)
  }

  /** console.log capture — selfUpdate() prints via console.log */
  private async captureConsole(fn: () => Promise<unknown>): Promise<string[]> {
    const lines: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => {
      lines.push(a.map((x) => String(x)).join(' '))
    }
    try {
      await fn()
    } finally {
      console.log = orig
    }
    return lines
  }

  /* ------------------------------------------------------------------ */
  /* slash commands — full parity with tui.ts                             */
  /* ------------------------------------------------------------------ */

  private async command(raw: string): Promise<void> {
    const parts = raw.slice(1).split(/\s+/)
    const cmd = parts[0]
    const arg = parts.slice(1).join(' ')
    const host = this.host
    const cfg = host.sanitizeConfig()

    switch (cmd) {
      case 'help': case '?': {
        return this.helpOverlay()
      }

      case 'new': {
        return this.newSessionFlow()
      }

      case 'sessions': {
        const list = host.listSessions()
        if (list.length === 0) return this.println(dim('  no sessions yet'))
        this.println(bold('  sessions (newest first)'))
        for (const s of list.slice(0, 20)) {
          const active = host.session?.id === s.id ? green('▸ ') : '  '
          this.println(` ${active}${bold(s.title)} ${dim(`· ${s.mode} · ${s.messageCount} msgs · ${fmtWhen(s.updatedAt)} · ${s.id.slice(0, 8)}`)}`)
        }
        return
      }

      case 'open': {
        if (!arg) {
          return this.openSessionPicker()
        }
        const s = host.listSessions().find((x) => x.id.startsWith(arg))
        if (!s) return this.println(red(`  no session starts with "${arg}"`))
        const loaded = host.loadSession(s.id)
        this.swapTranscript(loaded) // display follows the switch — its text replays
        return
      }

      case 'delete': {
        if (!arg) return this.println(dim('  usage: /delete <session-id-prefix>'))
        const s = host.listSessions().find((x) => x.id.startsWith(arg))
        if (!s) return this.println(red(`  no session starts with "${arg}"`))
        host.deleteSession(s.id)
        this.println(`  ${okPill()} deleted ${s.title}`)
        return
      }

      case 'share': {
        const r = host.share(arg || undefined)
        if (!r.ok) return this.println(`  ${errPill()} ${red(`${r.error}`)}`)
        this.println(`  ${okPill()} share exported`)
        this.println(`    ${dim('file')}  ${r.file}`)
        this.println(`    ${dim('url')}   ${this.webUrl ? this.webUrl.replace(/\/$/, '') + r.url : dim('run with --web-gui to serve it')}`)
        return
      }

      case 'relay': {
        const [sub, code] = arg.split(/\s+/)
        if (sub === 'stop') {
          if (!code) return this.println(dim('  usage: /relay stop <code> — see /relay list'))
          const r = host.relayRevoke(code)
          return this.println(r.ok ? `  ${okPill()} relay ${code} ended` : dim(`  no live relay ${code}`))
        }
        if (sub === 'list') {
          const relays = host.relayList()
          if (relays.length === 0) return this.println(dim('  no live relays — /relay starts one for this session'))
          this.println(bold(`  live relays (${relays.length})`))
          for (const r of relays) {
            this.println(`   ${green('◉')} ${bold(r.code)} ${dim(`· ${r.sessionTitle} · since ${fmtWhen(r.createdAt)}`)}`)
          }
          this.println(dim('    stop: /relay stop <code>'))
          return
        }
        const target = sub
          ? host.listSessions().find((s) => s.id.startsWith(sub))
          : host.session
        if (!target) return this.println(dim('  no session yet — say something first, or /relay <session-prefix>'))
        const r = host.relayCreate(target.id)
        if (!r.ok || !r.code) return this.println(`  ${errPill()} ${red(`${r.error}`)}`)
        const base = this.webUrl ?? this.relayBase
        if (!base) {
          try {
            await this.startRelayEndpoint()
          } catch (e) {
            return this.println(`  ${errPill()} ${red(`could not start the relay endpoint: ${(e as Error).message}`)}`)
          }
        }
        const url = (this.webUrl ?? this.relayBase ?? '').replace(/\/$/, '') + r.url
        this.println(`  ${okPill()} live relay for "${target.title}"`)
        this.println(`    ${bold('url')}   ${url}`)
        this.println(dim(`    read-only live view · ends with /relay stop ${r.code}`))
        this.println(dim('    sharing beyond this machine: tagent relay --host 0.0.0.0 (prints LAN urls)'))
        return
      }

      case 'timeline': {
        const tl = host.timeline()
        if (tl.length === 0) return this.println(dim('  no subagent runs recorded for this session'))
        this.println(bold(`  timeline · ${tl.length} subagent run(s)`))
        for (const s of tl) {
          this.println(`   ${cyan('▸')} ${bold(s.title)} ${dim(`· ${s.messageCount} msgs · ${fmtWhen(s.createdAt)}`)}`)
        }
        this.println(dim('    full transcripts live in .tagent/sessions/'))
        return
      }

      case 'mode': {
        if (arg === 'plan' || arg === 'build' || arg === 'test') {
          host.setSessionMode(arg)
          this.printModeBanner(arg)
          return
        }
        const cur = host.session?.mode ?? 'build'
        const pick = await this.pick(
          [
            { label: 'build', hint: 'write files, run commands, finish the job', value: 'build' as const },
            { label: 'plan', hint: 'read-only — interview → PRD → approval', value: 'plan' as const },
            { label: 'test', hint: 'QA — run the app, click through, report', value: 'test' as const },
          ],
          'mode',
          { selected: cur === 'build' ? 0 : cur === 'plan' ? 1 : 2 },
        )
        if (!pick) return this.println(dim('  cancelled'))
        host.setSessionMode(pick)
        this.printModeBanner(pick)
        return
      }

      case 'test': {
        // switch to test mode + optionally verify a running URL immediately
        const url = arg.trim()
        host.setSessionMode('test')
        this.printModeBanner('test')
        if (url && /^(https?:\/\/|\w+([.:-]\w+)+:\d+)/.test(url)) {
          this.sendViaQueue(`Verify the app running at ${url} — test every feature you can reach, check responsiveness (mobile/tablet/desktop) and visuals, then write the report.`)
        } else if (url) {
          this.println(`  ${warnPill()} ${yellow(`"${url}" does not look like a URL — mode switched, send a target manually`)}`)
        } else {
          this.println(dim('    the agent will serve the project itself — or send it a URL / feature list to test'))
        }
        return
      }

      case 'model': {
        if (arg === 'refresh' || arg === 'discover') {
          this.println(dim('  discovering models (GET /models on every provider with a key)…'))
          const r = await host.providersRefresh()
          this.println(green(`  ✔ ${r.updated.length} provider(s) refreshed${r.failed.length ? red(` · ${r.failed.length} unreachable`) : ''}`))
          if (r.updated.length) this.println(dim(`    ${r.updated.join(', ')}`))
          return
        }
        // /model list — the flat catalog view + the model roles
        if (arg === 'list' || arg === 'catalog') {
          const infos = listProviderInfos(host.cfg)
          const ready = infos.filter((p) => !p.needsKey || p.hasKey)
          const locked = infos.filter((p) => p.needsKey && !p.hasKey)
          this.println(bold('  model roles'))
          for (const r of describeModelRoles(host.cfg)) {
            this.println(`   ${r.role === 'main' ? green('▸') : ' '} ${bold(padCol(r.role, 14))} ${r.set ? r.ref : dim(r.ref)}`)
          }
          this.println(`  ${bold('providers')} — current main: ${bold(cfg.defaultModel)} ${dim(`(${cfg.defaultProvider})`)}`)
          this.println(bold('  ready'))
          for (const p of ready) {
            const mark = p.id === host.cfg.defaultProvider ? green('▸') : ' '
            const key = !p.needsKey ? dim('free') : p.hasKey ? green('key✓') : red('no key')
            this.println(`  ${mark} ${bold(padCol(p.id, 16))} ${key} ${dim(p.models.map((m) => m.id).slice(0, 4).join(', '))}${p.models.length > 4 ? dim(` +${p.models.length - 4}`) : ''}`)
          }
          if (locked.length) this.println(dim(`  ${locked.length} more in the catalog (add a key): ${locked.slice(0, 8).map((p) => p.id).join(', ')}${locked.length > 8 ? '…' : ''}`))
          this.println(dim('  roles: /model subagent|vision <provider>/<model> · off → follow main · interactive: /model'))
          return
        }
        // no arg → the role picker, then providers, then models
        if (!arg) return this.modelRoleFlow()
        // /model custom → straight into the custom-provider wizard
        if (arg === 'custom' || arg === 'add') return this.customProviderWizard()
        // role-scoped: /model subagent <ref|off> · /model vision <ref|off> · /model media vision <ref>
        {
          const ALIAS: Record<string, 'subagent' | 'vision' | 'audio' | 'video' | 'pdf'> = {
            subagent: 'subagent', sub: 'subagent', vision: 'vision', audio: 'audio', video: 'video', pdf: 'pdf',
          }
          const parts = arg.split(/\s+/)
          let role: (typeof ALIAS)[string] | undefined
          let rest = ''
          if (parts[0] === 'media' && parts.length >= 2 && ALIAS[parts[1]]) {
            role = ALIAS[parts[1]]
            rest = parts.slice(2).join(' ')
          } else if (ALIAS[parts[0]]) {
            role = ALIAS[parts[0]]
            rest = parts.slice(1).join(' ')
          }
          if (role) {
            if (!rest) return this.modelPickerFlow(role as never)
            if (rest === 'off' || rest === 'none' || rest === 'clear') {
              host.settingsSave({ modelRole: { role, ref: '' } })
              return this.println(`  ${okPill()} ${role} → follows the main model again`)
            }
            const r = parseModelRef(rest, host.cfg)
            const provider = r?.provider ?? host.cfg.defaultProvider
            const modelId = r?.model ?? rest
            const info = listProviderInfos(host.cfg).find((p) => p.id === provider)
            if (!info) return this.println(red(`  unknown provider "${provider}" — /model to list`))
            if (info.needsKey && !info.hasKey) return this.println(red(`  ${provider} has no key yet — /apikey ${provider}`))
            host.settingsSave({ modelRole: { role, ref: `${provider}/${modelId}` } })
            this.println(`  ${okPill()} ${role} → ${bold(`${provider} · ${modelId}`)}`)
            if (role === 'vision' && !info.models.find((m) => m.id === modelId)?.vision) {
              this.println(yellow(`    ⚠ ${modelId} is not flagged vision-capable — image input may fail`))
            }
            return
          }
        }
        // "provider/model" (opencode style) or legacy "provider:model"
        const ref = parseModelRef(arg, host.cfg)
        if (ref) {
          const info = listProviderInfos(host.cfg).find((p) => p.id === ref.provider)
          if (!info) return this.println(red(`  unknown provider "${ref.provider}" — /model to list`))
          if (info.needsKey && !info.hasKey) return this.println(red(`  ${ref.provider} has no key yet — /apikey ${ref.provider}`))
          host.settingsSave({ defaultProvider: ref.provider, defaultModel: ref.model })
          this.println(`  ${okPill()} ${ref.provider} · ${ref.model}`)
          return
        }
        // exact provider id → pick its first model
        const info = listProviderInfos(host.cfg).find((p) => p.id === arg)
        if (info) {
          if (info.needsKey && !info.hasKey) return this.println(red(`  ${info.id} has no key yet — /apikey ${info.id}`))
          const nextModel = info.models[0]?.id
          if (!nextModel) return this.println(red(`  provider "${info.id}" has no models configured — /model refresh`))
          host.settingsSave({ defaultProvider: info.id, defaultModel: nextModel })
          this.println(`  ${okPill()} ${info.id} · ${nextModel}`)
          return
        }
        // otherwise: search across providers and models
        const q = arg.toLowerCase()
        const infos = listProviderInfos(host.cfg)
        const provHits = infos.filter((p) => p.id.includes(q) || p.label.toLowerCase().includes(q))
        const modelHits = infos.flatMap((p) => p.models.filter((m) => m.id.toLowerCase().includes(q)).map((m) => ({ p, m })))
        if (provHits.length + modelHits.length === 0) {
          return this.println(red(`  nothing matches "${arg}" — /model to list everything · /model custom to add your own`))
        }
        if (provHits.length + modelHits.length === 1) {
          const hit = provHits.length ? { provider: provHits[0].id, model: provHits[0].models[0]?.id } : { provider: modelHits[0].p.id, model: modelHits[0].m.id }
          if (!hit.model) return this.println(red(`  ${hit.provider} has no models — /model refresh`))
          host.settingsSave({ defaultProvider: hit.provider, defaultModel: hit.model })
          this.println(`  ${okPill()} ${hit.provider} · ${hit.model}`)
          return
        }
        for (const p of provHits.slice(0, 10)) this.println(`  ${bold(p.id)} ${dim(p.label)}${p.needsKey && !p.hasKey ? red(' (no key)') : ''}`)
        for (const h of modelHits.slice(0, 15)) this.println(`  ${dim(h.p.id + ':')} ${bold(h.m.id)}`)
        this.println(dim(`  ${provHits.length + modelHits.length} matches — pick one: /model <provider>/<model>`))
        return
      }

      case 'caveman': {
        const v = arg === 'on' ? true : arg === 'off' ? false : !cfg.caveman
        host.settingsSave({ caveman: v })
        this.println(`  ${okPill()} caveman mode ${v ? 'ON — terse replies, compact prompts' : 'off'}`)
        return
      }

      case 'theme': {
        return this.themeFlow(arg || undefined)
      }

      case 'worklog': {
        const v = arg === 'on' ? true : arg === 'off' ? false : !cfg.worklog.enabled
        host.settingsSave({ worklogEnabled: v })
        this.println(`  ${okPill()} worklog + todos ${v ? 'on — the agent journals to WORKLOG.md' : 'off'}`)
        return
      }

      case 'webgui': {
        const cur = host.cfg.webGui === true
        const v = arg === 'on' ? true : arg === 'off' ? false : !cur
        const { updateGlobalConfig } = await import('@tagent/core')
        updateGlobalConfig({ webGui: v })
        this.println(`  ${okPill()} web gui will ${v ? 'start' : 'not start'} with ${bold('tagent start')}`)
        this.println(dim('    this run is unaffected — --web-gui always overrides'))
        return
      }

      case 'todos': {
        if (this.todos.length === 0) return this.println(dim('  no todos in this session'))
        const done = this.todos.filter((t) => t.status === 'completed').length
        this.println(`  ${bold(`${done}/${this.todos.length}`)}`)
        for (const t of this.todos) {
          const icon = t.status === 'completed' ? green('✔') : t.status === 'in_progress' ? cyan('▸') : dim('☐')
          this.println(`   ${icon} ${t.status === 'completed' ? dim(t.content) : t.content}`)
        }
        return
      }

      case 'log': {
        const file = path.join(host.root, 'WORKLOG.md')
        if (!fs.existsSync(file)) return this.println(dim('  no WORKLOG.md yet — the agent writes it as it works'))
        const n = Number(arg) > 0 ? Number(arg) : 15
        const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n')
        this.println(bold(`  WORKLOG.md (last ${n})`))
        for (const l of lines.slice(-n)) this.println(`  ${l}`)
        return
      }

      case 'maxturns': {
        const n = Number(arg)
        if (!(n >= 1 && n <= 80)) return this.println(dim('  usage: /maxturns <1-80>'))
        host.settingsSave({ maxTurns: Math.round(n) })
        this.println(`  ${okPill()} turn budget: ${Math.round(n)}`)
        return
      }

      case 'agents': case 'agent': {
        const sub = arg.split(/\s+/)[0]
        if (sub === 'new') {
          const name = (arg.split(/\s+/)[1] || 'my-specialist').replace(/\.md$/, '')
          const dir = path.join(host.root, '.tagent', 'agents')
          fs.mkdirSync(dir, { recursive: true })
          const file = path.join(dir, `${name}.md`)
          if (fs.existsSync(file)) return this.println(yellow(`  ${name}.md already exists`))
          fs.writeFileSync(file, SUBAGENT_TEMPLATE)
          this.println(`  ${okPill()} created .tagent/agents/${name}.md — edit it, it hot-loads next run`)
          this.println(dim('    fields: name · description · model · tools · mode · maxTurns; body = persona'))
          return
        }
        const { agents } = host.subagentsView()
        if (!agents.length) {
          this.println(dim('  no custom subagents — /agents new <name> creates one'))
          this.println(dim('    workspace: .tagent/agents/ · global: ~/.tagent/agents/'))
          return
        }
        this.println(bold(`  custom subagents (${agents.length})`))
        for (const a of agents) {
          this.println(`   ${cyan('▸')} ${bold(a.name)} ${dim(`· ${a.source} · ${a.mode} · ≤${a.maxTurns} turns${a.model ? ` · ${a.model}` : ''}${a.tools ? ` · tools: ${a.tools.join(',')}` : ''}`)}`)
          this.println(`     ${dim(a.description)}`)
        }
        this.println(dim('    spawn: the task tool with agent "<name>" · /agents new <name> to add one'))
        return
      }

      case 'diag': {
        const cur = (host.cfg.diagnostics?.command ?? '').trim()
        if (arg === 'test') {
          if (!cur) return this.println(dim('  no diagnostics command configured'))
          this.println(dim(`  running: ${cur} …`))
          const r = await host.diagnosticsRun()
          this.println(r.ok ? `  ${okPill()} pass · ${(r.ms / 1000).toFixed(1)}s` : `  ${errPill()} ${red(`fail · ${(r.ms / 1000).toFixed(1)}s${r.timedOut ? ' (timed out)' : ''}`)}`)
          if (r.output) for (const l of r.output.split('\n').slice(0, 15)) this.println(dim(`  ${l}`))
          return
        }
        if (arg === 'off' || arg === 'none' || arg === 'clear') {
          host.settingsSave({ diagnosticsCommand: '' })
          return this.println(`  ${okPill()} diagnostics gate off`)
        }
        if (arg) {
          host.settingsSave({ diagnosticsCommand: arg })
          this.println(`  ${okPill()} diagnostics gate: ${bold(arg)}`)
          this.println(dim('    runs once per edit turn; failures are fed back to the agent'))
          return
        }
        this.println(cur
          ? `  diagnostics: ${bold(cur)}`
          : dim('  diagnostics off — /diag "tsc --noEmit" or /diag "npm run lint" to arm the gate'))
        this.println(dim('    /diag test runs it once · /diag off disarms'))
        return
      }

      case 'subs': {
        const list = host.backgroundSubs()
        const { maxParallel, running } = host.subagentLimits()
        if (!list.length) {
          this.println(`  ${chip('🤖 background subagents', 'blue')} ${dim('none yet')}`)
          this.println(dim('    the agent spawns them: task {"background": true, …} — it keeps working while they run'))
          this.println(dim(`    limit: /config subs <n> (now ${maxParallel})`))
          return
        }
        this.println(`  ${chip('🤖 background subagents', 'blue')} ${bold(`${running} running · ${list.length} total`)} ${dim(`(limit ${maxParallel})`)}`)
        for (const line of renderSubsTable(list)) this.println(`    ${line}`)
        this.println(dim('    reports flow to the agent automatically ([SUBAGENT REPORT]) — /subs is just the live view'))
        return
      }

      case 'fallback': {
        // /fallback [main|subagent|vision] [add <provider> <model> [key] | rm <n> | clear]
        const parts = arg.split(/\s+/).filter(Boolean)
        const ALIAS: Record<string, 'main' | 'subagent' | 'vision'> = {
          main: 'main', agent: 'main', utama: 'main',
          subagent: 'subagent', sub: 'subagent',
          vision: 'vision', media: 'vision',
        }
        let role: 'main' | 'subagent' | 'vision' | undefined
        if (parts[0] && ALIAS[parts[0].toLowerCase()]) role = ALIAS[parts[0].toLowerCase()]
        const rest = role ? parts.slice(1) : parts
        const [verb, ...rp] = rest
        const view = host.fallbackChainsView()
        const lane = role ?? 'main'

        if (verb === 'add') {
          const [provider, model, ...keyParts] = rp
          if (!provider || !model) {
            return this.println(dim('  usage: /fallback [main|subagent|vision] add <provider> <model> [apiKey]'))
          }
          const key = keyParts.join(' ')
          const entry = { provider, model, ...(key ? { apiKey: key } : {}), enabled: true }
          if (lane === 'main') {
            host.settingsSave({ fallback: [...view.entries.main, entry] })
          } else {
            host.settingsSave({ fallbackRole: { role: lane, list: [...view.entries[lane], entry] } })
          }
          return this.println(`  ${okPill()} ${lane} fallback #${view.entries[lane].length + 1}: ${provider}/${model}${key ? ' (own key)' : ''}`)
        }
        if (verb === 'rm') {
          const i = Number(rp[0]) - 1
          const cur = view.entries[lane]
          if (!(i >= 0 && i < cur.length)) {
            return this.println(dim(`  usage: /fallback [main|subagent|vision] rm <1-${cur.length}>`))
          }
          const [gone] = cur.filter(Boolean).slice(i, i + 1)
          const next = cur.filter((_, idx) => idx !== i)
          if (lane === 'main') host.settingsSave({ fallback: next })
          else host.settingsSave({ fallbackRole: { role: lane, list: next } })
          return this.println(`  ${okPill()} ${lane}: removed ${gone?.provider ?? '?'}/${gone?.model ?? '?'}`)
        }
        if (verb === 'clear') {
          if (lane === 'main') host.settingsSave({ fallback: [] })
          else host.settingsSave({ fallbackRole: { role: lane, list: [] } })
          return this.println(`  ${okPill()} ${lane} fallback chain cleared`)
        }

        // view — one lane or all three
        const laneView = (name: string, chain: { label: string; model: string; primary: boolean }[]) => {
          this.println(bold(`  ${name} — try top → bottom`))
          for (const [i, ch] of chain.entries()) {
            this.println(`   ${ch.primary ? green('①') : dim(String(i + 1))} ${bold(ch.label)} ${dim(`· ${ch.model}`)}`)
          }
        }
        if (role) {
          laneView(lane, view.chains[lane])
          this.println(dim(`    add: /fallback ${lane === 'subagent' ? 'subagent' : lane} add <provider> <model> [apiKey] · rm <n> · clear`))
          return
        }
        laneView('main', view.chains.main)
        this.println('')
        laneView('subagent', view.chains.subagent)
        this.println('')
        laneView('vision', view.chains.vision)
        this.println(dim('    usage: /fallback <main|subagent|vision> add <provider> <model> [apiKey] · rm <n> · clear'))
        this.println(dim('    same provider + different apiKey = key-level failover (stack freely)'))
        return
      }

      case 'apikey': {
        let prov = arg
        if (!prov) {
          const infos = listProviderInfos(host.cfg)
          const provs = infos.filter((p) => p.needsKey)
          if (provs.length === 0) return this.println(dim('  every configured provider is keyless'))
          prov = (await this.pick(
            provs.map((p) => ({
              label: p.label,
              hint: p.hasKey ? 'key ✓' : 'no key',
              detail: p.id,
              value: p.id,
            })),
            'provider — api key',
            { filterable: true },
          )) ?? ''
          if (!prov) return this.println(dim('  cancelled'))
        }
        // multi-key: the first key lands unlabeled as "main"; from the second
        // one on, ask for a label — the keychain is what /model and /config
        // use to offer the pick
        const existing = listProviderKeys(readGlobalConfig(), prov)
        let label = 'main'
        if (existing.length) {
          label = ((await this.ask('label (e.g. "backup", "free tier")')) ?? '').trim() || `key ${existing.length + 1}`
        }
        const key = (await this.askHidden(`api key for ${prov}`)).trim()
        if (!key) return this.println(dim('  cancelled — empty key'))
        const r = addProviderKey(prov, label, key)
        host.settingsSave({ apiKey: { provider: prov, key } })
        this.println(`  ${okPill()} key saved for ${prov}${existing.length ? ` — ${bold(r.entry.label)}` : ''}`)
        if (existing.length) {
          this.println(dim('    switch keys: /config keys (or re-run /model) · travels: /config push'))
        }
        return
      }

      case 'mcp': {
        await this.mcpManager(arg)
        return
      }

      case 'plugins': case 'plugin': {
        await this.pluginManager(arg)
        return
      }

      case 'update': {
        this.println(dim('  checking for updates…'))
        const info = await checkUpdate(true)
        if (!info) return this.println(red('  could not reach the update endpoint (offline?)'))
        if (!info.outdated) return this.println(`  ${okPill()} up to date — v${info.current}`)
        this.println(`  update available: v${info.current} → ${bold('v' + info.latest)}`)
        if (info.notes) this.println(dim(`  ${info.notes}`))
        const yes = await this.askYesNo('  update now?', true)
        if (yes) {
          const lines = await this.captureConsole(() => selfUpdate(info))
          for (const l of lines) this.println(`  ${l}`)
        } else {
          this.println(dim(`  later — ${info.url ?? 'https://github.com/asysurya/tagent/releases'}`))
        }
        return
      }

      case 'permissions': {
        this.println(bold('  permissions') + dim(` · default: ${host.cfg.permissions.defaultMode}`))
        for (const [tool, mode] of Object.entries(host.cfg.permissions.tools)) {
          const color = mode === 'allow' ? green(mode) : mode === 'deny' ? red(mode) : yellow(mode)
          this.println(`    ${padCol(tool, 14)} ${color}`)
        }
        this.println(dim('    change: /allow <tool> · /ask <tool> · /deny <tool>'))
        return
      }

      case 'allow': case 'ask': case 'deny': {
        if (!arg) return this.println(dim(`  usage: /${cmd} <tool>`))
        const perm = { ...(host.cfg.permissions) }
        perm.tools = { ...perm.tools, [arg]: cmd }
        host.settingsSave({ permissions: perm })
        this.println(`  ${okPill()} ${arg} → ${cmd}`)
        return
      }

      case 'files': {
        const tree = host.filesList(arg || '.') as {
          name: string
          children?: { name: string; type: string; size?: number; children?: unknown[] }[]
        }
        this.println(bold(`  ${host.root}${arg && arg !== '.' ? '/' + arg : ''}`))
        const draw = (children: { name: string; type: string; size?: number; children?: unknown[] }[], pad: string, depth: number) => {
          if (depth > 3) return
          for (const ch of children ?? []) {
            const last = ch === children![children!.length - 1]
            const branch = last ? '└─ ' : '├─ '
            const label = ch.type === 'dir' ? bold(blue(ch.name + '/')) : ch.name
            const size = ch.type === 'file' && ch.size ? dim(' ' + fmtBytes(ch.size)) : ''
            this.println(`  ${pad}${branch}${label}${size}`)
            if (ch.type === 'dir') draw(ch.children as never, pad + (last ? '   ' : '│  '), depth + 1)
          }
        }
        draw(tree.children ?? [], '', 0)
        return
      }

      case 'read': {
        if (!arg) return this.println(dim('  usage: /read <file>'))
        try {
          const r = host.fileRead(arg) as { content?: string; binary?: boolean }
          if (r.binary) return this.println(dim('  binary file'))
          const lines = (r.content ?? '').split('\n')
          const max = 200
          for (const [i, l] of lines.slice(0, max).entries()) {
            this.println(`  ${dim(String(i + 1).padStart(3))} ${l}`)
          }
          if (lines.length > max) this.println(dim(`  … ${lines.length - max} more lines`))
        } catch (e) {
          this.println(`  ${errPill()} ${red(`${(e as Error).message}`)}`)
        }
        return
      }

      case 'grep': {
        if (!arg) return this.println(dim('  usage: /grep <pattern>'))
        const hits = this.grepWorkspace(arg)
        if (hits.length === 0) return this.println(dim('  no matches'))
        for (const h of hits.slice(0, 40)) {
          this.println(`  ${bold(h.file)}${dim(':' + h.line)}  ${truncateStyled(h.text, Math.max(20, this.termW - 30))}`)
        }
        if (hits.length > 40) this.println(dim(`  … ${hits.length - 40} more matches`))
        return
      }

      case 'sh': case 'shell': {
        if (!arg) return this.println(dim('  usage: /sh <command>'))
        const out = await host.terminalExec(arg)
        for (const l of out.split('\n').slice(0, 40)) this.println(`  ${l}`)
        return
      }

      case 'auth': {
        await this.authWizard()
        return
      }

      case 'config': {
        await this.configManager(arg)
        return
      }

      case 'repo': case 'sync': {
        await this.repoManager(arg)
        return
      }

      case 'push': {
        // v0.13: routed through core syncProject — the same path as daemon
        // sync:push and `tagent sync` — so the project registry (link +
        // lastSyncAt) stays truthful. Token resolution order matches
        // syncProject: credential store → workspace cfg → global cfg.
        const token = getCredential('github') || host.cfg.github?.token || readGlobalConfig().github?.token
        if (!token) return this.println(red('  not logged in — /auth first (or run `tagent auth`)'))
        this.println(dim('  pushing…'))
        try {
          const r = await syncProject(host.root, host.cfg, {
            message: arg || undefined,
            onLog: (l) => this.println(dim(`  ${l}`)),
          })
          this.println(`  ${pushPill()} ${bold(`to ${r.repo}`)} ${dim(`(${r.commit})`)}`)
          this.println(dim(`  ${r.url}`))
          this.refreshSyncBadge()
        } catch (e) {
          this.refreshSyncBadge() // syncProject may have linked before the push failed
          this.println(`  ${errPill()} ${red((e as Error).message)}`)
        }
        return
      }

      case 'checkpoints': {
        const cps = listCheckpoints(host.root).slice(0, 12)
        if (cps.length === 0) return this.println(dim('  no snapshots yet'))
        this.println(`  ${chip('💾 checkpoints', 'blue')} ${bold(`${listCheckpoints(host.root).length} snapshot(s) — newest first`)}`)
        for (const cp of cps) {
          this.println(`    ${dim(fmtWhen(cp.at))} · ${cp.label}`)
        }
        return
      }

      case 'undo': {
        const r = host.undoCheckpoint() as { ok: boolean; checkpoint: { reason?: string } | null }
        if (r.ok) this.println(`  ${okPill()} rolled back · ${r.checkpoint?.reason ?? ''}`)
        else this.println(dim('  nothing to undo'))
        return
      }

      case 'memory': {
        const facts = listFacts(host.root)
        if (facts.length === 0) return this.println(dim('  no memory facts — the agent saves them via the memory tool'))
        this.println(`  ${chip('🧠 memory', 'blue')} ${bold(`${facts.length} fact(s) the agent remembers`)}`)
        for (const f of facts.slice(0, 20)) this.println(`    ${magenta('◆')} ${f.text}`)
        return
      }

      case 'skills': {
        const skills = listSkills(host.root)
        if (skills.length === 0) return this.println(dim('  no skills installed'))
        this.println(`  ${chip('🎯 skills', 'blue')} ${bold(`${skills.length} installed`)}`)
        for (const s of skills) this.println(`    ${bold(s.name)} ${dim(`(${s.source})`)} — ${s.description}`)
        return
      }

      case 'skill': {
        if (!arg) return this.println(dim('  usage: /skill <name>'))
        try {
          const r = host.skillRead(arg) as { content: string }
          for (const l of r.content.split('\n').slice(0, 60)) this.println(`  ${l}`)
        } catch (e) {
          this.println(`  ${errPill()} ${red(`${(e as Error).message}`)}`)
        }
        return
      }

      case 'compact': {
        const keep = arg ? Number(arg.replace(/[^0-9]/g, '')) : undefined
        if (arg && (!keep || keep < 1000)) {
          return this.println(dim('  usage: /compact [keep-tokens] — e.g. /compact 8000 (default 10000)'))
        }
        this.runCompact(keep)
        return
      }

      case 'stats': {
        const st = host.stats()
        const ctx = st.context as { used: number; limit: number; pct: number; bar: string; estimated: boolean }
        this.println(`  ${bold('sessions')} ${st.sessions} · ${bold('snapshots')} ${st.snapshots}`)
        if (ctx.bar) {
          this.println(`  ${bold('context')}   ${ctx.bar}${ctx.estimated ? dim(' (estimated)') : ''}`)
          this.println(dim('    /compact summarizes old turns — deterministic, no AI'))
        } else {
          this.println(`  ${bold('context')}   ~${fmtTok(ctx.used)} tokens (model window unknown — set contextWindow in ~/.tagent/zai-models.json or TAGENT_CONTEXT_WINDOW)`)
        }
        return
      }

      case 'settings': {
        const s = JSON.parse(
          JSON.stringify(host.sanitizeConfig(), (k, v) => (k === 'providers' ? undefined : v)),
        ) as Record<string, unknown>
        for (const [k, v] of Object.entries(s)) {
          this.println(`  ${padCol(k, 18)} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        }
        return
      }

      case 'stop': {
        if (!this.running) return this.println(dim('  nothing running'))
        this.interruptRun()
        return
      }

      case 'clear': {
        // TEXT-ONLY wipe — "cuman hapus teks aja, bukan memory": the screen,
        // the scrollback AND the saved transcript text go; the session's
        // messages (the agent's memory) stay, so the chat just continues.
        //   /clear        — everything (same as all)
        //   /clear all    — everything, explicit
        //   /clear <n>    — the text of the last n messages
        const a = arg.trim().toLowerCase()
        let keepCount = 0 // transcript entries to keep
        if (a && a !== 'all') {
          const n = Math.floor(Number(a))
          if (!n || n < 1) {
            return this.println(dim('  usage: /clear [count|all] — wipes text only, memory stays'))
          }
          const sid = host.session?.id
          if (sid) {
            const tr = host.sessionTranscript(sid)
            const bounds = tr.map((e, i) => (e.m ? i : -1)).filter((i) => i >= 0)
            keepCount = bounds.length ? bounds[Math.max(0, bounds.length - n)] : 0
          }
        }
        const sid = host.session?.id
        const msgs = host.session?.messages?.length ?? 0
        this.transcriptFlush()
        if (sid) host.sessionTranscriptTrim(sid, keepCount)
        this.wipeScreen()
        this.log = []
        this.flushed = 0
        this.flatCache = { upto: 0, lines: [] }
        this.viewing = false
        this.viewOffset = 0
        this.streamText = ''
        this.lastDoneLabel = ''
        this.banner()
        if (keepCount > 0 && sid) {
          for (const e of host.sessionTranscript(sid).slice(0, keepCount)) {
            this.log.push({ raw: e.t, ...(e.m ? { m: 1 } : {}) })
          }
        }
        this.sysPrintln(
          dim(
            keepCount > 0
              ? `  ⌫ dropped the last ${a.trim()} message${a.trim() === '1' ? '' : 's'}' text — memory intact (${msgs} messages)`
              : `  ⌫ text cleared — memory intact (${msgs} message${msgs === 1 ? '' : 's'} remembered)`,
          ),
        )
        this.requestRender()
        return
      }

      case 'exit': case 'quit': case 'q': {
        this.exit()
        return
      }

      default: {
        // plugin commands? (custom /commands exported by .tagent/plugins/*.mjs)
        const r = await host.pluginCommandRun(cmd, arg)
        if (r.ok) {
          if (r.output) this.println(`  ${r.output}`)
          return
        }
        if (!/no plugin command named/.test(r.error ?? '')) {
          this.println(`  ${errPill()} ${red(`${r.error}`)}`)
          return
        }
        this.println(dim(`  unknown command /${cmd} — /help`))
      }
    }
  }

  /** 'e' on a provider row — add or replace its API key without leaving
   *  the /model picker (the row hint refreshes when the save lands) */
  private async editProviderKey(providerId: string): Promise<void> {
    const info = listProviderInfos(this.host.cfg).find((p) => p.id === providerId)
    const has = info ? info.needsKey && info.hasKey : false
    const key = (await this.askHidden(`api key for ${providerId}${has ? ' — enter to keep, type to replace' : ''}`)).trim()
    if (!key) {
      this.println(dim('  — key unchanged'))
      return
    }
    this.host.settingsSave({ apiKey: { provider: providerId, key } })
    this.println(`  ${okPill()} key saved for ${providerId}`)
  }

  /** /model with no arg — FIRST pick the role (main agent · subagent · media),
   *  then provider → model. Three model jobs, three pickable models. */
  private async modelRoleFlow(): Promise<void> {
    const host = this.host
    const roles = describeModelRoles(host.cfg)
    const pick = await this.pick<string>(
      [
        {
          label: 'main agent', hint: 'the coding model', value: 'main',
          detail: `${roles[0].ref} — every run unless overridden below`,
        },
        {
          label: 'subagent', hint: 'task-tool subagents', value: 'subagent',
          detail: roles[1].set ? `${roles[1].ref} — override active` : 'same as main — pick to set a cheaper/faster model',
        },
        {
          label: 'media · vision', hint: 'screenshot & image QA', value: 'vision',
          detail: roles[2].set ? `${roles[2].ref} — override active` : 'main model when vision-capable — pick to dedicate one',
        },
        { label: 'media · audio', hint: 'reserved slot', value: 'audio', detail: 'for audio analysis when a provider supports it' },
        { label: 'media · video', hint: 'reserved slot', value: 'video', detail: 'for video analysis when a provider supports it' },
        { label: 'media · pdf', hint: 'reserved slot', value: 'pdf', detail: 'for document analysis when a provider supports it' },
      ],
      'model role — which job gets which model?',
      { footer: 'main · subagent · media (vision/audio/video/pdf) — esc cancel' },
    )
    if (!pick) return this.println(dim('  cancelled'))
    return this.modelPickerFlow(pick as 'main')
  }

  /** provider → model, saved onto the given role (default: the main agent). */
  private async modelPickerFlow(role: 'main' | 'subagent' | 'vision' | 'audio' | 'video' | 'pdf' = 'main'): Promise<void> {
    const host = this.host
    const infos = listProviderInfos(host.cfg)
    if (infos.length === 0) return this.println(red('  no providers configured'))
    const ready = infos.filter((p) => !p.needsKey || p.hasKey)
    const locked = infos.filter((p) => p.needsKey && !p.hasKey)
    const provItems: PickItem<string>[] = [
      {
        label: '+ add custom provider…', hint: 'any endpoint', value: '__add_custom__', keep: true,
        detail: 'OpenAI-compatible · Anthropic · Google — your base url, your models',
      },
      ...ready.map((p) => ({
        label: p.label,
        hint: `${!p.needsKey ? 'free' : 'key ✓'} · ${p.models.length} models${p.custom ? ' · custom' : ''}`,
        detail: `${p.id}${p.id === host.cfg.defaultProvider ? ' · current' : ''} · e edit key`,
        value: p.id,
        onEdit: () => this.editProviderKey(p.id),
      })),
      ...locked.map((p) => ({
        label: p.label,
        hint: 'needs key — e add it',
        detail: `${p.id} — add a key to unlock · e edit key`,
        value: p.id,
        onEdit: () => this.editProviderKey(p.id),
      })),
    ]
    const cur = provItems.findIndex((i) => i.value === host.cfg.defaultProvider)
    const provId = await this.pick(provItems, 'provider', {
      filterable: true,
      selected: Math.max(0, cur),
      footer: 'e edit key · type to search · esc',
    })
    if (!provId) return this.println(dim('  cancelled'))
    if (provId === '__add_custom__') return this.customProviderWizard()
    const info = infos.find((p) => p.id === provId)
    if (!info) return this.println(red(`  unknown provider "${provId}"`))
    if (info.needsKey && !info.hasKey) {
      const setKey = await this.askYesNo(`  ${bold(provId)} needs an API key — add it now?`, true)
      if (!setKey) return this.println(dim(`  cancelled — /apikey ${provId} any time`))
      const key = (await this.askHidden(`api key for ${provId}`)).trim()
      if (!key) return this.println(dim('  cancelled — empty key'))
      host.settingsSave({ apiKey: { provider: provId, key } })
      this.println(`  ${okPill()} key saved for ${provId}`)
    }
    // multi-key provider ("jadi kita adaptasiin juga /model biar bisa multi
    // apikey"): more than one named key in the drawer → pick which one feeds
    // the requests. Single-key providers skip straight to the model list.
    {
      const keys = describeProviderKeys(readGlobalConfig(), provId)
      if (keys.length > 1) {
        const kid = await this.pick(
          keys.map((k) => ({
            label: `${k.active ? green('●') : '○'} ${k.label}`,
            hint: k.active ? 'active' : 'switch to this key',
            detail: k.masked,
            value: k.id,
          })),
          `${provId} — api key`,
          { footer: 'the picked key feeds every request · manage: /config keys' },
        )
        if (kid) {
          const e = selectProviderKey(provId, kid)
          if (e) {
            // write the workspace slot too — the effective key changes NOW
            host.settingsSave({ apiKey: { provider: provId, key: e.key } })
            this.println(`  ${okPill()} ${provId} → ${bold(e.label)} ${dim('(api key)')}`)
          }
        }
      }
    }
    if (info.models.length === 0 && !info.custom) {
      const wantRefresh = await this.askYesNo(`  no cached models for ${provId} — discover now?`, true)
      if (!wantRefresh) return this.println(dim('  cancelled — try /model refresh later'))
      this.println(dim('  discovering models…'))
      await host.providersRefresh()
      const again = listProviderInfos(host.cfg).find((p) => p.id === provId)
      if (!again || again.models.length === 0) return this.println(red(`  discovery found nothing for ${provId} — /model ${provId.split('/')[0]} <model-id> to set one by hand`))
      info.models = again.models
    }
    const mcur = info.models.findIndex((m) => m.id === host.cfg.defaultModel && provId === host.cfg.defaultProvider)
    // role context for titles + the save
    const curRef =
      role === 'main'
        ? undefined
        : role === 'subagent'
          ? host.cfg.models?.subagent
          : host.cfg.models?.media?.[role]
    const overridden = role !== 'main'
    const saveRole = (provider: string, model: string) => {
      if (role === 'main') {
        host.settingsSave({ defaultProvider: provider, defaultModel: model })
        this.println(`  ${okPill()} main agent → ${bold(`${provider} · ${model}`)}`)
      } else {
        host.settingsSave({ modelRole: { role, ref: `${provider}/${model}` } })
        this.println(`  ${okPill()} ${role} → ${bold(`${provider} · ${model}`)}`)
      }
    }
    const modelId = await this.pick(
      [
        ...(overridden && curRef
          ? [{ label: '× clear override — follow the main model', hint: 'reset', value: '__clear_role__', keep: true,
              detail: `${role} currently: ${curRef}` } as { label: string; hint: string; value: string; keep?: boolean; detail?: string }]
          : []),
        ...info.models.map((m) => ({ label: m.id, hint: m.label, value: m.id })),
        {
          label: '+ custom model id…', hint: 'type any id', value: '__custom_model__', keep: true,
          detail: `for endpoints whose list is missing or wrong — saved as ${provId}/<id>`,
        },
      ],
      `${provId} — model${role === 'main' ? '' : ` (${role})`}`,
      { filterable: true, selected: Math.max(0, mcur), footer: 'type to search · esc cancel' },
    )
    if (!modelId) return this.println(dim('  cancelled'))
    if (modelId === '__clear_role__') {
      host.settingsSave({ modelRole: { role: role as never, ref: '' } })
      return this.println(`  ${okPill()} ${role} → follows the main model again`)
    }
    if (modelId === '__custom_model__') {
      const custom = (await this.ask(`model id for ${provId} (e.g. llama3.1, gemini-2.0-flash)`))?.trim()
      if (!custom) return this.println(dim('  cancelled'))
      // persist into a custom provider's list so the picker learns it
      const cp = host.cfg.customProviders?.find((p) => p.id === provId)
      if (cp && !(cp.models ?? []).includes(custom)) {
        host.settingsSave({ customProvider: { ...cp, models: [...(cp.models ?? []), custom] } })
      }
      saveRole(provId, custom)
      return
    }
    saveRole(provId, modelId)
  }

  /**
   * The custom-provider wizard — any OpenAI-compatible / Anthropic / Google
   * endpoint (ollama, lm studio, openrouter proxies, self-hosted gateways…).
   * Reachable from /model custom, the "+ add custom provider…" picker entry,
   * and it stays visible when a picker search comes up empty.
   */
  private async customProviderWizard(): Promise<void> {
    const host = this.host
    this.println(bold('  add a custom provider'))
    this.println(dim('    works with ollama, lm studio, openrouter, any /chat/completions endpoint'))
    const label = (await this.ask('label — how it shows in lists (e.g. "My Ollama")'))?.trim()
    if (!label) return this.println(dim('  cancelled'))
    const baseUrl = (await this.ask('base url (e.g. http://localhost:11434/v1)'))?.trim()
    if (!baseUrl) return this.println(dim('  cancelled — a base url is required'))
    const kind = await this.pick<{ kind: 'openai' | 'anthropic' | 'google' }>(
      [
        { label: 'openai-compatible', hint: '/chat/completions — ollama · lm studio · vllm · most providers', value: { kind: 'openai' as const } },
        { label: 'anthropic', hint: '/v1/messages — claude-style endpoints', value: { kind: 'anthropic' as const } },
        { label: 'google', hint: 'gemini generateContent endpoints', value: { kind: 'google' as const } },
      ],
      'api kind',
      { maxVisible: 3 },
    )
    if (!kind) return this.println(dim('  cancelled'))
    const apiKey = (await this.askHidden('api key — enter to skip (local endpoints usually need none)')).trim()
    const modelsRaw = (await this.ask('models, comma separated (e.g. llama3.1, qwen2.5)')) ?? ''
    const models = modelsRaw.split(/[,\s]+/).map((m) => m.trim()).filter(Boolean)
    // unique id: slug of the label, suffixed when taken
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom'
    const taken = new Set<string>([
      ...(host.cfg.customProviders ?? []).map((p) => p.id),
      ...listProviderInfos(host.cfg).map((p) => p.id),
    ])
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    const r = host.settingsSave({
      customProvider: { id, label, baseUrl, kind: kind.kind, apiKey: apiKey || undefined, models },
      defaultProvider: id,
      defaultModel: models[0] ?? '',
    })
    if ('error' in r && r.error) return this.println(`  ${errPill()} ${red(`${r.error}`)}`)
    this.println(`  ${okPill()} ${label} (${id}) saved and selected`)
    if (models[0]) {
      this.println(`  ${okPill()} ${id} · ${models[0]}`)
    } else {
      this.println(`  ${warnPill()} ${yellow(`no models yet — /model to pick one, or /model ${id} <model-id>`)}`)
    }
    this.println(dim(`    manage later: /model · failover: /fallback add ${id} <model> [key]`))
  }

  /** mode switch banner — tells the user (and the next prompt run) what the job is */
  private printModeBanner(mode: AgentMode): void {
    this.mode = mode
    if (mode === 'plan') {
      this.println(`  ${okPill()} mode: plan — read-only`)
      this.println(dim('    the agent investigates, INTERVIEWS you for missing detail, then delivers a plan'))
      this.println(dim('    approving the plan writes PRD.md and switches to build automatically'))
    } else if (mode === 'test') {
      this.println(`  ${okPill()} mode: test — QA agent`)
      this.println(dim('    the agent runs the project (serve), clicks through it (browser), screenshots + audits'))
      this.println(dim('    responsive (mobile/tablet/desktop) and visuals — then writes TEST-REPORT.md'))
      this.println(dim('    read-only for source files · playwright needed: bun add playwright && bunx playwright install chromium'))
    } else {
      this.println(`  ${okPill()} mode: build — full write access`)
      this.println(dim('    the agent reads PRD.md first when present, implements, and verifies its work'))
    }
  }

  /* ---------------- MCP manager (/mcp) ---------------- */

  private async mcpManager(arg: string) {
    const host = this.host
    const sub = arg.split(/\s+/)[0]

    if (sub === 'list') return this.mcpPrintStatus()

    // interactive dashboard
    for (;;) {
      const status = host.mcpStatus()
      const actions: PickItem<string>[] = []
      for (const s of status) {
        const state =
          s.state === 'ready' ? green(`${s.tools} tools ✓`)
          : s.state === 'error' ? red('error')
          : s.state === 'disabled' ? dim('off')
          : yellow('connecting')
        actions.push({
          label: s.name,
          hint: String(state),
          detail: s.error
            ? `${red(s.error.slice(0, 130))}${s.hint ? ` ${yellow(`→ ${s.hint.slice(0, 100)}`)}` : ''}`
            : s.note
              ? yellow(s.note)
              : s.command.slice(0, 70),
          value: `server:${s.name}`,
        })
      }
      actions.push({ label: '+ add from template', hint: 'context7 · memory · filesystem…', value: 'template', detail: 'one-click known servers' })
      actions.push({ label: '+ add custom', hint: 'command + args', value: 'custom', detail: 'any stdio MCP server' })
      if (status.length > 0) actions.push({ label: 'reload', hint: 'restart every server', value: 'reload' })
      actions.push({ label: 'done', hint: 'esc', value: 'done' })

      const pick = await this.pick(actions, 'MCP servers', {
        footer: status.some((s) => s.state === 'ready')
          ? `${status.filter((s) => s.state === 'ready').reduce((n, s) => n + s.tools, 0)} live tools`
          : 'tools appear as mcp_<server>_<tool>',
      })
      if (!pick || pick === 'done') return

      if (pick === 'template') {
        const templates = host.mcpTemplates()
        const t = await this.pick(
          templates.map((tpl) => ({ label: tpl.label, hint: tpl.name, detail: `${tpl.command} ${tpl.args.join(' ')} — ${tpl.note}`, value: tpl.name })),
          'add server — templates',
          { filterable: true },
        )
        if (!t) continue
        const tpl = templates.find((x) => x.name === t)!
        this.println(dim(`  starting ${tpl.name} (${tpl.command} ${tpl.args.join(' ')})…`))
        const r = await host.mcpSave({ name: tpl.name, command: tpl.command, args: tpl.args })
        if (r.error) this.println(`  ${errPill()} ${red(`${r.error}`)}`)
        else this.println(`  ${okPill()} ${tpl.name} added — see status`)
        continue
      }

      if (pick === 'custom') {
        const name = ((await this.ask('server name')) ?? '').trim()
        if (!name) { this.println(dim('  cancelled')); continue }
        const command = ((await this.ask('command (e.g. npx / uvx / node)')) ?? '').trim()
        if (!command) { this.println(dim('  cancelled')); continue }
        const rawArgs = ((await this.ask('args (space separated)')) ?? '').trim()
        const envLine = ((await this.ask('env KEY=VAL (comma separated, enter = none)')) ?? '').trim()
        const env: Record<string, string> = {}
        for (const part of envLine.split(',').map((s) => s.trim()).filter(Boolean)) {
          const [k, ...v] = part.split('=')
          if (k?.trim()) env[k.trim()] = v.join('=').trim()
        }
        this.println(dim(`  starting ${name}…`))
        const r = await host.mcpSave({
          name, command, args: rawArgs ? rawArgs.split(/\s+/) : [], env: Object.keys(env).length ? env : undefined,
        })
        if (r.error) this.println(`  ${errPill()} ${red(`${r.error}`)}`)
        else this.println(`  ${okPill()} ${name} added`)
        continue
      }

      if (pick === 'reload') {
        this.println(dim('  restarting MCP servers…'))
        await host.mcpEnsure()
        this.mcpPrintStatus()
        continue
      }

      if (pick.startsWith('server:')) {
        const name = pick.slice(7)
        const act = await this.pick(
          [
            { label: 'toggle enabled', hint: 'temporarily off', value: 'toggle' },
            { label: 'remove', hint: 'delete from config', value: 'remove' },
            { label: 'back', value: 'back' },
          ],
          name,
        )
        if (!act || act === 'back') continue
        if (act === 'toggle') {
          const r = await host.mcpToggle(name)
          if (r.error) this.println(`  ${errPill()} ${red(`${r.error}`)}`)
          else this.println(`  ${okPill()} ${name} ${r.enabled ? 'enabled' : 'disabled'}`)
        } else {
          const sure = await this.askYesNo(`  remove ${bold(name)}?`, true)
          if (!sure) continue
          const r = await host.mcpRemove(name)
          if (r.error) this.println(`  ${errPill()} ${red(`${r.error}`)}`)
          else this.println(`  ${okPill()} ${name} removed`)
        }
        continue
      }
    }
  }

  private mcpPrintStatus() {
    const status = this.host.mcpStatus()
    if (status.length === 0) {
      this.println(dim('  no MCP servers — /mcp to add one'))
      return
    }
    this.println(`  ${chip('🔌 MCP', 'red')} ${bold(`servers (${status.length})`)}`)
    for (const s of status) {
      // v0.23.1 — the state rides a chip (green ready / red error /
      // yellow connecting / dim off), padded to one column so the names align
      const label = s.state === 'ready' ? 'ready ✓' : s.state === 'disabled' ? 'off' : s.state
      const slot: BadgeSlot = s.state === 'ready' ? 'green' : s.state === 'error' ? 'red' : s.state === 'disabled' ? 'dim' : 'yellow'
      this.println(`    ${padCol(chip(label, slot), 13)} ${bold(padCol(s.name, 16))} ${dim(`· ${s.tools} tools`)}${s.enabled === false ? dim(' (disabled)') : ''}`)
      if (s.error) this.println(`       ${red(s.error.slice(0, 120))}`)
      if (s.hint) this.println(`       ${yellow(`→ ${s.hint}`)}`)
    }
    this.println(dim('    tools: mcp_<server>_<tool> · permissions: /allow mcp_<server> · manage: /mcp'))
  }

  /* ---------------- repo manager (/repo) ---------------- */

  /** /repo — the project-sync cockpit: auto-sync on/off + interval, the
   *  encrypted settings vault (api keys / providers / mcp / memory), the
   *  device passphrase, and a one-shot "sync now". Settings live in
   *  .tagent-sync/repo.json INSIDE the project — every device agrees. */
  private async repoManager(arg: string) {
    const host = this.host
    const sub = arg.split(/\s+/)[0]?.trim() ?? ''
    const rest = arg.slice(sub.length).trim()

    // quick args first — scriptable without the menu
    if (sub === 'on' || sub === 'off') {
      const s = readSyncSettings(host.root)
      writeSyncSettings(host.root, { ...s, auto: sub === 'on' })
      this.syncEngineRestart()
      return this.println(sub === 'on'
        ? `  ${okPill()} auto-sync on (every ${Math.round(readSyncSettings(host.root).intervalMs / 1000)}s)`
        : dim('  auto-sync off — /push still works any time'))
    }
    if (sub === 'interval' || sub === 'every') {
      const secs = Number(rest)
      if (!secs || secs < 5) return this.println(dim('  usage: /repo interval <seconds≥5>'))
      const s = readSyncSettings(host.root)
      writeSyncSettings(host.root, { ...s, intervalMs: secs * 1000 })
      this.syncEngineRestart()
      return this.println(`  ${okPill()} sync interval → every ${secs}s`)
    }
    if (sub === 'sync' || sub === 'now') {
      return this.repoSyncNow()
    }
    if (sub === 'status' || sub === 'info') {
      return this.repoStatus()
    }
    if (sub === 'passphrase') {
      return this.repoPassphraseFlow()
    }

    // interactive dashboard
    for (;;) {
      const s = readSyncSettings(host.root)
      const linked = getLinkedProject(host.root)
      const logged = authStatus().logged || !!host.cfg?.github?.token
      const eng = this.sync?.status()

      const vaultItems: PickItem<string>[] = [
        { label: `${s.vault.apiKeys ? green('☑') : '☐'} api keys`, hint: 'provider keys, encrypted', value: 'v:apiKeys' },
        { label: `${s.vault.customProviders ? green('☑') : '☐'} custom providers`, hint: 'endpoints + their keys', value: 'v:customProviders' },
        { label: `${s.vault.mcp ? green('☑') : '☐'} mcp servers`, hint: 'server defs + env', value: 'v:mcp' },
        { label: `${s.vault.memory ? green('☑') : '☐'} memory`, hint: 'saved facts', value: 'v:memory' },
      ]

      const actions: PickItem<string>[] = [
        {
          label: `${s.auto ? green('⦿ auto-sync: on') : '○ auto-sync: off'}${linked ? '' : yellow('  (not linked yet)')}`,
          hint: `every ${Math.round(s.intervalMs / 1000)}s · push + pull`,
          value: 'auto',
        },
        { label: 'interval', hint: `every ${Math.round(s.intervalMs / 1000)}s → change`, value: 'interval' },
        ...vaultItems,
        { label: 'passphrase', hint: getVaultPassphrase() ? 'saved on this device → rotate' : 'set this device\'s passphrase', value: 'pass' },
        { label: 'sync now', hint: 'one full round, right away', value: 'sync' },
        { label: 'status', hint: 'link · devices · sync history', value: 'status' },
      ]
      if (linked) actions.push({ label: 'unlink', hint: `forget ${linked.repo} on this device`, value: 'unlink' })
      actions.push({ label: 'done', hint: 'esc', value: 'done' })

      const lastSync = eng?.lastSyncAt ? ` · last ${fmtWhen(eng.lastSyncAt)}` : ''
      const errs = eng?.lastError ? red(` · ${eng.lastError.slice(0, 50)}`) : ''
      const pick = await this.pick(actions, 'repo sync', {
        footer: `${linked ? linked.repo : 'not linked'}${lastSync}${errs}${s.auto && eng?.running ? green(` · running ⇅${Math.round(eng.intervalMs / 1000)}s`) : ''}`,
      })
      if (!pick || pick === 'done') return

      if (pick === 'auto') {
        if (!linked && !logged) {
          this.println(yellow('  link this project first — /auth then /push'))
          continue
        }
        writeSyncSettings(host.root, { ...s, auto: !s.auto })
        this.syncEngineRestart()
        this.println(s.auto
          ? dim('  auto-sync off — /push still works any time')
          : `  ${okPill()} auto-sync on — every ${Math.round(readSyncSettings(host.root).intervalMs / 1000)}s`)
        continue
      }

      if (pick === 'interval') {
        const opts: { label: string; value: number }[] = [
          { label: '5s', value: 5000 }, { label: '10s', value: 10000 },
          { label: '15s', value: 15000 }, { label: '30s', value: 30000 },
          { label: '60s', value: 60000 }, { label: '5m', value: 300000 },
          { label: 'custom…', value: -1 },
        ]
        const t = await this.pick(
          opts.map((o) => ({ label: o.label, hint: o.value === s.intervalMs ? green('current') : '', value: o.value })),
          'sync interval',
          { selected: Math.max(0, opts.findIndex((o) => o.value === s.intervalMs)) },
        )
        let ms = t
        if (t === undefined) continue
        if (t === -1) {
          const raw = (await this.ask('interval in seconds (5-3600)')) ?? ''
          const secs = Number(raw.trim())
          if (!secs || secs < 5) { this.println(dim('  cancelled')); continue }
          ms = Math.min(secs * 1000, 3_600_000)
        }
        if (!ms) continue
        writeSyncSettings(host.root, { ...s, intervalMs: ms })
        this.syncEngineRestart()
        this.println(`  ${okPill()} sync interval → every ${Math.round(ms / 1000)}s`)
        continue
      }

      if (pick.startsWith('v:')) {
        const key = pick.slice(2) as keyof typeof s.vault
        writeSyncSettings(host.root, { ...s, vault: { ...s.vault, [key]: !s.vault[key] } })
        this.syncEngineRestart()
        continue
      }

      if (pick === 'pass') {
        await this.repoPassphraseFlow()
        continue
      }

      if (pick === 'sync') {
        await this.repoSyncNow()
        continue
      }

      if (pick === 'status') {
        this.repoStatus()
        continue
      }

      if (pick === 'unlink') {
        const sure = await this.askYesNo(`  unlink ${bold(linked!.repo)}? (files stay, auto-sync stops)`, true)
        if (!sure) continue
        try {
          unlinkProject(host.root)
        } catch { /* ignore */ }
        this.syncEngineRestart()
        this.refreshSyncBadge()
        this.println(`  ${okPill()} unlinked — /push links it again any time`)
        continue
      }
    }
  }

  /** /repo status — the detailed card: link, engine, last round, devices
   *  online, vault state and the per-project sync history timeline. */
  private repoStatus(): void {
    const host = this.host
    const s = readSyncSettings(host.root)
    const linked = getLinkedProject(host.root)
    const eng = this.syncStatus()
    const others = (() => {
      try {
        return onlineOthers(host.root)
      } catch {
        return []
      }
    })()
    const hist = readSyncHistory(host.root, 14)

    this.println(`  ${chip('⎇ sync', 'cyan')} ${bold('repo — status')}`)
    this.println(
      `    ${dim('project')}   ${bold(path.basename(host.root))} ${dim(host.root)}`,
    )
    this.println(
      `    ${dim('link')}      ${linked ? `${bold(linked.repo)} ${dim(`· linked ${fmtWhen(linked.linkedAt)}`)}` : yellow('not linked — /auth then /push')}`,
      )
    this.println(
      `    ${dim('engine')}    ${s.auto ? green('auto on') : 'auto off'} ${dim(`· every ${Math.round(s.intervalMs / 1000)}s`)} · ${eng?.running ? green('running') : dim('stopped')}`,
    )
    if (eng?.lastSyncAt) {
      this.println(
        `    ${dim('last')}      ${eng.lastAction === 'pulled' ? cyan('↓ pulled') : green('↑ pushed')} ${dim(fmtWhen(eng.lastSyncAt))}` +
          (eng.lastError ? ` ${red(`· ${truncateStyled(eng.lastError, 50)}`)}` : ''),
      )
    } else if (eng?.lastError) {
      this.println(`    ${dim('error')}     ${red(truncateStyled(eng.lastError, 64))}`)
    }
    this.println(
      `    ${dim('devices')}   ${
        others.length
          ? others.map((d) => `${green('◉')} ${bold(d.name)} ${dim(fmtWhen(d.at))}`).join(dim(' · '))
          : dim('just this device')
      } ${dim(`· heartbeat every ${Math.round(PRESENCE_EVERY_MS / 1000)}s`)}`,
    )
    const v = s.vault
    this.println(
      `    ${dim('vault')}     ${v.apiKeys ? green('☑') : '☐'} api keys · ${v.customProviders ? green('☑') : '☐'} providers · ${v.mcp ? green('☑') : '☐'} mcp · ${v.memory ? green('☑') : '☐'} memory ${getVaultPassphrase() ? green('· passphrase saved') : yellow('· no passphrase on this device')}`,
    )
    if (hist.length === 0) {
      this.println(`    ${dim('history')}   ${dim('nothing recorded yet')}`)
    } else {
      this.println(`    ${dim('history')}   ${dim(`last ${hist.length} round${hist.length === 1 ? '' : 's'} (newest first)`)}`)
      for (const h of hist.slice(0, 14)) {
        // v0.23.1 — the action rides a chip: green push, cyan pull, red error
        const slot: BadgeSlot = h.action === 'pushed' ? 'green' : h.action === 'pulled' ? 'cyan' : h.action === 'error' ? 'red' : 'blue'
        const at = new Date(h.at)
        const hhmmss = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}:${String(at.getSeconds()).padStart(2, '0')}`
        this.println(
          `      ${dim(hhmmss)} ${padCol(chip(h.action, slot), 12)} ${dim(truncateStyled(h.detail, 56))}${h.commit ? dim(` · ${h.commit.slice(0, 7)}`) : ''}`,
        )
      }
    }
    this.println(dim('    settings: /repo · history per device — .tagent/sync-history.json (gitignored)'))
  }

  /** one full sync round right now (dirty or not). */
  private async repoSyncNow(): Promise<void> {
    const host = this.host
    const token = getCredential('github') || host.cfg?.github?.token || readGlobalConfig().github?.token
    if (!token) return this.println(red('  not logged in — /auth first (or run `tagent auth`)'))
    this.println(dim('  syncing…'))
    try {
      const r = await syncProject(host.root, host.cfg, {
        message: `sync: manual ${new Date().toISOString().slice(11, 19)}`,
        onLog: (l) => this.println(dim(`  ${l}`)),
      })
      recordSyncHistory(host.root, { action: 'pushed', detail: 'manual — /repo sync', repo: r.repo, commit: r.commit })
      this.println(`  ${pushPill()} ${bold(`to ${r.repo}`)} ${dim(`(${r.commit})`)}`)
      this.refreshSyncBadge()
    } catch (e) {
      recordSyncHistory(host.root, { action: 'error', detail: `manual — ${(e as Error).message ?? e}` })
      this.refreshSyncBadge()
      this.println(`  ${errPill()} ${red((e as Error).message)}`)
    }
  }

  /** set / rotate this device's vault passphrase. Rotating re-seals the
   *  project vault with the new passphrase (decrypt with the old key first),
   *  so every other device picks up the change on its next pull. */
  private async repoPassphraseFlow(): Promise<void> {
    const host = this.host
    const old = getVaultPassphrase()
    const a = await this.ask(old ? 'new passphrase (empty = keep)' : 'passphrase for this project\'s shared settings', { masked: true })
    if (a === undefined) return this.println(dim('  cancelled'))
    const next = a.trim()
    if (!next) return this.println(dim('  unchanged'))
    const b = await this.ask('repeat passphrase', { masked: true })
    if ((b ?? '').trim() !== next) return this.println(`  ${errPill()} ${red(`passphrases differ — nothing changed`)}`)

    // an existing vault this device could open gets re-sealed NOW so the
    // new passphrase travels with the next sync tick
    const vaultPath = path.join(host.root, '.tagent-sync', 'vault.json')
    let resealed = false
    if (fs.existsSync(vaultPath) && old) {
      try {
        const { decryptVaultJSON, encryptVaultJSON, parseVaultFile } = await import('@tagent/core')
        const raw = JSON.parse(fs.readFileSync(vaultPath, 'utf8'))
        const vault = parseVaultFile(raw)
        if (vault) {
          const payload = decryptVaultJSON(vault, old)
          fs.writeFileSync(vaultPath, JSON.stringify(encryptVaultJSON(payload, next), null, 2))
          resealed = true
        }
      } catch (e) {
        return this.println(`  ${errPill()} ${red(`could not re-seal the vault: ${(e as Error).message}`)}`)
      }
    }
    setVaultPassphrase(next)
    this.println(`  ${okPill()} passphrase saved on this device`)
    if (resealed) this.println(dim('    vault re-encrypted — other devices need the new passphrase'))
    else this.println(dim('    the vault is (re)encrypted on the next sync tick'))
  }

  /** apply current sync settings to the live engine (start/stop/restart). */
  private syncEngineRestart(): void {
    try {
      if (!this.sync) {
        // starting lazily (e.g. first link) — the same gating as boot
        return this.startSyncEngine()
      }
      const s = readSyncSettings(this.host.root)
      if (!s.auto) {
        this.sync.stop()
        this.println(dim('  engine stopped'))
        return
      }
      this.sync.restart()
    } catch {
      /* settings I/O must never crash the TUI */
    }
  }

  /* ---------------- plugin manager (/plugins) ---------------- */

  private async pluginManager(arg: string) {
    const host = this.host
    const sub = arg.split(/\s+/)[0]

    if (sub === 'new' || sub === 'create' || sub === 'scaffold') {
      let name = arg.split(/\s+/).slice(1).join(' ').trim()
      if (!name) name = ((await this.ask('plugin name')) ?? '').trim()
      if (!name) return this.println(dim('  cancelled'))
      const r = host.pluginScaffold(name)
      this.println(`  ${okPill()} scaffold created`)
      this.println(`    ${dim(r.file)}`)
      this.println(dim('    edit it, then just run — plugins hot-reload each turn'))
      return
    }

    for (;;) {
      const plugins = host.pluginsList()
      const cmds = await host.pluginCommandList()
      const items: PickItem<string>[] = plugins.map((p) => ({
        label: p.name,
        hint: p.scope,
        detail: p.file,
        value: `info:${p.name}`,
      }))
      items.push({ label: '+ new plugin', hint: 'scaffold in .tagent/plugins/', value: 'new', detail: 'tools + hooks + commands template' })
      if (plugins.length > 0) items.push({ label: 'reload', hint: 'plugins reload each turn', value: 'reload' })
      items.push({ label: 'done', hint: 'esc', value: 'done' })

      const pick = await this.pick(items, 'plugins', {
        footer: cmds.length ? `${cmds.length} custom command(s)` : 'export commands → /<name>',
      })
      if (!pick || pick === 'done') return

      if (pick === 'new') {
        const name = ((await this.ask('plugin name')) ?? '').trim()
        if (!name) continue
        const r = host.pluginScaffold(name)
        this.println(`  ${okPill()} scaffold created`)
        this.println(`    ${dim(r.file)}`)
        continue
      }
      if (pick === 'reload') {
        this.println(dim('  plugins reload on the next message — no action needed'))
        continue
      }
      if (pick.startsWith('info:')) {
        const name = pick.slice(5)
        const p = plugins.find((x) => x.name === name)
        if (!p) continue
        this.println(bold(`  ${p.name}`) + dim(` · ${p.scope} · ${path.basename(p.file)}`))
        this.println(`    ${dim(p.file)}`)
        const pc = cmds.filter((c) => c.plugin === name)
        if (pc.length) this.println(`    commands: ${pc.map((c) => '/' + c.name).join(' · ')}`)
        const open = await this.askYesNo('  open the file? (first 40 lines)', false)
        if (open) {
          try {
            const rel = path.relative(host.root, p.file)
            const r = host.fileRead(rel) as { content?: string }
            for (const [i, l] of (r.content ?? '').split('\n').slice(0, 40).entries()) {
              this.println(`  ${dim(String(i + 1).padStart(3))} ${l}`)
            }
          } catch { this.println(red('  could not read the file')) }
        }
        continue
      }
    }
  }

  /* ---------------- config manager (/config) ---------------- */

  /**
   * /config — the GLOBAL config cockpit: "ini config keseluruhan, bukan
   * provider/mcp doang". Everything here reads/writes ~/.tagent/config.json
   * (the config-repo layer), not the workspace one:
   *   add mcp / provider / api keys (multi!) · pick the default model ·
   *   push/pull the encrypted tagent-config repo across devices.
   */
  private async configManager(arg: string) {
    const sub = arg.split(/\s+/)[0]?.trim() ?? ''
    const rest = arg.slice(sub.length).trim()

    if (sub === 'push') return this.configPushFlow()
    if (sub === 'pull') return this.configPullFlow()
    if (sub === 'status') return this.configStatus()
    if (sub === 'add' || sub === 'new') return this.configAddFlow(rest)
    if (sub === 'apply' || sub === 'use') return this.configApplyFlow(rest)
    if (sub === 'fallback' || sub === 'failover') return this.configFallbackFlow(rest)
    if (sub === 'keys' || sub === 'key') return this.configKeysFlow(rest)
    if (sub === 'subs' || sub === 'subagents') return this.configSubsFlow(rest)

    // interactive dashboard — the add/apply template
    for (;;) {
      const g = readGlobalConfig()
      const st = readConfigSyncState()
      const logged = authStatus().logged || !!getCredential('github')
      const keyN = (g.keychain ?? []).length
      const mcpN = Object.keys(g.mcp?.servers ?? {}).length
      const limits = this.host.subagentLimits()
      const roles = describeModelRoles(this.host.cfg)
      const actions: PickItem<string>[] = [
        {
          label: '+ add',
          hint: 'mcp · provider+key+models · api key',
          value: 'add',
          detail: 'a template you add once, then apply anywhere',
        },
        {
          label: '⚡ apply',
          hint: 'a provider/model → main · subagent · vision',
          value: 'apply',
          detail: `main ${roles[0].ref} · sub ${roles[1].ref} · vision ${roles[2].ref}`,
        },
        {
          label: '⛓ fallback',
          hint: '3 failover chains: main · sub · vision',
          value: 'fallback',
          detail: 'what each lane fails over to, in order',
        },
        {
          label: `🤖 subs ${yellow(`· ${limits.running}/${limits.maxParallel}`)}`,
          hint: 'background subagents — parallel limit',
          value: 'subs',
          detail: `max running at once (now ${limits.maxParallel})`,
        },
        {
          label: `🔑 api keys ${keyN ? yellow(`· ${keyN} named`) : ''}`,
          hint: 'multi-key per provider — pick / fallback',
          value: 'keys',
          detail: 'add, select the active key, stack as fallback',
        },
        {
          label: `${st.repo ? green('⎇ sync ok') : yellow('⎇ sync —')} ${st.repo ?? CONFIG_REPO_NAME}`,
          hint: logged ? 'push · pull · health' : 'login first (/auth)',
          value: 'sync',
          detail: `push ${st.lastPushAt ? fmtWhen(st.lastPushAt) : '—'} · pull ${st.lastPullAt ? fmtWhen(st.lastPullAt) : '—'}`,
        },
        { label: 'done', hint: 'esc', value: 'done' },
      ]
      const pick = await this.pick(actions, 'global config — add · apply', {
        footer: `~/.tagent/config.json${mcpN ? ` · ${mcpN} global mcp` : ''}${keyN ? ` · ${keyN} keys` : ''}`,
      })
      if (!pick || pick === 'done') return
      if (pick === 'add') { await this.configAddFlow(''); continue }
      if (pick === 'apply') { await this.configApplyFlow(''); continue }
      if (pick === 'fallback') { await this.configFallbackFlow(''); continue }
      if (pick === 'subs') { await this.configSubsFlow(''); continue }
      if (pick === 'keys') { await this.configKeysFlow(''); continue }
      if (pick === 'sync') {
        const act = await this.pick(
          [
            { label: 'status', hint: 'repo health', value: 'status' },
            { label: '↑ push', hint: 'this device → every device', value: 'push' },
            { label: '↓ pull', hint: 'every device → this device', value: 'pull' },
          ],
          'config sync',
        )
        if (act === 'status') await this.configStatus()
        else if (act === 'push') await this.configPushFlow()
        else if (act === 'pull') await this.configPullFlow()
        continue
      }
    }
  }

  /** /config apply [provider[/model]] — put a provider+model to WORK:
   *  as the main model, the subagent model, or the vision model. */
  private async configApplyFlow(rest: string): Promise<void> {
    const host = this.host
    const infos = listProviderInfos(host.cfg).filter((p) => !p.needsKey || p.hasKey)
    if (!infos.length) {
      return this.println(yellow('  no providers ready — /config add provider, or /apikey <provider>'))
    }
    // pick the provider (arg or interactive)
    let provId = rest.split(/\s+/)[0] ?? ''
    let modelId = rest.split(/\s+/)[1] ?? ''
    const parsed = provId.includes('/') ? parseModelRef(rest, host.cfg) : undefined
    if (parsed) {
      provId = parsed.provider
      modelId = modelId || parsed.model
    }
    if (!provId || !infos.some((p) => p.id === provId)) {
      provId = (await this.pick(
        infos.map((p) => ({
          label: p.label,
          hint: p.hasKey ? 'key ✓' : p.needsKey ? 'no key' : 'keyless',
          detail: p.models.slice(0, 3).map((m) => m.id).join(', ') || 'no models',
          value: p.id,
        })),
        'apply — pick a provider',
        { filterable: true },
      )) ?? ''
      if (!provId) return this.println(dim('  cancelled'))
      modelId = ''
    }
    const info = infos.find((p) => p.id === provId)!
    if (!modelId || !info.models.some((m) => m.id === modelId)) {
      if (info.models.length === 0) {
        return this.println(red(`  ${provId} has no models — /model ${provId} <model-id> sets one by hand`))
      }
      modelId = (await this.pick(
        info.models.map((m) => ({ label: m.id, hint: m.vision ? 'vision ✓' : '', value: m.id })),
        `apply — ${provId} model`,
        { filterable: true },
      )) ?? ''
      if (!modelId) return this.println(dim('  cancelled'))
    }
    // pick the role this provider/model takes over
    const roles = describeModelRoles(host.cfg)
    const role = await this.pick<{ role: 'main' | 'subagent' | 'vision' }>(
      [
        { label: 'main agent', hint: 'the coding model', value: { role: 'main' as const }, detail: roles[0].ref },
        { label: 'subagent', hint: 'task-tool subagents', value: { role: 'subagent' as const }, detail: roles[1].ref },
        { label: 'vision', hint: 'screenshot & image QA', value: { role: 'vision' as const }, detail: roles[2].ref },
      ],
      `apply ${provId}/${modelId} as…`,
      { maxVisible: 3 },
    )
    if (!role) return this.println(dim('  cancelled'))
    if (role.role === 'main') {
      host.settingsSave({ defaultProvider: provId, defaultModel: modelId })
    } else {
      host.settingsSave({ modelRole: { role: role.role, ref: `${provId}/${modelId}` } })
    }
    this.println(`  ${okPill()} ${role.role} → ${bold(`${provId} · ${modelId}`)}`)
    this.println(dim('    see all roles: /model list · failover per role: /fallback'))
  }

  /** /config fallback — the 3-lane manager (thin wrapper over /fallback's view). */
  private async configFallbackFlow(rest: string): Promise<void> {
    if (rest) return this.command(`/fallback ${rest}`)
    const view = this.host.fallbackChainsView()
    for (const lane of ['main', 'subagent', 'vision'] as const) {
      this.println(bold(`  ${lane} — try top → bottom`))
      for (const [i, ch] of view.chains[lane].entries()) {
        this.println(`   ${ch.primary ? green('①') : dim(String(i + 1))} ${bold(ch.label)} ${dim(`· ${ch.model}`)}`)
      }
      this.println('')
    }
    this.println(dim('    edit: /fallback <main|subagent|vision> add <provider> <model> [apiKey] · rm <n> · clear'))
  }

  /** /config subs [n] — background subagents: the parallel limit + live view. */
  private async configSubsFlow(rest: string): Promise<void> {
    const n = Number(rest.split(/\s+/)[0] ?? '')
    if (Number.isFinite(n) && n > 0) {
      this.host.settingsSave({ subagentMaxParallel: Math.floor(n) })
      return this.println(`  ${okPill()} background subagents limit → ${bold(String(Math.floor(n)))}`)
    }
    const { maxParallel, running } = this.host.subagentLimits()
    this.println(`  ${chip('🤖 background subagents', 'blue')} ${bold(`${running} running`)} ${dim(`· limit ${maxParallel} (config subagents.maxParallel)`)}`)
    const list = this.host.backgroundSubs()
    if (list.length) {
      for (const line of renderSubsTable(list)) this.println(`    ${line}`)
    } else {
      this.println(dim('    none yet — the agent spawns them: task {"background": true, …}'))
    }
    const next = (await this.ask('new parallel limit (enter = keep)')) ?? ''
    const v = Number(next.trim())
    if (Number.isFinite(v) && v > 0) {
      this.host.settingsSave({ subagentMaxParallel: Math.floor(v) })
      this.println(`  ${okPill()} limit → ${bold(String(Math.floor(v)))}`)
    }
  }

  /** /config status — the global card: scope, repo health, keys, vault. */
  private async configStatus(): Promise<void> {
    const g = readGlobalConfig()
    const st = readConfigSyncState()
    const logged = authStatus().logged || !!getCredential('github')
    this.println(`  ${chip('⚙ config', 'blue')} ${bold('global — status')}`)
    this.println(`    ${dim('scope')}     ~/.tagent/config.json (every project, every device)`)
    this.println(`    ${dim('default')}   ${bold(g.defaultProvider)} / ${bold(g.defaultModel)}`)
    this.println(`    ${dim('repo')}     ${st.repo ? st.repo : dim(`${CONFIG_REPO_NAME} — created on the next /config push`)}`)
    if (logged && st.repo) {
      this.println(dim('    checking GitHub…'))
      const h = await checkConfigRepo()
      if (h.status === 'ok') this.println(`    ${dim('health')}   ${green('● repo exists')}${st.lastPushAt ? dim(` · last push ${fmtWhen(st.lastPushAt)}`) : ''}`)
      else if (h.status === 'missing') this.println(`    ${dim('health')}   ${red('● repo deleted on GitHub')} ${yellow('— /config push recreates it')}`)
      else this.println(`    ${dim('health')}   ${yellow('○ unreachable (offline?)')}`)
    }
    if (st.lastPushAt) this.println(`    ${dim('pushed')}   ${fmtWhen(st.lastPushAt)}`)
    if (st.lastPullAt) this.println(`    ${dim('pulled')}   ${fmtWhen(st.lastPullAt)}`)
    const chain = g.keychain ?? []
    if (chain.length) {
      const byProv = new Map<string, number>()
      for (const k of chain) byProv.set(k.provider, (byProv.get(k.provider) ?? 0) + 1)
      this.println(`    ${dim('keys')}     ${[...byProv.entries()].map(([p, n]) => `${p}(${n})`).join(dim(' · '))}`)
    }
    const mcpN = Object.keys(g.mcp?.servers ?? {}).length
    if (mcpN) this.println(`    ${dim('mcp')}      ${mcpN} global server${mcpN === 1 ? '' : 's'}`)
    const provs = (g.customProviders ?? []).length
    if (provs) this.println(`    ${dim('custom')}   ${provs} provider${provs === 1 ? '' : 's'}`)
    this.println(`    ${dim('vault')}    ${getVaultPassphrase() ? green('passphrase saved on this device') : yellow('no passphrase yet — generated on first push (/config push)')}`)
    this.println(dim('    actions: /config push · /config pull · /config add key|mcp|provider · /config keys'))
  }

  /** /config push — seal + upload the global config. Recreates a deleted repo. */
  private async configPushFlow(): Promise<void> {
    const logged = authStatus().logged || !!getCredential('github')
    if (!logged) return this.println(red('  not logged in — /auth first'))
    this.println(dim('  sealing the global config (keys, mcp, providers…)…'))
    try {
      const r = await pushConfigSync({ onLog: (l) => this.println(dim(`  ${l}`)) })
      this.println(`  ${pushPill()} ${bold(r.repo)}${r.created ? ' ' + chip('new', 'green') : ''}`)
      if (r.passphrase) {
        this.println(`  ${warnPill('vault passphrase')} ${bold(r.passphrase)}`)
        this.println(yellow('    save it — other devices need it to unlock the config (/repo passphrase)'))
      }
      this.println(dim('    every device picks this up on its next `tagent start` (or /config pull)'))
    } catch (e) {
      this.println(`  ${errPill()} ${red((e as Error).message)}`)
    }
  }

  /** /config pull — remote is the truth; per-key merge into the global config. */
  private async configPullFlow(): Promise<void> {
    const logged = authStatus().logged || !!getCredential('github')
    if (!logged) return this.println(red('  not logged in — /auth first'))
    this.println(dim('  pulling the config repo…'))
    try {
      const r = await pullConfigSync({ onLog: (l) => this.println(dim(`  ${l}`)) })
      if (r.status === 'empty') {
        return this.println(dim('  the repo has no config yet (fresh?) — /config push uploads this device\'s config'))
      }
      if (r.status === 'needs-passphrase') {
        return this.println(yellow('  🔐 the synced config is locked — set this device\'s passphrase (/repo passphrase) to unlock'))
      }
      if (r.status === 'up-to-date') {
        return this.println(`  ${okPill()} already in sync with ${r.repo}`)
      }
      this.refreshLiveConfigFromGlobal()
      this.println(`  ${pullPill()} ${bold(r.repo ?? CONFIG_REPO_NAME)} — ${r.changed.length} key${r.changed.length === 1 ? '' : 's'} moved`)
      for (const c of r.changed.slice(0, 8)) this.println(dim(`    · ${c}`))
      if (r.changed.length > 8) this.println(dim(`    … +${r.changed.length - 8} more`))
      if (r.changed.some((c) => c.startsWith('mcp:'))) this.println(dim('    mcp changed — restart tagent (or /mcp reload) to reconnect servers'))
    } catch (e) {
      this.println(`  ${errPill()} ${red((e as Error).message)}`)
    }
  }

  /** re-layer a freshly pulled global config onto the LIVE host cfg — the
   *  workspace file keeps its own overrides (loadConfig semantics). */
  private refreshLiveConfigFromGlobal(): void {
    try {
      this.host.cfg = loadConfig(this.host.root)
    } catch {
      /* never break the session over a refresh */
    }
  }

  /** /config add mcp|provider|key — the global variants. */
  private async configAddFlow(rest: string): Promise<void> {
    const what = rest.split(/\s+/)[0]?.trim() ?? ''
    if (!what || !['mcp', 'provider', 'key'].includes(what)) {
      const pick = await this.pick(
        [
          { label: 'mcp server', hint: 'global — every project', value: 'mcp' },
          { label: 'custom provider', hint: 'endpoint + models', value: 'provider' },
          { label: 'api key', hint: 'named, multi per provider', value: 'key' },
        ],
        'add to the global config',
      )
      if (!pick) return this.println(dim('  cancelled'))
      return this.configAddFlow(pick)
    }
    if (what === 'mcp') return this.configAddMcpFlow()
    if (what === 'provider') return this.configAddProviderFlow()
    return this.configAddKeyFlow()
  }

  /** add a GLOBAL mcp server — hot-loads here too, travels via the config repo. */
  private async configAddMcpFlow(): Promise<void> {
    const host = this.host
    const templates = host.mcpTemplates()
    const mode = await this.pick(
      [
        { label: 'from template', hint: 'context7 · memory · filesystem…', value: 'tpl' },
        { label: 'custom', hint: 'command + args', value: 'custom' },
      ],
      'add mcp — global',
    )
    if (!mode) return this.println(dim('  cancelled'))
    let name = ''
    let server: { command: string; args?: string[]; env?: Record<string, string> } | undefined
    if (mode === 'tpl') {
      const t = await this.pick(
        templates.map((tpl) => ({ label: tpl.label, hint: tpl.name, detail: `${tpl.command} ${tpl.args.join(' ')} — ${tpl.note}`, value: tpl.name })),
        'add server — templates',
        { filterable: true },
      )
      if (!t) return this.println(dim('  cancelled'))
      const tpl = templates.find((x) => x.name === t)!
      name = tpl.name
      server = { command: tpl.command, args: tpl.args }
    } else {
      name = ((await this.ask('server name')) ?? '').trim()
      if (!name) return this.println(dim('  cancelled'))
      const command = ((await this.ask('command (e.g. npx / uvx / node)')) ?? '').trim()
      if (!command) return this.println(dim('  cancelled'))
      const rawArgs = ((await this.ask('args (space separated)')) ?? '').trim()
      const envLine = ((await this.ask('env KEY=VAL (comma separated, enter = none)')) ?? '').trim()
      const env: Record<string, string> = {}
      for (const part of envLine.split(',').map((s) => s.trim()).filter(Boolean)) {
        const [k, ...v] = part.split('=')
        if (k?.trim()) env[k.trim()] = v.join('=').trim()
      }
      server = { command, args: rawArgs ? rawArgs.split(/\s+/) : [], ...(Object.keys(env).length ? { env } : {}) }
    }
    // validate by starting it HERE (the battle-tested path), then mirror the
    // definition into the GLOBAL config so it travels with /config push
    this.println(dim(`  starting ${name}…`))
    const r = await host.mcpSave({ name, command: server.command, args: server.args, env: server.env })
    if (r.error) return this.println(`  ${errPill()} ${red(`${r.error}`)}`)
    const g = readGlobalConfig()
    updateGlobalConfig({
      mcp: {
        ...(g.mcp ?? {}),
        servers: {
          ...(g.mcp?.servers ?? {}),
          [name]: { command: server.command, ...(server.args?.length ? { args: server.args } : {}), ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}) },
        },
      },
    })
    this.println(`  ${okPill()} ${name} — global (every project) + active here`)
    this.println(dim('    travels to every device: /config push'))
  }

  /** add a GLOBAL custom provider (mirrors the wizard, writes global). */
  private async configAddProviderFlow(): Promise<void> {
    this.println(bold('  add a custom provider — global'))
    const label = (await this.ask('label — how it shows in lists (e.g. "My Ollama")'))?.trim()
    if (!label) return this.println(dim('  cancelled'))
    const baseUrl = (await this.ask('base url (e.g. http://localhost:11434/v1)'))?.trim()
    if (!baseUrl) return this.println(dim('  cancelled — a base url is required'))
    const kind = await this.pick<{ kind: 'openai' | 'anthropic' | 'google' }>(
      [
        { label: 'openai-compatible', hint: '/chat/completions — ollama · lm studio · vllm · most providers', value: { kind: 'openai' as const } },
        { label: 'anthropic', hint: '/v1/messages — claude-style endpoints', value: { kind: 'anthropic' as const } },
        { label: 'google', hint: 'gemini generateContent endpoints', value: { kind: 'google' as const } },
      ],
      'api kind',
      { maxVisible: 3 },
    )
    if (!kind) return this.println(dim('  cancelled'))
    const apiKey = (await this.askHidden('api key — enter to skip (local endpoints usually need none)')).trim()
    const modelsRaw = (await this.ask('models, comma separated (e.g. llama3.1, qwen2.5)')) ?? ''
    const models = modelsRaw.split(/[,\s]+/).map((m) => m.trim()).filter(Boolean)
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom'
    const g = readGlobalConfig()
    const taken = new Set<string>([
      ...(g.customProviders ?? []).map((p) => p.id),
      ...listProviderInfos(this.host.cfg).map((p) => p.id),
    ])
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    const entry = { id, label, baseUrl, kind: kind.kind, ...(apiKey ? { apiKey } : {}), models }
    updateGlobalConfig({ customProviders: [...(g.customProviders ?? []), entry] })
    this.println(`  ${okPill()} ${label} (${id}) — global`)
    this.println(dim(`    use it: /model ${id}${models[0] ? `/${models[0]}` : ' <model-id>'} · travels: /config push`))
  }

  /** add a named api key (multi-key per provider) to the GLOBAL keychain. */
  private async configAddKeyFlow(): Promise<void> {
    const infos = listProviderInfos(this.host.cfg)
    const prov = (await this.pick(
      infos.map((p) => ({
        label: p.label,
        hint: p.needsKey ? (p.hasKey ? 'key ✓' : 'no key') : 'keyless',
        detail: p.id,
        value: p.id,
      })),
      'provider — add an api key',
      { filterable: true },
    )) ?? ''
    if (!prov) return this.println(dim('  cancelled'))
    const mine = listProviderKeys(readGlobalConfig(), prov)
    if (mine.length) {
      for (const k of describeProviderKeys(readGlobalConfig(), prov)) {
        this.println(dim(`    ${k.active ? green('●') : '○'} ${k.label} ${dim(k.masked)}`))
      }
    }
    const label = ((await this.ask(`label (e.g. ${mine.length ? '"backup"' : '"work"'})`)) ?? '').trim() || 'key'
    const key = (await this.askHidden(`api key for ${prov}`)).trim()
    if (!key) return this.println(dim('  cancelled — empty key'))
    const r = addProviderKey(prov, label, key)
    if (r.duplicate) {
      return this.println(`  ${okPill()} already in the keychain as ${bold(r.entry.label)} — nothing to add`)
    }
    const active = activeKeyLabel(readGlobalConfig(), prov)
    this.println(`  ${okPill()} ${prov} · ${bold(r.entry.label)}${active === r.entry.label ? ' — active' : ''}`)
    this.println(dim(`    switch any time: /config keys · fallback: /fallback add · travels: /config push`))
  }

  /** /config keys — the multi-key manager: pick the active key, remove, stack. */
  private async configKeysFlow(rest: string): Promise<void> {
    const g = readGlobalConfig()
    const provs = keychainProviders(g)
    if (provs.length === 0) {
      return this.println(dim('  no named keys yet — /config add key creates the first one'))
    }
    const prov = (await this.pick(
      provs.map((p) => {
        const active = activeKeyLabel(g, p.provider)
        return {
          label: `${p.provider}${active ? ` ${dim(`· using ${active}`)}` : ''}`,
          hint: `${p.keys} key${p.keys === 1 ? '' : 's'}`,
          value: p.provider,
        }
      }),
      'keys — provider',
      { filterable: true },
    )) ?? ''
    if (!prov) return this.println(dim('  cancelled'))

    for (;;) {
      const entries = describeProviderKeys(readGlobalConfig(), prov)
      const active = entries.find((e) => e.active)
      const actions: PickItem<string>[] = [
        ...entries.map((e) => ({
          label: `${e.active ? green('●') : '○'} ${e.label}`,
          hint: e.active ? 'active' : 'select to use',
          detail: e.masked,
          value: `use:${e.id}`,
        })),
        { label: '+ add another key', hint: 'multi-key', value: 'add' },
        { label: '− remove a key', hint: 'delete from the keychain', value: 'rm' },
        { label: '↳ use as fallback', hint: 'stack this provider under the failover chain', value: 'fb' },
        { label: 'done', hint: 'esc', value: 'done' },
      ]
      const pick = await this.pick(actions, `${prov} — keys${active ? ` · active: ${active.label}` : ''}`, {
        footer: 'the active key feeds every request; others wait in the drawer',
      })
      if (!pick || pick === 'done') return
      if (pick === 'add') { await this.configAddKeyFlowFor(prov); continue }
      if (pick === 'rm') {
        const id = (await this.pick(entries.map((e) => ({ label: e.label, hint: e.masked, value: e.id })), 'remove — key')) ?? ''
        if (!id) continue
        const r = removeProviderKey(id)
        if (r) {
          this.println(`  ${okPill()} removed ${bold(r.removed.label)}${r.nowActive !== undefined ? ' — next key took over' : ''}`)
        }
        continue
      }
      if (pick === 'fb') {
        await this.keychainFallbackFlow(prov)
        continue
      }
      if (pick.startsWith('use:')) {
        const e = selectProviderKey(prov, pick.slice(4))
        if (e) {
          // the workspace slot too — the effective key changes NOW even when
          // this project had its own override
          this.host.settingsSave({ apiKey: { provider: prov, key: e.key } })
          const masked = describeProviderKeys(readGlobalConfig(), prov).find((x) => x.id === e.id)?.masked ?? ''
          this.println(`  ${okPill()} ${prov} now uses ${bold(e.label)} ${dim(`(${masked})`)}`)
        } else this.println(`  ${errPill()} key not found`)
        continue
      }
    }
  }

  /** add a key for a KNOWN provider (from the keys manager). */
  private async configAddKeyFlowFor(prov: string): Promise<void> {
    const label = ((await this.ask('label (e.g. "backup")')) ?? '').trim() || 'key'
    const key = (await this.askHidden(`api key for ${prov}`)).trim()
    if (!key) return this.println(dim('  cancelled — empty key'))
    const r = addProviderKey(prov, label, key)
    this.println(r.duplicate
      ? `  ${okPill()} already in the keychain as ${bold(r.entry.label)}`
      : `  ${okPill()} ${prov} · ${bold(r.entry.label)}${activeKeyLabel(readGlobalConfig(), prov) === r.entry.label ? ' — active' : ''}`)
  }

  /** stack a keychain key into the fallback chain (key-level failover). */
  private async keychainFallbackFlow(prov: string): Promise<void> {
    const entries = describeProviderKeys(readGlobalConfig(), prov)
    if (!entries.length) return this.println(dim('  no keys to stack'))
    const id = (await this.pick(entries.map((e) => ({ label: e.label, hint: e.masked, value: e.id })), 'fallback — pick the key')) ?? ''
    if (!id) return this.println(dim('  cancelled'))
    const entry = listProviderKeys(readGlobalConfig(), prov).find((k) => k.id === id)
    if (!entry) return this.println(dim('  cancelled'))
    const infos = listProviderInfos(this.host.cfg)
    const info = infos.find((p) => p.id === prov)
    const defModel = this.host.cfg.defaultProvider === prov ? this.host.cfg.defaultModel : (info?.models[0]?.id ?? '')
    const model = ((await this.ask(`model for the fallback entry${defModel ? ` (enter = ${defModel})` : ''}`)) ?? '').trim() || defModel
    if (!model) return this.println(dim('  cancelled — a model is required'))
    const list = [...(this.host.cfg.fallback ?? []), { provider: prov, model, apiKey: entry.key, enabled: true, label: `${prov} ${entry.label}` }]
    this.host.settingsSave({ fallback: list })
    this.println(`  ${okPill()} fallback #${list.length}: ${prov}/${model} ${dim(`· key "${entry.label}"`)}`)
    this.println(dim('    chain: /fallback · it takes over when the primary key fails'))
  }

  /** /config use <provider>/<model> — set the GLOBAL default. */
  private async configUseFlow(rest: string): Promise<void> {
    if (!rest) {
      const infos = listProviderInfos(this.host.cfg)
      const ready = infos.filter((p) => !p.needsKey || p.hasKey)
      const p = (await this.pick(
        ready.map((x) => ({ label: x.label, hint: `${x.models.length} models`, value: x.id })),
        'default provider — global',
        { filterable: true },
      )) ?? ''
      if (!p) return this.println(dim('  cancelled'))
      const info = infos.find((x) => x.id === p)!
      if (info.models.length === 0) return this.println(red(`  ${p} has no models — /model refresh`))
      const m = (await this.pick(info.models.map((mm) => ({ label: mm.id, hint: mm.label, value: mm.id })), `${p} — model`, { filterable: true })) ?? ''
      if (!m) return this.println(dim('  cancelled'))
      return this.configUseFlow(`${p}/${m}`)
    }
    const ref = parseModelRef(rest, this.host.cfg)
    if (!ref) return this.println(dim('  usage: /config use <provider>/<model>'))
    const info = listProviderInfos(this.host.cfg).find((p) => p.id === ref.provider)
    if (!info) return this.println(red(`  unknown provider "${ref.provider}"`))
    if (info.needsKey && !info.hasKey) return this.println(red(`  ${ref.provider} has no key — /config add key`))
    updateGlobalConfig({ defaultProvider: ref.provider, defaultModel: ref.model })
    this.println(`  ${okPill()} global default: ${ref.provider} · ${ref.model}`)
    const local = this.host.cfg.defaultProvider === ref.provider && this.host.cfg.defaultModel === ref.model
    if (!local) this.println(dim('    this project keeps its own /model choice — /model to change it here'))
    this.println(dim('    travels to every device: /config push'))
  }

  /* ---------------- auth wizard ---------------- */

  private async authWizard() {
    const host = this.host
    const github = host.cfg.github ?? {}
    if (github.token) {
      this.println(`  ${okPill()} connected as ${github.login}`)
      const a = (await this.ask('switch account? (l = logout, enter = stay)')) ?? ''
      if (a.trim().toLowerCase().startsWith('l')) {
        await host.githubLogout()
        this.refreshSyncBadge()
        this.println(dim('  logged out'))
      }
      return
    }
    this.println(bold('  GitHub login'))
    const choice = await this.pick(
      [
        { label: 'device flow', hint: 'no secrets pasted', detail: 'one button on GitHub', value: 'device' },
        { label: 'personal access token', hint: 'works everywhere', value: 'pat' },
      ],
      'login method',
    )
    try {
      if (choice === 'device') {
        const start = await host.githubDeviceStart()
        this.println(`  ${bold('open')}  ${start.verification_uri}`)
        this.println(`  ${bold('code')}   ${bold(cyan(start.user_code))}`)
        this.println(dim('  waiting for authorization…'))
        const r = await host.githubDevicePoll()
        this.println(`  ${okPill()} logged in as ${r.login}`)
      } else if (choice === 'pat') {
        const token = (await this.askHidden('GitHub token')).trim()
        if (!token) return this.println(dim('  cancelled'))
        const r = await host.githubPat(token)
        this.println(`  ${okPill()} logged in as ${r.login}`)
      } else {
        return this.println(dim('  cancelled'))
      }
      this.refreshSyncBadge()
      await this.authConfigBootstrap()
      this.println(dim('  sync this workspace any time with `tagent sync`'))
    } catch (e) {
      this.println(`  ${errPill()} ${red(`${(e as Error).message}`)}`)
    }
  }

  /**
   * Post-auth: "tagent otomatis bikin repo private" — ensure
   * login/tagent-config exists and carries this device's config. Pull-first:
   * when another device already set the repo up, its config merges in BEFORE
   * the push, so a defaults-only device can never clobber a richer remote.
   */
  private async authConfigBootstrap(): Promise<void> {
    try {
      await pullConfigSync().catch(() => undefined)
      this.println(dim('  setting up your private config repo…'))
      const r = await pushConfigSync()
      this.println(`  ${okPill()} config repo ${bold(r.repo)}${r.created ? ` ${chip('private', 'green')}` : ''}`)
      if (r.passphrase) {
        this.println(`  ${warnPill('vault passphrase')} ${bold(r.passphrase)}`)
        this.println(yellow('    save it — other devices need it to unlock the config'))
      }
      this.println(dim('    providers · api keys · mcp · models — same on every device (/config)'))
    } catch (e) {
      this.println(`  ${warnPill('config repo')} ${yellow(`setup skipped — ${(e as Error).message}`)}`)
    }
  }

  /* ---------------- relay endpoint ---------------- */

  /** start a minimal local endpoint for /relay (no GUI, first free port 4020-4029) */
  private async startRelayEndpoint(): Promise<void> {
    const { createDaemon } = await import('./daemon')
    let lastErr: unknown
    for (let port = 4020; port < 4030; port++) {
      try {
        this.relayServer = await createDaemon({
          port, host: '127.0.0.1', workspaceRoot: this.host.root,
          agentHost: this.host, quiet: true,
        })
        this.relayBase = `http://127.0.0.1:${port}`
        return
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  /* ---------------- grep ---------------- */

  private grepWorkspace(pattern: string, maxHits = 200): { file: string; line: number; text: string }[] {
    let re: RegExp
    try {
      re = new RegExp(pattern, 'i')
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    }
    const hits: { file: string; line: number; text: string }[] = []
    const skip = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.tagent', 'gui-dist', 'tool-results'])
    const walk = (dir: string, rel: string) => {
      if (hits.length >= maxHits) return
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (skip.has(e.name)) continue
        const abs = path.join(dir, e.name)
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) walk(abs, r)
        else if (e.isFile()) {
          try {
            const st = fs.statSync(abs)
            if (st.size > 500_000) continue
            const lines = fs.readFileSync(abs, 'utf8').split('\n')
            for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
              if (re.test(lines[i])) hits.push({ file: r, line: i + 1, text: lines[i].trim() })
            }
          } catch { /* skip */ }
        }
      }
    }
    walk(this.host.root, '')
    return hits
  }

  /* ------------------------------------------------------------------ */
  /* rendering                                                           */
  /* ------------------------------------------------------------------ */

  private get termW(): number {
    return Math.max(20, this.io.output.columns ?? 80)
  }
  private get termH(): number {
    return Math.max(6, this.io.output.rows ?? 24)
  }
  private transcriptW(): number {
    return Math.max(10, this.termW - 2)
  }

  requestRender(): void {
    this.dirty = true
    if (!this.frameTimer) {
      this.frameTimer = setTimeout(() => {
        this.frameTimer = undefined
        this.renderNow()
      }, 33)
    }
  }

  /** build + write one frame (also the test entry point)
   *
   * Two paint models share this code:
   *  - INLINE: jump to the first sticky row, wipe, flush pending transcript
   *    lines into the terminal's own scrollback, rewrite the sticky region
   *  - FULLSCREEN: repaint from the top-left of the alternate screen —
   *    navbar · transcript viewport · overlays · editor. Nothing ever
   *    scrolls; the built-in viewer pages through the history instead.
   */
  renderNow(): void {
    if (this.frameTimer) {
      clearTimeout(this.frameTimer)
      this.frameTimer = undefined
    }
    const rows = this.buildFrame()
    this.lastFrame = rows
    let out = ''
    if (this.fullscreen) {
      out = '\x1b[H'
      for (let i = 0; i < rows.length; i++) {
        // every row hard-truncated to the terminal width — a soft-wrap
        // here would grow the frame's real row count and the next redraw
        // would paint the editor OVER the transcript (the "input box
        // nabrak response" bug on narrow/mobile terminals)
        out += '\r\x1b[2K' + truncateStyled(rows[i], this.termW)
        if (i < rows.length - 1) out += '\n'
      }
      out += '\x1b[J'
    } else {
      if (this.stickyDrawn > 0) out += `\x1b[${this.stickyDrawn - 1}A`
      out += '\x1b[J'
      while (this.flushed < this.log.length) {
        const e = this.log[this.flushed]
        const wrapped = e.wrapped ?? (e.wrapped = wrapStyled(e.raw, this.transcriptW()))
        for (const l of wrapped) out += '\r\x1b[2K' + truncateStyled(l, this.termW) + '\n'
        this.flushed++
      }
      for (let i = 0; i < rows.length; i++) {
        out += '\r\x1b[2K' + truncateStyled(rows[i], this.termW)
        if (i < rows.length - 1) out += '\n'
      }
    }
    this.writeOut(out)
    this.stickyDrawn = this.fullscreen ? 0 : rows.length
    this.dirty = false
  }

  /** pure sticky-region builder — no writes (testable).
   * Layout, top to bottom: navbar · (fullscreen: transcript viewport | inline:
   * live stream tail) · overlay box · status row · editor box · hint row.
   * Never taller than the screen. */
  buildFrame(): string[] {
    const W = this.termW
    const H = this.termH
    const rows: string[] = []
    const head = this.headerRows(W)
    const edRows = this.editorRows(W)
    const statusRow = safeRow(this.statusRow(W))
    const hintRow = safeRow(this.hintRow(W))
    // how many rows overlays may take without pushing the editor off-screen
    const avail = Math.max(0, H - head.length - edRows.length - 2)
    // overlay renderers register their tap zones while they build (relative
    // row indices) — reset the list first so zones never leak across frames
    this.ovZones = []
    const ovRows = this.overlayRows(W, avail)
    const transAvail = Math.max(0, avail - ovRows.length)
    for (const r of head) rows.push(safeRow(r))
    if (this.fullscreen) {
      // the viewport is ALWAYS exactly transAvail tall — blank rows pad the
      // top, so the transcript anchors to the editor and the EDITOR anchors
      // to the bottom edge of the screen (the navbar's mirror image)
      const body = this.transcriptRows(W, transAvail)
      for (let i = body.length; i < transAvail; i++) rows.push('')
      for (const r of body) rows.push(safeRow(r))
    } else {
      // inline: the transcript lives in the terminal's native scrollback —
      // the sticky region carries the live stream tail, and swaps to the
      // history window while the viewer is open (pgup / wheel up)
      const src = this.viewing
        ? this.transcriptRows(W, Math.max(0, transAvail))
        : this.streamTailRows(W, Math.max(0, transAvail))
      for (const r of src) rows.push(safeRow(r))
    }
    const ovStart = rows.length
    for (const r of ovRows) rows.push(safeRow(r))
    // tap zones of THIS frame — absolute rows, only in fullscreen (mouse
    // tracking runs there); overlays may be clamped by slice(-H) at the top
    // but never their zones (only the navbar/transcript shrink from above)
    this.clickZones = this.fullscreen
      ? this.ovZones
          .filter((z) => z.i >= 0 && z.i < ovRows.length)
          .map((z) => ({ y: ovStart + z.i, hit: z.hit }))
      : []
    rows.push(statusRow)
    for (const r of edRows) rows.push(safeRow(r))
    rows.push(hintRow)
    // last-resort clamp — dropping the top-most rows keeps the editor visible
    const final = rows.length > H ? rows.slice(rows.length - H) : rows
    if (final.length !== rows.length) {
      // the top was clipped — shift the zones up by the same amount so taps
      // still land on the rows that are actually on screen
      const cut = rows.length - final.length
      for (const z of this.clickZones) z.y -= cut
    }
    return final
  }

  /** sanitized config with a 1s cache — the hint row reads it every frame */
  private cfgFast(): ReturnType<AgentHost['sanitizeConfig']> {
    const now = Date.now()
    if (this.cfgCache && now - this.cfgCache.at < 1000) return this.cfgCache.val
    const val = this.host.sanitizeConfig()
    this.cfgCache = { at: now, val }
    return val
  }

  /** the sticky navbar — the old boot banner, promoted: it never scrolls
   * away and refreshes every second (startNavTicker). Model, MCP servers,
   * context bar, mode and session clock live here now.
   *
   *   ╭─ ✻ Tagent v0.19.0 ── 💬 <session title> ──────────────╮
   *   ╰─ 🤖 build · 📂 <workspace> · glm-4.7 · 🔌 2✓ 31 · 4m ─╯ */
  private headerRows(W: number): string[] {
    // responsive floor: never wider than the terminal — a hard 34-col floor
    // soft-wrapped on narrow (phone/split) terminals and the wrapped rails
    // broke the sticky-region math (the input box painted over the reply)
    const boxW = Math.max(14, Math.min(W - 2, 78))
    const cfg = this.cfgFast() as { defaultModel: string }
    const st = this.host.mcpStatus()
    const ready = st.filter((s) => s.state === 'ready')
    const connecting = st.filter((s) => s.state === 'connecting')
    const errored = st.filter((s) => s.state === 'error')
    let mcp: string
    if (connecting.length) mcp = yellow(`connecting ${connecting.length}…`)
    else if (errored.length && ready.length) mcp = `${green(`${ready.length}✓`)} ${red(`${errored.length}✗`)}`
    else if (errored.length) mcp = red('error')
    else if (ready.length) mcp = green(`${ready.length}✓ ${ready.reduce((n, s) => n + s.tools, 0)}t`)
    else mcp = dim('off')
    const ci = this.host.contextInfo()
    let ctx = ''
    if (ci.limit > 0) {
      const raw = renderContextBar(ci.used, ci.limit, 8)
      const pct = contextPct(ci.used, ci.limit)
      ctx = ` · ${pct >= 80 ? red(raw) : pct >= 60 ? yellow(raw) : green(raw)}`
    }
    // "device lain sedang online" — the top navbar mirrors the hint row's
    // presence badge (green only when someone else is actually there)
    let devSeg = ''
    const sst = this.syncStatus()
    if (sst?.running && sst.others.length > 0) {
      const who = sst.others.length === 1
        ? truncateStyled(sst.others[0].name, 16)
        : `${sst.others.length} devices`
      devSeg = ` · ${green(`◉ ${who} online`)}`
    }
    const title = `${orange('✻')} ${bold('Tagent')} ${dim(`v${CURRENT_VERSION}`)} · ${dim('💬')} ${truncateStyled(this.sessionTitle, Math.max(6, boxW - 34))}`
    // workspace — which folder the agent is working in; the hint row's ⎇
    // segment shows the sync REPO, this shows the local folder itself
    const wsName = path.basename(this.opts.workspaceRoot || '.') || this.opts.workspaceRoot || '.'
    const foot = `🤖 ${this.mode} · 📂 ${truncateStyled(wsName, 18)} · ${shortModelName(cfg.defaultModel)} · 🔌 ${mcp}${ctx}${devSeg} · ${fmtElapsed(Date.now() - this.startedAt)}`
    return roundBox({ title, footer: foot, rows: [], width: boxW })
  }

  /** 1s refresh — the navbar's facts (mcp handshakes landing, the context
   *  bar, the session clock) change with time, not just with keystrokes */
  private startNavTicker(): void {
    if (this.navTimer) return
    this.navTimer = setInterval(() => {
      if (this.exited || this.destroyed) return
      this.requestRender()
    }, 1000)
  }

  /** flat list of every transcript line — the fullscreen viewer pages through
   *  it. Incrementally cached; wrapped caches live on the log entries. */
  private flatLines(): string[] {
    for (let i = this.flatCache.upto; i < this.log.length; i++) {
      const e = this.log[i]
      const wrapped = e.wrapped ?? (e.wrapped = wrapStyled(e.raw, this.transcriptW()))
      for (const l of wrapped) this.flatCache.lines.push(l)
    }
    this.flatCache.upto = this.log.length
    this.flushed = this.log.length
    return this.flatCache.lines
  }

  /** the fullscreen transcript viewport: the newest h lines while live, or a
   *  window into the history while the viewer is open */
  private transcriptRows(W: number, h: number): string[] {
    if (h <= 0) return []
    const lines = this.flatLines()
    const tail = this.streamTailRows(W, h)
    if (this.viewing) {
      const bottom = Math.max(0, lines.length - 2)
      const start = Math.min(Math.max(0, this.viewOffset), bottom)
      return lines.slice(start, start + h).map((l) => truncateStyled(l, W))
    }
    const body = lines.slice(Math.max(0, lines.length - h))
    return [...body.map((l) => truncateStyled(l, W)), ...tail].slice(-h)
  }

  /** page size of the history viewer (keeps navbar + editor visible) */
  private viewerPage(): number {
    return Math.max(3, this.termH - 10)
  }

  /** scroll the fullscreen history viewer. Negative = older, positive =
   *  newer; landing on the bottom snaps back to live mode. */
  private scrollBy(delta: number): void {
    const lines = this.flatLines()
    const n = lines.length
    if (n === 0) return
    const bottom = Math.max(0, n - 2)
    if (!this.viewing) {
      if (delta >= 0) return // already live at the bottom — nothing older
      this.viewing = true
      this.viewOffset = Math.max(0, bottom - Math.max(3, Math.floor(this.termH / 3)))
    }
    this.viewOffset = Math.max(0, Math.min(this.viewOffset + delta, bottom))
    if (this.viewOffset >= bottom) {
      this.viewing = false
      this.viewOffset = 0
    }
    this.requestRender()
  }

  /** the live message tail while streaming — rendered as MARKDOWN live
   *  (v0.23.0): the same renderer as the final flush, on the partial text
   *  (an unclosed fence is auto-closed so a streaming code block shows as
   *  a block instead of raw backticks). Cached by text length — chunks only
   *  append, so the parse is skipped when nothing new landed. */
  private streamTailRows(W: number, availH: number): string[] {
    if (this.statusKind !== 'stream' || !this.streamText || availH <= 0) return []
    const w = Math.max(10, Math.min(W - 4, 78))
    let text = this.streamText
    const fenceOpens = (text.match(/^[ \t]*(`{3,}|~{3,})/gm) ?? []).length
    if (fenceOpens % 2 === 1) text += '\n```'
    let lines: string[]
    if (this.streamCache?.len === text.length) {
      lines = this.streamCache.lines
    } else {
      if (this.mdRender) {
        try {
          lines = this.mdRender(text, w)
        } catch {
          lines = wrapStyled(this.streamText.trimEnd(), w)
        }
      } else {
        lines = wrapStyled(this.streamText.trimEnd(), w)
      }
      this.streamCache = { len: text.length, lines }
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const max = Math.max(1, Math.min(8, availH))
    const tail = lines.slice(-max)
    return tail.map((l, i) => (i === tail.length - 1 ? `  ${l}${dim('▌')}` : `  ${l}`))
  }

  private statusRow(W: number): string {
    if (this.viewing) {
      const lines = this.flatLines()
      const h = Math.max(1, this.termH - 10)
      const shown = Math.min(this.viewOffset + h, lines.length)
      return truncateStyled(yellow(`↑ history ${Math.min(this.viewOffset + 1, lines.length)}–${shown} of ${lines.length} · pgdn/x end → live`), W)
    }
    let s = ''
    if (this.notice) {
      s = red(this.notice)
    } else if (this.statusKind === 'stream') {
      s = `${cyan(SPINNER[this.spinnerFrame])} ${dim(`🌊 streaming · ${this.streamChars} chars · esc to interrupt`)}`
    } else if (this.statusKind === 'status') {
      const ic = /thinking/.test(this.statusLabel) ? STATUS_ICONS.thinking : STATUS_ICONS.acting
      s = `${cyan(SPINNER[this.spinnerFrame])} ${dim(`${ic} ${this.statusLabel}`)}${this.running ? dim(' · esc to interrupt') : ''}`
    } else if (this.lastDoneLabel) {
      s = dim(this.lastDoneLabel)
    }
    return truncateStyled(s, W)
  }

  /** the row under the editor box — Claude Code's `? for shortcuts` line:
   *  keys on the left, live session stats right. The context bar
   *  (`12.3k/131k [██████░░░░] 9%`) shows how much of the model's window the
   *  session eats; without a known limit it falls back to token counters. */
  private hintRow(W: number): string {
    const cfg = this.cfgFast() as { defaultModel: string }
    const keys = this.running ? 'esc interrupt · ? shortcuts · ctrl+x menu' : HINT_KEYS
    let ctx = ''
    if (this.ctxLimit > 0) {
      const pct = contextPct(this.ctxUsed, this.ctxLimit)
      const raw = renderContextBar(this.ctxUsed, this.ctxLimit, 10)
      ctx = pct >= 80 ? red(raw) : pct >= 60 ? yellow(raw) : green(raw)
    } else if (this.tokensIn + this.tokensOut > 0) {
      ctx = `${fmtTok(this.tokensIn)}${SYM.arrowUp} ${fmtTok(this.tokensOut)}${SYM.arrowDown}`
    }
    // ⎇ repo · live engine state (interval + last action) when it's running
    let badge = ''
    if (this.syncBadge) {
      badge = ` · ⎇ ${this.syncBadge}`
      const s = this.syncStatus()
      if (s?.running) {
        badge += ` ${dim(`⇅${Math.round(s.intervalMs / 1000)}s`)}`
        // "device lain sedang online" — fresh heartbeats from other devices
        if (s.others.length > 0) {
          const who = s.others.length === 1
            ? truncateStyled(s.others[0].name, 16)
            : `${s.others.length} devices`
          badge += ` ${green(`◉ ${who}`)}`
        }
        if (this.syncHint) badge += ` ${this.syncHint}`
        if (s.lastError) badge += ` ${red('!')}`
      }
    }
    const right = `${this.mode} · ${shortModelName(cfg.defaultModel)}${ctx ? ` · ${ctx}` : ''} · ${fmtElapsed(Date.now() - this.startedAt)}${badge}`
    const room = W - vwidthANSI(keys) - 2
    const rightCut = room > 10 ? dim(truncateStyled(right, Math.max(4, room))) : ''
    const keysCut = truncateStyled(keys, Math.max(4, W - vwidthANSI(rightCut) - 1))
    const pad = Math.max(1, W - vwidthANSI(keysCut) - vwidthANSI(rightCut))
    return dim(keysCut) + ' '.repeat(pad) + rightCut
  }

  /** cached engine status — status() touches the filesystem (settings +
   *  presence); the 1s navbar tick and the per-frame hint row share one
   *  read through this ~500ms cache. */
  private syncStatus(): SyncEngineStatus | undefined {
    if (!this.sync) return undefined
    const now = Date.now()
    if (!this.syncStatusCache.val || now - this.syncStatusCache.at > 500) {
      try {
        this.syncStatusCache = { at: now, val: this.sync.status() }
      } catch {
        /* settings I/O must never break a render */
      }
    }
    return this.syncStatusCache.val
  }

  /** slow ticker (30s) — keeps the elapsed-time stat fresh while idle; while
   * a run is going the spinner already re-renders every 100ms */
  private startStatsTicker(): void {
    if (this.statsTimer) return
    this.statsTimer = setInterval(() => {
      if (this.exited || this.destroyed) return
      this.requestRender()
    }, 30_000)
  }

  /** load A2's markdown renderer once at boot — dynamic on purpose: the app
   * still boots (and streams raw text) if the module is missing or broken */
  private preloadMarkdown(): void {
    import('./markdown')
      .then((m) => {
        this.mdRender = m.renderMarkdown
      })
      .catch(() => undefined)
  }

  /** boot the project auto-sync engine. Engages only when the project is
   *  LINKED + logged in (a repo the user already synced once) and settings
   *  say auto — a fresh folder is never surprise-uploaded. The vault
   *  catch-up applies synced settings on devices that haven't seen them. */
  private startSyncEngine(): void {
    try {
      if (!getLinkedProject(this.host.root)) return
      if (!authStatus().logged && !this.host.cfg?.github?.token) return
      const st = readSyncSettings(this.host.root)
      if (!st.auto) return
      this.sync = new SyncEngine({
        root: this.host.root,
        getConfig: () => this.host.cfg,
        onEvent: (e) => this.onSyncEvent(e),
      })
      this.sync.restart()
      void this.sync!.applyVaultOnce().then((changed) => {
        if (changed.length) {
          this.println(green(`  🔐 vault applied — ${changed.join(', ')}`))
        } else if (vaultNeedsPassphrase(this.host.root)) {
          this.println(yellow('  🔐 this project shares encrypted settings — set the passphrase to unlock them (/repo)'))
        }
      })
    } catch {
      /* never break boot over sync */
    }
  }

  /**
   * The `tagent start` config-repo pass — "kalo reponya diapus tagent bakal
   * ngecek terus dan kasih warn setiap tagent start":
   *
   *   repo deleted on GitHub  → a yellow warning banner (every start)
   *   remote config moved     → pulled + applied (banner shows what moved)
   *   local config moved      → pushed (devices converge, zero clicks)
   *   offline / not logged in → silence (the next start checks again)
   */
  private startupConfigSync(): void {
    void smartConfigSync()
      .then((r) => {
        if (this.exited || this.destroyed) return
        if (r.health.status === 'missing') {
          this.bannerBox(
            '⚙ config sync',
            'config repo deleted on GitHub — /config push recreates it',
            yellow,
            'yellow',
          )
          return
        }
        if (r.error) {
          this.println(`  ${warnPill('config sync')} ${yellow(r.error.slice(0, 140))}`)
          return
        }
        const pulled = r.pulled
        if (pulled && pulled.status === 'applied' && pulled.changed.length) {
          this.refreshLiveConfigFromGlobal()
          this.bannerBox('⚙ config sync', `pulled — ${pulled.changed.slice(0, 5).join(', ')}${pulled.changed.length > 5 ? ` +${pulled.changed.length - 5}` : ''}`, cyan, 'cyan')
        }
        if (r.pushed) {
          if (r.pushed.passphrase) {
            this.println(`  ${warnPill('vault passphrase')} ${bold(r.pushed.passphrase)}`)
            this.println(yellow('    save it — other devices need it to unlock the config (/repo passphrase)'))
          }
          this.bannerBox('⚙ config sync', `pushed → ${r.pushed.repo}`, green, 'green')
        }
      })
      .catch(() => undefined) // never break boot over the config repo
  }

  /** engine events → banner boxes + a fresh badge. System happenings ride
   *  the v0.23.0 frame so they stand out from chat like everything else. */
  private onSyncEvent(e: SyncEvent): void {
    if (e.type === 'pushed') {
      this.syncHint = `↑ ${e.commit}`
      this.bannerBox('⎇ auto-sync', `pushed ${e.commit} → ${e.repo}`, green, 'green')
    } else if (e.type === 'pulled') {
      this.syncHint = `↓ ${e.files || ''}${e.applied.length ? ' 🔐' : ''}`.trim()
      const bits: string[] = []
      if (e.files > 0) bits.push(`${e.files} file${e.files === 1 ? '' : 's'}`)
      if (e.applied.length) bits.push(`vault: ${e.applied.join(', ')}`)
      this.bannerBox('⎇ auto-sync', `pulled${bits.length ? ` — ${bits.join(' · ')}` : ' — up to date'}`, cyan, 'cyan')
    } else if (e.type === 'vault-passphrase') {
      this.println(yellow('  🔐 shared settings are locked — set this device\'s passphrase (/repo) to unlock'))
    } else if (e.type === 'error') {
      this.syncHint = red('sync error')
      this.println(`  ${errPill('sync')} ${red(e.message)}`)
    }
    this.refreshSyncBadge()
  }

  /** refresh the cached GitHub sync badge (stats row '⎇ owner/repo').
   * Reads the project registry + credential state — file I/O, so this is
   * called only at boot, after /push and after the auth wizard, never in
   * the render path. Login check mirrors syncProject's token resolution
   * (credential store / global config cover `tagent auth` + the GUI dialog;
   * the workspace cfg token covers the in-TUI legacy /auth path). */
  private refreshSyncBadge(): void {
    try {
      const linked = getLinkedProject(this.host.root)
      const logged = authStatus().logged || !!this.host.cfg?.github?.token
      this.syncBadge = linked && logged ? linked.repo : ''
    } catch {
      this.syncBadge = ''
    }
  }

  /* ---------------- editor rendering ---------------- */

  private editorRows(W: number): string[] {
    const innerW = Math.max(4, W - 4)
    const allSegs = this.editor.lines.map((l) => wrapSegments(l, innerW))
    const totalVis = allSegs.reduce((n, a) => n + a.length, 0)
    // the box grows with the text (up to 8 rows, Claude Code-style) and the
    // view scrolls to keep the cursor visible
    const contentRows = Math.min(8, Math.max(2, totalVis))
    // cursor visual position
    let rowsBefore = 0
    for (let i = 0; i < this.editor.row; i++) rowsBefore += allSegs[i]?.length ?? 0
    const pos = cursorPos(allSegs[this.editor.row] ?? [{ s: '', colStart: 0 }], this.editor.col)
    const cursorVis = rowsBefore + pos.row

    // scroll the editor view to keep the cursor visible
    if (totalVis <= contentRows) this.edScroll = 0
    else {
      if (cursorVis < this.edScroll) this.edScroll = cursorVis
      if (cursorVis >= this.edScroll + contentRows) this.edScroll = cursorVis - contentRows + 1
      this.edScroll = Math.min(this.edScroll, totalVis - contentRows)
    }

    const border = this.running ? orange : dim
    const top = border('╭' + '─'.repeat(innerW + 2) + '╮')
    const bottom = border('╰' + '─'.repeat(innerW + 2) + '╯')
    const rail = (s: string) => `${border('│')} ${s} ${border('│')}`
    const rows: string[] = [top]

    let vis = 0
    let placeholderDone = false
    for (let li = 0; li < allSegs.length && vis < this.edScroll + contentRows; li++) {
      for (let si = 0; si < allSegs[li].length; si++) {
        const at = vis
        vis += 1
        if (at < this.edScroll || at >= this.edScroll + contentRows) continue
        if (this.editor.isEmpty) {
          if (placeholderDone) {
            rows.push(rail(fitStyled('', innerW)))
          } else {
            rows.push(rail(fitStyled(dim(truncateStyled(EDITOR_PLACEHOLDER, innerW)), innerW)))
            placeholderDone = true
          }
          continue
        }
        const seg = allSegs[li][si]
        let text = seg.s
        if (li === this.editor.row && si === pos.row) {
          const before = text.slice(0, pos.vcol)
          const at2 = text.slice(pos.vcol, pos.vcol + nextLen(text, pos.vcol)) || ' '
          const after = text.slice(pos.vcol + (at2 === ' ' && pos.vcol >= text.length ? 0 : at2.length))
          text = before + (USE_COLOR ? `\x1b[7m${at2}\x1b[27m` : at2) + after
        }
        rows.push(rail(fitStyled(text, innerW)))
      }
    }
    while (rows.length < contentRows + 1) {
      if (this.editor.isEmpty && !placeholderDone) {
        rows.push(rail(fitStyled(dim(truncateStyled(EDITOR_PLACEHOLDER, innerW)), innerW)))
        placeholderDone = true
      } else rows.push(rail(fitStyled('', innerW)))
    }
    rows.push(bottom)
    return rows
  }

  /* ---------------- overlay rendering ---------------- */

  private overlayRows(W: number, viewportH: number): string[] {
    const top = this.overlayStack[this.overlayStack.length - 1]
    if (top) {
      const rows = this.renderOverlay(top, W, viewportH)
      return rows.slice(0, viewportH).map((r) => r)
    }
    const pal = this.slashPalette()
    if (pal) return this.renderPalette(pal, W, viewportH)
    const file = this.fileCompletion()
    if (file) return this.renderFileCompletion(file, W, viewportH)
    return []
  }

  private renderOverlay(ov: Overlay, W: number, viewportH: number): string[] {
    switch (ov.kind) {
      case 'list':
        return this.renderListOverlay(ov, W, viewportH)
      case 'input':
        return this.renderInputOverlay(ov, W)
      case 'confirm':
        return this.renderConfirmOverlay(ov, W)
      case 'permission':
        return this.renderPermissionOverlay(ov, W, viewportH)
      case 'askform':
        return this.renderAskFormOverlay(ov, W, viewportH)
      case 'plan':
        return this.renderPlanOverlay(ov, W, viewportH)
      case 'text':
        return this.renderTextOverlay(ov, W, viewportH)
    }
  }

  private box(title: string, inner: string[], footer: string, W: number, width = Math.min(W - 2, 78)): string[] {
    const boxW = width
    const innerW = Math.max(4, boxW - 4)
    const rows: string[] = []
    const titleCut = truncateStyled(title, Math.max(1, innerW - 2))
    const tLen = vwidthANSI(titleCut)
    const tPad = Math.max(0, innerW + 2 - tLen - 3)
    rows.push(dim(`╭─ ${titleCut} ${'─'.repeat(tPad)}╮`))
    for (const l of inner) {
      rows.push(`${dim('│')} ${fitStyled(l, innerW)} ${dim('│')}`)
    }
    const fCut = truncateStyled(footer, Math.max(1, innerW))
    const fPad = Math.max(0, innerW + 2 - vwidthANSI(fCut) - 3)
    rows.push(dim(`╰─ ${fCut} ${'─'.repeat(fPad)}╯`))
    return rows
  }

  private renderListOverlay(ov: Extract<Overlay, { kind: 'list' }>, W: number, viewportH: number): string[] {
    const boxW = Math.min(W - 2, 78)
    const innerW = Math.max(4, boxW - 4)
    const vis = this.listVisible(ov)
    const maxVis = Math.max(1, Math.min(ov.maxVisible, viewportH - 6, 14))
    if (ov.cursor >= vis.length) ov.cursor = Math.max(0, vis.length - 1)
    if (ov.cursor < ov.offset) ov.offset = ov.cursor
    if (ov.cursor >= ov.offset + maxVis) ov.offset = ov.cursor - maxVis + 1
    ov.offset = Math.min(ov.offset, Math.max(0, vis.length - maxVis))

    const inner: string[] = []
    const zones: { i: number; hit: () => void }[] = []
    // number badges — the mobile pick: 1-9 select without the arrow dance
    const useDigits = !ov.filterable
    if (ov.filter) inner.push(dim(`/${ov.filter}▌`))
    if (ov.filter && this.listMatchCount(ov) === 0) {
      inner.push(dim(`  no matches for "${ov.filter}"`))
      inner.push(dim('  nothing built in matches — a custom one probably will'))
    }
    const win = vis.slice(ov.offset, ov.offset + maxVis)
    let lastGroup = ''
    for (let i = 0; i < win.length; i++) {
      const it = win[i]
      const idx = ov.offset + i
      const isCursor = idx === ov.cursor
      if (it.group && it.group !== lastGroup) {
        inner.push(dim(bold(truncateStyled(it.group.toUpperCase(), innerW))))
        lastGroup = it.group
      }
      const mark = isCursor ? accent('❯') : ' '
      const badge = useDigits && i < 9 ? dim(`${i + 1} `) : ''
      const label = truncateStyled(it.label, Math.max(6, innerW - 34))
      const pad = ' '.repeat(Math.max(1, Math.min(30, innerW - 30) - vwidthANSI(label)))
      let line = ` ${mark} ${badge}${isCursor ? bold(accent(label)) : it.disabled ? dim(label) : label}${pad}`
      if (it.hint) line += ' ' + dim(truncateStyled(it.hint, 28))
      inner.push(line)
      // tap target — a touch on the row picks it (fullscreen mouse)
      zones.push({
        i: inner.length - 1,
        hit: () => {
          if (this.overlayStack.includes(ov) && !it.disabled) this.settle(ov, it.value)
        },
      })
      if (isCursor && it.detail) inner.push(`     ${dim(truncateStyled(it.detail, Math.max(10, innerW - 6)))}`)
    }
    if (vis.length > maxVis) {
      inner.push(dim(`  ${ov.offset > 0 ? '↑' : ' '} ${ov.offset + maxVis < vis.length ? '↓' : ' '} ${ov.offset + 1}–${Math.min(ov.offset + maxVis, vis.length)} of ${vis.length}`))
    }
    const footer = ov.footer ?? (ov.filterable ? 'type to filter' : '')
    const keys = useDigits ? '1-9 pick · ↑↓ move · enter select' : '↑↓ move · enter select'
    const rows = this.box(ov.title, inner, `${keys} · ${footer || 'esc cancel'}`, W)
    // box() puts the first inner row at rows[1] — the offsets survive the
    // clamp because only the TOP of the frame is ever sliced, never overlays
    for (const z of zones) this.ovZones.push({ i: z.i + 1, hit: z.hit })
    return rows
  }

  private renderInputOverlay(ov: Extract<Overlay, { kind: 'input' }>, W: number): string[] {
    const innerW = Math.max(4, Math.min(W - 2, 78) - 4)
    const ed = ov.editor
    let text = ed.text
    let col = ed.col
    if (ov.masked) {
      // mask by code point — keep the cursor column consistent with the mask
      col = [...ed.text.slice(0, ed.col)].length
      text = '•'.repeat([...ed.text].length)
    }
    const segs = wrapSegments(text, innerW)
    const pos = cursorPos(segs, col)
    const seg = segs[pos.row] ?? { s: '', colStart: 0 }
    let line = seg.s
    const before = line.slice(0, pos.vcol)
    const at = line.slice(pos.vcol, pos.vcol + nextLen(line, pos.vcol)) || ' '
    const after = line.slice(pos.vcol + (at === ' ' && pos.vcol >= line.length ? 0 : at.length))
    line = before + (USE_COLOR ? `\x1b[7m${at}\x1b[27m` : at) + after
    return this.box(ov.title, [line], 'enter confirm · esc cancel', W)
  }

  private renderConfirmOverlay(ov: Extract<Overlay, { kind: 'confirm' }>, W: number): string[] {
    const yes = ov.value ? bold(accent(` ${'yes'} `)) : dim(' yes ')
    const no = !ov.value ? bold(yellow(` ${'no'} `)) : dim(' no ')
    const rows = this.box(ov.title, [`${yes} ${no}  ${dim('←→ · enter · tap')}`], 'esc cancel', W)
    // a tap on the choice row toggles it (mobile: no ←/→ keys to reach for)
    this.ovZones.push({
      i: 1,
      hit: () => {
        if (this.overlayStack.includes(ov)) {
          ov.value = !ov.value
          this.requestRender()
        }
      },
    })
    return rows
  }

  private renderPermissionOverlay(ov: Extract<Overlay, { kind: 'permission' }>, W: number, viewportH: number): string[] {
    const req = ov.req
    const risk = req.risk === 'high' ? red('high') : req.risk === 'medium' ? yellow('medium') : green('low')
    const innerW = Math.max(4, Math.min(W - 2, 78) - 4)
    const inner = [
      `${dim('risk')} ${risk}${req.reason ? dim(` · ${truncateStyled(req.reason, Math.max(10, innerW - 20))}`) : ''}`,
      `${bold(req.tool)} ${dim(summarizeInput(req))}`,
      '',
    ]
    const options: [string, string][] = [
      ['allow once', 'this call only'],
      ['always allow', `remember ${req.tool}`],
      ['allow this session', 'until Tagent exits'],
      ['deny', 'stop this call'],
    ]
    const zones: { i: number; hit: () => void }[] = []
    for (const [i, [label, hint]] of options.entries()) {
      const isCursor = i === ov.cursor
      const mark = isCursor ? accent('❯') : ' '
      inner.push(` ${mark} ${dim(`${i + 1} `)}${isCursor ? bold(accent(label)) : label}  ${dim(hint)}`)
      // tap the option (or press its number) — one gesture, no arrows
      const choice = (['once', 'always', 'session', 'deny'] as const)[i]
      zones.push({
        i: inner.length - 1,
        hit: () => {
          if (this.overlayStack.includes(ov)) this.settle(ov, choice)
        },
      })
    }
    const footer = '1-4 · y/a/s/n · tap or enter'
    const shown = inner.slice(0, Math.max(3, viewportH - 4))
    const rows = this.box('permission needed', shown, footer, W)
    for (const z of zones) if (z.i < shown.length) this.ovZones.push({ i: z.i + 1, hit: z.hit })
    return rows
  }

  /** the ask_user form — questions, radio/checkbox options, inputs, notes, submit */
  private renderAskFormOverlay(ov: Extract<Overlay, { kind: 'askform' }>, W: number, viewportH: number): string[] {
    const boxW = Math.min(W - 2, 78)
    const innerW = Math.max(4, boxW - 4)
    const lines: { text: string; row: number }[] = []
    const push = (text: string, row = -1) => lines.push({ text, row })

    if (ov.form.intro) {
      for (const l of wrapStyled(ov.form.intro, innerW - 2)) push(dim(l))
      push('')
    }

    const cur = ov.rows[Math.min(ov.cursor, ov.rows.length - 1)]
    const rowIndexOf = (pred: (r: AskRow) => boolean) => {
      const i = ov.rows.findIndex(pred)
      return i >= 0 ? i : -1
    }

    ov.form.fields.forEach((f, i) => {
      const hint = f.type === 'option' ? ' — pick one' : f.type === 'multi' ? ' — pick any' : ''
      const q = `${i + 1}. ${f.label}${f.required ? ' *' : ''}`
      for (const l of wrapStyled(bold(q) + dim(hint), innerW - 2)) push(l)
      if (ov.missing.includes(f.label)) push(`  ${red('required — this one needs an answer')}`)

      if (f.type === 'input') {
        const ed = ov.editors[i]
        const rowIdx = rowIndexOf((r) => r.kind === 'input' && r.fieldIndex === i)
        const focused = cur && cur.kind === 'input' && cur.fieldIndex === i
        if (focused && ed) {
          push(blockCursorLine(ed.lines[ed.row] ?? '', ed.col), rowIdx)
        } else {
          const t = ed?.text ?? ''
          push(t ? truncateStyled(t, innerW - 4) : dim(f.placeholder ?? 'type here…'), rowIdx)
        }
      } else {
        const opts = ov.options[f.id] ?? []
        opts.forEach((opt, oi) => {
          const rowIdx = rowIndexOf((r) => r.kind === 'option' && r.fieldIndex === i && r.optionIndex === oi)
          const isCursor = cur && cur.kind === 'option' && cur.fieldIndex === i && cur.optionIndex === oi
          const sel = (ov.selected[f.id] ?? []).includes(opt)
          const mark = f.type === 'option' ? (sel ? green('●') : dim('○')) : (sel ? green('☑') : dim('☐'))
          const label = truncateStyled(opt, innerW - 8)
          push(`${isCursor ? accent('❯') : ' '} ${mark} ${isCursor ? bold(accent(label)) : label}`, rowIdx)
        })
        if (f.allowAddOption !== false) {
          const rowIdx = rowIndexOf((r) => r.kind === 'add' && r.fieldIndex === i)
          const isCursor = cur && cur.kind === 'add' && cur.fieldIndex === i
          push(`${isCursor ? accent('❯') : ' '} ${isCursor ? bold(accent('+ add option…')) : dim('+ add option…')}`, rowIdx)
        }
      }
      push('')
    })

    if (ov.form.allowNotes !== false) {
      push(dim(ov.form.notesLabel ?? 'notes for the agent (optional)'))
      const rowIdx = rowIndexOf((r) => r.kind === 'notes')
      const focused = cur && cur.kind === 'notes'
      const shown = ov.notes.isEmpty ? [] : ov.notes.lines.slice(0, 3)
      if (!shown.length) {
        push(`${focused ? accent('❯') : ' '} ${dim('…')}`, rowIdx)
      } else {
        shown.forEach((l, li) => {
          const mark = li === 0 ? (focused ? accent('❯') : ' ') : '  '
          if (focused && ov.notes.row === li) {
            push(`${mark} ${blockCursorLine(l, ov.notes.col)}`, rowIdx)
          } else {
            push(`${mark} ${truncateStyled(l, innerW - 4)}`, rowIdx)
          }
        })
      }
      push('')
    }

    {
      const rowIdx = rowIndexOf((r) => r.kind === 'submit')
      const isCursor = cur && cur.kind === 'submit'
      push(`${isCursor ? accent('❯') : ' '} ${isCursor ? bold(green('submit answers')) : dim('submit answers')}`, rowIdx)
    }

    const footer = '↑↓ move · space/enter pick · a add option · tab next field · esc cancel'

    // window the form around the cursor line (forms can outgrow small terminals)
    const textLines = lines.map((l) => l.text)
    const cursorLine = lines.findIndex((l) => l.row === ov.cursor)
    const visibleH = Math.max(3, viewportH - 2)
    let start = Math.max(0, Math.min(ov.scroll, Math.max(0, textLines.length - visibleH)))
    if (cursorLine >= 0) {
      if (cursorLine < start) start = cursorLine
      if (cursorLine >= start + visibleH) start = cursorLine - visibleH + 1
    }
    start = Math.max(0, Math.min(start, Math.max(0, textLines.length - visibleH)))
    ov.scroll = start
    const shown = textLines.slice(start, start + visibleH)
    while (shown.length < Math.min(visibleH, 3)) shown.push('')
    const rows = this.box(ov.form.title ?? 'agent asks', shown, footer, W)
    // tap targets — every VISIBLE interactive row (options, add CTAs,
    // inputs, notes, submit): a touch focuses + activates it
    for (let i = start; i < Math.min(start + visibleH, lines.length); i++) {
      const l = lines[i]
      if (l.row >= 0) {
        const rowIndex = l.row
        this.ovZones.push({ i: i - start + 1, hit: () => this.askFormTap(ov, rowIndex) })
      }
    }
    return rows
  }

  /** tap on an ask-form row (fullscreen click) — focus it, then act like
   *  enter: options toggle, the submit row submits, inputs/notes take
   *  focus so the next keystroke lands in them (the mobile flow). */
  private askFormTap(ov: Extract<Overlay, { kind: 'askform' }>, rowIndex: number): void {
    if (!this.overlayStack.includes(ov)) return
    const row = ov.rows[rowIndex]
    if (!row) return
    ov.cursor = rowIndex
    ov.missing = []
    if (row.kind === 'submit') return this.askFormSubmit(ov)
    this.askFormKey(ov, { t: 'enter' })
    this.requestRender()
  }

  private renderPlanOverlay(ov: Extract<Overlay, { kind: 'plan' }>, W: number, viewportH: number): string[] {
    const boxW = Math.min(W - 2, 78)
    const innerW = Math.max(4, boxW - 4)
    const textH = Math.max(2, Math.min(14, viewportH - 8))
    const start = Math.min(ov.scroll, Math.max(0, ov.plan.length - textH))
    ov.scroll = Math.max(0, start)
    const inner: string[] = []
    const shown = ov.plan.slice(ov.scroll, ov.scroll + textH)
    for (const l of shown) inner.push(l)
    while (inner.length < textH) inner.push('')
    inner.push('')
    const opts = [
      ov.cursor === 0 ? `${cyan('❯')} ${bold(green('execute plan'))} ${dim('writes PRD.md · switches to build · starts implementing')}` : `  execute plan`,
      ov.cursor === 1 ? `${cyan('❯')} ${bold(yellow('keep planning'))} ${dim('stay in plan mode')}` : `  keep planning`,
    ]
    inner.push(...opts)
    return this.box('plan ready', inner.slice(0, viewportH - 2), '↑↓ choose · pgup/pgdn scroll · esc ask later', W)
  }

  private renderTextOverlay(ov: Extract<Overlay, { kind: 'text' }>, W: number, viewportH: number): string[] {
    const boxW = Math.min(W - 2, 78)
    const innerW = Math.max(4, boxW - 4)
    const wrapped: string[] = []
    for (const l of ov.lines) wrapped.push(...wrapStyled(l, innerW))
    const textH = Math.max(1, viewportH - 3)
    const maxScroll = Math.max(0, wrapped.length - textH)
    if (ov.scroll > maxScroll) ov.scroll = maxScroll
    const shown = wrapped.slice(ov.scroll, ov.scroll + textH)
    while (shown.length < textH) shown.push('')
    return this.box(ov.title, shown, `↑↓/pgup/pgdn scroll · esc close · ${ov.scroll + 1}–${Math.min(ov.scroll + textH, wrapped.length)} of ${wrapped.length}`, W)
  }

  /* ---------------- attached overlays (palette + @files) ---------------- */

  private renderPalette(pal: { token: string; items: { name: string; desc: string }[] }, W: number, viewportH: number): string[] {
    if (this.palCursor >= pal.items.length) this.palCursor = Math.max(0, pal.items.length - 1)
    const maxVis = Math.max(1, Math.min(8, viewportH - 5))
    const off = Math.min(Math.max(0, this.palCursor - maxVis + 1), Math.max(0, pal.items.length - maxVis))
    const inner: string[] = []
    if (pal.token) inner.push(dim(`commands matching "${pal.token}"`))
    const zones: { i: number; hit: () => void }[] = []
    const win = pal.items.slice(off, off + maxVis)
    for (let i = 0; i < win.length; i++) {
      const isCursor = off + i === this.palCursor
      const mark = isCursor ? accent('❯') : ' '
      const name = truncateStyled('/' + win[i].name, 18)
      const pad = ' '.repeat(Math.max(1, 18 - vwidthANSI(name)))
      inner.push(`${mark} ${isCursor ? bold(accent(name)) : name}${pad}${dim(win[i].desc)}`)
      // tap → pick this command into the editor + run it
      zones.push({
        i: inner.length - 1,
        hit: () => {
          this.palCursor = off + i
          this.palToken = null
          this.paletteEnter()
        },
      })
    }
    if (pal.items.length > maxVis) {
      inner.push(dim(`  ${off > 0 ? '↑' : ' '} ${off + maxVis < pal.items.length ? '↓' : ' '} ${off + 1}–${Math.min(off + maxVis, pal.items.length)} of ${pal.items.length}`))
    }
    const rows = this.box('commands', inner, '↑↓ select · enter run · tab complete · esc hide', W, Math.min(W - 2, 66))
    const clipped = rows.slice(0, Math.max(1, viewportH))
    for (const z of zones) if (z.i + 1 < clipped.length) this.ovZones.push({ i: z.i + 1, hit: z.hit })
    return clipped
  }

  private renderFileCompletion(file: { token: string; items: string[] }, W: number, viewportH: number): string[] {
    if (this.fileCursor >= file.items.length) this.fileCursor = Math.max(0, file.items.length - 1)
    const maxVis = Math.max(1, Math.min(8, viewportH - 5))
    const inner: string[] = []
    const zones: { i: number; hit: () => void }[] = []
    for (let i = 0; i < Math.min(file.items.length, maxVis); i++) {
      const isCursor = i === this.fileCursor
      const mark = isCursor ? accent('❯') : ' '
      inner.push(`${mark} ${isCursor ? bold(accent(file.items[i])) : file.items[i]}`)
      // tap → insert the @file mention
      zones.push({
        i: inner.length - 1,
        hit: () => {
          this.fileCursor = i
          this.insertFileCandidate()
        },
      })
    }
    if (file.items.length > maxVis) inner.push(dim(`  ↓ ${Math.min(file.items.length, maxVis)} of ${file.items.length}`))
    const rows = this.box(`@ files — ${file.token}`, inner, '↑↓ select · enter/tab insert · esc hide', W, Math.min(W - 2, 66))
    const clipped = rows.slice(0, Math.max(1, viewportH))
    for (const z of zones) if (z.i + 1 < clipped.length) this.ovZones.push({ i: z.i + 1, hit: z.hit })
    return clipped
  }
}

/* ------------------------------------------------------------------ */
/* format helpers (ported from tui.ts)                                 */
/* ------------------------------------------------------------------ */

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

function fmtWhen(ts: number): string {
  const d = new Date(ts)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toTimeString().slice(0, 5) : d.toISOString().slice(0, 10)
}

/** one-line human summary of a tool input, e.g. `src/app.ts` or `git status` */
function summarizeInput(call: { tool?: string; input?: unknown }): string {
  const input = (call.input ?? {}) as Record<string, unknown>
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) if (input[k] !== undefined) return input[k]
    return undefined
  }
  const v =
    pick('path', 'file', 'command', 'pattern', 'query', 'url', 'name', 'description', 'text', 'skill', 'entry') ??
    (Array.isArray(input.todos) ? `${input.todos.length} todos` : undefined)
  if (v === undefined) return ''
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 70 ? s.slice(0, 67) + '…' : s
}

/** 12345 → "12.3k" for the usage footer */
function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** ms → "42s" / "12m" / "1h 05m" for the persistent stats row */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** compact display name for a model id — the last path/hierarchy segment */
function shortModelName(m: string): string {
  return truncateStyled(m.split(/[/:]/).pop() ?? m, 24)
}

/* ------------------------------------------------------------------ */
/* public api                                                          */
/* ------------------------------------------------------------------ */

/**
 * Can this terminal run the inline app? index.ts falls back to the classic
 * readline TUI (tui.ts) when this returns false. The bar is low: the sticky
 * region only needs a handful of rows — the transcript lives in the
 * terminal's own scrollback, so even a phone terminal qualifies.
 */
export function appCapable(): boolean {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return false
  const rows = (process.stdout as { rows?: number }).rows ?? 0
  const cols = (process.stdout as { columns?: number }).columns ?? 0
  // 0×0 = size not reported yet (pty race before TIOCSWINSZ / early boot) —
  // assume a standard 24×80 and let SIGWINCH fix the layout when it arrives.
  if (rows === 0 && cols === 0) return true
  return rows >= 8 && cols >= 20
}

/**
 * Run the TUI. Mirrors `new Tui(host, opts).start()` — resolves when the
 * user exits (ctrl+c twice, /exit). Always restores the terminal.
 * Fullscreen (opencode-style) is the default; `tagent start --inline`
 * passes fullscreen:false for the scrollback-native inline app.
 */
export async function runApp(
  host: AgentHost,
  opts: { workspaceRoot: string; webUrl?: string; initialMode?: AgentMode; autoSend?: string; fullscreen?: boolean; noResume?: boolean },
): Promise<void> {
  const app = new TuiApp(host, opts)
  try {
    await app.start()
  } finally {
    app.destroy()
  }
}
