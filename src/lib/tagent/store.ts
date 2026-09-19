'use client'

import { create } from 'zustand'
import type { Socket } from 'socket.io-client'
import { toast } from 'sonner'
import {
  call,
  connectDaemon,
  hello as helloDaemon,
  mcpList,
  mcpSave as mcpSaveRpc,
  mcpRemove as mcpRemoveRpc,
  mcpToggle as mcpToggleRpc,
  mcpTemplates as mcpTemplatesRpc,
  pluginsList as pluginsListRpc,
  pluginScaffold as pluginScaffoldRpc,
} from './client'
import type {
  AgentMode,
  AgentStatus,
  ChatMessage,
  CheckpointMeta,
  Connection,
  FileNode,
  HelloPayload,
  LoopSummary,
  McpServerStatus,
  McpTemplate,
  MemoryFact,
  MemoryState,
  PermissionRequest,
  PluginMeta,
  RelayEntry,
  SanitizedConfig,
  SessionData,
  SessionMeta,
  SkillMeta,
  SubagentInfo,
  ToolCallRecord,
  WorkspaceInfo,
} from './types'

type RightTab = 'files' | 'terminal' | 'memory' | 'skills' | 'worklog' | 'timeline'

interface FileBuffer {
  path: string
  content: string
  dirty: boolean
  binary?: boolean
}

interface TagentState {
  /* connection + world */
  connection: Connection
  socket: Socket | null
  workspace: HelloPayload['workspace'] | null
  workspaces: WorkspaceInfo[]
  config: SanitizedConfig | null
  skills: SkillMeta[]
  memory: MemoryState
  sessions: SessionMeta[]
  checkpoints: CheckpointMeta[]
  availableTools: { name: string; description: string; risk: string }[]
  worklogContent: string
  worklogExists: boolean
  timeline: SessionMeta[]
  relays: RelayEntry[]
  mcpStatus: McpServerStatus[]
  mcpTemplates: McpTemplate[]
  plugins: PluginMeta[]

  /* active session */
  session: SessionData | null
  stream: string
  status: AgentStatus | null
  running: boolean
  subagents: SubagentInfo[]
  pendingPermission: PermissionRequest | null
  permissionHistory: Record<string, 'ask' | 'allow' | 'deny'>

  /* ui */
  rightTab: RightTab
  rightOpen: boolean
  fileTree: FileNode | null
  fileBuffer: FileBuffer | null
  terminalOutput: string[]
  githubBusy: boolean

  /* actions */
  boot: () => Promise<void>
  setMode: (m: AgentMode) => Promise<void>
  newSession: () => Promise<void>
  loadSession: (id: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  send: (text: string) => Promise<void>
  interrupt: () => void
  respondPermission: (approved: boolean, remember?: 'once' | 'session' | 'always') => void
  setModel: (provider: string, model: string) => Promise<void>
  setApiKey: (provider: string, key: string) => Promise<void>
  providersRefresh: () => Promise<{ ok?: boolean; updated?: string[]; failed?: string[]; error?: string }>
  saveCustomProvider: (cp: { id: string; label: string; baseUrl: string; apiKey?: string; models: string[]; kind?: 'openai' | 'anthropic' | 'google' }) => Promise<{ ok?: boolean; error?: string }>
  removeCustomProvider: (id: string) => Promise<void>
  setToolPermission: (tool: string, mode: 'ask' | 'allow' | 'deny') => Promise<void>
  setToolEnabled: (tool: 'bash' | 'browser', enabled: boolean) => Promise<void>
  setCaveman: (v: boolean) => Promise<void>
  setWorklog: (v: boolean) => Promise<void>
  setWebGui: (v: boolean) => Promise<void>
  setCacheFileState: (v: boolean) => Promise<void>
  setCacheWeb: (v: boolean) => Promise<void>
  setMaxTurns: (n: number) => Promise<void>
  refreshWorklog: () => Promise<void>
  shareSession: (id: string) => Promise<{ ok: boolean; url?: string; file?: string; error?: string }>
  relaySession: (id: string) => Promise<{ ok: boolean; code?: string; url?: string; error?: string }>
  relayRevoke: (code: string) => Promise<void>
  refreshRelays: () => Promise<void>
  refreshTimeline: () => Promise<void>
  saveGithubPat: (token: string) => Promise<{ ok: boolean; login?: string; error?: string }>
  githubPush: () => Promise<void>
  switchWorkspace: (path: string) => Promise<void>
  saveMega: (enabled: boolean, email: string, sessionKey: string) => Promise<void>
  megaSync: () => Promise<void>
  megaPull: () => Promise<void>
  undo: () => Promise<void>
  mcpRefresh: () => Promise<void>
  mcpAddServer: (server: { name: string; command: string; args?: string[]; env?: Record<string, string> }) => Promise<{ ok?: boolean; error?: string }>
  mcpRemoveServer: (name: string) => Promise<void>
  mcpToggleServer: (name: string) => Promise<void>
  pluginsRefresh: () => Promise<void>
  pluginNew: (name: string) => Promise<{ ok?: boolean; file?: string; error?: string }>
  openFile: (path: string) => Promise<void>
  closeFile: () => void
  saveFile: () => Promise<void>
  refreshTree: () => Promise<void>
  setRightTab: (t: RightTab) => void
  toggleRight: () => void
  runTerminal: (cmd: string) => Promise<void>
  saveAgents: (which: 'global' | 'workspace', content: string) => Promise<void>
  addFact: (text: string) => Promise<void>
  deleteFact: (id: string) => Promise<void>
  readSkill: (name: string) => Promise<string>

  /* internal event reducers (also used by demo mode) */
  _applyHello: (payload: HelloPayload) => Promise<void>
  _apply: {
    message: (m: ChatMessage) => void
    toolStart: (c: ToolCallRecord) => void
    toolEnd: (c: ToolCallRecord) => void
    status: (s: AgentStatus) => void
    todos: (todos: SessionData['todos']) => void
    subagent: (i: SubagentInfo) => void
    filesChanged: () => void
    permission: (p: PermissionRequest | null) => void
    chatDone: (s: LoopSummary) => void
    chunk: (t: string) => void
  }
}

const initial = {
  connection: 'connecting' as Connection,
  socket: null,
  workspace: null,
  workspaces: [] as WorkspaceInfo[],
  config: null,
  skills: [],
  memory: { agents: { global: '', workspace: '' }, facts: [] },
  sessions: [],
  checkpoints: [],
  availableTools: [],
  worklogContent: '',
  worklogExists: false,
  timeline: [],
  relays: [],
  mcpStatus: [],
  mcpTemplates: [],
  plugins: [],
  session: null,
  stream: '',
  status: null,
  running: false,
  subagents: [],
  pendingPermission: null,
  permissionHistory: {},
  rightTab: 'files' as RightTab,
  rightOpen: true,
  fileTree: null,
  fileBuffer: null,
  terminalOutput: [],
  githubBusy: false,
}

export const useTagent = create<TagentState>((set, get) => ({
  ...initial,

  async boot() {
    const socket = connectDaemon()
    set({ socket })
    // debug handle
    ;(window as unknown as Record<string, unknown>).__tagent = { socket, state: get }
    const fail = setTimeout(async () => {
      if (get().connection === 'connecting') {
        set({ connection: 'demo' })
        const { startDemo } = await import('./demo')
        startDemo()
      }
    }, 9000)
    socket.on('connect', async () => {
      clearTimeout(fail)
      console.info('[tagent] socket connected — saying hello…')
      try {
        const payload = await helloDaemon(socket)
        console.info('[tagent] hello ok — live mode')
        await get()._applyHello(payload)
        void get().refreshRelays()
      } catch (e) {
        console.warn('[tagent] hello failed — falling back to demo:', (e as Error).message)
        set({ connection: 'demo' })
        const { startDemo } = await import('./demo')
        startDemo()
      }
    })
    socket.on('disconnect', () => {
      if (get().connection === 'ready') set({ connection: 'connecting' })
    })
    socket.on('connect_error', () => {
      clearTimeout(fail)
      if (get().connection === 'connecting') set({ connection: 'demo' })
    })

    /* live events */
    socket.on('message:new', (d: { message: ChatMessage }) => get()._apply.message(d.message))
    socket.on('agent:chunk', (d: { text: string }) => get()._apply.chunk(d.text))
    socket.on('agent:status', (s: AgentStatus) => get()._apply.status(s))
    socket.on('tool:start', (d: { call: ToolCallRecord }) => get()._apply.toolStart(d.call))
    socket.on('tool:end', (d: { call: ToolCallRecord }) => get()._apply.toolEnd(d.call))
    socket.on('todos:update', (d: { todos: SessionData['todos'] }) => get()._apply.todos(d.todos))
    socket.on('subagent:update', (d: { info: SubagentInfo }) => get()._apply.subagent(d.info))
    socket.on('files:changed', () => get()._apply.filesChanged())
    socket.on('permission:request', (p: PermissionRequest) => get()._apply.permission(p))
    socket.on('chat:done', (d: { summary: LoopSummary; checkpoints?: CheckpointMeta[] }) =>
      get()._apply.chatDone(d.summary),
    )
    socket.on('session:list', (sessions: SessionMeta[]) => set({ sessions }))
    socket.on('workspace:changed', (payload: HelloPayload) => {
      // daemon switched workspaces (local action or mega:pull) — adopt the new world
      void get()._applyHello(payload)
    })
    socket.on('session:active', (s: SessionData) => {
      set((st) => ({
        session: s,
        subagents: [],
        stream: '',
        status: null,
        running: false,
        checkpoints: st.checkpoints,
      }))
    })
    socket.on('notify', (d: { level: 'info' | 'warn' | 'error'; message: string }) => {
      notify(d.level, d.message)
    })
  },

  _apply: {
    message(m) {
      if (m.role === 'user' && m.meta?.toolResults) return
      set((st) => {
        if (!st.session) return st
        const messages = [...st.session.messages]
        const i = messages.findIndex((x) => x.id === m.id)
        if (i >= 0) messages[i] = m
        else messages.push(m)
        return {
          session: { ...st.session, messages },
          stream: m.role === 'assistant' ? '' : st.stream,
        }
      })
    },
    chunk(text) {
      set({ stream: text })
    },
    status(s) {
      set({ status: s, running: !['done', 'error', 'aborted', 'idle'].includes(s.phase) })
    },
    toolStart(c) {
      set((st) => {
        if (!st.session) return st
        const messages = st.session.messages.map((m) => ({ ...m, toolCalls: m.toolCalls ? [...m.toolCalls] : undefined }))
        // attach to the last assistant message
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'assistant') {
            const calls = [...(messages[i].toolCalls ?? [])]
            const j = calls.findIndex((x) => x.id === c.id)
            if (j >= 0) calls[j] = c
            else calls.push(c)
            messages[i] = { ...messages[i], toolCalls: calls }
            break
          }
        }
        return { session: { ...st.session, messages } }
      })
    },
    toolEnd(c) {
      set((st) => {
        if (!st.session) return st
        const messages = st.session.messages.map((m) => {
          if (!m.toolCalls?.length) return m
          const j = m.toolCalls.findIndex((x) => x.id === c.id)
          if (j === -1) {
            // tool call belonging to the newest assistant turn arrived late
            if (m.role === 'assistant' && m === st.session!.messages[st.session!.messages.length - 1]) {
              return { ...m, toolCalls: [...m.toolCalls, c] }
            }
            return m
          }
          const calls = [...m.toolCalls]
          calls[j] = { ...calls[j], ...c }
          return { ...m, toolCalls: calls }
        })
        return { session: { ...st.session, messages } }
      })
    },
    todos(todos) {
      set((st) => (st.session ? { session: { ...st.session, todos: todos } } : st))
    },
    subagent(info) {
      set((st) => {
        const subagents = [...st.subagents]
        const i = subagents.findIndex((s) => s.description === info.description && s.parentId === info.parentId)
        if (i >= 0) subagents[i] = info
        else subagents.push(info)
        return { subagents }
      })
    },
    filesChanged() {
      void get().refreshTree()
      void get().refreshWorklog()
    },
    permission(p) {
      set({ pendingPermission: p })
    },
    chatDone(summary) {
      set((st) => ({
        running: false,
        status: { phase: summary.finished === 'error' ? 'error' : 'done', detail: `${summary.turns} turns · ${summary.toolCalls} tool calls` },
      }))
      void get().refreshTree()
      void get().refreshTimeline()
    },
  },

  _applyHello: async (payload) => {
    set({
      connection: 'ready',
      workspace: payload.workspace,
      workspaces: payload.recentWorkspaces ?? [],
      config: payload.config,
      skills: payload.skills,
      memory: payload.memory,
      sessions: payload.sessions,
      checkpoints: payload.checkpoints,
      availableTools: payload.tools,
      mcpStatus: payload.mcp ?? [],
      plugins: payload.plugins ?? [],
      // world changed — reset per-session/per-file UI state
      session: null,
      stream: '',
      status: null,
      running: false,
      subagents: [],
      pendingPermission: null,
      fileTree: null,
      fileBuffer: null,
      worklogContent: '',
      worklogExists: false,
      timeline: [],
    })
    if (payload.sessions.length > 0) {
      await get().loadSession(payload.sessions[0].id)
    } else {
      await get().newSession()
    }
    await get().refreshTree()
    await get().refreshWorklog()
    await get().refreshTimeline()
  },

  async setMode(m) {
    const { socket, session } = get()
    if (session) {
      set({ session: { ...session, mode: m } })
      if (socket && get().connection === 'ready') await call(socket, 'session:mode', { mode: m })
    }
  },

  async newSession() {
    const { socket, connection } = get()
    if (connection === 'demo') {
      const { demoNewSession } = await import('./demo')
      demoNewSession()
      return
    }
    if (!socket) return
    const s = await call<SessionData>(socket, 'session:new', { mode: get().session?.mode ?? 'build' })
    set({ session: { ...s, messages: [], todos: [] }, subagents: [], stream: '', status: null })
  },

  async loadSession(id) {
    const { socket, connection } = get()
    if (connection === 'demo') return
    if (!socket) return
    const s = await call<SessionData | null>(socket, 'session:load', { id })
    if (s) {
      set({ session: s, subagents: [], stream: '', status: null })
      void get().refreshTimeline()
    }
  },

  async deleteSession(id) {
    const { socket, connection } = get()
    if (connection === 'demo') return
    if (!socket) return
    await call(socket, 'session:delete', { id })
    const sessions = get().sessions.filter((s) => s.id !== id)
    set({ sessions })
    if (get().session?.id === id) {
      const next = sessions[0]
      if (next) await get().loadSession(next.id)
      else await get().newSession()
    }
  },

  async send(text) {
    const { socket, connection } = get()
    if (!text.trim()) return
    if (connection === 'demo' || !socket) {
      const { runDemoChat } = await import('./demo')
      await runDemoChat(text)
      return
    }
    if (!get().session) {
      await get().newSession()
    }
    const session = get().session
    if (!session) return
    const userMsg: ChatMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      content: text,
      createdAt: Date.now(),
    }
    set((st) => ({
      session: st.session ? { ...st.session, messages: [...st.session.messages, userMsg] } : st.session,
      running: true,
      status: { phase: 'thinking' },
    }))
    await call<boolean>(socket, 'chat:send', { text, mode: session.mode }, 30000).catch(() => undefined)
  },

  interrupt() {
    const { socket, connection } = get()
    if (connection === 'ready' && socket) socket.emit('chat:interrupt')
    else set({ running: false, status: { phase: 'aborted' } })
  },

  respondPermission(approved, remember = 'once') {
    const { socket, pendingPermission, connection } = get()
    if (connection === 'demo') {
      set({ pendingPermission: null })
      return
    }
    if (socket && pendingPermission) {
      socket.emit('permission:respond', { requestId: pendingPermission.id, approved, remember })
    }
    set({ pendingPermission: null })
  },

  async setModel(provider, model) {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return
    const r = await call<{ ok: boolean; config: SanitizedConfig }>(socket, 'settings:save', {
      defaultProvider: provider,
      defaultModel: model,
    })
    if (r.config) set({ config: r.config })
    set((st) => (st.session ? { session: { ...st.session, model } } : st))
  },

  async setApiKey(provider, key) {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return
    const r = await call<{ ok: boolean; config: SanitizedConfig }>(socket, 'settings:save', {
      apiKey: { provider, key },
    })
    if (r.config) set({ config: r.config })
  },

  async providersRefresh() {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return { error: 'daemon not connected' }
    return call<{ ok: boolean; updated: string[]; failed: string[]; config: SanitizedConfig }>(socket, 'providers:refresh', {}, 60000)
      .then((r) => {
        if (r.config) set({ config: r.config })
        return { ok: r.ok, updated: r.updated, failed: r.failed }
      })
      .catch((e: Error) => ({ error: e.message }))
  },

  async saveCustomProvider(cp) {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return { error: 'daemon not connected' }
    const r = await call<{ ok?: boolean; error?: string; config: SanitizedConfig }>(socket, 'settings:save', {
      customProvider: cp,
    })
    if (r.config) set({ config: r.config })
    return { ok: r.ok, error: r.error }
  },

  async removeCustomProvider(id) {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return
    const r = await call<{ ok?: boolean; config: SanitizedConfig }>(socket, 'settings:save', {
      customProviderRemove: id,
    })
    if (r.config) set({ config: r.config })
  },

  async setToolPermission(tool, mode) {
    const { socket, config } = get()
    if (!socket || !config) return
    const permissions = { ...config.permissions, tools: { ...config.permissions.tools, [tool]: mode } }
    const r = await call<{ ok: boolean; config: SanitizedConfig }>(socket, 'settings:save', { permissions })
    if (r.config) set({ config: r.config })
  },

  async setToolEnabled(tool, enabled) {
    const { socket, config } = get()
    if (!socket || !config) return
    const tools = { ...config.tools, [tool]: enabled }
    const r = await call<{ ok: boolean; config: SanitizedConfig }>(socket, 'settings:save', { tools })
    if (r.config) set({ config: r.config })
  },

  async setCaveman(v) {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return
    const r = await call<{ ok: boolean; config: SanitizedConfig }>(socket, 'settings:save', { caveman: v })
    if (r.config) set({ config: r.config })
    toast(v ? 'Caveman mode ON — terse replies, fewer tokens 🦴' : 'Caveman mode off')
  },

  async setWorklog(v) {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return
    const r = await call<{ ok: boolean; config: SanitizedConfig }>(socket, 'settings:save', { worklogEnabled: v })
    if (r.config) set({ config: r.config })
    toast(v ? 'Worklog + todos enabled' : 'Worklog disabled')
  },

  async setWebGui(v) {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return
    const r = await call<{ ok: boolean; config: SanitizedConfig }>(socket, 'settings:save', { webGui: v })
    if (r.config) set({ config: r.config })
    toast(v ? 'Web GUI will start with tagent start' : 'Web GUI will stay off (tagent start is TUI-only)')
  },

  async setCacheFileState(v) {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return
    const r = await call<{ ok: boolean; config: SanitizedConfig }>(socket, 'settings:save', { cacheFileState: v })
    if (r.config) set({ config: r.config })
    toast(v ? 'File cache on — unchanged re-reads return a stub' : 'File cache off — every read serves full content')
  },

  async setCacheWeb(v) {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return
    const r = await call<{ ok: boolean; config: SanitizedConfig }>(socket, 'settings:save', { cacheWeb: v })
    if (r.config) set({ config: r.config })
    toast(v ? 'Web cache on — repeated fetches/searches hit the cache' : 'Web cache off')
  },

  async setMaxTurns(n) {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return
    const r = await call<{ ok: boolean; config: SanitizedConfig }>(socket, 'settings:save', {
      maxTurns: Math.min(Math.max(Math.round(n) || 1, 1), 80),
    })
    if (r.config) set({ config: r.config })
  },

  async refreshWorklog() {
    const { socket, connection } = get()
    if (connection !== 'ready' || !socket) return
    type ReadResult = { content?: string; error?: string; binary?: boolean }
    let r: ReadResult
    try {
      r = await call<ReadResult>(socket, 'file:read', { path: 'WORKLOG.md' })
    } catch {
      r = { error: 'unreachable' }
    }
    if (r.error || r.binary) set({ worklogExists: false, worklogContent: '' })
    else set({ worklogExists: true, worklogContent: r.content ?? '' })
  },

  async refreshTimeline() {
    const { socket, connection, session } = get()
    if (connection !== 'ready' || !socket) return
    const r = await call<{ timeline: SessionMeta[] }>(socket, 'session:timeline', { sessionId: session?.id }, 10000)
      .catch(() => ({ timeline: [] as SessionMeta[] }))
    set({ timeline: r.timeline ?? [] })
  },

  async shareSession(id) {
    const { socket, connection } = get()
    if (connection !== 'ready' || !socket) return { ok: false, error: 'daemon not connected' }
    return call<{ ok: boolean; url?: string; file?: string; error?: string }>(socket, 'session:share', { id })
  },

  async relaySession(id) {
    const { socket, connection } = get()
    if (connection !== 'ready' || !socket) return { ok: false, error: 'daemon not connected' }
    const r = await call<{ ok: boolean; code?: string; url?: string; error?: string }>(socket, 'relay:create', { sessionId: id })
    void get().refreshRelays()
    return r
  },

  async relayRevoke(code) {
    const { socket, connection } = get()
    if (connection !== 'ready' || !socket) return
    await call<{ ok: boolean }>(socket, 'relay:revoke', { code })
    await get().refreshRelays()
  },

  async refreshRelays() {
    const { socket, connection } = get()
    if (connection !== 'ready' || !socket) return
    const r = await call<{ relays?: RelayEntry[] }>(socket, 'relay:list', {}, 10000)
      .catch(() => ({ relays: [] as RelayEntry[] }))
    set({ relays: r.relays ?? [] })
  },

  async saveGithubPat(token) {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return { ok: false, error: 'daemon not connected' }
    return call<{ ok: boolean; login?: string; error?: string }>(socket, 'github:pat', { token })
  },

  async githubPush() {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return
    set({ githubBusy: true })
    const r = await call<{ ok: boolean; error?: string }>(socket, 'github:push', { message: 'Update from Tagent' }, 180000).catch((e) => ({ ok: false, error: (e as Error).message }))
    set({ githubBusy: false })
    if (r.ok) toast('Pushed to GitHub ✓')
    else toast.error(r.error ?? 'push failed')
  },

  async switchWorkspace(path) {
    const { socket, running } = get()
    if (!socket || get().connection !== 'ready') return
    if (running) {
      toast.warning('Stop the running agent before switching workspaces')
      return
    }
    const r = await call<{ ok?: boolean; error?: string; workspace?: HelloPayload }>(socket, 'workspace:switch', { path }, 20000)
      .catch((e) => ({ error: (e as Error).message }))
    if (r.error) {
      toast.error(r.error)
      return
    }
    if (r.workspace) await get()._applyHello(r.workspace)
    else await get()._applyHello(await helloDaemon(socket))
    toast(`Workspace → ${get().workspace?.name ?? path}`)
  },

  async saveMega(enabled, email, sessionKey) {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return
    const r = await call<{ ok?: boolean; error?: string; config?: SanitizedConfig }>(socket, 'mega:save', {
      enabled, email, sessionKey,
    })
    if (r.error) {
      toast.error(r.error)
      return
    }
    if (r.config) set({ config: r.config })
    else set((st) => (st.config ? { config: { ...st.config, mega: { enabled, email: email || null } } } : st))
    toast('MEGA settings saved ✓')
  },

  async megaSync() {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return
    const r = await call<{ ok?: boolean; facts?: number; error?: string }>(socket, 'mega:sync', {}, 120000)
      .catch((e) => ({ error: (e as Error).message }))
    if (r.error) toast.error(r.error)
    else toast(`Synced ${r.facts ?? 0} facts to MEGA (E2E encrypted) ✓`)
  },

  async megaPull() {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return
    const r = await call<{ ok?: boolean; imported?: number; total?: number; error?: string }>(socket, 'mega:pull', {}, 120000)
      .catch((e) => ({ error: (e as Error).message }))
    if (r.error) toast.error(r.error)
    else toast(`Imported ${r.imported ?? 0} facts from MEGA (${r.total ?? 0} total) ✓`)
  },

  async undo() {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return
    const r = await call<{ ok: boolean; checkpoint?: CheckpointMeta }>(socket, 'checkpoint:undo', {})
    if (r.ok) toast(`Restored checkpoint: ${r.checkpoint?.label ?? 'latest'}`)
    else toast.warning('No checkpoint to restore')
    await get().refreshTree()
  },

  async mcpRefresh() {
    const { socket, connection } = get()
    if (!socket || connection !== 'ready') return
    try {
      const [list, tpl] = await Promise.all([mcpList(socket), mcpTemplatesRpc(socket)])
      set({ mcpStatus: list.status ?? [], mcpTemplates: tpl.templates ?? [] })
    } catch { /* daemon gone — keep stale */ }
  },

  async mcpAddServer(server) {
    const { socket } = get()
    if (!socket) return { error: 'not connected' }
    const r = await mcpSaveRpc(socket, server)
    if (r.error) return r
    if (r.status) set({ mcpStatus: r.status })
    else await get().mcpRefresh()
    return r
  },

  async mcpRemoveServer(name) {
    const { socket } = get()
    if (!socket) return
    await mcpRemoveRpc(socket, name)
    await get().mcpRefresh()
  },

  async mcpToggleServer(name) {
    const { socket } = get()
    if (!socket) return
    const r = await mcpToggleRpc(socket, name)
    if (r.error) toast.error(r.error)
    await get().mcpRefresh()
  },

  async pluginsRefresh() {
    const { socket, connection } = get()
    if (!socket || connection !== 'ready') return
    try {
      const r = await pluginsListRpc(socket)
      set({ plugins: r.plugins ?? [] })
    } catch { /* daemon gone */ }
  },

  async pluginNew(name) {
    const { socket } = get()
    if (!socket) return { error: 'not connected' }
    const r = await pluginScaffoldRpc(socket, name)
    if (r.ok) await get().pluginsRefresh()
    return r
  },

  async openFile(path) {
    const { socket, connection } = get()
    if (connection === 'demo') {
      const { demoReadFile } = await import('./demo')
      set({ fileBuffer: { path, content: demoReadFile(path), dirty: false } })
      return
    }
    if (!socket) return
    const r = await call<{ path: string; content: string; binary?: boolean; error?: string }>(socket, 'file:read', { path })
    if (r.error) set({ fileBuffer: { path, content: `// ${r.error}`, dirty: false } })
    else set({ fileBuffer: { path, content: r.binary ? '(binary file)' : r.content, dirty: false, binary: r.binary } })
  },

  closeFile() {
    set({ fileBuffer: null })
  },

  async saveFile() {
    const { socket, fileBuffer } = get()
    if (!socket || !fileBuffer || fileBuffer.binary) return
    const r = await call<{ ok: boolean; error?: string }>(socket, 'file:save', {
      path: fileBuffer.path,
      content: fileBuffer.content,
    })
    if (r.ok) {
      set({ fileBuffer: { ...fileBuffer, dirty: false } })
      toast(`Saved ${fileBuffer.path}`)
    } else toast.error(r.error ?? 'save failed')
  },

  async refreshTree() {
    const { socket, connection } = get()
    if (connection === 'demo') {
      const { demoTree } = await import('./demo')
      set({ fileTree: demoTree() })
      return
    }
    if (!socket) return
    const tree = await call<FileNode>(socket, 'files:list', { path: '.' })
    set({ fileTree: tree })
  },

  setRightTab(t) {
    set({ rightTab: t, rightOpen: true })
  },
  toggleRight() {
    set((st) => ({ rightOpen: !st.rightOpen }))
  },

  async runTerminal(cmd) {
    const { socket, connection } = get()
    if (connection === 'demo') {
      set((st) => ({ terminalOutput: [...st.terminalOutput, `$ ${cmd}`, '(demo mode — terminal disabled)'] }))
      return
    }
    if (!socket) return
    set((st) => ({ terminalOutput: [...st.terminalOutput, `$ ${cmd}`] }))
    const r = await call<{ output: string }>(socket, 'terminal:exec', { command: cmd }, 60000).catch((e) => ({ output: `error: ${(e as Error).message}` }))
    set((st) => ({ terminalOutput: [...st.terminalOutput, r.output || '(no output)'] }))
  },

  async saveAgents(which, content) {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return
    await call(socket, 'memory:save-agents', { which, content })
    set((st) => ({ memory: { ...st.memory, agents: { ...st.memory.agents, [which]: content } } }))
  },

  async addFact(text) {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return
    const r = await call<{ fact: MemoryFact }>(socket, 'memory:save-fact', { text })
    if (r?.fact) set((st) => ({ memory: { ...st.memory, facts: [...st.memory.facts, r.fact] } }))
  },

  async deleteFact(id) {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return
    await call(socket, 'memory:delete-fact', { id })
    set((st) => ({ memory: { ...st.memory, facts: st.memory.facts.filter((f) => f.id !== id) } }))
  },

  async readSkill(name) {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return ''
    const r = await call<{ content?: string; error?: string }>(socket, 'skill:read', { name })
    return r.content ?? r.error ?? ''
  },
}))

function notify(level: 'info' | 'warn' | 'error', msg: string) {
  if (level === 'error') toast.error(msg)
  else if (level === 'warn') toast.warning(msg)
  else toast(msg)
}
