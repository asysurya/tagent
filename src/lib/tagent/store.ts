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
  authStatus as authStatusRpc,
  login as loginRpc,
  logout as logoutRpc,
  syncStatus as syncStatusRpc,
  syncPush as syncPushRpc,
  syncLink as syncLinkRpc,
  refuseSync as refuseSyncRpc,
  unlinkSync as unlinkSyncRpc,
  fetchProjects as fetchProjectsRpc,
} from './client'
import type {
  AgentMode,
  AgentStatus,
  AuthLoginResponse,
  ChatMessage,
  CheckpointMeta,
  Connection,
  FallbackEntry,
  FileNode,
  HelloPayload,
  LoopSummary,
  McpServerStatus,
  McpTemplate,
  MemoryFact,
  MemoryState,
  PermissionRequest,
  PluginMeta,
  ProjectReg,
  RelayEntry,
  SanitizedConfig,
  SessionData,
  SessionMeta,
  SkillMeta,
  SubagentInfo,
  SyncLinkResponse,
  SyncPushResponse,
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
  /** plan-mode draft awaiting approval (server: `plan:ready` / `plan:approve`) */
  planOffer: string | null

  /* ui */
  rightTab: RightTab
  rightOpen: boolean
  fileTree: FileNode | null
  fileBuffer: FileBuffer | null
  terminalOutput: string[]
  githubBusy: boolean

  /* github auth + project sync (v0.13 guest→login flow).
   * NOTE: the login NAME lives in `loginName` because `login` is the action. */
  guest: boolean
  loginName?: string
  linkedRepo?: string
  lastSyncAt?: number
  projects: ProjectReg[]
  /** one-time "sync this project to GitHub?" dialog (set by a successful login) */
  promptLink: boolean
  authBusy: boolean
  syncing: boolean
  linking: boolean
  authError?: string
  syncError?: string

  /* actions */
  boot: () => Promise<void>
  setMode: (m: AgentMode) => Promise<void>
  newSession: () => Promise<void>
  loadSession: (id: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  send: (text: string) => Promise<void>
  interrupt: () => void
  respondPermission: (approved: boolean, remember?: 'once' | 'session' | 'always') => void
  respondPlan: (execute: boolean) => void
  saveFallback: (entries: FallbackEntry[]) => Promise<void>
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
  authStatus: () => Promise<void>
  login: (pat: string) => Promise<AuthLoginResponse>
  logout: () => Promise<{ ok: boolean; error?: string }>
  syncStatus: () => Promise<void>
  syncPush: (message?: string) => Promise<SyncPushResponse>
  syncLink: (repo?: string) => Promise<SyncLinkResponse>
  /** "Jangan untuk proyek ini" — never show the sync prompt for this workspace again */
  refuseSync: () => Promise<void>
  /** remove the registry link for the active workspace */
  unlinkSync: () => Promise<void>
  /** "Nanti" — just close the one-time sync prompt */
  dismissPromptLink: () => void
  fetchProjects: () => Promise<void>
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
  planOffer: null,
  rightTab: 'files' as RightTab,
  rightOpen: true,
  fileTree: null,
  fileBuffer: null,
  terminalOutput: [],
  githubBusy: false,
  guest: true,
  loginName: undefined,
  linkedRepo: undefined,
  lastSyncAt: undefined,
  projects: [] as ProjectReg[],
  promptLink: false,
  authBusy: false,
  syncing: false,
  linking: false,
}

/**
 * Messages the chat should actually render.
 * - drops user messages that are internal tool-result blobs (meta.toolResults) —
 *   they are session-loop plumbing, not conversation; live events already
 *   filter them, this covers the reload/hello/session:active full-array paths
 * - drops assistant placeholders with neither text nor tool calls
 */
export function visibleMessages(session: SessionData | null | undefined): ChatMessage[] {
  if (!session) return []
  return session.messages.filter((m) => {
    if (m.role === 'user' && m.meta?.toolResults) return false
    if (m.role === 'assistant' && !m.content && !(m.toolCalls?.length)) return false
    return true
  })
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
        void get().authStatus() // guest↔login for the header / sync UI
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

    /* live events — session-scoped ones carry the running session's id and are
       dropped after the user switched sessions, so a run in flight never
       bleeds its text/tools/subagents into the newly opened session */
    const forActiveSession = (d: { sessionId?: string }) =>
      d?.sessionId == null || !get().session || d.sessionId === get().session?.id
    socket.on('message:new', (d: { sessionId?: string; message: ChatMessage }) => {
      if (forActiveSession(d)) get()._apply.message(d.message)
    })
    socket.on('agent:chunk', (d: { sessionId?: string; text: string }) => {
      if (forActiveSession(d)) get()._apply.chunk(d.text)
    })
    socket.on('agent:status', (s: AgentStatus) => get()._apply.status(s))
    socket.on('tool:start', (d: { sessionId?: string; call: ToolCallRecord }) => {
      if (forActiveSession(d)) get()._apply.toolStart(d.call)
    })
    socket.on('tool:end', (d: { sessionId?: string; call: ToolCallRecord }) => {
      if (forActiveSession(d)) get()._apply.toolEnd(d.call)
    })
    socket.on('todos:update', (d: { sessionId?: string; todos: SessionData['todos'] }) => {
      if (forActiveSession(d)) get()._apply.todos(d.todos)
    })
    socket.on('subagent:update', (d: { sessionId?: string; info: SubagentInfo }) => {
      if (forActiveSession(d)) get()._apply.subagent(d.info)
    })
    socket.on('files:changed', () => get()._apply.filesChanged())
    socket.on('permission:request', (p: PermissionRequest) => get()._apply.permission(p))
    socket.on('plan:ready', (d: { plan?: string }) => {
      if (d?.plan) set({ planOffer: d.plan })
    })
    socket.on('chat:done', (d: { sessionId?: string; summary: LoopSummary; checkpoints?: CheckpointMeta[] }) => {
      if (forActiveSession(d)) get()._apply.chatDone(d.summary)
    })
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
        planOffer: null,
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
        if (i >= 0) {
          messages[i] = m
        } else {
          // the daemon echoes our optimistic user message back under a
          // server-generated id — replace the local bubble in place instead
          // of pushing a second identical one
          const last = messages[messages.length - 1]
          const isLocalEcho =
            m.role === 'user' &&
            last?.role === 'user' &&
            last.id.startsWith('local-') &&
            last.content === m.content
          if (isLocalEcho) messages[messages.length - 1] = m
          else messages.push(m)
        }
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
      set((st) => ({
        status: s,
        running: !['done', 'error', 'aborted', 'idle'].includes(s.phase),
        // once streaming is over the text is final — drop the draft so the
        // next run never flashes the previous turn's stream first
        stream: s.phase === 'thinking' ? st.stream : '',
      }))
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
        const lastIdx = st.session.messages.length - 1
        const messages = st.session.messages.map((m, i) => {
          const j = m.toolCalls?.findIndex((x) => x.id === c.id) ?? -1
          if (j === -1) {
            // result for a call we never saw start — attach to the newest
            // assistant turn (by index: immutable copies break identity)
            if (m.role === 'assistant' && i === lastIdx) {
              return { ...m, toolCalls: [...(m.toolCalls ?? []), c] }
            }
            return m
          }
          const calls = [...(m.toolCalls as ToolCallRecord[])]
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
        // belt-and-braces: a finished run must never leave a draft behind
        stream: '',
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
      planOffer: null,
      fileTree: null,
      fileBuffer: null,
      worklogContent: '',
      worklogExists: false,
      timeline: [],
      // workspace may have changed — its link state is refetched below
      linkedRepo: undefined,
      lastSyncAt: undefined,
      promptLink: false,
    })
    if (payload.sessions.length > 0) {
      await get().loadSession(payload.sessions[0].id)
    } else {
      await get().newSession()
    }
    await get().refreshTree()
    await get().refreshWorklog()
    await get().refreshTimeline()
    void get().syncStatus()
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
    set({ session: { ...s, messages: [], todos: [] }, subagents: [], stream: '', status: null, planOffer: null })
  },

  async loadSession(id) {
    const { socket, connection } = get()
    if (connection === 'demo') return
    if (!socket) return
    const s = await call<SessionData | null>(socket, 'session:load', { id })
    if (s) {
      set({ session: s, subagents: [], stream: '', status: null, planOffer: null })
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

  async renameSession(id, title) {
    const { socket, connection } = get()
    if (connection === 'demo') return
    if (!socket) return
    const s = await call<SessionData | null>(socket, 'session:rename', { id, title })
    if (!s) return
    set((st) => ({
      sessions: st.sessions.map((x) => (x.id === id ? { ...x, title: s.title } : x)),
      session: st.session?.id === id ? { ...st.session, title: s.title } : st.session,
    }))
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
    // no timeout (0): the ack may only land long after the run completes,
    // and run outcome is settled by `chat:done` / `notify` events anyway.
    // Only a dead socket (send refused / disconnect) should fail the UI.
    await call<boolean>(socket, 'chat:send', { text, mode: session.mode }, 0).catch((e: Error) => {
      if (get().connection === 'ready') return // daemon alive — chat:done settles the state
      set({ running: false, status: { phase: 'error', detail: e.message } })
      toast.error(`Send failed — ${e.message}`)
    })
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

  respondPlan(execute) {
    const { socket, connection, planOffer } = get()
    if (!planOffer) return
    if (connection === 'ready' && socket) socket.emit('plan:approve', { execute })
    set({ planOffer: null })
  },

  async saveFallback(entries) {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return
    type SaveResult = { ok?: boolean; error?: string; config?: SanitizedConfig }
    const r = await call<SaveResult>(socket, 'settings:save', { fallback: entries }).catch(
      (e: Error): SaveResult => ({ error: e.message }),
    )
    if (r.error) {
      toast.error(r.error)
      return
    }
    if (r.config) set({ config: r.config })
    toast('Fallback chain saved ✓')
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
    // v0.13: delegates to the canonical auth:login (credential store + registry)
    return get().login(token)
  },

  async githubPush() {
    // v0.13: delegates to sync:push — same push, but the project registry
    // (link + lastSyncAt) is updated so `tagent projects` and the GUI agree
    set({ githubBusy: true })
    try { await get().syncPush('Update from Tagent') } finally { set({ githubBusy: false }) }
  },

  async authStatus() {
    const { socket, connection } = get()
    if (connection !== 'ready' || !socket) return
    const r = await authStatusRpc(socket).catch(() => null)
    if (!r) return
    set((st) => ({
      guest: !!r.guest,
      loginName: r.login,
      // keep the legacy config view honest (topbar/settings read config.github)
      config: st.config
        ? { ...st.config, github: { ...st.config.github, connected: !r.guest, login: r.login ?? null } }
        : st.config,
    }))
  },

  async login(pat) {
    const token = pat.trim()
    if (!token) return { ok: false, error: 'no token provided' }
    const { socket, connection } = get()
    if (connection !== 'ready' || !socket) return { ok: false, error: 'daemon not connected' }
    set({ authBusy: true, authError: undefined })
    const r = await loginRpc(socket, token).catch((e: Error): AuthLoginResponse => ({ ok: false, error: e.message }))
    set({ authBusy: false })
    if (r.ok) {
      set((st) => ({
        guest: false,
        loginName: r.login,
        // the daemon asks us (once) to offer the initial sync for this project
        promptLink: !!r.promptLink,
        config: st.config
          ? { ...st.config, github: { ...st.config.github, connected: true, login: r.login ?? null } }
          : st.config,
      }))
      void get().syncStatus()
    } else {
      set({ authError: r.error })
    }
    return r
  },

  async logout() {
    const { socket, connection } = get()
    if (connection !== 'ready' || !socket) return { ok: false, error: 'daemon not connected' }
    set({ authBusy: true })
    const r = await logoutRpc(socket).catch((): { ok: boolean } => ({ ok: false }))
    set({ authBusy: false, guest: true, loginName: undefined, promptLink: false })
    set((st) => st.config
      ? { config: { ...st.config, github: { ...st.config.github, connected: false, login: null } } }
      : st)
    if (r.ok) toast('Logged out of GitHub')
    return r
  },

  async syncStatus() {
    const { socket, connection } = get()
    if (connection !== 'ready' || !socket) return
    const r = await syncStatusRpc(socket).catch(() => null)
    if (!r) return
    set({ guest: !!r.guest, loginName: r.login, linkedRepo: r.repo, lastSyncAt: r.lastSyncAt })
  },

  async syncPush(message) {
    const { socket, connection } = get()
    if (connection !== 'ready' || !socket) return { ok: false, error: 'daemon not connected' }
    if (get().syncing) return { ok: false, error: 'sync already in progress' }
    set({ syncing: true, syncError: undefined })
    const r = await syncPushRpc(socket, message).catch((e: Error): SyncPushResponse => ({ ok: false, error: e.message }))
    set({ syncing: false })
    if (r.ok) {
      set({ linkedRepo: r.repo ?? get().linkedRepo, lastSyncAt: r.lastSyncAt ?? Date.now(), promptLink: false })
      toast(`Synced to ${r.repo ?? 'GitHub'} ✓`)
    } else {
      set({ syncError: r.error })
      // 'not logged in' is the auth-guard signal — the GUI opens the login dialog
      toast.error(r.error === 'not logged in' ? 'Log in to GitHub first' : (r.error ?? 'sync failed'))
    }
    return r
  },

  async syncLink(repo) {
    const { socket, connection } = get()
    if (connection !== 'ready' || !socket) return { ok: false, error: 'daemon not connected' }
    set({ linking: true, syncError: undefined })
    const r = await syncLinkRpc(socket, repo).catch((e: Error): SyncLinkResponse => ({ ok: false, error: e.message }))
    set({ linking: false })
    if (r.ok) {
      set({ linkedRepo: r.repo ?? get().linkedRepo, promptLink: false })
      toast(`Linked to ${r.repo ?? 'repo'} ✓`)
      void get().syncStatus()
    } else {
      set({ syncError: r.error })
      toast.error(r.error ?? 'link failed')
    }
    return r
  },

  async refuseSync() {
    const { socket, connection } = get()
    if (connection !== 'ready' || !socket) return
    await refuseSyncRpc(socket).catch(() => null)
    set({ promptLink: false })
  },

  async unlinkSync() {
    const { socket, connection } = get()
    if (connection !== 'ready' || !socket) return
    await unlinkSyncRpc(socket).catch(() => null)
    set({ linkedRepo: undefined, lastSyncAt: undefined })
    void get().fetchProjects()
  },

  dismissPromptLink() {
    set({ promptLink: false })
  },

  async fetchProjects() {
    const { socket, connection } = get()
    if (connection !== 'ready' || !socket) return
    const r = await fetchProjectsRpc(socket).catch(() => null)
    if (r) set({ projects: r.projects ?? [] })
  },

  async switchWorkspace(path) {
    const { socket, running } = get()
    if (!socket || get().connection !== 'ready') return
    if (running) {
      toast.warning('Stop the running agent before switching workspaces')
      return
    }
    type SwitchResult = { ok?: boolean; error?: string; workspace?: HelloPayload }
    const r = await call<SwitchResult>(socket, 'workspace:switch', { path }, 20000).catch(
      (e: Error): SwitchResult => ({ error: e.message }),
    )
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
    type SyncResult = { ok?: boolean; facts?: number; error?: string }
    const r = await call<SyncResult>(socket, 'mega:sync', {}, 120000).catch(
      (e: Error): SyncResult => ({ error: e.message }),
    )
    if (r.error) toast.error(r.error)
    else toast(`Synced ${r.facts ?? 0} facts to MEGA (E2E encrypted) ✓`)
  },

  async megaPull() {
    const { socket } = get()
    if (!socket || get().connection !== 'ready') return
    type PullResult = { ok?: boolean; imported?: number; total?: number; error?: string }
    const r = await call<PullResult>(socket, 'mega:pull', {}, 120000).catch(
      (e: Error): PullResult => ({ error: e.message }),
    )
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
