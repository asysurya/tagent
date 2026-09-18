import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'

import {
  listProviderInfos,
  parseModelRef,
  listCheckpoints,
  listFacts,
  listSkills,
  CURRENT_VERSION,
  type LoopSummary,
  type PermissionRequest,
  type SessionData,
  type SubagentInfo,
  type TodoItem,
  type ToolCallRecord,
} from '@tagent/core'

import { AgentHost } from './host'
import type { DaemonHandle } from './daemon'

/**
 * The TUI — Tagent's primary interface.
 *
 * Pure stdin/stdout with a sprinkle of ANSI: it runs identically on a desktop
 * terminal, over SSH, and on a phone (Termux / UserLAnd). Every feature the
 * web GUI has is reachable here through slash commands; permissions prompt
 * inline; tokens stream live.
 *
 * Rendering model (keeps readline happy):
 *  - completed lines are APPENDED and never redrawn
 *  - one transient bottom row (the "ticker") shows the live status, the
 *    streamed partial line, or nothing
 *  - println() clears the ticker row, appends the line, re-renders the prompt
 *  - while a permission question is pending, agent output is buffered
 */

/* ------------------------------------------------------------------ */
/* ansi + format helpers                                               */
/* ------------------------------------------------------------------ */

const tty = !!process.stdout.isTTY
const c = (code: string, s: string) => (tty && process.env.NO_COLOR === undefined ? `\x1b[${code}m${s}\x1b[0m` : s)
const bold = (s: string) => c('1', s)
const dim = (s: string) => c('2', s)
const red = (s: string) => c('31', s)
const green = (s: string) => c('32', s)
const yellow = (s: string) => c('33', s)
const blue = (s: string) => c('34', s)
const magenta = (s: string) => c('35', s)
const cyan = (s: string) => c('36', s)

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const CLEAR_ROW = '\r\x1b[2K'

function width(): number {
  return Math.max((process.stdout.columns ?? 80) - 2, 40)
}

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

/* ------------------------------------------------------------------ */
/* the tui                                                             */
/* ------------------------------------------------------------------ */

export interface TuiOptions {
  workspaceRoot: string
  /** url of a web gui sharing this host (printed in the header) */
  webUrl?: string
}

export class Tui {
  private rl: readline.Interface
  private running = false
  private queued: string[] = []
  private runStartedAt = 0
  private todos: TodoItem[] = []
  private lastSubagentTurn = new Map<string, number>()
  private printedLines = 0
  private permissionFrozen = false
  private frozenBuffer: string[] = []
  private spinnerFrame = 0
  private spinnerTimer: ReturnType<typeof setInterval> | undefined
  private ticker = ''            // current transient row label (no spinner)
  private tickerMode: 'none' | 'status' | 'stream' = 'none'
  private streamLabel = ''
  private exited = false
  private lastCtrlC = 0
  private webUrl?: string
  /** on-demand relay endpoint (created by /relay, closed on exit) */
  private relayServer?: DaemonHandle
  private relayBase?: string

  constructor(private host: AgentHost, opts: TuiOptions) {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '',
      terminal: tty,
    })
    this.webUrl = opts.webUrl
  }

  /* ---------------- lifecycle ---------------- */

  async start(): Promise<void> {
    this.banner()
    this.wireHost()
    this.wireInput()

    // the most recent session is one /open away — keep its todos loaded
    const sessions = this.host.listSessions()
    if (sessions.length > 0) this.host.loadSession(sessions[0].id)

    this.setPrompt()
    this.rl.prompt()

    await new Promise<void>((resolve) => {
      this.rl.on('close', resolve)
    })
  }

  private banner() {
    const cfg = this.host.sanitizeConfig()
    const lines = [
      '',
      bold(cyan(`  Tagent v${CURRENT_VERSION}`)) + dim('  ·  terminal-native coding agent'),
      dim(`  workspace  ${this.host.root}`),
      dim(`  model      ${cfg.defaultModel} (${cfg.defaultProvider}) · mode: build · caveman: ${cfg.caveman ? 'on 🦴' : 'off'}`),
      this.webUrl
        ? dim(`  web gui    ${this.webUrl} (sharing this session)`)
        : dim('  web gui    off — /webgui on or start with --web-gui'),
      dim(`  ${bold('/help')} lists every command · plain text talks to the agent · Ctrl+C interrupts`),
      '',
    ]
    for (const l of lines) this.println(l)
  }

  /* ---------------- host events ---------------- */

  private wireHost() {
    const bus = this.host.bus
    bus.on('agent:status', (s: { phase: string; detail?: string }) => this.onStatus(s.phase, s.detail))
    bus.on('agent:chunk', (d: { text: string }) => this.onChunk(d.text))
    bus.on('message:new', (d: { message: { role: string; content: string } }) => {
      if (d.message.role === 'assistant') this.onAssistantMessage(d.message.content)
    })
    bus.on('tool:start', (d: { call: ToolCallRecord }) => this.onToolStart(d.call))
    bus.on('tool:end', (d: { call: ToolCallRecord }) => this.onToolEnd(d.call))
    bus.on('todos:update', (d: { todos: TodoItem[] }) => this.onTodos(d.todos))
    bus.on('subagent:update', (d: { info: SubagentInfo }) => this.onSubagent(d.info))
    bus.on('notify', (d: { level: string; message: string }) => {
      const icon = d.level === 'error' ? red('!') : d.level === 'warn' ? yellow('!') : blue('·')
      this.println(`  ${icon} ${d.message}`)
    })
    bus.on('permission:request', (req: PermissionRequest) => void this.onPermission(req))
    bus.on('chat:done', (d: { summary: LoopSummary }) => this.onChatDone(d.summary))
    bus.on('session:active', (s: SessionData) => {
      this.todos = s.todos ?? []
    })
  }

  private onStatus(phase: string, detail?: string) {
    if (phase === 'thinking') {
      const turn = detail?.match(/turn (\d+)/)?.[1] ?? ''
      this.showTicker('status', `thinking${turn ? ` · turn ${turn}` : ''}`)
    } else if (phase === 'acting') {
      this.showTicker('status', detail ?? 'acting')
    } else if (phase === 'done' || phase === 'error' || phase === 'aborted') {
      this.hideTicker()
    }
  }

  /** live token streaming: complete lines append, the partial rides the ticker */
  private onChunk(full: string) {
    if (!tty) return
    const lines = full.split('\n')
    const complete = lines.slice(0, -1)
    for (let i = this.printedLines; i < complete.length; i++) {
      this.println(complete[i] === '' ? '' : `  ${complete[i]}`)
    }
    this.printedLines = complete.length
    const partial = (lines[lines.length - 1] ?? '').trimEnd()
    if (partial) {
      this.streamLabel = partial.length > width() - 8 ? '…' + partial.slice(-(width() - 10)) : partial
      this.showTicker('stream', `${dim('│ ')}${this.streamLabel}${dim('▌')}`)
    }
  }

  private onAssistantMessage(content: string) {
    this.hideTicker()
    const lines = content.split('\n')
    for (let i = this.printedLines; i < lines.length; i++) {
      this.println(lines[i] === '' ? '' : `  ${lines[i]}`)
    }
    this.printedLines = 0
  }

  private onToolStart(call: ToolCallRecord) {
    this.hideTicker()
    this.println(`  ${dim(`⚙ ${call.tool} ${summarizeInput(call)}`)}`)
  }

  private onToolEnd(call: ToolCallRecord) {
    this.hideTicker()
    const icon = call.status === 'done' ? green('✓') : call.status === 'error' ? red('✗') : call.status === 'denied' ? yellow('⊘') : '·'
    const dur = call.startedAt && call.endedAt ? ` ${dim(((call.endedAt - call.startedAt) / 1000).toFixed(1) + 's')}` : ''
    const out = (call.output ?? '').split('\n').find((l) => l.trim()) ?? ''
    const tail = out ? ` ${dim('— ' + out.slice(0, 100))}` : ''
    this.println(`  ${icon} ${call.tool}${dur}${tail}`)
  }

  private onTodos(todos: TodoItem[]) {
    const prev = JSON.stringify(this.todos)
    this.todos = todos
    if (prev === JSON.stringify(todos) || todos.length === 0) return
    const done = todos.filter((t) => t.status === 'completed').length
    this.println(`  ${bold(`📋 ${done}/${todos.length}`)}`)
    for (const t of todos.slice(0, 12)) {
      const icon = t.status === 'completed' ? green('✔') : t.status === 'in_progress' ? cyan('▸') : dim('☐')
      const body = t.status === 'completed' ? dim(t.content) : t.content
      this.println(`   ${icon} ${body}`)
    }
  }

  private onSubagent(info: SubagentInfo) {
    const last = this.lastSubagentTurn.get(info.id) ?? -1
    if (info.turns === last) return
    this.lastSubagentTurn.set(info.id, info.turns)
    this.println(`  ${magenta('▸')} ${dim(`subagent · ${info.description} — turn ${info.turns}`)}`)
  }

  private async onPermission(req: PermissionRequest) {
    this.permissionFrozen = true
    this.hideTicker()
    const risk = req.risk === 'high' ? red('high') : req.risk === 'medium' ? yellow('medium') : green('low')
    this.println('')
    this.println(`  ${bold('┌ permission needed')} ${dim(`· risk: ${risk}`)}`)
    this.println(`  │ ${bold(req.tool)} ${dim(summarizeInput(req))}`)
    this.println(`  ${dim('└')} [y] allow · [n] deny · [a] always · [s] this session`)

    const answer = await this.ask('  ❯ ')
    const a = answer.trim().toLowerCase()
    const approved = a === '' || a === 'y' || a === 'a' || a === 's'
    const remember = a === 'a' ? 'always' : a === 's' ? 'session' : 'once'
    this.host.permissionRespond(req.id, approved, remember)
    this.permissionFrozen = false
    this.flushFrozen()
    this.println(approved ? green('  ✔ allowed') : yellow('  ⊘ denied'))
  }

  private onChatDone(summary: LoopSummary) {
    const secs = ((Date.now() - this.runStartedAt) / 1000).toFixed(1)
    this.hideTicker()
    const mark = summary.finished === 'complete' ? green('✔ done') : summary.finished === 'aborted' ? yellow('■ stopped') : red('✗ error')
    this.println(`  ${mark} ${dim(`· ${summary.turns} turns · ${summary.toolCalls} tool calls · ${secs}s`)}`)
    if (summary.error) this.println(`  ${red(summary.error)}`)
    this.running = false
    const next = this.queued.shift()
    if (next) {
      this.println(dim('  ↩ sending queued message…'))
      void this.send(next)
    } else {
      this.setPrompt()
    }
  }

  /* ---------------- ticker (transient bottom row) ---------------- */

  private showTicker(mode: 'status' | 'stream', label: string) {
    this.clearTickerRow()
    this.ticker = label
    this.tickerMode = mode
    if (!this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length
        this.redrawTicker()
      }, 100)
    }
    this.redrawTicker()
  }

  private hideTicker() {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer)
      this.spinnerTimer = undefined
    }
    this.clearTickerRow()
    this.tickerMode = 'none'
    this.ticker = ''
  }

  private redrawTicker() {
    if (this.tickerMode === 'none') return
    this.clearTickerRow()
    const content =
      this.tickerMode === 'status'
        ? `${cyan(SPINNER[this.spinnerFrame])} ${dim(this.ticker)}`
        : `${dim('│ ')}${this.ticker}${dim('▌')}`
    this.writeRaw(CLEAR_ROW + content)
    this.restorePromptAfterTicker()
  }

  private clearTickerRow() {
    if (this.tickerMode !== 'none') this.writeRaw(CLEAR_ROW)
  }

  /** the prompt lives on the same row as the ticker — re-show it after a clear */
  private restorePromptAfterTicker() {
    if (this.promptText && this.rl.line !== undefined) {
      this.writeRaw('\r' + this.promptText + this.rl.line)
    }
  }

  /* ---------------- output primitives ---------------- */

  private writeRaw(s: string) {
    process.stdout.write(s)
  }

  private println(s: string) {
    const out = s + '\n'
    if (this.permissionFrozen) {
      this.frozenBuffer.push(out)
      return
    }
    // clear the transient ticker row, print the line, then re-anchor the prompt
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer)
      this.spinnerTimer = undefined
    }
    this.clearTickerRow()
    this.tickerMode = 'none'
    if (this.promptText && this.rl.line !== undefined && tty) {
      this.writeRaw(CLEAR_ROW + out + this.promptText + this.rl.line)
    } else {
      this.writeRaw(CLEAR_ROW + out)
    }
  }

  private flushFrozen() {
    const buf = this.frozenBuffer
    this.frozenBuffer = []
    for (const b of buf) this.writeRaw(b)
    this.restorePromptAfterTicker()
  }

  private promptText = ''

  private setPrompt() {
    this.promptText = this.running ? dim('  …❯ ') : bold(cyan('  ❯ '))
    this.rl.setPrompt(this.promptText)
  }

  /* ---------------- input ---------------- */

  private wireInput() {
    this.rl.on('line', (line: string) => {
      if (this.permissionFrozen) return // consumed by the pending question
      const text = line.trim()
      if (!text) { this.rl.prompt(); return }
      void this.handleLine(text) // prompts are re-anchored by println()
    })
    this.rl.on('SIGINT', () => {
      if (this.permissionFrozen) return
      if (this.running) {
        this.println(yellow('  ■ interrupting…'))
        this.host.interrupt()
        return
      }
      const now = Date.now()
      if (now - this.lastCtrlC < 2000) {
        this.exit()
      } else {
        this.lastCtrlC = now
        this.println(dim('  Ctrl+C again to exit'))
        this.rl.prompt()
      }
    })
    this.rl.on('close', () => {
      this.writeRaw('\n')
      process.exit(0)
    })
  }

  private async handleLine(text: string) {
    if (text.startsWith('/')) {
      await this.command(text)
      if (!this.exited && !this.permissionFrozen && !this.running) this.setPrompt()
      return
    }
    if (this.running) {
      this.queued.push(text)
      this.println(dim('  ⏳ queued — sending after this run (/stop to interrupt)'))
      return
    }
    await this.send(text)
  }

  private async send(text: string) {
    this.running = true
    this.runStartedAt = Date.now()
    this.lastSubagentTurn.clear()
    this.setPrompt()
    this.println(`  ${bold('❯')} ${text}`)
    try {
      await this.host.chatSend(text)
    } catch (e) {
      this.println(red(`  ✗ ${(e as Error).message}`))
      this.running = false
      this.setPrompt()
    }
  }

  private ask(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(prompt, (answer) => resolve(answer ?? ''))
    })
  }

  /** hidden input for secrets (PAT / API keys) */
  private askHidden(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rl = this.rl as any
      const orig = rl._writeToOutput
      rl._writeToOutput = () => undefined
      this.rl.question(prompt, (answer) => {
        rl._writeToOutput = orig
        this.println('')
        resolve(answer ?? '')
      })
    })
  }

  exit() {
    this.exited = true
    this.hideTicker()
    this.host.interrupt()
    void this.relayServer?.close().catch(() => undefined)
    this.rl.close()
  }

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

  /* ------------------------------------------------------------------ */
  /* slash commands — full feature parity with the web gui                */
  /* ------------------------------------------------------------------ */

  private async command(raw: string) {
    const parts = raw.slice(1).split(/\s+/)
    const cmd = parts[0]
    const arg = parts.slice(1).join(' ')
    const host = this.host
    const cfg = host.sanitizeConfig()

    switch (cmd) {
      case 'help': case '?': {
        this.println(bold('\n  Tagent commands'))
        const rows: [string, string][] = [
          ['sessions · new [plan] · open <id> · delete <id>', 'session management'],
          ['share [id] · relay [id|list|stop <code>] · timeline', 'HTML export · live share · subagent runs'],
          ['mode [plan|build] · model [p[:m]]', 'planning vs build · pick llm'],
          ['caveman [on|off] · worklog [on|off] · maxturns <n>', 'agent behavior'],
          ['todos · log [n]', 'live plan · journal tail'],
          ['apikey <provider> · permissions · allow/deny/ask <tool>', 'access'],
          ['files [path] · read <f> · grep <pat> · sh <cmd>', 'workspace'],
          ['auth · push [msg]', 'GitHub'],
          ['checkpoints · undo · memory · skills · skill <n>', 'memory & history'],
          ['stats · settings · webgui [on|off]', 'info'],
          ['stop · clear · exit', 'run control'],
        ]
        for (const [k, v] of rows) this.println(`    ${bold('/' + k.padEnd(46))} ${dim(v)}`)
        this.println('')
        return
      }

      case 'new': {
        const mode = arg === 'plan' ? 'plan' : 'build'
        const s = host.newSession(mode)
        this.println(green(`  ✔ new ${mode} session · ${s.id}`))
        return
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
        if (!arg) return this.println(dim('  usage: /open <session-id-prefix>'))
        const s = host.listSessions().find((x) => x.id.startsWith(arg))
        if (!s) return this.println(red(`  no session starts with "${arg}"`))
        const loaded = host.loadSession(s.id)
        this.println(green(`  ✔ ${loaded?.title} · ${loaded?.messageCount} messages`))
        return
      }

      case 'delete': {
        if (!arg) return this.println(dim('  usage: /delete <session-id-prefix>'))
        const s = host.listSessions().find((x) => x.id.startsWith(arg))
        if (!s) return this.println(red(`  no session starts with "${arg}"`))
        host.deleteSession(s.id)
        this.println(green(`  ✔ deleted ${s.title}`))
        return
      }

      case 'share': {
        const r = host.share(arg || undefined)
        if (!r.ok) return this.println(red(`  ✗ ${r.error}`))
        this.println(green('  ✔ share exported'))
        this.println(`    ${dim('file')}  ${r.file}`)
        this.println(`    ${dim('url')}   ${this.webUrl ? this.webUrl.replace(/\/$/, '') + r.url : dim('run with --web-gui to serve it')}`)
        return
      }

      case 'relay': {
        const [sub, code] = arg.split(/\s+/)
        if (sub === 'stop') {
          if (!code) return this.println(dim('  usage: /relay stop <code> — see /relay list'))
          const r = host.relayRevoke(code)
          return this.println(r.ok ? green(`  ✔ relay ${code} ended`) : dim(`  no live relay ${code}`))
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
        if (!r.ok || !r.code) return this.println(red(`  ✗ ${r.error}`))
        const base = this.webUrl ?? this.relayBase
        if (!base) {
          try {
            await this.startRelayEndpoint()
          } catch (e) {
            return this.println(red(`  ✗ could not start the relay endpoint: ${(e as Error).message}`))
          }
        }
        const url = (this.webUrl ?? this.relayBase ?? '').replace(/\/$/, '') + r.url
        this.println(green(`  ✔ live relay for "${target.title}"`))
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
        if (arg === 'plan' || arg === 'build') {
          host.setSessionMode(arg)
          this.println(green(`  ✔ mode: ${arg}`))
        } else {
          const cur = host.session?.mode ?? 'build'
          this.println(`  mode: ${bold(cur)} ${dim('— /mode plan or /mode build')}`)
        }
        return
      }

      case 'model': {
        if (!arg) {
          const infos = listProviderInfos(host.cfg)
          const ready = infos.filter((p) => !p.needsKey || p.hasKey)
          const locked = infos.filter((p) => p.needsKey && !p.hasKey)
          this.println(`  current: ${bold(cfg.defaultModel)} ${dim(`(${cfg.defaultProvider})`)}`)
          this.println(bold('  ready'))
          for (const p of ready) {
            const mark = p.id === host.cfg.defaultProvider ? green('▸') : ' '
            const key = !p.needsKey ? dim('free') : p.hasKey ? green('key✓') : red('no key')
            this.println(`  ${mark} ${bold(p.id.padEnd(16))} ${key} ${dim(p.models.map((m) => m.id).slice(0, 4).join(', '))}${p.models.length > 4 ? dim(` +${p.models.length - 4}`) : ''}`)
          }
          if (locked.length) this.println(dim(`  ${locked.length} more in the catalog (add a key): ${locked.slice(0, 8).map((p) => p.id).join(', ')}${locked.length > 8 ? '…' : ''}`))
          this.println(dim('  set: /model <provider>/<model> · search: /model <text> · /model refresh'))
          return
        }
        if (arg === 'refresh' || arg === 'discover') {
          this.println(dim('  discovering models (GET /models on every provider with a key)…'))
          const r = await host.providersRefresh()
          this.println(green(`  ✔ ${r.updated.length} provider(s) refreshed${r.failed.length ? red(` · ${r.failed.length} unreachable`) : ''}`))
          if (r.updated.length) this.println(dim(`    ${r.updated.join(', ')}`))
          return
        }
        // "provider/model" (opencode style) or legacy "provider:model"
        const ref = parseModelRef(arg, host.cfg)
        if (ref) {
          const info = listProviderInfos(host.cfg).find((p) => p.id === ref.provider)
          if (!info) return this.println(red(`  unknown provider "${ref.provider}" — /model to list`))
          if (info.needsKey && !info.hasKey) return this.println(red(`  ${ref.provider} has no key yet — /apikey ${ref.provider}`))
          host.settingsSave({ defaultProvider: ref.provider, defaultModel: ref.model })
          this.println(green(`  ✔ ${ref.provider} · ${ref.model}`))
          return
        }
        // exact provider id → pick its first model
        const info = listProviderInfos(host.cfg).find((p) => p.id === arg)
        if (info) {
          if (info.needsKey && !info.hasKey) return this.println(red(`  ${info.id} has no key yet — /apikey ${info.id}`))
          const nextModel = info.models[0]?.id
          if (!nextModel) return this.println(red(`  provider "${info.id}" has no models configured — /model refresh`))
          host.settingsSave({ defaultProvider: info.id, defaultModel: nextModel })
          this.println(green(`  ✔ ${info.id} · ${nextModel}`))
          return
        }
        // otherwise: search across providers and models
        const q = arg.toLowerCase()
        const infos = listProviderInfos(host.cfg)
        const provHits = infos.filter((p) => p.id.includes(q) || p.label.toLowerCase().includes(q))
        const modelHits = infos.flatMap((p) => p.models.filter((m) => m.id.toLowerCase().includes(q)).map((m) => ({ p, m })))
        if (provHits.length + modelHits.length === 0) return this.println(red(`  nothing matches "${arg}" — /model to list everything`))
        if (provHits.length + modelHits.length === 1) {
          const hit = provHits.length ? { provider: provHits[0].id, model: provHits[0].models[0]?.id } : { provider: modelHits[0].p.id, model: modelHits[0].m.id }
          if (!hit.model) return this.println(red(`  ${hit.provider} has no models — /model refresh`))
          host.settingsSave({ defaultProvider: hit.provider, defaultModel: hit.model })
          this.println(green(`  ✔ ${hit.provider} · ${hit.model}`))
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
        this.println(green(`  ✔ caveman mode ${v ? 'ON 🦴 — terse replies, compact prompts' : 'off'}`))
        return
      }

      case 'worklog': {
        const v = arg === 'on' ? true : arg === 'off' ? false : !cfg.worklog.enabled
        host.settingsSave({ worklogEnabled: v })
        this.println(green(`  ✔ worklog + todos ${v ? 'on — the agent journals to WORKLOG.md' : 'off'}`))
        return
      }

      case 'webgui': {
        const cur = host.cfg.webGui === true
        const v = arg === 'on' ? true : arg === 'off' ? false : !cur
        const { updateGlobalConfig } = await import('@tagent/core')
        updateGlobalConfig({ webGui: v })
        this.println(green(`  ✔ web gui will ${v ? 'start' : 'not start'} with ${bold('tagent start')}`))
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
        this.println(green(`  ✔ turn budget: ${Math.round(n)}`))
        return
      }

      case 'apikey': {
        if (!arg) return this.println(dim('  usage: /apikey <provider> — see /model for ids'))
        const key = await this.askHidden('  key ❯ ')
        host.settingsSave({ apiKey: { provider: arg, key } })
        this.println(green(`  ✔ key saved for ${arg}`))
        return
      }

      case 'permissions': {
        this.println(bold('  permissions') + dim(` · default: ${host.cfg.permissions.defaultMode}`))
        for (const [tool, mode] of Object.entries(host.cfg.permissions.tools)) {
          const color = mode === 'allow' ? green(mode) : mode === 'deny' ? red(mode) : yellow(mode)
          this.println(`    ${tool.padEnd(14)} ${color}`)
        }
        this.println(dim('    change: /allow <tool> · /ask <tool> · /deny <tool>'))
        return
      }

      case 'allow': case 'ask': case 'deny': {
        if (!arg) return this.println(dim(`  usage: /${cmd} <tool>`))
        const perm = { ...(host.cfg.permissions) }
        perm.tools = { ...perm.tools, [arg]: cmd }
        host.settingsSave({ permissions: perm })
        this.println(green(`  ✔ ${arg} → ${cmd}`))
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
          this.println(red(`  ✗ ${(e as Error).message}`))
        }
        return
      }

      case 'grep': {
        if (!arg) return this.println(dim('  usage: /grep <pattern>'))
        const hits = this.grepWorkspace(arg)
        if (hits.length === 0) return this.println(dim('  no matches'))
        for (const h of hits.slice(0, 40)) {
          this.println(`  ${bold(h.file)}${dim(':' + h.line)}  ${h.text.slice(0, width() - 30)}`)
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

      case 'push': {
        const github = host.cfg.github ?? {}
        if (!github.token) return this.println(red('  not connected — /auth first'))
        this.println(dim('  pushing…'))
        try {
          const r = await host.githubPush(arg || undefined)
          const res = (r as { result: { repo: string; commit: string } }).result
          this.println(green(`  ✔ pushed to ${res.repo} (${res.commit})`))
        } catch (e) {
          this.println(red(`  ✗ ${(e as Error).message}`))
        }
        return
      }

      case 'checkpoints': {
        const cps = listCheckpoints(host.root).slice(0, 12)
        if (cps.length === 0) return this.println(dim('  no snapshots yet'))
        for (const cp of cps) {
          this.println(`   ${cyan('◉')} ${dim(fmtWhen(cp.at))} · ${cp.reason}`)
        }
        return
      }

      case 'undo': {
        const r = host.undoCheckpoint() as { ok: boolean; checkpoint: { reason?: string } | null }
        if (r.ok) this.println(green(`  ✔ rolled back · ${r.checkpoint?.reason ?? ''}`))
        else this.println(dim('  nothing to undo'))
        return
      }

      case 'memory': {
        const facts = listFacts(host.root)
        if (facts.length === 0) return this.println(dim('  no memory facts — the agent saves them via the memory tool'))
        for (const f of facts.slice(0, 20)) this.println(`   ${magenta('◆')} ${f.text}`)
        return
      }

      case 'skills': {
        const skills = listSkills(host.root)
        if (skills.length === 0) return this.println(dim('  no skills installed'))
        for (const s of skills) this.println(`   ${bold(s.name)} ${dim(`(${s.source})`)} — ${s.description}`)
        return
      }

      case 'skill': {
        if (!arg) return this.println(dim('  usage: /skill <name>'))
        try {
          const r = host.skillRead(arg) as { content: string }
          for (const l of r.content.split('\n').slice(0, 60)) this.println(`  ${l}`)
        } catch (e) {
          this.println(red(`  ✗ ${(e as Error).message}`))
        }
        return
      }

      case 'stats': {
        const st = host.stats()
        this.println(`  ${bold('sessions')} ${st.sessions} · ${bold('snapshots')} ${st.snapshots}`)
        return
      }

      case 'settings': {
        const s = JSON.parse(
          JSON.stringify(host.sanitizeConfig(), (k, v) => (k === 'providers' ? undefined : v)),
        ) as Record<string, unknown>
        for (const [k, v] of Object.entries(s)) {
          this.println(`  ${k.padEnd(18)} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        }
        return
      }

      case 'stop': {
        if (!this.running) return this.println(dim('  nothing running'))
        this.host.interrupt()
        this.println(yellow('  ■ interrupting…'))
        return
      }

      case 'clear': {
        this.writeRaw('\x1b[2J\x1b[H')
        this.banner()
        return
      }

      case 'exit': case 'quit': case 'q': {
        this.exit()
        return
      }

      default:
        this.println(dim(`  unknown command /${cmd} — /help`))
    }
  }

  /* ---------------- auth wizard ---------------- */

  private async authWizard() {
    const host = this.host
    const github = host.cfg.github ?? {}
    if (github.token) {
      this.println(green(`  ✔ connected as ${github.login}`))
      const a = await this.ask(dim('  switch account? [l]ogout · [Enter]=stay '))
      if (a.trim().toLowerCase().startsWith('l')) {
        await host.githubLogout()
        this.println(dim('  logged out'))
      }
      return
    }
    this.println(bold('  GitHub login'))
    this.println(dim('  1) device flow — no secrets pasted (needs TAGENT_GH_CLIENT_ID)'))
    this.println(dim('  2) personal access token — works everywhere'))
    const a = (await this.ask(`  ${bold('choose')} [1/2] `)).trim()
    try {
      if (a === '1') {
        const start = await host.githubDeviceStart()
        this.println(`\n  ${bold('open')}  ${start.verification_uri}`)
        this.println(`  ${bold('code')}   ${bold(cyan(start.user_code))}\n`)
        this.println(dim('  waiting for authorization…'))
        const r = await host.githubDevicePoll()
        this.println(green(`  ✔ logged in as ${r.login}`))
      } else if (a === '2') {
        const token = (await this.askHidden('  token ❯ ')).trim()
        if (!token) return this.println(dim('  cancelled'))
        const r = await host.githubPat(token)
        this.println(green(`  ✔ logged in as ${r.login}`))
      } else {
        return this.println(dim('  cancelled'))
      }
      this.println(dim('  push this workspace any time with /push'))
    } catch (e) {
      this.println(red(`  ✗ ${(e as Error).message}`))
    }
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
}

/* ------------------------------------------------------------------ */
/* non-tty (pipe) mode — `echo "fix X" | tagent start`                  */
/* ------------------------------------------------------------------ */

export async function runPiped(host: AgentHost): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin })
  let busy = false
  const queue: string[] = []
  const drained = () => !busy && queue.length === 0
  // one-shot/pipe mode cannot answer prompts — deny them explicitly
  host.bus.on('permission:request', (req: PermissionRequest) => {
    console.log(`[permission] ${req.tool} (risk: ${req.risk}) — denied in pipe mode (pre-allow with /allow or config)`)
    host.permissionRespond(req.id, false)
  })
  // print the agent's answers as they finalize
  host.bus.on('message:new', (d: { message: { role: string; content: string; meta?: { toolResults?: boolean } } }) => {
    const m = d.message
    if (m.role === 'assistant' && !m.meta?.toolResults && m.content.trim()) {
      console.log(m.content + '\n')
    }
  })
  const next = async () => {
    if (busy || queue.length === 0) {
      return
    }
    busy = true
    const text = queue.shift()!
    try {
      const summary = await host.chatSend(text)
      console.log(`— ${summary.turns} turns · ${summary.toolCalls} tool calls · ${summary.finished}`)
    } catch (e) {
      console.error(`error: ${(e as Error).message}`)
      process.exitCode = 1
    }
    busy = false
    void next()
  }
  rl.on('line', (line) => {
    const t = line.trim()
    if (!t) return
    if (t === '/exit' || t === '/quit') { rl.close(); process.exit(0) }
    queue.push(t)
    void next()
  })
  await new Promise<void>((resolve) => {
    // resolve only when stdin is closed AND nothing is queued/running —
    // never before the first 'line' event had a chance to arrive
    rl.on('close', () => {
      const timer = setInterval(() => {
        if (drained()) { clearInterval(timer); resolve() }
      }, 100)
    })
  })
  // give the last console.log a beat to flush
  await new Promise((r) => setTimeout(r, 50))
  process.exit(0)
}
