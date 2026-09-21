import { spawn, type ChildProcess } from 'node:child_process'
import type { McpConfig, McpServerConfig, ToolDefinition } from './types'
import { CURRENT_VERSION } from './version'

export type { McpConfig, McpServerConfig } from './types'

/**
 * MCP (Model Context Protocol) client — stdio transport.
 *
 * Tagent speaks the official JSON-RPC handshake and exposes every remote tool
 * as a native tool named `mcp_<server>_<tool>` — same permission gates, same
 * system-prompt docs as built-ins. Servers are configured in
 * `.tagent/config.json`:
 *
 *   "mcp": { "servers": { "context7": {
 *     "command": "npx", "args": ["-y", "@upstash/context7-mcp"],
 *     "env": { "API_KEY": "…" }, "enabled": true
 *   }}}
 *
 * stdio is the transport 99% of local servers speak (npx / uvx / binaries);
 * it keeps everything on-machine — keys never leave the box.
 */

export interface McpServerStatus {
  name: string
  command: string
  enabled: boolean
  state: 'connecting' | 'ready' | 'error' | 'disabled'
  tools: number
  error?: string
}

interface RemoteTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/** how long to wait for the MCP initialize handshake. npx/uvx download the
 *  server package on first run — cold caches (Codespaces, CI boxes, Termux)
 *  easily spend 30–50s there, so the default is generous. Override with
 *  TAGENT_MCP_INIT_TIMEOUT_MS=<millis> (values under 1s are ignored). */
function initTimeoutMs(): number {
  const v = Math.floor(Number(process.env.TAGENT_MCP_INIT_TIMEOUT_MS ?? ''))
  return Number.isFinite(v) && v >= 1000 ? v : 60_000
}
/** per-CALL budget — some MCP tools are slow by nature (scrapers, agents,
 *  build pipelines). Override with TAGENT_MCP_CALL_TIMEOUT_MS=<millis>
 *  (values under 1s are ignored). The agent may also pass `__timeout_ms`
 *  on any mcp_* call for a per-invocation budget (1s..1h, clamped). */
function callTimeoutMs(): number {
  const v = Math.floor(Number(process.env.TAGENT_MCP_CALL_TIMEOUT_MS ?? ''))
  return Number.isFinite(v) && v >= 1000 ? v : 120_000
}
const CALL_TIMEOUT_MS = callTimeoutMs()
const CALL_TIMEOUT_MAX = 3_600_000
/** clamp an agent-requested per-call budget into a sane range */
function clampCallTimeout(requested: unknown): number | undefined {
  const v = Math.floor(Number(requested))
  if (!Number.isFinite(v)) return undefined
  return Math.min(Math.max(v, 1_000), CALL_TIMEOUT_MAX)
}
const LIST_TIMEOUT_MS = 10_000
const MAX_OUTPUT = 24_000

/** `mcp__server__tool` → safe identifier: [a-z0-9_] */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

/** keep names under 60 chars but unique-ish (hash suffix when truncated) */
function toolName(server: string, tool: string): string {
  const base = `mcp_${slug(server)}_${slug(tool)}`
  if (base.length <= 60) return base
  let h = 0
  for (const ch of base) h = (h * 31 + ch.charCodeAt(0)) | 0
  return base.slice(0, 50) + '_' + Math.abs(h).toString(36)
}

function schemaToParams(schema?: Record<string, unknown>): Record<string, string> {
  const props = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>
  const required = new Set((schema?.required ?? []) as string[])
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(props)) {
    const t = typeof v.type === 'string' ? v.type : 'any'
    const req = required.has(k) ? '' : '?'
    const desc = typeof v.description === 'string' ? ` — ${v.description.slice(0, 90)}` : ''
    out[k + req] = `${t}${desc}`
  }
  return out
}

/** one connected server process */
class McpConnection {
  private proc: ChildProcess
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  tools: RemoteTool[] = []
  serverInfo?: { name?: string; version?: string }
  /** live handshake state — 'connecting' until initialize + tools/list land */
  state: 'connecting' | 'ready' | 'error' = 'connecting'
  error?: string

  constructor(
    public name: string,
    public cfg: McpServerConfig,
  ) {
    this.proc = spawn(cfg.command, cfg.args ?? [], {
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let buf = ''
    this.proc.stdout!.setEncoding('utf8')
    this.proc.stdout!.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          this.receive(JSON.parse(line))
        } catch {
          // non-JSON stderr-ish noise on stdout — ignore
        }
      }
    })
    this.proc.stderr!.setEncoding('utf8')
    this.proc.on('exit', (code) => {
      const err = new Error(`server exited (code ${code})`)
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(err)
      }
      this.pending.clear()
    })
    this.proc.on('error', (err) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(err instanceof Error ? err : new Error(String(err)))
      }
      this.pending.clear()
    })
  }

  private receive(msg: Record<string, unknown>) {
    const id = msg.id
    if (typeof id !== 'number') return // notification or server request — ignore
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new Error(String((msg.error as { message?: string }).message ?? msg.error)))
    else p.resolve(msg.result)
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.proc.killed || this.proc.exitCode !== null) {
        return reject(new Error('server process is not running'))
      }
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs / 1000}s`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      const json = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      try {
        this.proc.stdin!.write(json + '\n')
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e as Error)
      }
    })
  }

  async initialize(timeoutMs = initTimeoutMs()): Promise<void> {
    const result = (await this.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'tagent', version: CURRENT_VERSION },
      },
      timeoutMs,
    )) as { serverInfo?: { name?: string; version?: string } }
    this.serverInfo = result?.serverInfo
    // initialized notification (no response expected)
    try {
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    } catch { /* best-effort */ }
  }

  async loadTools(): Promise<RemoteTool[]> {
    const result = (await this.request('tools/list', {}, LIST_TIMEOUT_MS)) as { tools?: RemoteTool[] }
    this.tools = Array.isArray(result?.tools) ? result.tools : []
    return this.tools
  }

  async call(tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<string> {
    const budget = timeoutMs ?? CALL_TIMEOUT_MS
    const result = (await this.request('tools/call', { name: tool, arguments: args }, budget)) as {
      content?: { type: string; text?: string }[]
      isError?: boolean
    }
    const text = (result?.content ?? [])
      .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : c.type === 'resource' ? JSON.stringify(c) : `[${c.type}]`))
      .join('\n')
      .trim()
    const out = text || '(empty result)'
    if (result?.isError) throw new Error(out)
    return out.length > MAX_OUTPUT ? out.slice(0, MAX_OUTPUT) + '\n…(truncated)' : out
  }

  kill() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('server stopped'))
    }
    this.pending.clear()
    try {
      this.proc.stdin?.end()
    } catch { /* already closed */ }
    this.proc.kill()
  }
}

/**
 * McpManager — owns every server connection of a workspace.
 * Created once per host; `ensureStarted` connects enabled servers (with
 * per-server isolation — one broken server never blocks the rest).
 */
export class McpManager {
  private conns = new Map<string, McpConnection>()
  private started = false

  constructor(private mcp?: McpConfig) {}

  private servers(): [string, McpServerConfig][] {
    return Object.entries(this.mcp?.servers ?? {})
  }

  /** spawn + initialize + tools/list for every enabled server (idempotent).
   *  A timeout gets ONE automatic retry — npx cold-starts (Codespace, CI,
   *  Termux) regularly blow past the first budget while the download warms
   *  the cache; the second attempt then completes in seconds. */
  async ensureStarted(force = false): Promise<void> {
    if (this.started && !force) return
    this.started = true
    const enabled = this.servers().filter(([, cfg]) => cfg.enabled !== false && cfg.command)
    await Promise.all(
      enabled.map(async ([name, cfg]) => {
        if (this.conns.has(name)) return
        let conn = new McpConnection(name, cfg)
        this.conns.set(name, conn) // registered immediately — status shows 'connecting'
        try {
          await conn.initialize()
          await conn.loadTools()
          conn.state = 'ready'
        } catch (e) {
          conn.state = 'error'
          conn.error = (e as Error).message
          if (/timed out/.test(conn.error)) {
            // one fresh spawn with a doubled budget — see the doc comment
            conn.kill()
            conn = new McpConnection(name, cfg)
            this.conns.set(name, conn)
            try {
              await conn.initialize(initTimeoutMs() * 2)
              await conn.loadTools()
              conn.state = 'ready'
            } catch (e2) {
              conn.state = 'error'
              conn.error = (e2 as Error).message
            }
          }
        }
      }),
    )
  }

  /** restart a single server after a config change */
  async restart(name: string): Promise<void> {
    this.conns.get(name)?.kill()
    this.conns.delete(name)
    this.started = true
    const cfg = this.mcp?.servers?.[name]
    if (!cfg || cfg.enabled === false || !cfg.command) return
    const conn = new McpConnection(name, cfg)
    this.conns.set(name, conn)
    try {
      await conn.initialize()
      await conn.loadTools()
      conn.state = 'ready'
    } catch (e) {
      conn.state = 'error'
      conn.error = (e as Error).message
    }
  }

  /** replace config wholesale (daemon settings save) and reconnect */
  async reconfigure(mcp: McpConfig): Promise<void> {
    this.mcp = mcp
    for (const conn of this.conns.values()) conn.kill()
    this.conns.clear()
    this.started = false
    await this.ensureStarted()
  }

  /** ToolDefinitions for the agent loop — only READY servers contribute */
  toolDefinitions(): ToolDefinition[] {
    const defs: ToolDefinition[] = []
    for (const [name, conn] of this.conns) {
      if (conn.state !== 'ready') continue
      for (const t of conn.tools) {
        const tn = toolName(name, t.name)
        const baseParams = schemaToParams(t.inputSchema)
        const schema = (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }
        defs.push({
          name: tn,
          description: `[mcp:${name}] ${t.description ?? t.name}`.slice(0, 400),
          risk: 'medium',
          params: { ...baseParams, __timeout_ms: 'number — per-call budget in ms (min 1000, max 3600000, default 120000)' },
          inputSchema: {
            ...(typeof schema === 'object' && schema !== null ? schema : {}),
            properties: {
              ...(((schema as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>),
              __timeout_ms: { type: 'number', description: 'Per-call timeout in milliseconds (1000-3600000). Override when this tool is known to be slow.' },
            },
          },
          run: async (input) => {
            const { __timeout_ms, ...args } = input
            return conn.call(t.name, args, clampCallTimeout(__timeout_ms))
          },
        })
      }
    }
    return defs
  }

  status(): McpServerStatus[] {
    return this.servers().map(([name, cfg]) => {
      const conn = this.conns.get(name)
      return {
        name,
        command: [cfg.command, ...(cfg.args ?? [])].join(' '),
        enabled: cfg.enabled !== false,
        state: cfg.enabled === false ? 'disabled' : conn ? conn.state : 'connecting',
        tools: conn?.tools.length ?? 0,
        error: conn?.state === 'error' ? conn.error : undefined,
      }
    })
  }

  /** count of live tools — for the banner / hello payload */
  toolCount(): number {
    return this.toolDefinitions().length
  }

  close() {
    for (const conn of this.conns.values()) conn.kill()
    this.conns.clear()
    this.started = false
  }
}

/* ------------------------------------------------------------------ */
/* config helpers                                                       */
/* ------------------------------------------------------------------ */

export function mcpServersFromConfig(cfg: { mcp?: McpConfig }): [string, McpServerConfig][] {
  return Object.entries(cfg.mcp?.servers ?? {})
}

/** normalize user input into a McpServerConfig entry */
export function normalizeMcpServer(input: {
  name?: string
  command?: string
  args?: unknown
  env?: unknown
  enabled?: boolean
  description?: string
}): { name: string; server?: McpServerConfig; error?: string } {
  const name = slug(String(input.name ?? ''))
  if (!name) return { name: '', error: 'server name required (letters, numbers, -)' }
  const command = String(input.command ?? '').trim()
  if (!command) return { name, error: 'command required (e.g. npx, uvx, node)' }
  const args = Array.isArray(input.args) ? input.args.map((a) => String(a)) : []
  let env: Record<string, string> | undefined
  if (input.env && typeof input.env === 'object' && !Array.isArray(input.env)) {
    env = {}
    for (const [k, v] of Object.entries(input.env as Record<string, unknown>)) {
      const val = String(v ?? '').trim()
      if (val) env[k] = val
    }
    if (Object.keys(env).length === 0) env = undefined
  }
  return {
    name,
    server: {
      command,
      args,
      env,
      enabled: input.enabled !== false,
      description: input.description ? String(input.description) : undefined,
    },
  }
}

/** a few known-good servers the TUI / GUI offer as one-click templates */
export const MCP_TEMPLATES: { name: string; label: string; command: string; args: string[]; note: string }[] = [
  {
    name: 'context7',
    label: 'Context7 — up-to-date library docs',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    note: 'Fresh documentation for any library the agent is working with',
  },
  {
    name: 'filesystem',
    label: 'Filesystem (official) — jailed extra dirs',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    note: 'MCP-native file access; Tagent built-ins already cover most cases',
  },
  {
    name: 'memory',
    label: 'Memory (official) — knowledge graph',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    note: 'Persistent semantic graph memory the agent can query',
  },
  {
    name: 'sequential-thinking',
    label: 'Sequential Thinking — step-by-step reasoning',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    note: 'Structured thinking space for complex multi-step problems',
  },
  {
    name: 'fetch',
    label: 'Fetch (official) — fetch & process web pages',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    note: 'Needs uv installed (pip install uv). Tagent web_fetch already covers basics',
  },
]
