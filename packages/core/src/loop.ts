import fs from 'node:fs'
import path from 'node:path'
import type {
  AgentEvents,
  AgentMode,
  ChatMessage,
  LoopSummary,
  PermissionManager,
  ProviderAdapter,
  SessionData,
  SubagentInfo,
  TokenUsage,
  ToolCallRecord,
  ToolContext,
  ToolDefinition,
} from './types'
import { getAdapter, acceptsImages, type NativeToolDef, type WireMessage } from './providers'
import { parseModelRef } from './providers/registry'
import { buildSystemPrompt } from './system-prompt'
import { createCheckpoint, shouldCheckpoint } from './checkpoints'
import { jailPath, trunc, uid } from './util'
import { fileStateFor } from './cache'
import { buildToolset, TEST_MODE_TOOLS, ALL_TOOLS } from './tools'
import { findSubagent, listSubagents } from './subagents'
import { diagnosticsCommand, renderDiagnosticsBlock, runDiagnostics } from './diagnostics'
import { completeWithFallback, fallbackTail, type ResolvedChainEntry } from './fallback'

const ACTION_RE = /```tagent:action\s*\n([\s\S]*?)```/g
const MAX_TOOL_OUTPUT = 24_000
/** caveman mode: tighter tool-output budget — real token savings */
const MAX_TOOL_OUTPUT_CAVEMAN = 8_000
/** how often streamed text is pushed to the UI (ms) — keeps phones calm */
const CHUNK_EMIT_MS = 60
/** context diet: above this, OLD tool results get compacted to stubs */
const COMPACT_THRESHOLD = 150_000
/** how many of the newest tool-result turns stay uncompacted */
const COMPACT_KEEP = 4

function toNativeToolDef(t: ToolDefinition): NativeToolDef {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    },
  }
}

/** Hide the raw action protocol from the streamed text shown to the user. */
function displayText(s: string): string {
  const i = s.indexOf('```tagent:action')
  return i >= 0 ? s.slice(0, i).trimEnd() : s
}

export interface AgentLoopOptions {
  session: SessionData
  provider: ProviderAdapter
  model: string
  events: AgentEvents
  permissions: PermissionManager
  config: import('./types').TagentConfig
  mode: AgentMode
  /** nesting depth — 0 = primary agent */
  depth?: number
  /** restrict to read-only tools (subagent explore) */
  readOnly?: boolean
  signal?: AbortSignal
  onSessionUpdate?: (session: SessionData) => void
  /** timeline support — the host persists subagent sessions through this */
  onSubagentSession?: (sub: SessionData, phase: 'start' | 'end') => void
  /** extra tools injected by the host (MCP servers, plugins, …) */
  extraTools?: ToolDefinition[]
  /** custom subagent persona — replaces the default identity in the system prompt */
  agentPrompt?: string
  /** custom subagent tool whitelist (tool names) */
  toolsFilter?: string[]
}

interface ParsedAction {
  id: string
  tool: string
  input: Record<string, unknown>
}

/**
 * The agent loop: prompt → model → parse action blocks → execute tools
 * (permission-gated, checkpointed) → feed results back → repeat until the
 * model answers without actions, or the turn budget is spent.
 */
export class AgentLoop {
  private abort = new AbortController()
  private snapshots = new Map<string, boolean>()
  readonly tools: ToolDefinition[]
  readonly ctx: ToolContext
  /** primary first, then the ordered fallback chain */
  private chain: ResolvedChainEntry[]

  constructor(private opts: AgentLoopOptions) {
    this.tools = [
      ...buildToolset({
        readOnly: opts.readOnly,
        depth: opts.depth ?? 0,
        config: opts.config,
        ...(opts.mode === 'test' ? { mode: 'test' as const } : {}),
      }),
      ...(opts.readOnly ? [] : (opts.extraTools ?? [])),
    ].filter((t) => !opts.toolsFilter || opts.toolsFilter.includes(t.name))
    this.chain = [
      { adapter: opts.provider, model: opts.model, label: 'primary' },
      ...fallbackTail(opts.config),
    ]
    this.ctx = {
      workspaceRoot: opts.session.workspaceId,
      sessionId: opts.session.id,
      depth: opts.depth ?? 0,
      config: opts.config,
      events: opts.events,
      signal: this.abort.signal,
      todos: opts.session.todos,
      spawnSubagent: (description, prompt, agent, maxTurns) =>
        this.spawnSubagent(description, prompt, agent, maxTurns),
    }
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => this.abort.abort(), { once: true })
    }
  }

  stop(): void {
    this.abort.abort()
  }

  /* ---------------------------------------------------------------- */

  async run(userText: string): Promise<LoopSummary> {
    const { session } = this.opts
    // @-mentions → inline file attachments: zero tool turns for known files
    const expanded = this.expandFileMentions(userText)
    const userMsg: ChatMessage = { id: uid(), role: 'user', content: expanded, createdAt: Date.now() }
    session.messages.push(userMsg)
    this.opts.events.onUserMessage?.(userMsg)

    const caveman = this.opts.config.caveman === true
    const system = buildSystemPrompt({
      workspaceRoot: session.workspaceId,
      mode: this.opts.mode,
      tools: this.tools,
      subagent: (this.opts.depth ?? 0) > 0,
      caveman,
      ...(this.opts.agentPrompt ? { agentPrompt: this.opts.agentPrompt } : {}),
      ...(diagnosticsCommand(this.opts.config) && !this.opts.readOnly
        ? { diagnostics: diagnosticsCommand(this.opts.config) }
        : {}),
      // the primary agent keeps the journal; subagents & plan mode stay lean
      worklog:
        this.opts.config.worklog?.enabled !== false &&
        (this.opts.depth ?? 0) === 0 &&
        this.opts.mode === 'build',
    })

    let turns = 0
    let toolCalls = 0
    let usageTotal: TokenUsage | undefined
    const maxTurns = Math.min(this.opts.config.maxTurns ?? 40, 80)
    // native function-calling when the provider supports it (config: nativeTools)
    const useNativeTools =
      this.opts.config.nativeTools !== false &&
      this.opts.provider.supportsNativeTools === true &&
      this.tools.length > 0
    const nativeTools = useNativeTools ? this.tools.map(toNativeToolDef) : undefined

    try {
      while (turns < maxTurns) {
        if (this.abort.signal.aborted) return { turns, toolCalls, finished: 'aborted', usage: usageTotal }
        turns++

        this.opts.events.onStatus?.(
          'thinking',
          `turn ${turns}${usageTotal ? ` · ${fmtTokens(usageTotal.input)} in` : ''}`,
        )
        // streamed token display — throttled, idempotent (full text so far)
        let lastEmit = 0
        const emitStream = (full: string, force = false) => {
          const now = Date.now()
          if (force || now - lastEmit >= CHUNK_EMIT_MS) {
            lastEmit = now
            this.opts.events.onAssistantChunk?.(session.id, displayText(full))
          }
        }
        const result = await completeWithFallback(
          this.chain,
          {
            model: this.opts.model,
            signal: this.abort.signal,
            messages: this.renderMessages(system),
            tools: nativeTools,
            onText: (full) => emitStream(full),
          },
          (info) =>
            this.opts.events.onNotify?.(
              'warn',
              `provider ${info.failed} failed — ${info.error.slice(0, 140)}${info.next ? ` · switching to ${info.next}` : ' · no fallback left'}`,
            ),
        )

        if (this.abort.signal.aborted) return { turns, toolCalls, finished: 'aborted', usage: usageTotal }

        const raw = result.text
        // token accounting (when the provider reports usage in its stream)
        if (result.usage) {
          usageTotal = usageTotal
            ? {
                input: usageTotal.input + (result.usage.input ?? 0),
                output: usageTotal.output + (result.usage.output ?? 0),
                cacheRead: (usageTotal.cacheRead ?? 0) + (result.usage.cacheRead ?? 0),
              }
            : { input: result.usage.input ?? 0, output: result.usage.output ?? 0, cacheRead: result.usage.cacheRead }
          this.opts.events.onUsage?.({ input: result.usage.input ?? 0, output: result.usage.output ?? 0, cacheRead: result.usage.cacheRead, turn: turns })
        }
        const { cleanText, actions } = this.parseActions(raw)
        // merge actions that came through native function calling
        const nativeActions: ParsedAction[] = (result.toolCalls ?? []).map((c) => ({
          id: c.id ?? uid(),
          tool: c.tool,
          input: (c.input ?? {}) as Record<string, unknown>,
        }))
        const allActions = [...actions, ...nativeActions]

        const assistantMsg: ChatMessage = {
          id: uid(),
          role: 'assistant',
          content: cleanText.trim(),
          createdAt: Date.now(),
          ...(result.usage ? { meta: { usage: { input: result.usage.input ?? 0, output: result.usage.output ?? 0, cacheRead: result.usage.cacheRead } } } : {}),
        }
        session.messages.push(assistantMsg)

        if (allActions.length === 0) {
          emitStream(assistantMsg.content, true)
          this.opts.events.onAssistantMessage?.(assistantMsg)
          this.opts.onSessionUpdate?.(session)
          this.opts.events.onStatus?.('done', usageDetail(turns, usageTotal))
          // plan mode: a clean finish that presents a plan enables the
          // approve-and-build flow in the host
          const plan = this.opts.mode === 'plan' ? extractPlan(assistantMsg.content) : undefined
          return { turns, toolCalls, finished: 'complete', usage: usageTotal, ...(plan ? { plan } : {}) }
        }

        // brief text streams out before the actions execute
        emitStream(assistantMsg.content, true)
        this.opts.events.onAssistantMessage?.(assistantMsg)
        this.opts.onSessionUpdate?.(session)

        const results: string[] = []
        this.opts.events.onStatus?.('acting', `${allActions.length} action(s)`)
        let editedThisTurn = false

        for (const action of allActions) {
          if (this.abort.signal.aborted) break
          const record: ToolCallRecord = {
            id: action.id,
            tool: action.tool,
            input: action.input,
            status: 'running',
            startedAt: Date.now(),
          }
          assistantMsg.toolCalls = [...(assistantMsg.toolCalls ?? []), record]
          this.opts.events.onToolStart?.(record)

          let output: string
          try {
            const tool = this.tools.find((t) => t.name === action.tool)
            if (!tool) {
              const known = ALL_TOOLS.some((t) => t.name === action.tool)
              throw new Error(
                known
                  ? `Tool "${action.tool}" is not available in ${this.opts.mode} mode${
                      this.opts.mode === 'test'
                        ? ' — test mode verifies the project without modifying it. Switch to build mode to fix issues.'
                        : '. Switch to build mode to use it.'
                    }`
                  : `Unknown tool "${action.tool}". Available: ${this.tools.map((t) => t.name).join(', ')}`,
              )
            }
            if (this.opts.mode === 'plan' && !isReadOnlyTool(tool.name)) {
              throw new Error('Plan mode is read-only — switch to build mode to modify files.')
            }
            if (this.opts.mode === 'test' && !TEST_MODE_TOOLS.has(tool.name)) {
              throw new Error(
                'Test mode is read-only — it verifies the project without modifying it (the only write is test_report). ' +
                  'Switch to build mode to fix issues.',
              )
            }
            // permission gate — ask the human when the rule says so
            this.opts.events.onStatus?.('waiting-permission', tool.name)
            const decision = await this.opts.permissions.gate(tool.name, action.input, this.ctx, tool.risk)
            if (!decision.approved) {
              record.status = 'denied'
              output = 'Permission denied by the user. Do not retry this exact action; ask the user how to proceed or continue with what you can.'
            } else {
              this.opts.events.onStatus?.('acting', tool.name)
              // pre-write checkpoint
              if (shouldCheckpoint(tool.name, this.snapshots.get(session.id) === true, this.ctx)) {
                this.snapshots.set(session.id, true)
                try {
                  createCheckpoint(session.workspaceId, `pre-${tool.name} (session ${session.id})`)
                } catch { /* checkpoint is best-effort */ }
              }
              output = await tool.run(action.input, this.ctx)
              record.status = 'done'
              if (record.status === 'done' && (tool.name === 'write_file' || tool.name === 'edit_file')) {
                editedThisTurn = true
              }
            }
          } catch (e) {
            record.status = 'error'
            output = `Error: ${(e as Error).message}`
          }
          record.output = trunc(output, caveman ? 1_600 : 4_000)
          record.endedAt = Date.now()
          toolCalls++
          this.opts.events.onToolEnd?.(record)
          results.push(
            `### ${action.tool} (${record.status})\ninput: ${JSON.stringify(action.input).slice(0, 400)}\noutput:\n${trunc(output, caveman ? MAX_TOOL_OUTPUT_CAVEMAN : MAX_TOOL_OUTPUT)}`,
          )
        }

        this.opts.onSessionUpdate?.(session)

        if (this.abort.signal.aborted) return { turns, toolCalls, finished: 'aborted', usage: usageTotal }

        // auto-diagnostics: one quality-gate run per edit turn — failures are
        // fed straight back so the model self-corrects before saying "done"
        if (editedThisTurn && diagnosticsCommand(this.opts.config)) {
          this.opts.events.onStatus?.('acting', 'diagnostics')
          const diag = await runDiagnostics(session.workspaceId, this.opts.config)
          if (diag) {
            results.push(renderDiagnosticsBlock(diag))
            if (!diag.ok) {
              this.opts.events.onNotify?.('warn', `diagnostics failed — the agent is fixing it (${(diag.ms / 1000).toFixed(1)}s)`)
            }
          }
        }

        // feed results back as the next user turn
        const { content: fedText, images } = this.collectImages(results.join('\n\n'), this.opts.session.workspaceId)
        const resultMsg: ChatMessage = {
          id: uid(),
          role: 'user',
          content: `TOOL RESULTS:\n\n${fedText}\n\nContinue. If the task is complete, reply with a summary and NO action blocks.`,
          createdAt: Date.now(),
          meta: { toolResults: true, ...(images.length ? { images } : {}) },
        }
        session.messages.push(resultMsg)
      }

      this.opts.events.onStatus?.('done', 'max turns reached')
      return { turns, toolCalls, finished: 'max-turns', usage: usageTotal }
    } catch (e) {
      const err = (e as Error).message
      this.opts.events.onStatus?.('error', err)
      this.opts.events.onNotify?.('error', `Agent error: ${err}`)
      return { turns, toolCalls, finished: 'error', error: err, usage: usageTotal }
    }
  }

  /* ---------------------------------------------------------------- */

  /**
   * @path mentions → inline attachments (max 5 files, ≤60KB each).
   * The agent starts with the content already in context — no read turn spent.
   * Attached files are recorded in the file-state cache, so a later
   * read_file of the same path correctly answers "unchanged, in context".
   */
  private expandFileMentions(text: string): string {
    if (!text.includes('@')) return text
    const { session } = this.opts
    const attachments: string[] = []
    const expanded = text.replace(/(^|\s)@([\w./@-]+)/g, (whole, pre: string, p: string) => {
      if (attachments.length >= 5) return whole
      if (!/[./]/.test(p)) return whole // @mention without a path shape stays as-is
      let abs: string
      try {
        abs = jailPath(session.workspaceId, p)
      } catch {
        return whole // escapes workspace — leave untouched
      }
      try {
        const st = fs.statSync(abs)
        if (!st.isFile() || st.size > 60_000) return whole
        const raw = fs.readFileSync(abs, 'utf8')
        if (raw.includes('\u0000')) return whole // binary
        attachments.push(`===== @${p} (user-attached, ${st.size} bytes) =====\n${raw}`)
        if (this.opts.config.cache?.fileState !== false) fileStateFor(session.workspaceId).record(abs)
        return `${pre}@${p} (attached below)`
      } catch {
        return whole
      }
    })
    if (attachments.length === 0) return text
    return `${expanded}\n\n${attachments.join('\n\n')}`
  }

  /**
   * Spawn a subagent. `agentKind` is "general", "explore", or the name of a
   * custom subagent (.tagent/agents/<name>.md) — persona, tool whitelist,
   * model override, and turn budget come from the definition.
   */
  private async spawnSubagent(
    description: string,
    prompt: string,
    agentKind: string,
    maxTurns: number,
  ): Promise<string> {
    const { session } = this.opts
    const def =
      agentKind !== 'general' && agentKind !== 'explore'
        ? findSubagent(session.workspaceId, agentKind)
        : undefined
    if (agentKind !== 'general' && agentKind !== 'explore' && !def) {
      return `Error: unknown agent "${agentKind}" — available: general, explore${
        listSubagentNames(session.workspaceId)
          .map((n) => `, ${n}`)
          .join('')
      }`
    }
    // model override: "provider/model" (cross-provider) or a bare model id
    let provider = this.opts.provider
    let model = this.opts.model
    if (def?.model) {
      const ref = parseModelRef(def.model, this.opts.config)
      if (ref) {
        try {
          provider = getAdapter(ref.provider, this.opts.config)
          model = ref.model
        } catch {
          /* fall back to the parent's provider */
        }
      } else {
        model = def.model
      }
    }
    const sub: SessionData = {
      id: uid(),
      workspaceId: session.workspaceId,
      title: `${def ? `${def.name}: ` : ''}${description}`,
      model,
      mode: def ? def.mode : this.opts.mode,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
      messages: [],
      todos: [],
      // timeline metadata — persisted by the host, hidden from the sidebar
      parentId: session.id,
      subagent: true,
    }
    this.opts.onSubagentSession?.(sub, 'start')
    const events = wrapEventsForSubagent(this.opts.events, sub.title)
    const loop = new AgentLoop({
      session: sub,
      provider,
      model,
      events,
      permissions: this.opts.permissions,
      config: { ...this.opts.config, maxTurns: def?.maxTurns ?? maxTurns },
      mode: def ? def.mode : this.opts.mode,
      depth: (this.opts.depth ?? 0) + 1,
      readOnly: agentKind === 'explore' || def?.mode === 'plan',
      signal: this.abort.signal,
      onSubagentSession: this.opts.onSubagentSession,
      ...(def ? { agentPrompt: def.systemPrompt, toolsFilter: def.tools } : {}),
    })
    const summary = await loop.run(prompt)
    this.opts.onSubagentSession?.(sub, 'end')
    const report =
      sub.messages.filter((m) => m.role === 'assistant' && !m.meta?.toolResults).map((m) => m.content).join('\n\n') ||
      `(subagent produced no text report; finished=${summary.finished})`
    return report
  }

  /**
   * Screenshot wiring — [IMAGE:<path>] markers from tool output become image
   * parts on the tool-results message (when the model can see images) or a
   * plain path reference (when it cannot). Session stores only the paths;
   * base64 is read lazily at request time.
   */
  private collectImages(
    text: string,
    workspaceRoot: string,
  ): { content: string; images: string[] } {
    const markerRe = /\[IMAGE:([^\]]+)\]/g
    const paths = [...new Set([...text.matchAll(markerRe)].map((m) => m[1]))].slice(0, 4)
    if (!paths.length) return { content: text, images: [] }

    const canSee = acceptsImages(this.opts.provider, this.opts.model)
    if (!canSee) {
      // keep the reference readable — the model can still cite the path
      return { content: text.replace(markerRe, (_m, p) => `(screenshot at ${path.relative(workspaceRoot, p)})`), images: [] }
    }
    const keep: string[] = []
    for (const p of paths) {
      try {
        if (fs.statSync(p).size > 2_500_000) continue // ~1.9MB binary cap — skip monsters
        keep.push(p)
      } catch { /* deleted — skip */ }
    }
    if (!keep.length) {
      return { content: text.replace(markerRe, (_m, p) => `(screenshot at ${p})`), images: [] }
    }
    return { content: text.replace(markerRe, ''), images: keep }
  }

  private renderMessages(system: string): WireMessage[] {
    const out: WireMessage[] = [
      { role: 'system', content: system },
    ]
    for (const m of this.opts.session.messages) {
      if (m.role === 'assistant') {
        const actions = (m.toolCalls ?? []).map((c) =>
          '```tagent:action\n' + JSON.stringify({ tool: c.tool, input: c.input }) + '\n```',
        )
        out.push({ role: 'assistant', content: [m.content, ...actions].filter(Boolean).join('\n\n') })
      } else if (m.meta?.toolResults) {
        out.push({ role: 'user', content: m.content })
      } else {
        out.push({ role: 'user', content: m.content })
      }
    }

    // ---- visual context: attach screenshots to the newest tool results -----
    // base64 is read at request time (session files only store paths); keep
    // the last 2 image-bearing messages, max 4 images total — older ones
    // degrade to text references. Positional: out[i + 1] ↔ session.messages[i].
    if (acceptsImages(this.opts.provider, this.opts.model)) {
      let budget = 4
      let msgsUsed = 0
      for (let i = this.opts.session.messages.length - 1; i >= 0 && budget > 0 && msgsUsed < 2; i--) {
        const m = this.opts.session.messages[i]
        if (m.role !== 'user' || !Array.isArray(m.meta?.images) || !(m.meta.images as string[]).length) continue
        msgsUsed++
        const wireIdx = i + 1 // +1 — out[0] is the system message
        if (wireIdx >= out.length) continue
        const parts: { data: string; mediaType: string }[] = []
        for (const p of m.meta.images as string[]) {
          if (budget <= 0) break
          try {
            const buf = fs.readFileSync(p)
            if (buf.byteLength > 1_900_000) continue
            parts.push({ data: buf.toString('base64'), mediaType: 'image/png' })
            budget--
          } catch { /* unreadable — skip */ }
        }
        if (parts.length) out[wireIdx] = { ...out[wireIdx], images: parts }
      }
    }

    // ---- context diet -------------------------------------------------
    // 1) compact OLD tool results: keep the newest COMPACT_KEEP full, turn
    //    older ones into one-line stubs. Saves the bulk of long sessions
    //    while preserving the reasoning trail.
    let total = out.reduce((n, m) => n + m.content.length, 0)
    if (total > COMPACT_THRESHOLD) {
      const toolIdx: number[] = []
      for (let i = 0; i < out.length; i++) {
        if (out[i].role === 'user' && out[i].content.startsWith('TOOL RESULTS:')) toolIdx.push(i)
      }
      const keep = new Set(toolIdx.slice(-COMPACT_KEEP))
      for (const i of toolIdx) {
        if (keep.has(i)) continue
        total -= out[i].content.length - 120
        out[i] = {
          role: 'user',
          content:
            '[older tool results compacted to save context — contents you read earlier remain in your conversation; re-run a tool if you need fresh output]',
        }
      }
    }

    // 2) hard backstop: drop oldest middle turns if still huge
    const MAX_CHARS = 400_000
    while (total > MAX_CHARS && out.length > 4) {
      const removed = out.splice(1, 1) // keep system + latest
      total -= removed[0].content.length
    }
    return out
  }

  private parseActions(raw: string): { cleanText: string; actions: ParsedAction[] } {
    const actions: ParsedAction[] = []
    let clean = raw
    for (const m of raw.matchAll(ACTION_RE)) {
      try {
        const parsed = JSON.parse(m[1])
        if (parsed && typeof parsed.tool === 'string') {
          actions.push({
            id: uid(),
            tool: parsed.tool,
            input: (parsed.input ?? {}) as Record<string, unknown>,
          })
        }
      } catch {
        actions.push({
          id: uid(),
          tool: '__invalid_json__',
          input: { raw: m[1].slice(0, 500) },
        })
      }
    }
    clean = raw.replace(ACTION_RE, '').trim()
    return { cleanText: clean, actions }
  }
}

const READ_ONLY_TOOLS = new Set([
  'read_file', 'read_files', 'list_files', 'grep', 'web_fetch', 'ddg_search', 'task', 'todowrite', 'memory', 'load_skill',
])

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name)
}

/** custom subagent names — for unknown-agent error messages */
function listSubagentNames(workspaceRoot: string): string[] {
  try {
    return listSubagents(workspaceRoot).map((a) => a.name)
  } catch {
    return []
  }
}

/**
 * Detect a presented implementation plan in a plan-mode final answer.
 * Accepts a "## Plan"-style heading (returns the text under it) or a bare
 * numbered step list (>= 4 steps, no question marks) — questions and short
 * chatter don't count.
 */
export function extractPlan(text: string): string | undefined {
  if (!text || !text.trim()) return undefined
  const heading = text.match(/^\s*#{1,3}\s*(?:implementation\s+)?plan\b[^\n]*\n?/im)
  if (heading && heading.index !== undefined) {
    const rest = text.slice(heading.index).trim()
    return rest.length >= 24 ? rest.slice(0, 16_000) : undefined
  }
  const steps = text.match(/^\s*(?:\d+[.)]|[-*])\s+\S/gm) ?? []
  if (steps.length >= 4 && !text.includes('?') && text.trim().length >= 20) {
    return text.trim().slice(0, 16_000)
  }
  return undefined
}

/** 12345 → "12.3k" */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function usageDetail(turns: number, usage?: TokenUsage): string {
  if (!usage) return `turns: ${turns}`
  const cache = usage.cacheRead ? `, ${fmtTokens(usage.cacheRead)} cached` : ''
  return `turns: ${turns} · tokens ${fmtTokens(usage.input)} in / ${fmtTokens(usage.output)} out${cache}`
}

/** Rename subagent events so the UI can nest them under the parent activity. */
function wrapEventsForSubagent(
  parent: AgentEvents,
  description: string,
): AgentEvents {
  let info: SubagentInfo = {
    id: uid(),
    parentId: '',
    description,
    status: 'running',
    turns: 0,
  }
  return {
    ...parent,
    onStatus: (phase, detail) => parent.onSubagent?.({ ...info, status: 'running' }),
    onAssistantMessage: () => undefined,
    onAssistantChunk: () => undefined,
    onToolStart: (call) => {
      info.turns++
      parent.onSubagent?.({ ...info, status: 'running' })
    },
    onUserMessage: () => undefined,
    onFilesChanged: (paths) => parent.onFilesChanged?.(paths),
    onNotify: (level, msg) => parent.onNotify?.(level, `[subagent:${description}] ${msg}`),
  }
}
