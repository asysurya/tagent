/**
 * Tagent Core — shared types
 * Terminal-native coding agent engine: loop, tools, providers, sessions.
 */

export type Role = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  id: string
  role: Role
  content: string
  createdAt: number
  /** assistant messages may carry executed tool calls */
  toolCalls?: ToolCallRecord[]
  meta?: Record<string, unknown>
}

export interface ToolCallRecord {
  id: string
  tool: string
  input: unknown
  status: 'running' | 'done' | 'error' | 'denied'
  output?: string
  startedAt?: number
  endedAt?: number
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  id: string
  content: string
  status: TodoStatus
  priority?: 'high' | 'medium' | 'low'
}

export interface SessionMeta {
  id: string
  workspaceId: string
  title: string
  model: string
  mode: AgentMode
  createdAt: number
  updatedAt: number
  messageCount: number
  /** set for subagent sessions — the parent session id */
  parentId?: string
  /** true → hidden from the session list, shown on the parent timeline */
  subagent?: boolean
}

export interface SessionData extends SessionMeta {
  messages: ChatMessage[]
  todos: TodoItem[]
}

export type AgentMode = 'build' | 'plan'

/** MCP server definition (stdio transport) — see core/src/mcp.ts */
export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  /** disabled servers are skipped entirely (default true) */
  enabled?: boolean
  /** short note shown to the agent + in pickers */
  description?: string
}

export interface McpConfig {
  servers?: Record<string, McpServerConfig>
}

export interface ModelInfo {
  id: string
  label: string
  provider: string
  description?: string
}

export interface CustomProviderConfig {
  id: string
  label: string
  baseUrl: string
  apiKey?: string
  models: string[]
  /** wire protocol — defaults to 'openai' (OpenAI-compatible) */
  kind?: 'openai' | 'anthropic' | 'google'
}

export interface ProviderInfo {
  id: string
  label: string
  kind: 'builtin' | 'openai' | 'anthropic' | 'google' | 'custom'
  needsKey: boolean
  hasKey: boolean
  models: ModelInfo[]
  docsUrl?: string
  /** env var that provides the key when none is stored in config */
  envVar?: string
  /** featured in the quick picker */
  popular?: boolean
  /** user-defined custom endpoint (deletable) */
  custom?: boolean
}

export type Risk = 'low' | 'medium' | 'high'

export interface PermissionDecision {
  approved: boolean
  remember?: 'once' | 'session' | 'always'
}

export interface PermissionRequest {
  id: string
  tool: string
  input: unknown
  risk: Risk
  reason?: string
}

export interface SubagentInfo {
  id: string
  parentId: string
  description: string
  status: 'running' | 'done' | 'error'
  turns: number
  report?: string
}

/** token accounting reported by providers that expose usage in the stream */
export interface TokenUsage {
  input: number
  output: number
  /** tokens served from a provider-side prompt cache (Anthropic cache_read, OpenAI cached_tokens) */
  cacheRead?: number
}

export type AgentPhase =
  | 'idle'
  | 'thinking'
  | 'acting'
  | 'waiting-permission'
  | 'summarizing'
  | 'done'
  | 'error'
  | 'aborted'

export interface LoopSummary {
  turns: number
  toolCalls: number
  finished: 'complete' | 'max-turns' | 'aborted' | 'error'
  error?: string
  /** cumulative tokens across all turns of this run (when the provider reports usage) */
  usage?: TokenUsage
  /** set when a plan-mode run finished by presenting an implementation plan —
   *  hosts use it to offer the approve-and-build flow */
  plan?: string
}

export interface ToolContext {
  workspaceRoot: string
  sessionId: string
  depth: number
  config: TagentConfig
  events: AgentEvents
  signal?: AbortSignal
  /** mutable shared per-session todo list */
  todos: TodoItem[]
  /** injected by AgentLoop — spawns an isolated subagent. agent is "general",
   *  "explore", or a custom subagent name from .tagent/agents/ */
  spawnSubagent?: (
    description: string,
    prompt: string,
    agent: string,
    maxTurns: number,
  ) => Promise<string>
}

export interface ToolDefinition {
  name: string
  description: string
  risk: Risk
  /** compact parameter documentation for the system prompt */
  params: Record<string, string>
  /** JSON schema (OpenAI function-calling shape) for native tool-calling */
  inputSchema?: Record<string, unknown>
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<string>
}

export interface AgentEvents {
  onStatus?(phase: AgentPhase, detail?: string): void
  onAssistantChunk?(sessionId: string, delta: string): void
  onAssistantMessage?(msg: ChatMessage): void
  onUserMessage?(msg: ChatMessage): void
  onToolStart?(call: ToolCallRecord): void
  onToolEnd?(call: ToolCallRecord): void
  onPermission?(req: PermissionRequest): Promise<PermissionDecision>
  onTodos?(todos: TodoItem[]): void
  onSubagent?(info: SubagentInfo): void
  onFilesChanged?(paths: string[]): void
  onNotify?(level: 'info' | 'warn' | 'error', message: string): void
  /** per-turn token usage — the UI can display live cost */
  onUsage?(usage: TokenUsage & { turn: number }): void
}

export interface MemoryFact {
  id: string
  text: string
  tags?: string[]
  createdAt: number
}

export interface SkillMeta {
  name: string
  description: string
  source: 'builtin' | 'global' | 'workspace'
  path: string
}

/* ------------------------------------------------------------------ */

export interface TagentConfig {
  version: 1
  defaultProvider: string
  defaultModel: string
  /** providerId → API key (BYOK). Stored locally, never committed. */
  apiKeys: Record<string, string>
  /** custom OpenAI-compatible endpoints */
  customProviders: CustomProviderConfig[]
  permissions: {
    defaultMode: 'ask' | 'allow'
    tools: Record<string, 'ask' | 'allow' | 'deny'>
  }
  tools: {
    bash: boolean
    browser: boolean
  }
  github?: {
    clientId?: string
    token?: string
    login?: string
    repo?: string
  }
  mega?: {
    enabled: boolean
    email?: string
    sessionKey?: string
  }
  autoCheckpoint: boolean
  maxTurns: number
  /** agent-maintained progress journal (WORKLOG.md) + live todo protocol */
  worklog?: {
    enabled: boolean
  }
  /** caveman mode — ultra-terse replies + compact prompts. Big token saver. */
  caveman?: boolean
  /** start the web GUI together with `tagent start` (default false — the TUI
   *  is the primary interface; the GUI is a companion). Overridable per run
   *  with --web-gui / --no-web-gui. Stored in the GLOBAL config. */
  webGui?: boolean
  /** use native function-calling when the provider supports it (default true).
   *  The markdown action protocol is always available as a fallback. */
  nativeTools?: boolean
  /** recent workspaces (tracked globally for the workspace switcher) */
  recentWorkspaces?: { path: string; at: number }[]
  /** Model Context Protocol servers (stdio) — extra tools for the agent */
  mcp?: McpConfig
  /** smart caching layer — the token economist */
  cache?: {
    /** file-state cache: unchanged-file re-reads return a stub (default true) */
    fileState?: boolean
    /** TTL cache for web_fetch / ddg_search (default true) */
    web?: boolean
    /** web cache window in minutes (default 10) */
    webTtlMin?: number
  }
  /** auto-diagnostics — a command (tsc --noEmit, npm run lint, …) run after
   *  edit turns; failures are fed back so the model self-corrects */
  diagnostics?: {
    command?: string
    timeoutMs?: number
  }
}
