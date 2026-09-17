import http from 'node:http'
import { Server as SocketIOServer } from 'socket.io'
import path from 'node:path'
import fs from 'node:fs'
import type { Server as HttpServer } from 'node:http'

import {
  AgentLoop,
  PermissionManager,
  SessionStore,
  listProviderInfos,
  getAdapter,
  loadConfig,
  saveConfig,
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
  pushWorkspace,
  loadPlugins,
  emitPluginEvent,
  buildToolset,
  type AgentEvents,
  type ChatMessage,
  type PermissionDecision,
  type PermissionRequest,
  type SessionData,
  type SessionMeta,
  type TagentConfig,
  type ToolCallRecord,
} from '@tagent/core'

import { walkTree, readWorkspaceFile, saveWorkspaceFile } from './files'

export interface DaemonOptions {
  port: number
  host?: string
  workspaceRoot: string
  configOverride?: Partial<TagentConfig>
  socketPath?: string
  guiDir?: string
  quiet?: boolean
}

interface PendingPermission {
  resolve: (d: PermissionDecision) => void
  req: PermissionRequest
  timer: ReturnType<typeof setTimeout>
}

export interface DaemonHandle {
  server: HttpServer
  io: SocketIOServer
  close(): Promise<void>
}

export function createDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const root = path.resolve(opts.workspaceRoot)
  /** session.workspaceId doubles as the absolute workspace root for tools */
  const workspaceId = root
  let cfg = loadConfig(root, opts.configOverride)
  const persist = () => saveConfig(root, cfg)

  // When a built GUI directory exists we serve it as a static SPA and move
  // the websocket to /socket so it never collides with static assets.
  const guiDir = opts.guiDir && fs.existsSync(path.join(opts.guiDir, 'index.html'))
    ? path.resolve(opts.guiDir as string)
    : null
  const socketIoPath = opts.socketPath ?? (guiDir ? '/socket' : '/')

  const sessions = new SessionStore(root, workspaceId)
  let session: SessionData | undefined
  let loop: AgentLoop | undefined

  const pendingPermissions = new Map<string, PendingPermission>()

  const log = (...a: unknown[]) => { if (!opts.quiet) console.log('[tagent]', ...a) }

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  function activeProvider() {
    return getAdapter(cfg.defaultProvider, cfg)
  }

  function sanitizeConfig() {
    return {
      defaultProvider: cfg.defaultProvider,
      defaultModel: cfg.defaultModel,
      providers: listProviderInfos(cfg),
      permissions: cfg.permissions,
      tools: cfg.tools,
      github: { connected: !!cfg.github?.token, login: cfg.github?.login ?? null, repo: cfg.github?.repo ?? null },
      mega: { enabled: !!cfg.mega?.enabled, email: cfg.mega?.email ?? null },
      autoCheckpoint: cfg.autoCheckpoint,
      maxTurns: cfg.maxTurns,
      bashEnabled: cfg.tools.bash,
      browserEnabled: cfg.tools.browser,
    }
  }

  async function ensureSession(mode: 'build' | 'plan' = 'build'): Promise<SessionData> {
    if (session) return session
    session = sessions.create('New session', cfg.defaultModel, mode)
    emit('session:active', session)
    emit('session:list', sessions.list())
    return session
  }

  function makeEvents(socketId: string): AgentEvents {
    return {
      onStatus: (phase, detail) => emitTo(socketId, 'agent:status', { phase, detail }),
      onUserMessage: (msg) => emitTo(socketId, 'message:new', { sessionId: session?.id, message: msg }),
      onAssistantChunk: (sid, delta) => emitTo(socketId, 'agent:chunk', { sessionId: sid, text: delta }),
      onAssistantMessage: (msg) => emitTo(socketId, 'message:new', { sessionId: session?.id, message: msg }),
      onToolStart: (call: ToolCallRecord) => emitTo(socketId, 'tool:start', { sessionId: session?.id, call }),
      onToolEnd: (call: ToolCallRecord) => emitTo(socketId, 'tool:end', { sessionId: session?.id, call }),
      onTodos: (todos) => emitTo(socketId, 'todos:update', { sessionId: session?.id, todos }),
      onSubagent: (info) => emitTo(socketId, 'subagent:update', { sessionId: session?.id, info }),
      onFilesChanged: (paths) => emitTo(socketId, 'files:changed', { paths }),
      onNotify: (level, message) => emitTo(socketId, 'notify', { level, message }),
      onPermission: (req) =>
        new Promise<PermissionDecision>((resolve) => {
          const timer = setTimeout(() => {
            pendingPermissions.delete(req.id)
            resolve({ approved: false })
          }, 5 * 60 * 1000)
          pendingPermissions.set(req.id, { resolve, req, timer })
          emitTo(socketId, 'permission:request', req)
        }),
    }
  }

  /* ------------------------------------------------------------------ */
  /* static GUI (built Next.js export)                                   */
  /* ------------------------------------------------------------------ */

  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.map': 'application/json',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.webp': 'image/webp',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.wasm': 'application/wasm',
  }

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
      if (urlPath.includes('..')) { res.writeHead(400).end('bad path'); return }
      let filePath = path.join(guiDir as string, urlPath)
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        // SPA fallback: unknown routes render the app shell
        filePath = path.join(guiDir as string, 'index.html')
        if (!fs.existsSync(filePath)) {
          res.writeHead(404).end('GUI bundle missing (index.html). Re-run `bun run build:gui`.')
          return
        }
      }
      const ext = path.extname(filePath).toLowerCase()
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
      })
      fs.createReadStream(filePath).pipe(res)
    } catch {
      res.writeHead(500).end('static error')
    }
  }

  /* ------------------------------------------------------------------ */
  /* server                                                              */
  /* ------------------------------------------------------------------ */

  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, server: 'tagent', version: '0.1.0', gui: !!guiDir }))
      return
    }
    if (guiDir) {
      // never shadow the websocket endpoint with a static file
      if ((req.url ?? '/').split('?')[0] === socketIoPath || (req.url ?? '').startsWith(socketIoPath + '/')) return
      serveStatic(req, res)
      return
    }
    res.writeHead(404).end('tagent daemon — connect via websocket')
  })

  const io = new SocketIOServer(server, {
    path: socketIoPath,
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60_000,
    pingInterval: 25_000,
    maxHttpBufferSize: 20e6,
  })

  function emit(event: string, payload?: unknown) { io.emit(event, payload) }
  function emitTo(socketId: string, event: string, payload?: unknown) {
    io.to(socketId).emit(event, payload)
  }

  io.on('connection', (socket) => {
    log('gui connected:', socket.id)

    /* ------------------------------ hello ------------------------------ */
    socket.on('hello', (_p: unknown, cb?: (resp: unknown) => void) => {
      const ack = typeof _p === 'function' ? _p : cb
      const resp = {
        server: 'tagent',
        version: '0.1.0',
        workspace: {
          id: workspaceId,
          name: path.basename(root),
          path: root,
        },
        config: sanitizeConfig(),
        skills: listSkills(root),
        memory: {
          agents: readAgents(root),
          facts: listFacts(root),
        },
        sessions: sessions.list(),
        tools: buildToolset({ config: cfg }).map((t) => ({
          name: t.name, description: t.description, risk: t.risk,
        })),
        checkpoints: listCheckpoints(root).slice(0, 10),
      }
      ack?.(resp)
    })

    /* ----------------------------- sessions ---------------------------- */
    socket.on('session:new', (p: { mode?: 'build' | 'plan' }, cb?: (s: SessionData) => void) => {
      session = sessions.create('New session', cfg.defaultModel, p?.mode ?? 'build')
      emit('session:active', session)
      emit('session:list', sessions.list())
      cb?.(session)
    })

    socket.on('session:load', (p: { id: string }, cb?: (s: SessionData | null) => void) => {
      const s = sessions.load(p?.id)
      if (s) {
        session = s
        emit('session:active', s)
        emit('todos:update', { sessionId: s.id, todos: s.todos })
      }
      cb?.(s ?? null)
    })

    socket.on('session:delete', (p: { id: string }) => {
      if (session?.id === p?.id) session = undefined
      sessions.delete(p?.id)
      emit('session:list', sessions.list())
    })

    socket.on('session:mode', (p: { mode: 'build' | 'plan' }) => {
      if (session) {
        session.mode = p?.mode ?? 'build'
        sessions.save(session)
        emit('session:active', session)
      }
    })

    /* ------------------------------- chat ------------------------------ */
    socket.on(
      'chat:send',
      async (p: { text: string; mode?: 'build' | 'plan' }, cb?: (ok: boolean) => void) => {
        const text = String(p?.text ?? '').trim()
        if (!text) return cb?.(false)
        try {
          const s = await ensureSession(p?.mode ?? session?.mode ?? 'build')
          if (p?.mode && s.mode !== p.mode) {
            s.mode = p.mode
            sessions.save(s)
          }
          if (loop) {
            emitTo(socket.id, 'notify', { level: 'warn', message: 'A run is already in progress — stopped it first.' })
            loop.stop()
            await new Promise((r) => setTimeout(r, 100))
          }
          const events = makeEvents(socket.id)
          const plugins = await loadPlugins(root)
          await emitPluginEvent(plugins, 'onSessionStart', { session: s, config: cfg })
          const permissions = new PermissionManager(cfg, persist)
          loop = new AgentLoop({
            session: s,
            provider: activeProvider(),
            model: cfg.defaultModel,
            events,
            permissions,
            config: cfg,
            mode: s.mode,
            onSessionUpdate: (sess) => sessions.save(sess),
          })
          cb?.(true)
          const summary = await loop.run(text)
          await emitPluginEvent(plugins, 'onAgentDone', { summary, session: s })
          sessions.save(s)
          emit('session:list', sessions.list())
          emitTo(socket.id, 'chat:done', { sessionId: s.id, summary, checkpoints: listCheckpoints(root).slice(0, 10) })
        } catch (e) {
          emitTo(socket.id, 'notify', { level: 'error', message: `Chat failed: ${(e as Error).message}` })
          emitTo(socket.id, 'chat:done', { sessionId: session?.id, summary: { turns: 0, toolCalls: 0, finished: 'error', error: (e as Error).message } })
        } finally {
          loop = undefined
        }
      },
    )

    socket.on('chat:interrupt', () => {
      loop?.stop()
    })

    /* ---------------------------- permissions -------------------------- */
    socket.on(
      'permission:respond',
      (p: { requestId: string; approved: boolean; remember?: 'once' | 'session' | 'always' }) => {
        const pending = pendingPermissions.get(p?.requestId)
        if (pending) {
          clearTimeout(pending.timer)
          pendingPermissions.delete(p.requestId)
          pending.resolve({ approved: !!p.approved, remember: p.remember })
        }
      },
    )

    /* ------------------------------- files ----------------------------- */
    socket.on('files:list', (p: { path?: string }, cb?: (tree: unknown) => void) => {
      try {
        cb?.(walkTree(root, p?.path ?? '.'))
      } catch (e) {
        cb?.({ error: (e as Error).message })
      }
    })

    socket.on('file:read', (p: { path: string }, cb?: (r: unknown) => void) => {
      try {
        cb?.(readWorkspaceFile(root, p?.path))
      } catch (e) {
        cb?.({ error: (e as Error).message })
      }
    })

    socket.on('file:save', (p: { path: string; content: string }, cb?: (r: unknown) => void) => {
      try {
        cb?.(saveWorkspaceFile(root, p?.path, p?.content))
        emit('files:changed', { paths: [p.path] })
      } catch (e) {
        cb?.({ error: (e as Error).message })
      }
    })

    /* ------------------------------ memory ----------------------------- */
    socket.on('memory:get', (p: {}, cb?: (r: unknown) => void) => {
      cb?.({ agents: readAgents(root), facts: listFacts(root) })
    })

    socket.on('memory:save-agents', (p: { which: 'global' | 'workspace'; content: string }, cb?: (r: unknown) => void) => {
      try {
        saveAgents(root, p.which === 'global' ? 'global' : 'workspace', String(p.content ?? ''))
        cb?.({ ok: true })
      } catch (e) {
        cb?.({ error: (e as Error).message })
      }
    })

    socket.on('memory:save-fact', (p: { text: string }, cb?: (r: unknown) => void) => {
      const fact = saveFact(root, String(p?.text ?? ''))
      cb?.({ fact })
    })

    socket.on('memory:delete-fact', (p: { id: string }, cb?: (r: unknown) => void) => {
      cb?.({ ok: deleteFact(root, p?.id) })
    })

    /* ------------------------------ skills ----------------------------- */
    socket.on('skills:list', (_p: {}, cb?: (r: unknown) => void) => {
      cb?.(listSkills(root))
    })

    socket.on('skill:read', (p: { name: string }, cb?: (r: unknown) => void) => {
      try {
        cb?.({ content: loadSkill(root, p?.name) })
      } catch (e) {
        cb?.({ error: (e as Error).message })
      }
    })

    /* ---------------------------- checkpoints -------------------------- */
    socket.on('checkpoint:undo', async (_p: {}, cb?: (r: unknown) => void) => {
      try {
        const meta = undoCheckpoint(root)
        emit('files:changed', { paths: ['*'] })
        cb?.({ ok: !!meta, checkpoint: meta ?? null })
      } catch (e) {
        cb?.({ error: (e as Error).message })
      }
    })

    /* ------------------------------ settings --------------------------- */
    socket.on('settings:save', (p: Partial<{
      defaultProvider: string
      defaultModel: string
      apiKey: { provider: string; key: string }
      permissions: TagentConfig['permissions']
      tools: TagentConfig['tools']
      maxTurns: number
      autoCheckpoint: boolean
    }>, cb?: (r: unknown) => void) => {
      try {
        if (p.defaultProvider) cfg.defaultProvider = p.defaultProvider
        if (p.defaultModel) cfg.defaultModel = p.defaultModel
        if (p.apiKey?.provider) {
          const key = String(p.apiKey.key ?? '').trim()
          if (key) cfg.apiKeys[p.apiKey.provider] = key
          else delete cfg.apiKeys[p.apiKey.provider]
        }
        if (p.permissions) cfg.permissions = p.permissions
        if (p.tools) cfg.tools = p.tools
        if (typeof p.maxTurns === 'number') cfg.maxTurns = Math.min(Math.max(p.maxTurns, 1), 80)
        if (typeof p.autoCheckpoint === 'boolean') cfg.autoCheckpoint = p.autoCheckpoint
        persist()
        cb?.({ ok: true, config: sanitizeConfig() })
      } catch (e) {
        cb?.({ error: (e as Error).message })
      }
    })

    /* ------------------------------- github ----------------------------- */
    socket.on('github:pat', async (p: { token: string }, cb?: (r: unknown) => void) => {
      try {
        const token = String(p?.token ?? '').trim()
        const login = await validatePat(token)
        cfg.github = { ...(cfg.github ?? {}), token, login }
        persist()
        cb?.({ ok: true, login })
      } catch (e) {
        cb?.({ error: (e as Error).message })
      }
    })

    socket.on('github:push', async (p: { message?: string }, cb?: (r: unknown) => void) => {
      try {
        const result = await pushWorkspace(root, cfg, p?.message || 'Update from Tagent', (line) =>
          emitTo(socket.id, 'notify', { level: 'info', message: line }),
        )
        cb?.({ ok: true, result })
        emitTo(socket.id, 'notify', { level: 'info', message: `Pushed to ${result.repo} (${result.commit})` })
      } catch (e) {
        cb?.({ error: (e as Error).message })
      }
    })

    /* ----------------------------- terminal ----------------------------- */
    socket.on('terminal:exec', async (p: { command: string }, cb?: (r: unknown) => void) => {
      if (!cfg.tools.bash) {
        cb?.({ output: 'Terminal is disabled in this environment (Settings → Tools).' })
        return
      }
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const exec = promisify(execFile)
      try {
        const { stdout, stderr } = await exec('bash', ['-lc', String(p?.command ?? '')], {
          cwd: root,
          timeout: 30_000,
          maxBuffer: 1024 * 512,
          env: { ...process.env, NO_COLOR: '1' },
        })
        cb?.({ output: `${stdout}${stderr ? `\n${stderr}` : ''}`.slice(0, 30_000) })
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; message?: string }
        cb?.({ output: `${err.stdout ?? ''}${err.stderr ?? err.message ?? ''}`.slice(0, 30_000) })
      }
    })

    socket.on('workspace:stats', (_p: {}, cb?: (r: unknown) => void) => {
      const dirs = fs.existsSync(path.join(root, '.tagent', 'sessions'))
        ? fs.readdirSync(path.join(root, '.tagent', 'sessions')).length
        : 0
      cb?.({ sessions: dirs, snapshots: listCheckpoints(root).length })
    })

    socket.on('disconnect', () => {
      log('gui disconnected:', socket.id)
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // a crashing socket handler must never take the daemon down
    process.on('uncaughtException', (err) => {
      console.error('[tagent] uncaught (daemon stays up):', err?.message)
    })
    process.on('unhandledRejection', (err) => {
      console.error('[tagent] unhandled rejection (daemon stays up):', err)
    })
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      log(`daemon ready on ${opts.host ?? '127.0.0.1'}:${opts.port} (workspace: ${root})`)
      if (guiDir) log(`serving GUI from ${guiDir} (websocket: ${socketIoPath})`)
      resolve({
        server,
        io,
        close: async () => {
          io.close()
          await new Promise<void>((r) => server.close(() => r()))
        },
      })
    })
  })
}
