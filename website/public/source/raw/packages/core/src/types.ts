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

export type AgentMode = 'build' | 'plan' | 'test'

/* ------------------------------------------------------------------ */
/* model roles — main agent · subagents · media analysis                */
/* ------------------------------------------------------------------ */

/** The media modalities tagent can route to dedicated models. */
export type MediaModality = 'vision' | 'audio' | 'video' | 'pdf'

/**
 * Per-role model overrides — "provider/model" (or legacy "provider:model")
 * refs, or a bare model id (same provider as the main agent).
 *
 *   models.subagent        — what task-tool subagents run on
 *   models.media.vision   — screenshots & image QA reports (the vision tool)
 *   models.media.audio|video|pdf — reserved slots for the other modalities
 *
 * Unset → the main agent's defaultProvider/defaultModel (for media, only
 * when that model actually accepts images).
 */
export interface ModelRoles {
  subagent?: string
  media?: Partial<Record<MediaModality, string>>
}

/* ------------------------------------------------------------------ */
/* ask_user — interactive question forms                                */
/* ------------------------------------------------------------------ */

/** One field of an ask_user form. */
export interface AskFormField {
  /** stable key the answers come back under (auto f1/f2… when omitted) */
  id: string
  /** the question shown to the user */
  label: string
  /** option = single choice · multi = multiple choice · input = free text */
  type: 'option' | 'multi' | 'input'
  /** choices for option/multi */
  options?: string[]
  /** option/multi: the user may add their own option (default true) */
  allowAddOption?: boolean
  /** input: placeholder hint */
  placeholder?: string
  /** answer required before submit (default false) */
  required?: boolean
}

/** Form request the agent sends via the ask_user tool. */
export interface AskFormRequest {
  id: string
  title?: string
  /** short context line above the fields */
  intro?: string
  fields: AskFormField[]
  /** show the notes textarea under the fields (default true) */
  allowNotes?: boolean
  notesLabel?: string
}

/** The user's answers (null = the form was dismissed). */
export interface AskFormResponse {
  /** field id → the chosen option / custom text, or the selected choices for multi */
  answers: Record<string, string | string[]>
  /** the optional free-form note below the fields */
  notes?: string
}

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
  /** accepts image input (screenshots) — enables visual test verification */
  vision?: boolean
  /** approx context-window size in tokens — powers the live context bar.
  * 0/undefined = unknown (no bar, only token counters). */
  contextWindow?: number
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

/** One background subagent (task background:true) as tracked by the host's
 *  registry — the id is short ("a1", "a2"…), shown in notifications
 *  ("subagent a1 finished") and addressable from the subs tool. */
export interface BgSubInfo {
  id: string
  description: string
  /** agent kind: general | explore | test | custom name */
  kind: string
  status: 'running' | 'done' | 'error'
  startedAt: number
  finishedAt?: number
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

/** Live context-window state — emitted after every model turn. */
export interface ContextInfo {
  /** approx tokens the NEXT request will carry (last input + output) */
  used: number
  /** the model's context window (0 = unknown) */
  limit: number
  turn: number
  /** true when `used` is a local estimate (provider reported no usage) */
  estimated?: boolean
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
  /** injected by AgentLoop — spawn a DETACHED subagent; resolves immediately
   *  with its id ("a1"…) or an error (e.g. parallel limit). The report is
   *  delivered later through onBackgroundSub → deliverBackgroundReport /
   *  a fresh host run — never as this tool's return value. */
  spawnBackgroundSubagent?: (
    description: string,
    prompt: string,
    agent: string,
    maxTurns: number,
  ) => { id: string } | { error: string }
  /** host-owned registry of background subagents — read by the subs tool */
  backgroundSubs?: { list(): BgSubInfo[] }
  /** injected by AgentLoop (primary agent only) — switch the CURRENT run's
   *  mode. The user approves every switch through the permission gate before
   *  this is ever called (the switch_mode tool is risk:medium). */
  switchMode?: (
    mode: AgentMode,
    reason: string,
  ) => { ok: true; mode: AgentMode } | { error: string }
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
  /** ask_user tool — present the form to the human; null = dismissed/unavailable */
  onAskUser?(form: AskFormRequest): Promise<AskFormResponse | null>
  onTodos?(todos: TodoItem[]): void
  onSubagent?(info: SubagentInfo): void
  onFilesChanged?(paths: string[]): void
  onNotify?(level: 'info' | 'warn' | 'error', message: string): void
  /** per-turn token usage — the UI can display live cost */
  onUsage?(usage: TokenUsage & { turn: number }): void
  /** per-turn context-window state — powers the usage bar + compact prompts */
  onContext?(info: ContextInfo): void
  /** the agent switched modes mid-run via switch_mode (user-approved) —
   *  hosts update their mode display + session persistence from this */
  onModeChange?(mode: AgentMode): void
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
  /** one-line usage hint — frontmatter `usage:` or the body's first paragraph */
  usage?: string
  /** domain tags — frontmatter `tags:` (comma-separated), lowercase */
  tags?: string[]
  source: 'builtin' | 'global' | 'workspace'
  path: string
  /** filled by the skill router — match quality, 0..1 */
  matchScore?: number
  /** filled by the skill router — why it matched ("rule:next-detected") */
  matchReason?: string
}

/* ------------------------------------------------------------------ */

export interface TagentConfig {
  version: 1
  defaultProvider: string
  defaultModel: string
  /** per-role model overrides: subagents + per-modality media models.
   *  Unset roles run on defaultProvider/defaultModel. */
  models?: ModelRoles
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
    /** background dev-server manager (`tagent test` core) — default true */
    serve?: boolean
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
  /** TUI color theme (v0.23.0): dark · light · tokyo-night · dracula · nord ·
   *  gruvbox — stored in the GLOBAL config (a personal preference); every
   *  paint reads the live palette, /theme switches it instantly. */
  theme?: string
  /** context-window management: live usage bar + deterministic compaction.
  *  Compaction is 100% local code — no AI call, no invented content. */
  compact?: {
    /** warn + offer compaction when context use crosses this % of the
    *  model's window (default 80; 0 disables the prompt, /compact stays) */
    threshold?: number
    /** approx tokens of recent turns kept verbatim when compacting (default 10000) */
    keepTokens?: number
  }
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
  /** multi-key per provider: named API keys ("work", "backup", "free tier"…).
   *  The ACTIVE key is always apiKeys[provider] — every existing resolution
   *  path keeps working untouched; the keychain is the drawer, apiKeys is
   *  the one key currently in the slot. Stored in the GLOBAL config so the
   *  config repo carries it across devices (never in project files). */
  keychain?: ProviderKeyEntry[]
  /** smart caching layer — the token economist */
  cache?: {
    /** file-state cache: unchanged-file re-reads return a stub (default true) */
    fileState?: boolean
    /** TTL cache for web_fetch / ddg_search (default true) */
    web?: boolean
    /** web cache window in minutes (default 10) */
    webTtlMin?: number
  }
  /** ordered provider failover — primary first, then these entries.
   *  LEGACY: applies to the MAIN agent only. */
  fallback?: FallbackEntry[]
  /** v0.27: per-role failover chains. `main` mirrors the legacy `fallback`
   *  field when unset (single source of truth stays `fallback` for main);
   *  `subagent` gates task-tool subagent loops; `vision` gates the vision
   *  tool's media model calls. */
  fallbacks?: {
    main?: FallbackEntry[]
    subagent?: FallbackEntry[]
    vision?: FallbackEntry[]
  }
  /** background subagents (task background:true) */
  subagents?: {
    /** max CONCURRENTLY RUNNING background subagents (default 4) — the
     *  task tool refuses spawns beyond this until one finishes */
    maxParallel?: number
  }
  /** auto-diagnostics — a command (tsc --noEmit, npm run lint, …) run after
   *  edit turns; failures are fed back so the model self-corrects */
  diagnostics?: {
    command?: string
    timeoutMs?: number
  }
  /** v0.30: skill discovery — search tool + auto-router */
  skills?: {
    /** auto-load relevant skills based on workspace signals + the user's
     *  message (default true). /reload-skills re-runs it manually. */
    autoRoute?: boolean
    /** max skills auto-loaded per route (default 3) */
    autoRouteMax?: number
    /** min match score 0..1 for auto-load (default 0.5) */
    autoRouteThreshold?: number
  }
}

/** One link in the provider fallback chain. A per-entry apiKey overrides the
 *  stored key — that is how the same provider can be stacked under multiple
 *  accounts (e.g. three OpenRouter keys in a row). */
export interface FallbackEntry {
  provider: string
  model: string
  apiKey?: string
  enabled?: boolean
  /** short display name, e.g. "openrouter backup key" */
  label?: string
}

/** One named API key of a provider — the multi-key model. The ACTIVE key is
 *  apiKeys[provider]; picking a different entry copies it there (and so feeds
 *  every existing resolveApiKey/getAdapter path). */
export interface ProviderKeyEntry {
  /** short stable id (k1, k2…) */
  id: string
  /** provider id this key belongs to */
  provider: string
  /** human label — "work", "backup", "free tier"… */
  label: string
  key: string
  createdAt: number
}
