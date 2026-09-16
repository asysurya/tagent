import type {
  AgentEvents,
  AgentMode,
  ChatMessage,
  LoopSummary,
  PermissionManager,
  ProviderAdapter,
  SessionData,
  SubagentInfo,
  ToolCallRecord,
  ToolContext,
  ToolDefinition,
} from './types'
import { buildSystemPrompt } from './system-prompt'
import { createCheckpoint, shouldCheckpoint } from './checkpoints'
import { trunc, uid } from './util'
import { buildToolset } from './tools'

const ACTION_RE = /```tagent:action\s*\n([\s\S]*?)```/g
const MAX_TOOL_OUTPUT = 24_000

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

  constructor(private opts: AgentLoopOptions) {
    this.tools = buildToolset({ readOnly: opts.readOnly, depth: opts.depth ?? 0, config: opts.config })
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
    const userMsg: ChatMessage = { id: uid(), role: 'user', content: userText, createdAt: Date.now() }
    session.messages.push(userMsg)
    this.opts.events.onUserMessage?.(userMsg)

    const system = buildSystemPrompt({
      workspaceRoot: session.workspaceId,
      mode: this.opts.mode,
      tools: this.tools,
      subagent: (this.opts.depth ?? 0) > 0,
    })

    let turns = 0
    let toolCalls = 0
    const maxTurns = Math.min(this.opts.config.maxTurns ?? 40, 80)

    try {
      while (turns < maxTurns) {
        if (this.abort.signal.aborted) return { turns, toolCalls, finished: 'aborted' }
        turns++

        this.opts.events.onStatus?.('thinking', `turn ${turns}`)
        const raw = await this.opts.provider.complete({
          model: this.opts.model,
          signal: this.abort.signal,
          messages: this.renderMessages(system),
        })

        if (this.abort.signal.aborted) return { turns, toolCalls, finished: 'aborted' }

        const { cleanText, actions } = this.parseActions(raw)

        const assistantMsg: ChatMessage = {
          id: uid(),
          role: 'assistant',
          content: cleanText.trim(),
          createdAt: Date.now(),
        }
        session.messages.push(assistantMsg)

        if (actions.length === 0) {
          this.opts.events.onAssistantChunk?.(session.id, assistantMsg.content)
          this.opts.events.onAssistantMessage?.(assistantMsg)
          this.opts.onSessionUpdate?.(session)
          this.opts.events.onStatus?.('done', `turns: ${turns}`)
          return { turns, toolCalls, finished: 'complete' }
        }

        // brief text streams out before the actions execute
        this.opts.events.onAssistantChunk?.(session.id, assistantMsg.content)
        this.opts.events.onAssistantMessage?.(assistantMsg)
        this.opts.onSessionUpdate?.(session)

        const results: string[] = []
        this.opts.events.onStatus?.('acting', `${actions.length} action(s)`)

        for (const action of actions) {
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
              throw new Error(
                `Unknown tool "${action.tool}". Available: ${this.tools.map((t) => t.name).join(', ')}`,
              )
            }
            if (this.opts.mode === 'plan' && !isReadOnlyTool(tool.name)) {
              throw new Error('Plan mode is read-only — switch to build mode to modify files.')
            }
            // permission gate — ask the human when the rule says so
            this.opts.events.onStatus?.('waiting-permission', tool.name)
            const decision = await this.opts.permissions.gate(tool.name, action.input, this.ctx)
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
            }
          } catch (e) {
            record.status = 'error'
            output = `Error: ${(e as Error).message}`
          }
          record.output = trunc(output, 4_000)
          record.endedAt = Date.now()
          toolCalls++
          this.opts.events.onToolEnd?.(record)
          results.push(
            `### ${action.tool} (${record.status})\ninput: ${JSON.stringify(action.input).slice(0, 400)}\noutput:\n${trunc(output, MAX_TOOL_OUTPUT)}`,
          )
        }

        this.opts.onSessionUpdate?.(session)

        if (this.abort.signal.aborted) return { turns, toolCalls, finished: 'aborted' }

        // feed results back as the next user turn
        const resultMsg: ChatMessage = {
          id: uid(),
          role: 'user',
          content: `TOOL RESULTS:\n\n${results.join('\n\n')}\n\nContinue. If the task is complete, reply with a summary and NO action blocks.`,
          createdAt: Date.now(),
          meta: { toolResults: true },
        }
        session.messages.push(resultMsg)
      }

      this.opts.events.onStatus?.('done', 'max turns reached')
      return { turns, toolCalls, finished: 'max-turns' }
    } catch (e) {
      const err = (e as Error).message
      this.opts.events.onStatus?.('error', err)
      this.opts.events.onNotify?.('error', `Agent error: ${err}`)
      return { turns, toolCalls, finished: 'error', error: err }
    }
  }

  /* ---------------------------------------------------------------- */

  private async spawnSubagent(
    description: string,
    prompt: string,
    agentKind: 'general' | 'explore',
    maxTurns: number,
  ): Promise<string> {
    const { session } = this.opts
    const sub: SessionData = {
      id: uid(),
      workspaceId: session.workspaceId,
      title: description,
      model: this.opts.model,
      mode: this.opts.mode,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
      messages: [],
      todos: [],
    }
    const events = wrapEventsForSubagent(this.opts.events, description)
    const loop = new AgentLoop({
      session: sub,
      provider: this.opts.provider,
      model: this.opts.model,
      events,
      permissions: this.opts.permissions,
      config: { ...this.opts.config, maxTurns },
      mode: this.opts.mode,
      depth: (this.opts.depth ?? 0) + 1,
      readOnly: agentKind === 'explore',
      signal: this.abort.signal,
    })
    const summary = await loop.run(prompt)
    const report =
      sub.messages.filter((m) => m.role === 'assistant' && !m.meta?.toolResults).map((m) => m.content).join('\n\n') ||
      `(subagent produced no text report; finished=${summary.finished})`
    return report
  }

  private renderMessages(system: string): { role: 'system' | 'user' | 'assistant'; content: string }[] {
    const out: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
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
    // keep context sane: drop oldest middle turns if huge
    const MAX_CHARS = 400_000
    let total = out.reduce((n, m) => n + m.content.length, 0)
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
  'read_file', 'list_files', 'grep', 'web_fetch', 'ddg_search', 'task', 'todowrite', 'memory', 'load_skill',
])

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name)
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
