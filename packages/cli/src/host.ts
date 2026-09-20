import path from 'node:path'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'

import {
  AgentLoop,
  PermissionManager,
  SessionStore,
  CURRENT_VERSION,
  listProviderInfos,
  getAdapter,
  loadConfig,
  saveConfig,
  updateGlobalConfig,
  workspaceDir,
  listSkills,
  loadSkill,
  readAgents,
  saveAgents,
  listFacts,
  saveFact,
  deleteFact,
  listCheckpoints,
  undoCheckpoint,
  validatePat,
  startDeviceLogin,
  pollDeviceToken,
  pushWorkspace,
  loadPlugins,
  emitPluginEvent,
  pluginMeta,
  pluginToolDefinitions,
  scaffoldPlugin,
  buildToolset,
  McpManager,
  normalizeMcpServer,
  MCP_TEMPLATES,
  type McpServerStatus,
  type McpServerConfig,
  listRecentWorkspaces,
  rememberWorkspace,
  syncMemoryToMega,
  pullMemoryFromMega,
  exportShare,
  createRelay,
  loadRelays,
  saveRelays,
  revokeRelay as revokeRelayEntry,
  relayUrl as relayLinkUrl,
  refreshModelCache,
  listSubagents,
  SUBAGENT_TEMPLATE,
  sanitizeFallback,
  describeChain,
  diagnosticsCommand,
  runDiagnostics,
  type RelayEntry,
  type AgentEvents,
  type ChatMessage,
  type LoopSummary,
  type PermissionDecision,
  type PermissionRequest,
  type SessionData,
  type SessionMeta,
  type TagentConfig,
  type ToolCallRecord,
  type CustomProviderConfig,
  type AgentMode,
} from '@tagent/core'

import { walkTree, readWorkspaceFile, saveWorkspaceFile } from './files'

/**
 * AgentHost — the single brain shared by every frontend.
 *
 * The TUI calls these methods directly; the daemon wraps them in
 * socket.io RPC; both listen to the same `bus` events, so a terminal and a
 * browser attached to the same agent stay perfectly in sync. No frontend has
 * features the other lacks — that is the point.
 */

interface PendingPermission {
  resolve: (d: PermissionDecision) => void
  req: PermissionRequest
  timer: ReturnType<typeof setTimeout>
}

export interface HostOptions {
  workspaceRoot: string
  configOverride?: Partial<TagentConfig>
  quiet?: boolean
}

export class AgentHost {
  root: string
  workspaceId: string
  cfg: TagentConfig
  /** every frontend subscribes here — TUI, browser tabs, future relays */
  readonly bus = new EventEmitter()

  private sessions: SessionStore
  session: SessionData | undefined
  private loop: AgentLoop | undefined
  private pending = new Map<string, PendingPermission>()
  /** last device-flow start (github:device:poll consumes it) */
  private deviceStart: Awaited<ReturnType<typeof startDeviceLogin>> | undefined
  /** MCP connections — one manager per workspace config */
  private mcp = new McpManager()
  /** a plan-mode run that presented a plan — awaiting approve/reject */
  private lastPlan: { sessionId: string; plan: string } | undefined

  constructor(opts: HostOptions) {
    this.root = path.resolve(opts.workspaceRoot)
    this.workspaceId = this.root
    this.cfg = loadConfig(this.root, opts.configOverride)
    this.mcp = new McpManager(this.cfg.mcp)
    this.sessions = new SessionStore(this.root, this.workspaceId)
    rememberWorkspace(this.root)
    this.bus.setMaxListeners(50)
  }

  private log(...a: unknown[]) { /* frontends render events; host stays quiet */ }

  private persist() { saveConfig(this.root, this.cfg) }

  /* ------------------------------------------------------------------ */
  /* world snapshot                                                      */
  /* ------------------------------------------------------------------ */

  hello() {
    return {
      server: 'tagent',
      version: CURRENT_VERSION,
      workspace: {
        id: this.workspaceId,
        name: path.basename(this.root),
        path: this.root,
      },
      config: this.sanitizeConfig(),
      skills: listSkills(this.root),
      memory: {
        agents: readAgents(this.root),
        facts: listFacts(this.root),
      },
      sessions: this.sessions.list(),
      tools: buildToolset({ config: this.cfg }).map((t) => ({
        name: t.name, description: t.description, risk: t.risk,
      })),
      checkpoints: listCheckpoints(this.root).slice(0, 10),
      recentWorkspaces: listRecentWorkspaces(this.root),
      mcp: this.mcpStatus(),
      plugins: pluginMeta(this.root),
    }
  }

  sanitizeConfig() {
    return {
      defaultProvider: this.cfg.defaultProvider,
      defaultModel: this.cfg.defaultModel,
      providers: listProviderInfos(this.cfg),
      permissions: this.cfg.permissions,
      tools: this.cfg.tools,
      github: { connected: !!this.cfg.github?.token, login: this.cfg.github?.login ?? null, repo: this.cfg.github?.repo ?? null },
      mega: { enabled: !!this.cfg.mega?.enabled, email: this.cfg.mega?.email ?? null },
      autoCheckpoint: this.cfg.autoCheckpoint,
      maxTurns: this.cfg.maxTurns,
      worklog: { enabled: this.cfg.worklog?.enabled !== false },
      caveman: this.cfg.caveman === true,
      webGui: this.cfg.webGui === true,
      cache: {
        fileState: this.cfg.cache?.fileState !== false,
        web: this.cfg.cache?.web !== false,
        webTtlMin: this.cfg.cache?.webTtlMin ?? 10,
      },
      fallback: (this.cfg.fallback ?? []).map((f) => ({
        provider: f.provider,
        model: f.model,
        enabled: f.enabled !== false,
        label: f.label,
        ...(f.apiKey ? { apiKey: '••••' } : {}),
      })),
      diagnostics: { command: diagnosticsCommand(this.cfg) ?? '' },
      bashEnabled: this.cfg.tools.bash,
      browserEnabled: this.cfg.tools.browser,
      mcp: this.cfg.mcp ?? { servers: {} },
      mcpStatus: this.mcpStatus(),
    }
  }

  /* ------------------------------------------------------------------ */
  /* workspaces                                                          */
  /* ------------------------------------------------------------------ */

  listWorkspaces() {
    return { current: this.root, recent: listRecentWorkspaces(this.root) }
  }

  switchWorkspace(target: string): { ok?: boolean; error?: string; workspace?: unknown } {
    try {
      const dir = path.resolve(String(target ?? ''))
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return { error: `Not a directory: ${dir}` }
      }
      if (dir === this.root) return { ok: true, workspace: this.hello() }
      if (this.loop) this.loop.stop()
      this.mcp.close()
      this.mcp = new McpManager()
      this.root = dir
      this.workspaceId = dir
      this.cfg = loadConfig(this.root)
      this.mcp = new McpManager(this.cfg.mcp)
      this.sessions = new SessionStore(this.root, this.workspaceId)
      this.session = undefined
      rememberWorkspace(this.root)
      const payload = this.hello()
      this.bus.emit('workspace:changed', payload)
      return { ok: true, workspace: payload }
    } catch (e) {
      return { error: (e as Error).message }
    }
  }

  /** webGui preference — launcher behavior, always global */
  setWebGui(v: boolean) {
    this.cfg.webGui = v
    updateGlobalConfig({ webGui: v })
    return { ok: true }
  }

  /* ------------------------------------------------------------------ */
  /* sessions                                                            */
  /* ------------------------------------------------------------------ */

  async ensureSession(mode: AgentMode = 'build'): Promise<SessionData> {
    if (this.session) return this.session
    this.session = this.sessions.create('New session', this.cfg.defaultModel, mode)
    this.bus.emit('session:active', this.session)
    this.bus.emit('session:list', this.sessions.list())
    return this.session
  }

  newSession(mode: AgentMode = 'build'): SessionData {
    this.session = this.sessions.create('New session', this.cfg.defaultModel, mode)
    this.bus.emit('session:active', this.session)
    this.bus.emit('session:list', this.sessions.list())
    return this.session
  }

  loadSession(id: string): SessionData | null {
    const s = this.sessions.load(id)
    if (s) {
      this.session = s
      this.bus.emit('session:active', s)
      this.bus.emit('todos:update', { sessionId: s.id, todos: s.todos })
    }
    return s ?? null
  }

  deleteSession(id: string) {
    if (this.session?.id === id) this.session = undefined
    this.sessions.delete(id)
    this.bus.emit('session:list', this.sessions.list())
  }

  renameSession(id: string, title: string): SessionData | null {
    const s = this.sessions.rename(id, title)
    if (!s) return null
    if (this.session?.id === id) this.session = s
    this.bus.emit('session:list', this.sessions.list())
    if (this.session?.id === id) this.bus.emit('session:active', s)
    return s
  }

  setSessionMode(mode: AgentMode) {
    if (this.session) {
      this.session.mode = mode ?? 'build'
      this.sessions.save(this.session)
      this.bus.emit('session:active', this.session)
    }
  }

  listSessions(): SessionMeta[] {
    return this.sessions.list()
  }

  /** persisted subagent runs of one session — the multi-agent timeline */
  timeline(sessionId?: string): SessionMeta[] {
    const id = sessionId ?? this.session?.id
    if (!id) return []
    return this.sessions.listSubagents(id)
  }

  /* ------------------------------------------------------------------ */
  /* chat — the run                                                       */
  /* ------------------------------------------------------------------ */

  /** send a message to the agent; resolves when the run finishes */
  async chatSend(text: string, mode?: AgentMode): Promise<LoopSummary> {
    let body = String(text ?? '').trim()
    if (!body) throw new Error('empty message')
    const s = await this.ensureSession(mode ?? this.session?.mode ?? 'build')
    if (mode && s.mode !== mode) {
      s.mode = mode
      this.sessions.save(s)
    }
    // build-mode PRD gate — the first build task without a PRD gets one chance
    // to route through plan mode (the agent asks; the user decides)
    if (s.mode === 'build' && s.messages.length === 0 && !fs.existsSync(path.join(this.root, 'PRD.md'))) {
      body =
        `[system] No PRD.md exists in this workspace yet. BEFORE doing the task, ask the user in ONE short message: ` +
        `(a) continue WITHOUT a PRD (they may answer "lanjut tanpa prd" / "continue"), or (b) switch to plan mode first ` +
        `(/mode plan) so you can interview them and produce one. ` +
        `If they say continue, do the task normally and never ask again this session. ` +
        `If they choose plan mode, stop immediately and tell them to switch.\n\n${body}`
    }
    // auto-title the session from its first real message
    if (s.title === 'New session') {
      s.title = body.replace(/\s+/g, ' ').slice(0, 48) || 'New session'
      this.sessions.save(s)
      this.bus.emit('session:list', this.sessions.list())
    }
    if (this.loop) {
      this.bus.emit('notify', { level: 'warn', message: 'A run is already in progress — stopped it first.' })
      this.loop.stop()
      await new Promise((r) => setTimeout(r, 100))
    }

    const events = this.makeEvents(s.id)
    const plugins = await loadPlugins(this.root, this.cfg)
    await emitPluginEvent(plugins, 'onSessionStart', { session: s, config: this.cfg })
    // MCP servers: lazy-connect on the first run of the workspace
    await this.mcp.ensureStarted()
    if (this.mcp.status().some((st) => st.state === 'error')) {
      this.bus.emit('notify', { level: 'warn', message: 'Some MCP servers failed to start — /mcp shows details.' })
    }
    const extraTools = [...this.mcp.toolDefinitions(), ...pluginToolDefinitions(plugins)]
    const permissions = new PermissionManager(this.cfg, () => this.persist())
    this.loop = new AgentLoop({
      session: s,
      provider: getAdapter(this.cfg.defaultProvider, this.cfg),
      model: this.cfg.defaultModel,
      events,
      permissions,
      config: this.cfg,
      mode: s.mode,
      extraTools,
      onSessionUpdate: (sess) => this.sessions.save(sess),
      // subagent runs persist → timeline survives restarts
      onSubagentSession: (sub) => this.sessions.save(sub),
    })
    try {
      const summary = await this.loop.run(body)
      await emitPluginEvent(plugins, 'onAgentDone', { summary, session: s })
      this.sessions.save(s)
      this.bus.emit('session:list', this.sessions.list())
      this.bus.emit('chat:done', {
        sessionId: s.id,
        summary,
        checkpoints: listCheckpoints(this.root).slice(0, 10),
      })
      // plan mode delivered a plan → offer the approve-and-build flow
      if (summary.plan && s.mode === 'plan') {
        this.lastPlan = { sessionId: s.id, plan: summary.plan }
        this.bus.emit('plan:ready', { sessionId: s.id, plan: summary.plan })
      }
      return summary
    } finally {
      this.loop = undefined
    }
  }

  /**
   * Respond to a presented plan. execute=true writes PRD.md, switches the
   * session to build mode, and kicks off the implementation.
   */
  approvePlan(execute: boolean): { ok: boolean; error?: string } {
    const lp = this.lastPlan
    this.lastPlan = undefined
    if (!lp) return { ok: false, error: 'no plan waiting for approval' }
    if (!this.session || this.session.id !== lp.sessionId) return { ok: false, error: 'session changed — plan expired' }
    if (this.running) return { ok: false, error: 'a run is already in progress' }
    if (!execute) return { ok: true } // keep planning
    try {
      const prd = renderPrdFromPlan(lp.plan, this.session.title)
      fs.writeFileSync(path.join(this.root, 'PRD.md'), prd)
    } catch (e) {
      return { ok: false, error: `could not write PRD.md: ${(e as Error).message}` }
    }
    this.setSessionMode('build')
    this.bus.emit('notify', { level: 'info', message: 'Plan approved — PRD.md written, switching to build mode.' })
    void this.chatSend(
      'The plan above was approved and saved to PRD.md. Execute it now, step by step, verifying as you go.',
    ).catch(() => undefined)
    return { ok: true }
  }

  interrupt() {
    this.loop?.stop()
  }

  get running(): boolean {
    return !!this.loop
  }

  private makeEvents(runSessionId: string): AgentEvents {
    return {
      onStatus: (phase, detail) => this.bus.emit('agent:status', { phase, detail }),
      onUserMessage: (msg: ChatMessage) => this.bus.emit('message:new', { sessionId: runSessionId, message: msg }),
      onAssistantChunk: (sessionId, delta) => this.bus.emit('agent:chunk', { sessionId: sessionId || runSessionId, text: delta }),
      onAssistantMessage: (msg: ChatMessage) => this.bus.emit('message:new', { sessionId: runSessionId, message: msg }),
      onToolStart: (call: ToolCallRecord) => this.bus.emit('tool:start', { sessionId: runSessionId, call }),
      onToolEnd: (call: ToolCallRecord) => this.bus.emit('tool:end', { sessionId: runSessionId, call }),
      onTodos: (todos) => this.bus.emit('todos:update', { sessionId: runSessionId, todos }),
      onSubagent: (info) => this.bus.emit('subagent:update', { sessionId: runSessionId, info }),
      onFilesChanged: (paths) => this.bus.emit('files:changed', { paths }),
      onNotify: (level, message) => this.bus.emit('notify', { level, message }),
      onPermission: (req: PermissionRequest) =>
        new Promise<PermissionDecision>((resolve) => {
          const timer = setTimeout(() => {
            this.pending.delete(req.id)
            resolve({ approved: false })
          }, 5 * 60 * 1000)
          this.pending.set(req.id, { resolve, req, timer })
          this.bus.emit('permission:request', req)
        }),
    }
  }

  permissionRespond(requestId: string, approved: boolean, remember?: 'once' | 'session' | 'always') {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    pending.resolve({ approved: !!approved, remember })
    return true
  }

  /* ------------------------------------------------------------------ */
  /* files & terminal                                                     */
  /* ------------------------------------------------------------------ */

  filesList(sub?: string) {
    return walkTree(this.root, sub ?? '.')
  }

  fileRead(p: string) {
    return readWorkspaceFile(this.root, p)
  }

  fileSave(p: string, content: string) {
    const result = saveWorkspaceFile(this.root, p, content)
    this.bus.emit('files:changed', { paths: [p] })
    return result
  }

  async terminalExec(command: string): Promise<string> {
    if (!this.cfg.tools.bash) return 'Terminal is disabled in this environment (settings → tools).'
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)
    try {
      const { stdout, stderr } = await exec('bash', ['-lc', String(command ?? '')], {
        cwd: this.root,
        timeout: 30_000,
        maxBuffer: 1024 * 512,
        env: { ...process.env, NO_COLOR: '1' },
      })
      return `${stdout}${stderr ? `\n${stderr}` : ''}`.slice(0, 30_000)
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; message?: string }
      return `${err.stdout ?? ''}${err.stderr ?? err.message ?? ''}`.slice(0, 30_000)
    }
  }

  /* ------------------------------------------------------------------ */
  /* memory · skills · checkpoints                                        */
  /* ------------------------------------------------------------------ */

  memoryGet() {
    return { agents: readAgents(this.root), facts: listFacts(this.root) }
  }

  memorySaveAgents(which: 'global' | 'workspace', content: string) {
    saveAgents(this.root, which === 'global' ? 'global' : 'workspace', String(content ?? ''))
    return { ok: true }
  }

  memorySaveFact(text: string) {
    return { fact: saveFact(this.root, String(text ?? '')) }
  }

  memoryDeleteFact(id: string) {
    return { ok: deleteFact(this.root, id) }
  }

  skillsList() {
    return listSkills(this.root)
  }

  skillRead(name: string) {
    return { content: loadSkill(this.root, name) }
  }

  undoCheckpoint() {
    const meta = undoCheckpoint(this.root)
    this.bus.emit('files:changed', { paths: ['*'] })
    return { ok: !!meta, checkpoint: meta ?? null }
  }

  stats() {
    const dir = workspaceDir(this.root) + '/sessions'
    const sessions = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0
    return { sessions, snapshots: listCheckpoints(this.root).length }
  }

  /* ------------------------------------------------------------------ */
  /* MCP servers + plugins                                               */
  /* ------------------------------------------------------------------ */

  mcpStatus(): McpServerStatus[] {
    return this.mcp.status()
  }

  /** connect now (first run) and return per-server state */
  async mcpEnsure(): Promise<McpServerStatus[]> {
    await this.mcp.ensureStarted()
    return this.mcp.status()
  }

  /** live tool list of every ready server — for /mcp and the GUI */
  mcpTools() {
    return this.mcp.toolDefinitions().map((t) => ({ name: t.name, description: t.description }))
  }

  mcpTemplates() {
    return MCP_TEMPLATES
  }

  /** upsert one server from user input; restarts it when enabled */
  async mcpSave(p: {
    name?: string
    command?: string
    args?: unknown
    env?: unknown
    enabled?: boolean
    description?: string
  }): Promise<{ ok?: boolean; error?: string; status?: McpServerStatus[] }> {
    const r = normalizeMcpServer(p)
    if (r.error || !r.server || !r.name) return { error: r.error ?? 'invalid server' }
    this.cfg.mcp = { ...(this.cfg.mcp ?? {}), servers: { ...(this.cfg.mcp?.servers ?? {}), [r.name]: r.server } }
    this.persist()
    if (r.server.enabled !== false) await this.mcpRestart(r.name)
    return { ok: true, status: this.mcp.status() }
  }

  async mcpRemove(name: string): Promise<{ ok?: boolean; error?: string }> {
    const servers = { ...(this.cfg.mcp?.servers ?? {}) }
    if (!servers[name]) return { error: `no server named "${name}"` }
    delete servers[name]
    this.cfg.mcp = { ...(this.cfg.mcp ?? {}), servers }
    this.persist()
    this.mcp.close()
    this.mcp = new McpManager(this.cfg.mcp)
    return { ok: true }
  }

  async mcpToggle(name: string): Promise<{ ok?: boolean; error?: string; enabled?: boolean }> {
    const s = this.cfg.mcp?.servers?.[name]
    if (!s) return { error: `no server named "${name}"` }
    s.enabled = s.enabled === false
    this.persist()
    if (s.enabled === false) {
      this.mcp.close()
      this.mcp = new McpManager(this.cfg.mcp)
    } else {
      await this.mcpRestart(name)
    }
    return { ok: true, enabled: s.enabled !== false }
  }

  private async mcpRestart(_name: string) {
    this.mcp.close()
    this.mcp = new McpManager(this.cfg.mcp)
    await this.mcp.ensureStarted()
  }

  pluginsList() {
    return pluginMeta(this.root)
  }

  pluginScaffold(name: string) {
    const file = scaffoldPlugin(this.root, String(name ?? '').trim() || 'my-plugin')
    return { ok: true, file }
  }

  /** every plugin command of this workspace — for /help and autocomplete */
  async pluginCommandList(): Promise<{ name: string; description?: string; plugin: string }[]> {
    const plugins = await loadPlugins(this.root, this.cfg)
    return plugins.flatMap((p) => p.commands.map((c) => ({ name: c.name, description: c.description, plugin: p.name })))
  }

  /** run a plugin slash command (loads plugins fresh, isolated) */
  async pluginCommandRun(name: string, args: string): Promise<{ ok: boolean; output?: string; error?: string }> {
    const plugins = await loadPlugins(this.root, this.cfg)
    for (const p of plugins) {
      const cmd = p.commands.find((c) => c.name === name)
      if (!cmd) continue
      try {
        const out = await cmd.run({ args, workspaceRoot: this.root, config: this.cfg })
        return { ok: true, output: typeof out === 'string' ? out : undefined }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
    return { ok: false, error: `no plugin command named "${name}"` }
  }

  /* ------------------------------------------------------------------ */
  /* settings                                                             */
  /* ------------------------------------------------------------------ */

  settingsSave(patch: Partial<{
    defaultProvider: string
    defaultModel: string
    apiKey: { provider: string; key: string }
    permissions: TagentConfig['permissions']
    tools: TagentConfig['tools']
    maxTurns: number
    autoCheckpoint: boolean
    worklogEnabled: boolean
    caveman: boolean
    webGui: boolean
    /** smart cache toggles — unchanged-file stubs + web TTL cache */
    cacheFileState?: boolean
    cacheWeb?: boolean
    /** ordered provider failover chain (replaces the whole list) */
    fallback?: import('@tagent/core').FallbackEntry[]
    /** auto-diagnostics command — "" clears the gate */
    diagnosticsCommand?: string
    /** upsert a custom provider by id (empty baseUrl + remove → delete) */
    customProvider?: CustomProviderConfig
    customProviderRemove?: string
  }>) {
    if (patch.defaultProvider) this.cfg.defaultProvider = patch.defaultProvider
    if (patch.defaultModel) this.cfg.defaultModel = patch.defaultModel
    if (patch.apiKey?.provider) {
      const key = String(patch.apiKey.key ?? '').trim()
      if (key) this.cfg.apiKeys[patch.apiKey.provider] = key
      else delete this.cfg.apiKeys[patch.apiKey.provider]
    }
    if (patch.customProvider) {
      const cp = patch.customProvider
      const list = this.cfg.customProviders ?? (this.cfg.customProviders = [])
      const i = list.findIndex((p) => p.id === cp.id)
      const normalized: CustomProviderConfig = {
        id: String(cp.id || '').trim(),
        label: String(cp.label || cp.id).trim(),
        baseUrl: String(cp.baseUrl || '').trim().replace(/\/$/, ''),
        apiKey: String(cp.apiKey ?? '').trim() || undefined,
        models: Array.isArray(cp.models) ? cp.models.map((m) => String(m).trim()).filter(Boolean) : [],
        kind: cp.kind === 'anthropic' || cp.kind === 'google' ? cp.kind : 'openai',
      }
      if (!normalized.id || !normalized.baseUrl) {
        return { error: 'custom provider needs an id and a baseUrl' }
      }
      if (i >= 0) list[i] = normalized
      else list.push(normalized)
    }
    if (patch.customProviderRemove) {
      this.cfg.customProviders = (this.cfg.customProviders ?? []).filter((p) => p.id !== patch.customProviderRemove)
      if (this.cfg.defaultProvider === patch.customProviderRemove) {
        this.cfg.defaultProvider = 'zai'
        this.cfg.defaultModel = 'glm-4.7'
      }
    }
    if (patch.permissions) this.cfg.permissions = patch.permissions
    if (patch.tools) this.cfg.tools = patch.tools
    if (typeof patch.maxTurns === 'number') this.cfg.maxTurns = Math.min(Math.max(patch.maxTurns, 1), 80)
    if (typeof patch.autoCheckpoint === 'boolean') this.cfg.autoCheckpoint = patch.autoCheckpoint
    if (typeof patch.worklogEnabled === 'boolean') {
      this.cfg.worklog = { ...(this.cfg.worklog ?? {}), enabled: patch.worklogEnabled }
    }
    if (typeof patch.caveman === 'boolean') this.cfg.caveman = patch.caveman
    if (typeof patch.webGui === 'boolean') {
      // launcher behavior — global so every workspace gets it
      this.cfg.webGui = patch.webGui
      updateGlobalConfig({ webGui: patch.webGui })
    }
    // smart cache toggles
    if (patch.cacheFileState !== undefined || patch.cacheWeb !== undefined) {
      const cur = this.cfg.cache ?? {}
      if (typeof patch.cacheFileState === 'boolean') cur.fileState = patch.cacheFileState
      if (typeof patch.cacheWeb === 'boolean') cur.web = patch.cacheWeb
      this.cfg.cache = cur
    }
    // provider fallback chain (full replace — the GUI/TUI sends the ordered list)
    if (patch.fallback !== undefined) this.cfg.fallback = sanitizeFallback(patch.fallback)
    // auto-diagnostics gate
    if (typeof patch.diagnosticsCommand === 'string') {
      this.cfg.diagnostics = { ...(this.cfg.diagnostics ?? {}), command: patch.diagnosticsCommand.trim().slice(0, 300) }
    }
    this.persist()
    return { ok: true, config: this.sanitizeConfig() }
  }

  /** live model discovery — hits every listable provider that has a key */
  async providersRefresh() {
    const result = await refreshModelCache(this.cfg)
    this.bus.emit('notify', {
      level: 'info',
      message: `Model discovery: ${result.updated.length} provider(s) refreshed${result.failed.length ? `, ${result.failed.length} unreachable` : ''}.`,
    })
    return { ok: true, ...result, config: this.sanitizeConfig() }
  }

  /* ------------------------------------------------------------------ */
  /* MEGA sync                                                           */
  /* ------------------------------------------------------------------ */

  megaSave(p: { enabled: boolean; email?: string; sessionKey?: string }) {
    const email = String(p?.email ?? '').trim()
    const sessionKey = String(p?.sessionKey ?? '').trim()
    this.cfg.mega = {
      ...(this.cfg.mega ?? {}),
      enabled: !!p?.enabled,
      email: email || undefined,
      sessionKey: sessionKey || (p?.enabled ? this.cfg.mega?.sessionKey : undefined),
    }
    this.persist()
    return { ok: true, mega: { enabled: this.cfg.mega.enabled, email: this.cfg.mega.email ?? null } }
  }

  async megaSync() {
    const result = await syncMemoryToMega(this.root, this.cfg)
    this.bus.emit('notify', { level: 'info', message: `MEGA sync done — ${result.facts} facts backed up (end-to-end encrypted).` })
    return { ok: true, ...result }
  }

  async megaPull() {
    const result = await pullMemoryFromMega(this.root, this.cfg)
    const payload = this.hello()
    this.bus.emit('workspace:changed', payload)
    return { ok: true, ...result }
  }

  /* ------------------------------------------------------------------ */
  /* GitHub — PAT, device flow, push                                     */
  /* ------------------------------------------------------------------ */

  /** clientId for the device flow: config → env. Tagent's own OAuth app is
   *  bundled; users can override with TAGENT_GH_CLIENT_ID. */
  private deviceClientId(): string {
    return this.cfg.github?.clientId || process.env.TAGENT_GH_CLIENT_ID || ''
  }

  async githubPat(token: string) {
    const login = await validatePat(token)
    this.cfg.github = { ...(this.cfg.github ?? {}), token, login }
    this.persist()
    return { ok: true, login }
  }

  async githubLogout() {
    this.cfg.github = { ...(this.cfg.github ?? {}), token: undefined, login: undefined }
    this.persist()
    return { ok: true }
  }

  /** Start the OAuth device flow. Returns the code the user must enter. */
  async githubDeviceStart() {
    const clientId = this.deviceClientId()
    if (!clientId) {
      throw new Error('No OAuth client_id configured — set TAGENT_GH_CLIENT_ID or github.clientId in config, or use a PAT instead.')
    }
    this.deviceStart = await startDeviceLogin(clientId)
    return {
      user_code: this.deviceStart.user_code,
      verification_uri: this.deviceStart.verification_uri,
      expires_in: this.deviceStart.expires_in,
      interval: this.deviceStart.interval,
    }
  }

  /** Block until the user authorizes (or timeout). Saves the token on success. */
  async githubDevicePoll() {
    if (!this.deviceStart) throw new Error('No device login in progress — call github:device:start first.')
    const token = await pollDeviceToken(this.deviceClientId(), this.deviceStart)
    const login = await validatePat(token)
    this.cfg.github = { ...(this.cfg.github ?? {}), token, login }
    this.persist()
    this.deviceStart = undefined
    return { ok: true, login }
  }

  async githubPush(message?: string) {
    const result = await pushWorkspace(this.root, this.cfg, message || 'Update from Tagent', (line) =>
      this.bus.emit('notify', { level: 'info', message: line }),
    )
    this.bus.emit('notify', { level: 'info', message: `Pushed to ${result.repo} (${result.commit})` })
    return { ok: true, result }
  }

  /* ------------------------------------------------------------------ */
  /* share links                                                          */
  /* ------------------------------------------------------------------ */

  /** Export a session as a standalone HTML file (default: the active one). */
  share(sessionId?: string): { ok: boolean; url?: string; file?: string; error?: string } {
    const s =
      (sessionId && this.sessions.load(sessionId)) ||
      (sessionId ? undefined : this.session) ||
      (sessionId ? undefined : this.sessions.list()[0] && this.sessions.load(this.sessions.list()[0].id))
    if (!s) return { ok: false, error: sessionId ? `session not found: ${sessionId}` : 'no session to share' }
    const r = exportShare(this.root, s)
    return { ok: true, url: r.url, file: r.file }
  }

  /* ------------------------------------------------------------------ */
  /* relay mode — live read-only sharing                                 */
  /* ------------------------------------------------------------------ */

  /** Read a session without activating it — the relay viewer snapshot. */
  sessionSnapshot(sessionId?: string): SessionData | null {
    const id = sessionId ?? this.session?.id
    if (!id) return null
    return this.sessions.load(id) ?? null
  }

  /** Create (or return) the live relay for a session — one relay per session. */
  relayCreate(sessionId?: string): { ok: boolean; code?: string; url?: string; error?: string } {
    const s =
      (sessionId && this.sessions.load(sessionId)) ||
      (sessionId ? undefined : this.session) ||
      (sessionId ? undefined : this.sessions.list()[0] && this.sessions.load(this.sessions.list()[0].id))
    if (!s) return { ok: false, error: sessionId ? `session not found: ${sessionId}` : 'no session to share' }
    const entry = createRelay(this.root, s.id, s.title)
    return { ok: true, code: entry.code, url: relayLinkUrl(entry.code) }
  }

  /** Active relays (prunes entries whose session no longer exists). */
  relayList(): RelayEntry[] {
    const known = new Set(this.sessions.list().map((s) => s.id))
    const relays = loadRelays(this.root).filter((r) => known.has(r.sessionId))
    saveRelays(this.root, relays)
    return relays
  }

  relayRevoke(code: string): { ok: boolean } {
    return { ok: revokeRelayEntry(this.root, String(code ?? '')) }
  }

  /** teardown — kill MCP server processes so nothing outlives the host */
  close() {
    this.mcp.close()
  }

  /* ------------------------------------------------------------------ */
  /* new surface: custom subagents · diagnostics · fallback view          */
  /* ------------------------------------------------------------------ */

  /** custom subagent definitions + the template for /agents new */
  subagentsView() {
    return { agents: listSubagents(this.root), template: SUBAGENT_TEMPLATE }
  }

  /** ordered failover chain as shown by /fallback */
  fallbackChainView() {
    return { chain: describeChain(this.cfg), entries: this.cfg.fallback ?? [] }
  }

  /** run the configured diagnostics command once (for /diag test) */
  async diagnosticsRun() {
    const r = await runDiagnostics(this.root, this.cfg)
    return r ?? { ok: false, output: 'no diagnostics command configured', command: '', ms: 0, timedOut: false }
  }
}

/** PRD.md rendered from an approved plan — the handoff artifact plan → build. */
function renderPrdFromPlan(plan: string, title: string): string {
  return `# PRD — ${title.replace(/\n/g, ' ').slice(0, 80)}

> Approved plan generated by Tagent on ${new Date().toISOString().slice(0, 10)}.
> The build agent reads this file first; material deviations should be confirmed with the user.

${plan.trim()}
`
}
