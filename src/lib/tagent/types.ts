/** Client-side mirrors of the Tagent core types (GUI ⇄ daemon protocol). */

export type Role = 'system' | 'user' | 'assistant'

export interface ToolCallRecord {
  id: string
  tool: string
  input: unknown
  status: 'running' | 'done' | 'error' | 'denied'
  output?: string
  startedAt?: number
  endedAt?: number
}

export interface ChatMessage {
  id: string
  role: Role
  content: string
  createdAt: number
  toolCalls?: ToolCallRecord[]
  meta?: Record<string, unknown>
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
  title: string
  model: string
  mode: AgentMode
  createdAt: number
  updatedAt: number
  messageCount: number
  parentId?: string
  subagent?: boolean
}

export interface SessionData extends SessionMeta {
  messages: ChatMessage[]
  todos: TodoItem[]
}

/** a live read-only share of one session (relay mode) */
export interface RelayEntry {
  code: string
  sessionId: string
  sessionTitle: string
  createdAt: number
  /** connected viewer sockets (server-side count) */
  viewers?: number
}

export type AgentMode = 'build' | 'plan'

export interface ModelInfo {
  id: string
  label: string
  provider: string
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

/** provider fallback — ordered failover chain tried when the primary fails */
export interface FallbackEntry {
  provider: string
  model: string
  apiKey?: string
  enabled?: boolean
  label?: string
}

export interface SanitizedConfig {
  defaultProvider: string
  defaultModel: string
  providers: ProviderInfo[]
  permissions: { defaultMode: 'ask' | 'allow'; tools: Record<string, 'ask' | 'allow' | 'deny'> }
  tools: { bash: boolean; browser: boolean }
  github: { connected: boolean; login: string | null; repo: string | null }
  mega: { enabled: boolean; email: string | null }
  autoCheckpoint: boolean
  maxTurns: number
  worklog: { enabled: boolean }
  caveman: boolean
  webGui: boolean
  cache: { fileState: boolean; web: boolean; webTtlMin: number }
  /** ordered provider failover chain (server-side feature) */
  fallback?: FallbackEntry[]
  mcp?: { servers?: Record<string, McpServerConfig> }
  mcpStatus?: McpServerStatus[]
}

/** MCP (Model Context Protocol) server — client-side mirror */
export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  enabled?: boolean
  description?: string
}

export interface McpServerStatus {
  name: string
  command: string
  enabled: boolean
  state: 'connecting' | 'ready' | 'error' | 'disabled'
  tools: number
  error?: string
}

export interface McpTemplate {
  name: string
  label: string
  command: string
  args: string[]
  note: string
}

export interface PluginMeta {
  name: string
  file: string
  scope: 'workspace' | 'global'
}

export interface PermissionRequest {
  id: string
  tool: string
  input: unknown
  risk?: string
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

export interface AgentStatus {
  phase:
    | 'idle' | 'thinking' | 'acting' | 'waiting-permission'
    | 'summarizing' | 'done' | 'error' | 'aborted'
  detail?: string
}

export interface LoopSummary {
  turns: number
  toolCalls: number
  finished: 'complete' | 'max-turns' | 'aborted' | 'error'
  error?: string
}

export interface MemoryFact {
  id: string
  text: string
  tags?: string[]
  createdAt: number
}

export interface MemoryState {
  agents: { global: string; workspace: string }
  facts: MemoryFact[]
}

export interface SkillMeta {
  name: string
  description: string
  source: 'builtin' | 'global' | 'workspace'
  path: string
}

export interface CheckpointMeta {
  id: string
  label: string
  at: number
  files: number
}

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
  children?: FileNode[]
}

export interface WorkspaceInfo {
  path: string
  name: string
  exists: boolean
  at?: number
}

export interface HelloPayload {
  server: string
  version: string
  workspace: { id: string; name: string; path: string }
  config: SanitizedConfig
  skills: SkillMeta[]
  memory: MemoryState
  sessions: SessionMeta[]
  tools: { name: string; description: string; risk: string }[]
  checkpoints: CheckpointMeta[]
  recentWorkspaces?: WorkspaceInfo[]
  mcp?: McpServerStatus[]
  plugins?: PluginMeta[]
}

/* --------- GitHub auth + project sync (v0.13 guest→login flow) --------- */

/** 'auth:status' — guest until a GitHub credential exists (no network) */
export interface AuthStatusResponse {
  ok: boolean
  guest: boolean
  login?: string
  error?: string
}

/** 'auth:login' — PAT validated against GitHub, then saved locally */
export interface AuthLoginResponse {
  ok: boolean
  login?: string
  /** true when the workspace has work, isn't linked and wasn't refused —
   *  show the one-time "sync this project to GitHub?" dialog */
  promptLink?: boolean
  error?: string
}

/** 'sync:status' — registry link + auth state for the active workspace */
export interface SyncStatusResponse {
  ok: boolean
  linked: boolean
  repo?: string
  lastSyncAt?: number
  guest: boolean
  login?: string
  error?: string
}

/** 'sync:push' — commit + push via core syncProject (registry auto-link) */
export interface SyncPushResponse {
  ok: boolean
  repo?: string
  url?: string
  commit?: string
  lastSyncAt?: number
  /** auth guard: 'not logged in' → the GUI should open the login dialog */
  error?: string
}

/** 'sync:link' — link the workspace to a repo (ensures the default repo when omitted) */
export interface SyncLinkResponse {
  ok: boolean
  repo?: string
  /** true when the repo was just created on GitHub */
  created?: boolean
  error?: string
}

/** 'projects:list' — the global project registry (~/.tagent/projects.json) */
export interface ProjectListResponse {
  ok: boolean
  projects: ProjectReg[]
  error?: string
}

/** registry entry — client-side mirror of @tagent/core ProjectReg */
export interface ProjectReg {
  id: string
  /** workspace display name (basename of root) */
  name: string
  /** owner/name on GitHub */
  repo: string
  /** resolved absolute workspace path — the registry key */
  root: string
  linkedAt: number
  lastSyncAt?: number
}

export type Connection = 'connecting' | 'ready' | 'demo'
