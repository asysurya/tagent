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
  SUBAGENT_TEMPLATE,
  type LoopSummary,
  type PermissionRequest,
  type SessionData,
  type SubagentInfo,
  type TodoItem,
  type ToolCallRecord,
  type AgentMode,
} from '@tagent/core'

import { AgentHost } from './host'
import type { DaemonHandle } from './daemon'
import { select, confirm, type SelectItem } from './select'
import { startupUpdatePrompt, selfUpdate } from './updater'

/**
 * The TUI — Tagent's primary interface.
 *
 * Pure stdin/stdout with a sprinkle of ANSI: it runs identically on a desktop
 * terminal, over SSH, and on a phone (Termux / UserLAnd). Every feature the
 * web GUI has is reachable here through slash commands; permissions prompt
 * inline; tokens stream live; menus are interactive — arrow keys + Enter,
 * like opencode.
 *
 * Rendering model (keeps readline happy):
 *  - completed lines are APPENDED and never redrawn
 *  - one transient bottom row (the "ticker") shows the live status, the
 *    streamed partial line, or nothing
 *  - println() clears the ticker row, appends the line, re-renders the prompt
 *  - while a permission question is pending, agent output is buffered
 *  - select() menus pause readline, take raw stdin, restore cleanly
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

    // update check — arrow-key y/N, right after the banner
    await startupUpdatePrompt()

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
    const mcpStatus = cfg.mcpStatus as { state: string; tools: number }[] | undefined
    const mcpReady = (mcpStatus ?? []).filter((s) => s.state === 'ready')
    const lines = [
      '',
      bold(cyan(`  Tagent v${CURRENT_VERSION}`)) + dim('  ·  terminal-native coding agent'),
      dim(`  workspace  ${this.host.root}`),
      dim(`  model      ${cfg.defaultModel} (${cfg.defaultProvider}) · mode: build · caveman: ${cfg.caveman ? 'on 🦴' : 'off'}`),
      mcpReady.length
        ? dim(`  mcp        ${mcpReady.length} server(s) connected · ${mcpReady.reduce((n, s) => n + s.tools, 0)} tools (/mcp)`)
        : dim('  mcp        none — /mcp adds Model Context Protocol servers'),
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

    const choice = await this.pick(
      [
        { label: 'allow once', hint: 'this call only', value: 'once' },
        { label: 'always allow', hint: `remember \`${req.tool}\``, value: 'always' },
        { label: 'allow this session', hint: 'until Tagent exits', value: 'session' },
        { label: 'deny', hint: 'stop this call', value: 'deny' },
      ],
      '└ allow?',
      { footer: 'a=always · s=session · y=once · n=deny' },
    )
    const a = choice ?? 'deny'
    const approved = a === 'once' || a === 'always' || a === 'session'
    const remember = a === 'always' ? 'always' : a === 'session' ? 'session' : 'once'
    this.host.permissionRespond(req.id, approved, remember)
    this.permissionFrozen = false
    this.flushFrozen()
    this.println(approved ? green('  ✔ allowed') : yellow('  ⊘ denied'))
  }

  /** mode switch banner — tells the user (and the next prompt run) what the job is */
  private printModeBanner(mode: AgentMode) {
    if (mode === 'plan') {
      this.println(green('  ✔ mode: plan — read-only'))
      this.println(dim('    the agent investigates, INTERVIEWS you for missing detail, then delivers a plan'))
      this.println(dim('    approving the plan writes PRD.md and switches to build automatically'))
    } else if (mode === 'test') {
      this.println(green('  ✔ mode: test — QA agent'))
      this.println(dim('    the agent runs the project (serve), clicks through it (browser), screenshots + audits'))
      this.println(dim('    responsive (mobile/tablet/desktop) and visuals — then writes TEST-REPORT.md'))
      this.println(dim('    read-only for source files · playwright needed: bun add playwright && bunx playwright install chromium'))
    } else {
      this.println(green('  ✔ mode: build — full write access'))
      this.println(dim('    the agent reads PRD.md first when present, implements, and verifies its work'))
    }
  }

  private onChatDone(summary: LoopSummary) {
    const secs = ((Date.now() - this.runStartedAt) / 1000).toFixed(1)
    this.hideTicker()
    const mark = summary.finished === 'complete' ? green('✔ done') : summary.finished === 'aborted' ? yellow('■ stopped') : red('✗ error')
    // token accounting — only when the provider reports usage in its stream
    const u = summary.usage
    const tok = u
      ? ` · ${fmtTok(u.input)} in / ${fmtTok(u.output)} out${u.cacheRead ? ` (${fmtTok(u.cacheRead)} cache-hit)` : ''}`
      : ''
    this.println(`  ${mark} ${dim(`· ${summary.turns} turns · ${summary.toolCalls} tool calls · ${secs}s${tok}`)}`)
    if (summary.error) this.println(`  ${red(summary.error)}`)
    this.running = false
    // plan mode delivered a plan → offer the approve-and-build flow
    if (summary.plan) void this.offerPlan(summary.plan)
    const next = this.queued.shift()
    if (next) {
      this.println(dim('  ↩ sending queued message…'))
      void this.send(next)
    } else {
      this.setPrompt()
    }
  }

  /** plan approval — arrow-key y/N; yes writes PRD.md and starts the build */
  private async offerPlan(_plan: string) {
    // give the done-line a beat before drawing the prompt box
    await new Promise((r) => setTimeout(r, 150))
    this.println('')
    this.println(`  ${bold('┌ plan ready')}`)
    this.println(dim('  │ approve → writes PRD.md · switches to build · starts implementing'))
    const yes = await this.askYesNo('└ execute this plan?', true)
    if (yes === undefined) return this.println(dim('  — ask again anytime, or /mode build to switch manually'))
    const r = this.host.approvePlan(yes)
    if (!r.ok && r.error) this.println(red(`  ✗ ${r.error}`))
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
      // give stdout a beat to flush — process.exit() can drop pending pty/pipe
      // writes and swallow the output of the command right before /exit
      setTimeout(() => process.exit(0), 100)
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

  /* ---------------- interactive menus (arrow keys) ---------------- */

  /** drop to a fresh row so a menu can draw under the prompt */
  private freshRow() {
    this.clearTickerRow()
    this.writeRaw('\n')
  }

  /**
   * The interactive picker — pauses readline, takes raw stdin, restores.
   * Returns undefined when the user hits Esc / Ctrl+C (never exits the app).
   */
  private async pick<T>(
    items: SelectItem<T>[],
    title: string,
    opts: { selected?: number; filterable?: boolean; footer?: string; maxVisible?: number } = {},
  ): Promise<T | undefined> {
    if (items.length === 0) return undefined
    this.freshRow()
    this.rl.pause()
    try {
      return await select<T>({
        title,
        items,
        selected: opts.selected,
        filterable: opts.filterable,
        footer: opts.footer,
        maxVisible: opts.maxVisible,
      })
    } finally {
      this.rl.resume()
    }
  }

  /** arrow-key y/n — used for quick confirmations */
  private async askYesNo(question: string, def = false): Promise<boolean | undefined> {
    this.freshRow()
    this.rl.pause()
    try {
      return await confirm(question, { default: def, cancelable: true })
    } finally {
      this.rl.resume()
    }
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
          ['mode [plan|build] · model [p[:m]|custom]', 'planning vs build · pick llm · add your own endpoint'],
          ['agents · mcp · plugins', 'custom subagents · MCP servers · plugin manager'],
          ['fallback [add <p> <m> [key]|rm <n>|clear]', 'provider failover chain'],
          ['diag [cmd|off|test]', 'auto-diagnostics gate (lint/typecheck loop)'],
          ['caveman [on|off] · worklog [on|off] · maxturns <n>', 'agent behavior'],
          ['todos · log [n]', 'live plan · journal tail'],
          ['apikey <provider> · permissions · allow/deny/ask <tool>', 'access'],
          ['files [path] · read <f> · grep <pat> · sh <cmd>', 'workspace'],
          ['auth · push [msg]', 'GitHub'],
          ['checkpoints · undo · memory · skills · skill <n>', 'memory & history'],
          ['stats · settings · update · webgui [on|off]', 'info · self-update'],
          ['stop · clear · exit', 'run control'],
        ]
        for (const [k, v] of rows) this.println(`    ${bold('/' + k.padEnd(46))} ${dim(v)}`)
        this.println('')
        return
      }

      case 'new': {
        let mode: AgentMode | undefined =
          arg === 'plan' || arg === 'build' || arg === 'test' ? arg : undefined
        if (!mode) {
          const pick = await this.pick(
            [
              { label: 'build', hint: 'the agent can write files & run commands', value: 'build' as const },
              { label: 'plan', hint: 'read-only — interview → plan → PRD approval', value: 'plan' as const },
              { label: 'test', hint: 'QA — run the app, click through it, report', value: 'test' as const },
            ],
            'new session — mode',
          )
          if (!pick) return this.println(dim('  cancelled'))
          mode = pick
        }
        const s = host.newSession(mode)
        this.println(green(`  ✔ new ${mode} session · ${s.id}`))
        if (mode === 'test') this.printModeBanner('test')
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
        if (!arg) {
          const list = host.listSessions()
          if (list.length === 0) return this.println(dim('  no sessions yet — just start typing'))
          const id = await this.pick(
            list.slice(0, 50).map((s) => ({
              label: s.title,
              hint: `${s.mode} · ${s.messageCount} msgs · ${fmtWhen(s.updatedAt)}`,
              detail: `id ${s.id.slice(0, 8)}${host.session?.id === s.id ? ' · active' : ''}`,
              value: s.id,
            })),
            'open session',
            { filterable: true },
          )
          if (!id) return this.println(dim('  cancelled'))
          const s = host.listSessions().find((x) => x.id === id)
          const loaded = host.loadSession(id)
          this.println(green(`  ✔ ${loaded?.title} · ${loaded?.messageCount} messages`))
          return
        }
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
        if (arg === 'plan' || arg === 'build' || arg === 'test') {
          host.setSessionMode(arg)
          this.printModeBanner(arg)
          return
        }
        const pick = await this.pick(
          [
            { label: 'build', hint: 'write files, run commands, finish the job', value: 'build' as const },
            { label: 'plan', hint: 'read-only — interview → PRD → approval', value: 'plan' as const },
            { label: 'test', hint: 'QA — run the app, click through, report', value: 'test' as const },
          ],
          'mode',
          { selected: host.session?.mode === 'plan' ? 1 : host.session?.mode === 'test' ? 2 : 0 },
        )
        if (!pick) return this.println(dim('  cancelled'))
        host.setSessionMode(pick)
        this.printModeBanner(pick)
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
        // /model list — the flat catalog view
        if (arg === 'list' || arg === 'catalog') {
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
          this.println(dim('  interactive: /model · set: /model <provider>/<model> · search: /model <text>'))
          return
        }
        // /model custom → straight into the custom-provider wizard
        if (arg === 'custom' || arg === 'add') return this.customProviderWizard()
        // no arg → the interactive picker (providers, then models)
        if (!arg) {
          const infos = listProviderInfos(host.cfg)
          if (infos.length === 0) return this.println(red('  no providers configured'))
          const ready = infos.filter((p) => !p.needsKey || p.hasKey)
          const locked = infos.filter((p) => p.needsKey && !p.hasKey)
          const provItems: SelectItem<string>[] = [
            {
              label: '+ add custom provider…', hint: 'any endpoint', value: '__add_custom__', keep: true,
              detail: 'OpenAI-compatible · Anthropic · Google — your base url, your models',
            },
            ...ready.map((p) => ({
              label: p.label,
              hint: `${!p.needsKey ? 'free' : 'key ✓'} · ${p.models.length} models${p.custom ? ' · custom' : ''}`,
              detail: `${p.id}${p.id === host.cfg.defaultProvider ? ' · current' : ''}`,
              value: p.id,
            })),
            ...locked.map((p) => ({
              label: p.label,
              hint: 'needs key',
              detail: `${p.id} — add a key to unlock`,
              value: p.id,
              disabled: false,
            })),
          ]
          const cur = provItems.findIndex((i) => i.value === host.cfg.defaultProvider)
          const provId = await this.pick(provItems, 'provider', {
            filterable: true, selected: Math.max(0, cur), footer: 'type to search · esc cancel',
          })
          if (!provId) return this.println(dim('  cancelled'))
          if (provId === '__add_custom__') return this.customProviderWizard()
          const info = infos.find((p) => p.id === provId)
          if (!info) return this.println(red(`  unknown provider "${provId}"`))
          if (info.needsKey && !info.hasKey) {
            const setKey = await this.askYesNo(`  ${bold(provId)} needs an API key — add it now?`, true)
            if (!setKey) return this.println(dim(`  cancelled — /apikey ${provId} any time`))
            const key = (await this.askHidden('  key ❯ ')).trim()
            if (!key) return this.println(dim('  cancelled — empty key'))
            host.settingsSave({ apiKey: { provider: provId, key } })
            this.println(green(`  ✔ key saved for ${provId}`))
          }
          if (info.models.length === 0 && !info.custom) {
            const wantRefresh = await this.askYesNo(`  no cached models for ${provId} — discover now?`, true)
            if (!wantRefresh) return this.println(dim('  cancelled — try /model refresh later'))
            this.println(dim('  discovering models…'))
            await host.providersRefresh()
            const again = listProviderInfos(host.cfg).find((p) => p.id === provId)
            if (!again || again.models.length === 0) return this.println(red(`  discovery found nothing for ${provId} — /model ${provId} <model-id> to set one by hand`))
            info.models = again.models
          }
          const mcur = info.models.findIndex((m) => m.id === host.cfg.defaultModel && provId === host.cfg.defaultProvider)
          const modelId = await this.pick(
            [
              ...info.models.map((m) => ({ label: m.id, hint: m.label, value: m.id })),
              {
                label: '+ custom model id…', hint: 'type any id', value: '__custom_model__', keep: true,
                detail: `for endpoints whose list is missing or wrong — saved as ${provId}/<id>`,
              },
            ],
            `${provId} — model`,
            { filterable: true, selected: Math.max(0, mcur), footer: 'type to search · esc cancel' },
          )
          if (!modelId) return this.println(dim('  cancelled'))
          if (modelId === '__custom_model__') {
            const custom = (await this.ask('  model id ❯ ')).trim()
            if (!custom) return this.println(dim('  cancelled'))
            // persist into a custom provider's list so the picker learns it
            const cp = host.cfg.customProviders?.find((p) => p.id === provId)
            if (cp && !(cp.models ?? []).includes(custom)) {
              host.settingsSave({ customProvider: { ...cp, models: [...(cp.models ?? []), custom] } })
            }
            host.settingsSave({ defaultProvider: provId, defaultModel: custom })
            this.println(green(`  ✔ ${provId} · ${custom}`))
            return
          }
          host.settingsSave({ defaultProvider: provId, defaultModel: modelId })
          this.println(green(`  ✔ ${provId} · ${modelId}`))
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
        if (provHits.length + modelHits.length === 0) {
          return this.println(red(`  nothing matches "${arg}" — /model to list everything · /model custom to add your own`))
        }
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

      case 'agents': case 'agent': {
        const sub = arg.split(/\s+/)[0]
        if (sub === 'new') {
          const name = (arg.split(/\s+/)[1] || 'my-specialist').replace(/\.md$/, '')
          const dir = path.join(host.root, '.tagent', 'agents')
          fs.mkdirSync(dir, { recursive: true })
          const file = path.join(dir, `${name}.md`)
          if (fs.existsSync(file)) return this.println(yellow(`  ${name}.md already exists`))
          fs.writeFileSync(file, SUBAGENT_TEMPLATE)
          this.println(green(`  ✔ created .tagent/agents/${name}.md — edit it, it hot-loads next run`))
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
          this.println(r.ok ? green(`  ✔ pass · ${(r.ms / 1000).toFixed(1)}s`) : red(`  ✗ fail · ${(r.ms / 1000).toFixed(1)}s${r.timedOut ? ' (timed out)' : ''}`))
          if (r.output) this.println(r.output.split('\n').slice(0, 15).map((l) => `  ${dim(l)}`).join('\n'))
          return
        }
        if (arg === 'off' || arg === 'none' || arg === 'clear') {
          host.settingsSave({ diagnosticsCommand: '' })
          return this.println(green('  ✔ diagnostics gate off'))
        }
        if (arg) {
          host.settingsSave({ diagnosticsCommand: arg })
          this.println(green(`  ✔ diagnostics gate: ${bold(arg)}`))
          this.println(dim('    runs once per edit turn; failures are fed back to the agent'))
          return
        }
        this.println(cur
          ? `  diagnostics: ${bold(cur)}`
          : dim('  diagnostics off — /diag "tsc --noEmit" or /diag "npm run lint" to arm the gate'))
        this.println(dim('    /diag test runs it once · /diag off disarms'))
        return
      }

      case 'fallback': {
        const [verb, ...rest] = arg.split(/\s+/)
        const list = [...(host.cfg.fallback ?? [])]
        if (verb === 'add') {
          const [provider, model, ...keyParts] = rest
          if (!provider || !model) return this.println(dim('  usage: /fallback add <provider> <model> [apiKey]'))
          const key = keyParts.join(' ')
          list.push({ provider, model, ...(key ? { apiKey: key } : {}), enabled: true })
          host.settingsSave({ fallback: list })
          return this.println(green(`  ✔ fallback #${list.length}: ${provider}/${model}${key ? ' (own key)' : ''}`))
        }
        if (verb === 'rm') {
          const i = Number(rest[0]) - 1
          if (!(i >= 0 && i < list.length)) return this.println(dim(`  usage: /fallback rm <1-${list.length}>`))
          const [gone] = list.splice(i, 1)
          host.settingsSave({ fallback: list })
          return this.println(green(`  ✔ removed ${gone.provider}/${gone.model}`))
        }
        if (verb === 'clear') {
          host.settingsSave({ fallback: [] })
          return this.println(green('  ✔ fallback chain cleared'))
        }
        const { chain } = host.fallbackChainView()
        this.println(bold('  provider fallback chain (try top → bottom)'))
        for (const [i, c] of chain.entries()) {
          this.println(`   ${c.primary ? green('①') : dim(String(i + 1))} ${bold(c.label)} ${dim(`· ${c.model}`)}`)
        }
        this.println(dim('    add: /fallback add <provider> <model> [apiKey] · rm: /fallback rm <n> · full editor: web gui settings'))
        this.println(dim('    same provider + different apiKey = key-level failover (stack freely)'))
        return
      }

      case 'apikey': {
        let prov = arg
        if (!prov) {
          const infos = listProviderInfos(host.cfg)
          const provs = infos.filter((p) => p.needsKey)
          if (provs.length === 0) return this.println(dim('  every configured provider is keyless'))
          prov = await this.pick(
            provs.map((p) => ({
              label: p.label,
              hint: p.hasKey ? 'key ✓' : 'no key',
              detail: p.id,
              value: p.id,
            })),
            'provider — api key',
            { filterable: true },
          )
          if (!prov) return this.println(dim('  cancelled'))
        }
        const key = await this.askHidden('  key ❯ ')
        host.settingsSave({ apiKey: { provider: prov, key } })
        this.println(green(`  ✔ key saved for ${prov}`))
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
        const { checkUpdate } = await import('@tagent/core')
        const info = await checkUpdate(true)
        if (!info) return this.println(red('  could not reach the update endpoint (offline?)'))
        if (!info.outdated) return this.println(green(`  ✔ up to date — v${info.current}`))
        this.println(`  update available: v${info.current} → ${bold('v' + info.latest)}`)
        if (info.notes) this.println(dim(`  ${info.notes}`))
        const yes = await this.askYesNo('  update now?', true)
        if (yes) await selfUpdate(info)
        else this.println(dim(`  later — ${info.url ?? 'https://github.com/asysurya/tagent/releases'}`))
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

      default: {
        // plugin commands? (custom /commands exported by .tagent/plugins/*.mjs)
        const r = await host.pluginCommandRun(cmd, arg)
        if (r.ok) {
          if (r.output) this.println(`  ${r.output}`)
          return
        }
        if (!/no plugin command named/.test(r.error ?? '')) {
          this.println(red(`  ✗ ${r.error}`))
          return
        }
        this.println(dim(`  unknown command /${cmd} — /help`))
      }
    }
  }

  /**
   * The custom-provider wizard — any OpenAI-compatible / Anthropic / Google
   * endpoint (ollama, lm studio, openrouter, self-hosted gateways…).
   * /model custom, or the "+ add custom provider…" picker entry.
   */
  private async customProviderWizard(): Promise<void> {
    const host = this.host
    this.println(bold('  add a custom provider'))
    this.println(dim('    works with ollama, lm studio, openrouter, any /chat/completions endpoint'))
    const label = (await this.ask('  label (e.g. "My Ollama") ❯ ')).trim()
    if (!label) return this.println(dim('  cancelled'))
    const baseUrl = (await this.ask('  base url (e.g. http://localhost:11434/v1) ❯ ')).trim()
    if (!baseUrl) return this.println(dim('  cancelled — a base url is required'))
    const kind = await this.pick(
      [
        { label: 'openai-compatible', hint: '/chat/completions — ollama · lm studio · vllm · most providers', value: 'openai' },
        { label: 'anthropic', hint: '/v1/messages — claude-style endpoints', value: 'anthropic' },
        { label: 'google', hint: 'gemini generateContent endpoints', value: 'google' },
      ],
      'api kind',
      { maxVisible: 3 },
    )
    if (!kind) return this.println(dim('  cancelled'))
    const apiKey = (await this.askHidden('  api key — enter to skip ❯ ')).trim()
    const modelsRaw = await this.ask('  models, comma separated (e.g. llama3.1, qwen2.5) ❯ ')
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
      customProvider: { id, label, baseUrl, kind, apiKey: apiKey || undefined, models },
      defaultProvider: id,
      defaultModel: models[0] ?? '',
    })
    if ('error' in r && r.error) return this.println(red(`  ✗ ${r.error}`))
    this.println(green(`  ✔ ${label} (${id}) saved and selected`))
    if (models[0]) {
      this.println(green(`  ✔ ${id} · ${models[0]}`))
    } else {
      this.println(yellow(`  ⚠ no models yet — /model to pick one, or /model ${id} <model-id>`))
    }
    this.println(dim(`    manage later: /model · failover: /fallback add ${id} <model> [key]`))
  }

  /* ---------------- MCP manager (/mcp) ---------------- */

  private async mcpManager(arg: string) {
    const host = this.host
    const sub = arg.split(/\s+/)[0]

    // /mcp list — status table (non-interactive)
    if (sub === 'list') return this.mcpPrintStatus()

    // interactive dashboard
    for (;;) {
      const status = host.mcpStatus()
      const actions: SelectItem<string>[] = []
      for (const s of status) {
        const state =
          s.state === 'ready' ? green(`${s.tools} tools ✓`)
          : s.state === 'error' ? red('error')
          : s.state === 'disabled' ? dim('off')
          : yellow('connecting')
        actions.push({
          label: s.name,
          hint: String(state),
          detail: s.error ? red(s.error.slice(0, 70)) : s.command.slice(0, 70),
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
        if (r.error) this.println(red(`  ✗ ${r.error}`))
        else this.println(green(`  ✔ ${tpl.name} added — see status`))
        continue
      }

      if (pick === 'custom') {
        const name = (await this.ask('  name ❯ ')).trim()
        if (!name) { this.println(dim('  cancelled')); continue }
        const command = (await this.ask('  command (e.g. npx / uvx / node) ❯ ')).trim()
        if (!command) { this.println(dim('  cancelled')); continue }
        const rawArgs = (await this.ask('  args (space separated) ❯ ')).trim()
        const envLine = (await this.ask('  env KEY=VAL (comma separated, enter = none) ❯ ')).trim()
        const env: Record<string, string> = {}
        for (const part of envLine.split(',').map((s) => s.trim()).filter(Boolean)) {
          const [k, ...v] = part.split('=')
          if (k?.trim()) env[k.trim()] = v.join('=').trim()
        }
        this.println(dim(`  starting ${name}…`))
        const r = await host.mcpSave({
          name, command, args: rawArgs ? rawArgs.split(/\s+/) : [], env: Object.keys(env).length ? env : undefined,
        })
        if (r.error) this.println(red(`  ✗ ${r.error}`))
        else this.println(green(`  ✔ ${name} added`))
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
          if (r.error) this.println(red(`  ✗ ${r.error}`))
          else this.println(green(`  ✔ ${name} ${r.enabled ? 'enabled' : 'disabled'}`))
        } else {
          const sure = await this.askYesNo(`  remove ${bold(name)}?`, true)
          if (!sure) continue
          const r = await host.mcpRemove(name)
          if (r.error) this.println(red(`  ✗ ${r.error}`))
          else this.println(green(`  ✔ ${name} removed`))
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
    this.println(bold(`  MCP servers (${status.length})`))
    for (const s of status) {
      const icon = s.state === 'ready' ? green('◉') : s.state === 'error' ? red('✗') : s.state === 'disabled' ? dim('○') : yellow('◌')
      this.println(`   ${icon} ${bold(s.name.padEnd(16))} ${dim(s.state)} · ${s.tools} tools${s.enabled === false ? dim(' (disabled)') : ''}`)
      if (s.error) this.println(`      ${red(s.error.slice(0, 90))}`)
    }
    this.println(dim('    tools: mcp_<server>_<tool> · permissions: /allow mcp_<server> · manage: /mcp'))
  }

  /* ---------------- plugin manager (/plugins) ---------------- */

  private async pluginManager(arg: string) {
    const host = this.host
    const sub = arg.split(/\s+/)[0]

    if (sub === 'new' || sub === 'create' || sub === 'scaffold') {
      const name = arg.split(/\s+/).slice(1).join(' ').trim() || (await this.ask('  plugin name ❯ ')).trim()
      if (!name) return this.println(dim('  cancelled'))
      const r = host.pluginScaffold(name)
      this.println(green(`  ✔ scaffold created`))
      this.println(`    ${dim(r.file)}`)
      this.println(dim('    edit it, then just run — plugins hot-reload each turn'))
      return
    }

    for (;;) {
      const plugins = host.pluginsList()
      const cmds = await host.pluginCommandList()
      const items: SelectItem<string>[] = plugins.map((p) => ({
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
        const name = (await this.ask('  plugin name ❯ ')).trim()
        if (!name) continue
        const r = host.pluginScaffold(name)
        this.println(green(`  ✔ scaffold created`))
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
        this.println(dim('    tools & hooks reload each turn'))
        const open = await this.askYesNo('  open the file in $EDITOR-less view? (/read)', false)
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
    const choice = await this.pick(
      [
        { label: 'device flow', hint: 'no secrets pasted', detail: 'needs TAGENT_GH_CLIENT_ID', value: 'device' },
        { label: 'personal access token', hint: 'works everywhere', value: 'pat' },
      ],
      'login method',
    )
    try {
      if (choice === 'device') {
        const start = await host.githubDeviceStart()
        this.println(`\n  ${bold('open')}  ${start.verification_uri}`)
        this.println(`  ${bold('code')}   ${bold(cyan(start.user_code))}\n`)
        this.println(dim('  waiting for authorization…'))
        const r = await host.githubDevicePoll()
        this.println(green(`  ✔ logged in as ${r.login}`))
      } else if (choice === 'pat') {
        const token = (await this.askHidden('  token ❯ ')).trim()
        if (!token) return this.println(dim('  cancelled'))
        const r = await host.githubPat(token)
        this.println(green(`  ✔ logged in as ${r.login}`))
      } else {
        return this.println(dim('  cancelled'))
      }
      this.println(dim('  sync this workspace any time with `tagent sync`'))
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

/** 12345 → "12.3k" for the usage footer */
function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}
