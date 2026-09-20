/**
 * select.ts — the interactive picker that makes the TUI feel like an app.
 *
 * Arrow keys / j·k move, Enter picks, Esc cancels, typing filters. Renders
 * inline in the chat stream (scroll windowed, prompt-safe) and restores the
 * readline state afterwards. Pure ANSI, zero dependencies — it works in
 * every terminal, over SSH and in Termux.
 *
 *    const model = await select({ title: 'pick a model', items: [...] })
 */

export interface SelectItem<T = string> {
  label: string
  /** right-aligned dim text (model count, key status, …) */
  hint?: string
  /** dim second line under the label */
  detail?: string
  value: T
  /** shown but not enterable (e.g. provider without a key) */
  disabled?: boolean
  /** pinned — always visible even when the filter matches nothing ("+ add custom…" CTAs) */
  keep?: boolean
}

export interface SelectOptions<T> {
  title?: string
  items: SelectItem<T>[]
  /** index to start on */
  selected?: number
  /** typing filters — defaults to true when there are many items */
  filterable?: boolean
  /** how many rows fit on screen (default 12) */
  maxVisible?: number
  /** extra dim line under the menu */
  footer?: string
  /** when false, Esc/Ctrl+C retries instead of returning undefined */
  cancelable?: boolean
}

const ESC = '\x1b'
const isTTY = !!process.stdout.isTTY

function color(code: string, s: string): string {
  return isTTY ? `\x1b[${code}m${s}\x1b[0m` : s
}
const bold = (s: string) => color('1', s)
const dim = (s: string) => color('2', s)
const cyan = (s: string) => color('36', s)
const red = (s: string) => color('31', s)
const yellow = (s: string) => color('33', s)

/** simple display width (CJK ≈ 2) — keeps columns aligned in the menu */
function vwidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    w += cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f9ff)) ? 2 : 1
  }
  return w
}

function truncateToWidth(s: string, max: number): string {
  let w = 0
  let out = ''
  for (const ch of s) {
    const cw = vwidth(ch)
    if (w + cw > max) break
    out += ch
    w += cw
  }
  return out
}

/**
 * The menu renderer — one instance per interaction. Draws, redraws on key,
 * cleans up. `show()` returns the picked item's value or undefined on cancel.
 */
class Menu<T> {
  private cursor = 0
  private offset = 0
  private filter = ''
  private visible: SelectItem<T>[] = []
  private linesDrawn = 0
  private done = false
  private resolve!: (v: T | undefined) => void
  private prevRawMode: boolean | undefined
  private onData?: (b: Buffer) => void

  constructor(private opts: SelectOptions<T>) {}

  private get maxVisible(): number {
    return Math.max(3, this.opts.maxVisible ?? 12)
  }

  private get filterable(): boolean {
    return this.opts.filterable ?? this.opts.items.length > 12
  }

  private get filtered(): SelectItem<T>[] {
    if (!this.filter) return this.opts.items
    const q = this.filter.toLowerCase()
    const hay = (it: SelectItem<T>) => (it.label + ' ' + (it.hint ?? '') + ' ' + (it.detail ?? '')).toLowerCase()
    const matched = this.opts.items.filter((it) => hay(it).includes(q))
    // pinned CTAs survive every filter — "search found nothing? add a custom one"
    const kept = this.opts.items.filter((it) => it.keep && !matched.includes(it))
    return [...matched, ...kept]
  }

  /** how many items actually match (CTAs excluded) — drives the empty state */
  private get matchCount(): number {
    if (!this.filter) return this.opts.items.length
    const q = this.filter.toLowerCase()
    return this.opts.items.filter((it) =>
      !it.keep && (it.label + ' ' + (it.hint ?? '') + ' ' + (it.detail ?? '')).toLowerCase().includes(q),
    ).length
  }

  show(): Promise<T | undefined> {
    if (!isTTY || !process.stdin.isTTY) {
      // non-interactive: pick the preselected item, never block
      const i = this.opts.selected ?? 0
      return Promise.resolve(this.opts.items[i]?.value)
    }
    return new Promise<T | undefined>((resolve) => {
      this.resolve = resolve
      this.cursor = Math.min(Math.max(this.opts.selected ?? 0, 0), Math.max(this.opts.items.length - 1, 0))
      this.prevRawMode = (process.stdin as { isRaw?: boolean }).isRaw
      process.stdin.setRawMode(true)
      process.stdin.resume()
      this.onData = (buf: Buffer) => this.key(buf.toString('utf8'))
      process.stdin.on('data', this.onData)
      this.render()
    })
  }

  /* ---------------- keys ---------------- */

  private key(s: string) {
    if (this.done) return
    if (s === '\x03') return this.finish(undefined) // Ctrl+C cancels, never exits
    if (s === '\x1b' || (s === 'q' && !this.filterable)) {
      // 'q' quits ONLY on non-searchable menus — in a searchable one it's a letter
      if (this.filter) {
        this.filter = ''
        this.cursor = 0
        this.offset = 0
        this.render()
        return
      }
      if (this.opts.cancelable !== false) return this.finish(undefined)
      return
    }
    if (s.startsWith('\x1b[')) {
      const dir = s.slice(2)
      if (dir === 'A' || dir === '5~') return this.move(-1)
      if (dir === 'B' || dir === '6~') return this.move(1)
      if (dir === 'H' || dir === '1~') return this.moveTo(0)
      if (dir === 'F' || dir === '4~') return this.moveTo(this.visible.length - 1)
      if (/^[0-9]+~$/.test(dir)) {
        const n = Number(dir.replace('~', '')) - 1
        if (n >= 0 && n < 9) return this.moveTo(n)
      }
      return
    }
    if (s === '\r' || s === '\n') {
      const it = this.visible[this.cursor]
      if (it && !it.disabled) this.finish(it.value)
      return
    }
    if (s === 'j' && !this.filter) return this.move(1)
    if (s === 'k' && !this.filter) return this.move(-1)
    if (s === 'g' && !this.filter) return this.moveTo(0)
    if (s === 'G' && !this.filter) return this.moveTo(this.visible.length - 1)
    if (s === '\x7f' || s === '\b') {
      if (this.filter) {
        this.filter = this.filter.slice(0, -1)
        this.cursor = 0
        this.offset = 0
        this.render()
      }
      return
    }
    // printable → filter
    if (this.filterable && /^[\x20-\x7e]$/.test(s)) {
      this.filter += s.toLowerCase()
      this.cursor = 0
      this.offset = 0
      this.render()
    }
  }

  private move(delta: number) {
    const n = this.visible.length
    if (n === 0) return
    // skip disabled entries while moving
    let next = this.cursor
    for (let step = 0; step < n; step++) {
      next = (next + delta + n) % n
      if (!this.visible[next].disabled) break
    }
    this.cursor = next
    this.scroll()
    this.render()
  }

  private moveTo(i: number) {
    this.cursor = Math.max(0, Math.min(i, this.visible.length - 1))
    this.scroll()
    this.render()
  }

  private scroll() {
    const max = this.maxVisible
    if (this.cursor < this.offset) this.offset = this.cursor
    if (this.cursor >= this.offset + max) this.offset = this.cursor - max + 1
    const maxOffset = Math.max(0, this.visible.length - max)
    this.offset = Math.min(this.offset, maxOffset)
  }

  /* ---------------- render ---------------- */

  private rows(): string[] {
    this.visible = this.filtered
    const rows: string[] = []
    if (this.opts.title) rows.push(bold(cyan(`  ${this.opts.title}`)))
    if (this.filter) rows.push(dim(`  /${this.filter}▌`))
    if (this.filter && this.matchCount === 0) {
      rows.push(dim(`  no matches for "${this.filter}"`))
      rows.push(dim('  nothing built in matches — a custom one probably will'))
    }

    const max = this.maxVisible
    const win = this.visible.slice(this.offset, this.offset + max)
    const labelW = 26
    for (let i = 0; i < win.length; i++) {
      const it = win[i]
      const idx = this.offset + i
      const isCursor = idx === this.cursor
      const mark = isCursor ? color('36;1', '❯') : ' '
      const label = truncateToWidth(it.label, labelW - 1)
      const pad = ' '.repeat(Math.max(1, labelW - vwidth(label)))
      let line = ` ${mark} ${isCursor ? bold(cyan(label)) : it.disabled ? dim(label) : label}${pad}`
      if (it.hint) {
        const hint = truncateToWidth(it.hint, 30)
        line += '  ' + (isCursor ? dim(hint) : dim(hint))
      }
      if (it.disabled && it.hint) line = line // hint already carries the reason
      rows.push(line)
      if (it.detail) rows.push(`      ${dim(truncateToWidth(it.detail, 68))}`)
    }
    if (this.visible.length > max) {
      const pos = `${this.offset + 1}–${Math.min(this.offset + max, this.visible.length)} of ${this.visible.length}`
      rows.push(dim(`  ${this.offset > 0 ? '↑' : ' '} ${this.offset + max < this.visible.length ? '↓' : ' '} ${pos}`))
    }
    const footer = this.opts.footer ?? (this.filterable ? 'type to filter' : '')
    rows.push(dim(`  ↑↓ move · enter select · esc cancel${footer ? ` · ${footer}` : ''}`))
    return rows
  }

  private render() {
    // clear previous frame
    if (this.linesDrawn > 0) {
      process.stdout.write(`\x1b[${this.linesDrawn}A`)
      for (let i = 0; i < this.linesDrawn; i++) process.stdout.write('\r\x1b[2K')
      process.stdout.write('\r')
    }
    const rows = this.rows()
    for (const r of rows) process.stdout.write(r + '\n')
    this.linesDrawn = rows.length
  }

  private finish(value: T | undefined) {
    this.done = true
    if (this.onData) process.stdin.removeListener('data', this.onData)
    try {
      if (this.prevRawMode === undefined) process.stdin.setRawMode(false)
      else process.stdin.setRawMode(this.prevRawMode)
    } catch { /* stdin gone */ }
    // clear the menu frame
    if (this.linesDrawn > 0) {
      process.stdout.write(`\x1b[${this.linesDrawn}A`)
      for (let i = 0; i < this.linesDrawn; i++) process.stdout.write('\r\x1b[2K')
      process.stdout.write('\r')
    }
    this.resolve(value)
  }
}

/** interactive single-select — returns undefined when cancelled */
export function select<T>(opts: SelectOptions<T>): Promise<T | undefined> {
  return new Menu<T>(opts).show()
}

/** y/n with arrow keys — `[y/N]` where the highlighted side flips with ← → */
export async function confirm(
  question: string,
  opts: { default?: boolean; yes?: string; no?: string; cancelable?: boolean } = {},
): Promise<boolean | undefined> {
  if (!isTTY || !process.stdin.isTTY) return opts.default ?? false
  const def = opts.default ?? false
  return new Promise<boolean | undefined>((resolve) => {
    let val = def
    let lines = 1
    const draw = () => {
      if (lines > 0) {
        process.stdout.write('\r\x1b[1A')
        process.stdout.write('\r\x1b[2K')
      }
      const yesTxt = val ? bold(cyan(` ${opts.yes ?? 'yes'} `)) : dim(` ${opts.yes ?? 'yes'} `)
      const noTxt = !val ? bold(yellow(` ${opts.no ?? 'no'} `)) : dim(` ${opts.no ?? 'no'} `)
      process.stdout.write(`  ${question} ${yesTxt} ${noTxt}${dim('  ←→ · enter')}\n`)
      lines = 1
    }
    const prevRaw = (process.stdin as { isRaw?: boolean }).isRaw
    const onKey = (buf: Buffer) => {
      const s = buf.toString('utf8')
      if (s === '\x03') return cleanup(undefined)
      if (s === '\x1b[D' || s === 'h' || s === 'y') { val = true; return draw() }
      if (s === '\x1b[C' || s === 'l' || s === 'n') { val = false; return draw() }
      if (s === '\r' || s === '\n') return cleanup(val)
      if (s === '\x1b') return cleanup(undefined)
    }
    const cleanup = (v: boolean | undefined) => {
      process.stdin.removeListener('data', onKey)
      try {
        if (prevRaw === undefined) process.stdin.setRawMode(false)
        else process.stdin.setRawMode(prevRaw)
      } catch { /* ignore */ }
      if (lines > 0) {
        process.stdout.write('\r\x1b[1A\r\x1b[2K')
      }
      resolve(v)
    }
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', onKey)
    draw()
  })
}

/** numbered quick-pick used for tiny inline choices (returns label of choice) */
export function choiceLabels(labels: string[], cursor = 0): SelectItem<number>[] {
  return labels.map((label, i) => ({ label, value: i, ...(i === cursor ? {} : {}) }))
}

export const selectColors = { bold, dim, cyan, red, yellow }
