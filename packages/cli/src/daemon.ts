import http from 'node:http'
import { Server as SocketIOServer } from 'socket.io'
import path from 'node:path'
import fs from 'node:fs'
import type { Server as HttpServer } from 'node:http'

import {
  readShareFile, findRelayByCode, renderRelayViewerHtml, CURRENT_VERSION,
  validatePat, saveGithubLogin, authStatus, logout as coreLogout, syncProject,
  getLinkedProject, linkProject, unlinkProject, listProjects, refuseLink,
  workspaceHasWork, isLinkRefused, defaultRepoName, ensureRepoDetailed,
  getCredential, readGlobalConfig, pushConfigSync, pullConfigSync,
  type RelayEntry,
  type AgentMode,
} from '@tagent/core'

import { AgentHost } from './host'
import type { Socket } from 'socket.io'

/**
 * The daemon — a thin network adapter over an AgentHost.
 *
 * Serves the web GUI (static SPA), the share-link routes and the socket.io
 * RPC. The TUI talks to the very same host object directly, so terminal and
 * browser are equals: same sessions, same runs, same permissions.
 */

export interface DaemonOptions {
  port: number
  host?: string
  workspaceRoot: string
  configOverride?: import('@tagent/core').TagentConfig | Record<string, never>
  socketPath?: string
  guiDir?: string
  quiet?: boolean
  /** share the host with a TUI running in this process */
  agentHost?: AgentHost
}

export interface DaemonHandle {
  server: HttpServer
  io: SocketIOServer
  host: AgentHost
  close(): Promise<void>
}

export function createDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const host = opts.agentHost ?? new AgentHost({
    workspaceRoot: opts.workspaceRoot,
    quiet: opts.quiet,
  })

  // The websocket always lives at /socket (with or without a GUI bundle)
  // so the relay viewer page and clients have one canonical endpoint —
  // socket.io serves its own client at /socket/socket.io.js.
  const guiDir = opts.guiDir && fs.existsSync(path.join(opts.guiDir, 'index.html'))
    ? path.resolve(opts.guiDir as string)
    : null
  const socketIoPath = opts.socketPath ?? '/socket'

  const log = (...a: unknown[]) => { if (!opts.quiet) console.log('[tagent]', ...a) }

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
    '.map': 'application/json; charset=utf-8',
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
    const url = (req.url ?? '/').split('?')[0]

    if (url.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true, server: 'tagent',
        version: host.hello().version, gui: !!guiDir, workspace: host.root,
      }))
      return
    }

    // share links — /share/<id>.html (read-only snapshot)
    if (url.startsWith('/share/')) {
      const html = readShareFile(host.root, url.slice('/share/'.length))
      if (html) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
        res.end(html)
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('share not found')
      }
      return
    }

    // relay mode — /relay/<code> (live read-only viewer page)
    if (url.startsWith('/relay/')) {
      const entry = findRelayByCode(host.root, url.slice('/relay/'.length))
      if (entry) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
        res.end(renderRelayViewerHtml(entry.code, socketIoPath))
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('relay not found — ask the owner for a fresh link')
      }
      return
    }

    if (guiDir) {
      // never shadow the websocket endpoint with a static file
      if (url === socketIoPath || url.startsWith(socketIoPath + '/')) return
      serveStatic(req, res)
      return
    }
    res.writeHead(404).end('tagent daemon — connect via websocket, or run with a GUI bundle for the web UI')
  })

  const io = new SocketIOServer(server, {
    path: socketIoPath,
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60_000,
    pingInterval: 25_000,
    maxHttpBufferSize: 20e6,
  })

  // host events broadcast to every attached browser tab (the "gui" room;
  // relay viewers never join it — they get session-filtered events instead)
  const forward = [
    'agent:status', 'message:new', 'agent:chunk', 'tool:start', 'tool:end',
    'todos:update', 'subagent:update', 'files:changed', 'notify', 'context:update',
    'permission:request', 'ask:request', 'chat:done', 'session:active', 'session:list',
    'workspace:changed', 'plan:ready',
  ]
  for (const event of forward) host.bus.on(event, (payload) => io.to('gui').emit(event, payload))

  /* ------------------------------------------------------------------ */
  /* relay viewers — read-only sockets bound to one session by code        */
  /* ------------------------------------------------------------------ */

  interface Viewer { entry: RelayEntry; sockets: Set<Socket> }
  const viewers = new Map<string, Viewer>()

  const toViewers = (fn: (v: Viewer) => void) => {
    for (const v of viewers.values()) fn(v)
  }

  // session-scoped events go ONLY to the viewers bound to that session
  for (const event of ['message:new', 'agent:chunk', 'tool:start', 'tool:end', 'todos:update', 'subagent:update', 'chat:done']) {
    host.bus.on(event, (payload) => {
      const sid = (payload as { sessionId?: string } | undefined)?.sessionId
      if (!sid) return
      toViewers((v) => {
        if (sid === v.entry.sessionId) v.sockets.forEach((s) => s.emit(event, payload))
      })
    })
  }
  // status is global — viewers only see it while their session is the active one
  host.bus.on('agent:status', (p: unknown) => {
    toViewers((v) => {
      if (host.session?.id === v.entry.sessionId) v.sockets.forEach((s) => s.emit('agent:status', p))
    })
  })

  // relay auth: ?relay=<code> — invalid codes never reach the connection handler
  io.use((socket, next) => {
    const code = socket.handshake.query?.relay
    if (!code) return next()
    const entry = findRelayByCode(host.root, String(code))
    if (!entry) return next(new Error('invalid relay code'))
    socket.data.relay = entry
    next()
  })

  const kickViewers = (code: string, message = 'relay:revoked') => {
    const v = viewers.get(code)
    if (!v) return
    v.sockets.forEach((s) => {
      s.emit(message)
      s.disconnect(true)
    })
    viewers.delete(code)
  }

  /** GitHub token from any store: credential → workspace cfg → global cfg
   *  (same resolution order syncProject uses — keeps legacy GUI logins working). */
  const ghToken = (): string | undefined =>
    getCredential('github') || host.cfg.github?.token || readGlobalConfig().github?.token

  io.on('connection', (socket) => {
    /* -------- relay viewer: snapshot on connect, then live + read-only ---- */
    if (socket.data.relay) {
      const entry = socket.data.relay as RelayEntry
      let v = viewers.get(entry.code)
      if (!v) {
        v = { entry, sockets: new Set() }
        viewers.set(entry.code, v)
      }
      v.sockets.add(socket)
      const snapshot = host.sessionSnapshot(entry.sessionId)
      socket.emit('relay:hello', {
        session: snapshot,
        running: host.running && host.session?.id === entry.sessionId,
        server: 'tagent',
        version: CURRENT_VERSION,
      })
      if (!snapshot) socket.emit('relay:revoked')
      log('relay viewer connected:', entry.code, '(' + v.sockets.size + ' watching)')
      socket.on('disconnect', () => {
        const cur = viewers.get(entry.code)
        if (!cur) return
        cur.sockets.delete(socket)
        if (cur.sockets.size === 0) viewers.delete(entry.code)
      })
      return // read-only: no RPC handlers for viewers
    }

    socket.join('gui')
    log('gui connected:', socket.id)

    /* ------------------------------ hello ------------------------------ */
    socket.on('hello', (_p: unknown, cb?: (resp: unknown) => void) => {
      const ack = typeof _p === 'function' ? _p : cb
      ack?.(host.hello())
    })

    /* --------------------------- workspaces ---------------------------- */
    socket.on('workspace:list', (_p: unknown, cb?: (r: unknown) => void) => {
      cb?.(host.listWorkspaces())
    })

    socket.on('workspace:switch', (p: { path: string }, cb?: (r: unknown) => void) => {
      cb?.(host.switchWorkspace(p?.path))
    })

    /* ----------------------------- sessions ---------------------------- */
    socket.on('session:new', (p: { mode?: AgentMode }, cb?: (s: unknown) => void) => {
      cb?.(host.newSession(p?.mode ?? 'build'))
    })

    socket.on('session:load', (p: { id: string }, cb?: (s: unknown) => void) => {
      cb?.(host.loadSession(p?.id) ?? null)
    })

    socket.on('session:delete', (p: { id: string }, cb?: (r: unknown) => void) => {
      host.deleteSession(p?.id)
      cb?.({ ok: true })
    })

    socket.on('session:rename', (p: { id: string; title: string }, cb?: (s: unknown) => void) => {
      cb?.(host.renameSession(p?.id ?? '', p?.title ?? '') ?? null)
    })

    socket.on('session:mode', (p: { mode: AgentMode }) => {
      host.setSessionMode(p?.mode ?? 'build')
    })

    socket.on('session:compact', (p: { keepTokens?: number }, cb?: (r: unknown) => void) => {
      try { cb?.(host.compactSession(p?.keepTokens)) } catch (e) { cb?.({ ok: false, error: (e as Error).message }) }
    })

    socket.on('context:info', (_p: unknown, cb?: (r: unknown) => void) => {
      try { cb?.(host.contextInfo()) } catch { cb?.({ used: 0, limit: 0, pct: 0, bar: '', estimated: true }) }
    })

    socket.on('plan:approve', (p: { execute: boolean }, cb?: (r: unknown) => void) => {
      try { cb?.(host.approvePlan(!!p?.execute)) } catch (e) { cb?.({ ok: false, error: (e as Error).message }) }
    })

    socket.on('agents:view', (_p: unknown, cb?: (r: unknown) => void) => {
      cb?.(host.subagentsView())
    })

    socket.on('fallback:view', (_p: unknown, cb?: (r: unknown) => void) => {
      cb?.(host.fallbackChainView())
    })

    socket.on('diagnostics:run', async (_p: unknown, cb?: (r: unknown) => void) => {
      cb?.(await host.diagnosticsRun())
    })

    socket.on('session:timeline', (p: { sessionId?: string }, cb?: (r: unknown) => void) => {
      cb?.({ timeline: host.timeline(p?.sessionId) })
    })

    socket.on('session:share', (p: { id?: string }, cb?: (r: unknown) => void) => {
      cb?.(host.share(p?.id))
    })

    /* ------------------------- relay mode ------------------------------ */
    socket.on('relay:create', (p: { sessionId?: string }, cb?: (r: unknown) => void) => {
      cb?.(host.relayCreate(p?.sessionId))
    })

    socket.on('relay:list', (_p: unknown, cb?: (r: unknown) => void) => {
      const relays = host.relayList().map((e) => ({
        ...e,
        viewers: viewers.get(e.code)?.sockets.size ?? 0,
      }))
      cb?.({ relays })
    })

    socket.on('relay:revoke', (p: { code?: string }, cb?: (r: unknown) => void) => {
      const code = String(p?.code ?? '')
      const r = host.relayRevoke(code)
      if (r.ok) kickViewers(code)
      cb?.(r)
    })

    /* ------------------------------- chat ------------------------------ */
    socket.on('chat:send', (p: { text: string; mode?: AgentMode }, cb?: (ok: boolean) => void) => {
      const text = String(p?.text ?? '').trim()
      if (!text) return cb?.(false)
      cb?.(true)
      host.chatSend(text, p?.mode).catch((e: Error) => {
        host.bus.emit('notify', { level: 'error', message: `Chat failed: ${e.message}` })
        host.bus.emit('chat:done', {
          sessionId: undefined,
          summary: { turns: 0, toolCalls: 0, finished: 'error', error: e.message },
        })
      })
    })

    socket.on('chat:interrupt', () => {
      host.interrupt()
    })

    /* ---------------------------- permissions -------------------------- */
    socket.on(
      'permission:respond',
      (p: { requestId: string; approved: boolean; remember?: 'once' | 'session' | 'always' }) => {
        host.permissionRespond(p?.requestId, !!p?.approved, p?.remember)
      },
    )

    /* ---------------------------- ask forms ---------------------------- */
    socket.on(
      'ask:respond',
      (p: { requestId: string; response: import('@tagent/core').AskFormResponse | null }) => {
        host.askRespond(p?.requestId, p?.response ?? null)
      },
    )

    /* ------------------------------- files ----------------------------- */
    socket.on('files:list', (p: { path?: string }, cb?: (tree: unknown) => void) => {
      try { cb?.(host.filesList(p?.path)) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    socket.on('file:read', (p: { path: string }, cb?: (r: unknown) => void) => {
      try { cb?.(host.fileRead(p?.path)) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    socket.on('file:save', (p: { path: string; content: string }, cb?: (r: unknown) => void) => {
      try { cb?.(host.fileSave(p?.path, p?.content)) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    /* ------------------------------ memory ----------------------------- */
    socket.on('memory:get', (_p: unknown, cb?: (r: unknown) => void) => {
      cb?.(host.memoryGet())
    })

    socket.on('memory:save-agents', (p: { which: 'global' | 'workspace'; content: string }, cb?: (r: unknown) => void) => {
      try { cb?.(host.memorySaveAgents(p?.which === 'global' ? 'global' : 'workspace', p?.content)) }
      catch (e) { cb?.({ error: (e as Error).message }) }
    })

    socket.on('memory:save-fact', (p: { text: string }, cb?: (r: unknown) => void) => {
      cb?.(host.memorySaveFact(p?.text))
    })

    socket.on('memory:delete-fact', (p: { id: string }, cb?: (r: unknown) => void) => {
      cb?.(host.memoryDeleteFact(p?.id))
    })

    /* ------------------------------ skills ----------------------------- */
    socket.on('skills:list', (_p: unknown, cb?: (r: unknown) => void) => {
      cb?.(host.skillsList())
    })

    socket.on('skill:read', (p: { name: string }, cb?: (r: unknown) => void) => {
      try { cb?.(host.skillRead(p?.name)) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    /* ---------------------------- checkpoints -------------------------- */
    socket.on('checkpoint:undo', async (_p: unknown, cb?: (r: unknown) => void) => {
      try { cb?.(host.undoCheckpoint()) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    /* ------------------------------ settings --------------------------- */
    socket.on('settings:save', (p: Record<string, unknown>, cb?: (r: unknown) => void) => {
      try { cb?.(host.settingsSave(p as never)) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    /* --------------------------- providers ----------------------------- */
    socket.on('providers:refresh', async (_p: unknown, cb?: (r: unknown) => void) => {
      try { cb?.(await host.providersRefresh()) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    /* ------------------------------ mega sync -------------------------- */
    socket.on('mega:save', (p: { enabled: boolean; email?: string; sessionKey?: string }, cb?: (r: unknown) => void) => {
      try { cb?.(host.megaSave(p)) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    socket.on('mega:sync', async (_p: unknown, cb?: (r: unknown) => void) => {
      try { cb?.(await host.megaSync()) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    socket.on('mega:pull', async (_p: unknown, cb?: (r: unknown) => void) => {
      try { cb?.(await host.megaPull()) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    /* ------------------------------- github ----------------------------- */
    socket.on('github:pat', async (p: { token: string }, cb?: (r: unknown) => void) => {
      try { cb?.(await host.githubPat(String(p?.token ?? '').trim())) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    socket.on('github:logout', async (_p: unknown, cb?: (r: unknown) => void) => {
      try { cb?.(await host.githubLogout()) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    socket.on('github:device:start', async (_p: unknown, cb?: (r: unknown) => void) => {
      try { cb?.(await host.githubDeviceStart()) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    socket.on('github:device:poll', async (_p: unknown, cb?: (r: unknown) => void) => {
      try { cb?.(await host.githubDevicePoll()) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    socket.on('github:push', async (p: { message?: string }, cb?: (r: unknown) => void) => {
      try { cb?.(await host.githubPush(p?.message)) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    /* ------------------- auth + project sync (v0.13) -------------------
     * Guest→login flow: a fresh install is a guest (no GitHub credential);
     * `auth:login` validates a PAT and saves it exactly like `tagent auth`
     * does (credential store + cached login). `sync:push` goes through
     * core syncProject so the project registry (link + lastSyncAt) stays
     * truthful — host.githubPush above is the legacy pre-registry path. */

    socket.on('auth:status', (_p: unknown, cb?: (r: unknown) => void) => {
      try {
        const a = authStatus()
        cb?.({ ok: true, guest: !a.logged, login: a.login })
      } catch (e) { cb?.({ ok: false, guest: true, error: (e as Error).message }) }
    })

    socket.on('auth:login', async (p: { pat?: string }, cb?: (r: unknown) => void) => {
      try {
        const pat = String(p?.pat ?? '').trim()
        if (!pat) return cb?.({ ok: false, error: 'no token provided' })
        const login = await validatePat(pat) // network — a bad PAT must ack, never throw
        saveGithubLogin(pat, login)          // credential store + cached login (same as `tagent auth`)
        // keep the in-memory cfg login fresh so hello()/pushWorkspace skip a
        // validatePat round-trip; the token itself never lands in config files
        host.cfg.github = { ...host.cfg.github, login }
        host.bus.emit('notify', { level: 'info', message: `GitHub connected as @${login}` })
        // v0.24: the private config repo — auto-created on auth, pull-first
        // so a defaults-only device never clobbers a richer remote
        let configRepo = ''
        try {
          await pullConfigSync().catch(() => undefined)
          const cr = await pushConfigSync()
          configRepo = cr.repo
          host.bus.emit('notify', {
            level: 'info',
            message: `Config repo ${cr.repo} ready — providers, keys and MCP sync across devices`,
          })
        } catch (err) {
          host.bus.emit('notify', { level: 'warn', message: `Config repo setup skipped: ${(err as Error).message}` })
        }
        // guest→login prompt payload: ask ONCE per workspace that has work,
        // is not linked yet and was not refused (owner's requested UX)
        const promptLink =
          workspaceHasWork(host.root) && !getLinkedProject(host.root) && !isLinkRefused(host.root)
        cb?.({ ok: true, login, promptLink, ...(configRepo ? { configRepo } : {}) })
      } catch (e) { cb?.({ ok: false, error: (e as Error).message }) }
    })

    socket.on('auth:logout', async (_p: unknown, cb?: (r: unknown) => void) => {
      try {
        coreLogout()               // credential store + global-config scrub
        await host.githubLogout()  // legacy token/login cached in the workspace config
        host.bus.emit('notify', { level: 'info', message: 'Logged out of GitHub' })
        cb?.({ ok: true })
      } catch (e) { cb?.({ ok: false, error: (e as Error).message }) }
    })

    socket.on('sync:status', (_p: unknown, cb?: (r: unknown) => void) => {
      try {
        const linked = getLinkedProject(host.root)
        const a = authStatus()
        cb?.({
          ok: true,
          linked: !!linked,
          repo: linked?.repo,
          lastSyncAt: linked?.lastSyncAt,
          guest: !a.logged,
          login: a.login,
        })
      } catch (e) { cb?.({ ok: false, linked: false, guest: true, error: (e as Error).message }) }
    })

    socket.on('sync:push', async (p: { message?: string }, cb?: (r: unknown) => void) => {
      try {
        if (!ghToken()) return cb?.({ ok: false, error: 'not logged in' })
        const result = await syncProject(host.root, host.cfg, {
          message: p?.message,
          onLog: (line) => host.bus.emit('notify', { level: 'info', message: line }),
        })
        host.bus.emit('notify', { level: 'info', message: `Synced ${result.repo} (${result.commit})` })
        cb?.({ ok: true, repo: result.repo, url: result.url, commit: result.commit, lastSyncAt: Date.now() })
      } catch (e) { cb?.({ ok: false, error: (e as Error).message }) }
    })

    socket.on('sync:link', async (p: { repo?: string }, cb?: (r: unknown) => void) => {
      try {
        const repo = String(p?.repo ?? '').trim()
        if (repo) return cb?.({ ok: true, repo: linkProject(host.root, repo).repo })
        // no explicit repo — ensure the default one exists on GitHub, then link
        const token = ghToken()
        if (!token) return cb?.({ ok: false, error: 'not logged in' })
        let login = authStatus().login || host.cfg.github?.login
        if (!login) login = await validatePat(token) // network — only when no cached login
        const ensured = await ensureRepoDetailed(token, login, defaultRepoName(host.root))
        const entry = linkProject(host.root, ensured.repo)
        cb?.({ ok: true, repo: entry.repo, created: ensured.created })
      } catch (e) { cb?.({ ok: false, error: (e as Error).message }) }
    })

    socket.on('sync:refuse', (_p: unknown, cb?: (r: unknown) => void) => {
      // "Jangan untuk proyek ini" — the user opted out of the sync prompt for this root
      try { refuseLink(host.root); cb?.({ ok: true }) } catch (e) { cb?.({ ok: false, error: (e as Error).message }) }
    })

    socket.on('sync:unlink', (_p: unknown, cb?: (r: unknown) => void) => {
      try { cb?.({ ok: unlinkProject(host.root) }) } catch (e) { cb?.({ ok: false, error: (e as Error).message }) }
    })

    socket.on('projects:list', (_p: unknown, cb?: (r: unknown) => void) => {
      try { cb?.({ ok: true, projects: listProjects() }) } catch (e) { cb?.({ ok: false, projects: [], error: (e as Error).message }) }
    })

    /* ----------------------------- terminal ----------------------------- */
    socket.on('terminal:exec', async (p: { command: string }, cb?: (r: unknown) => void) => {
      cb?.({ output: await host.terminalExec(p?.command) })
    })

    socket.on('workspace:stats', (_p: unknown, cb?: (r: unknown) => void) => {
      cb?.(host.stats())
    })

    /* ------------------------------- mcp -------------------------------- */
    socket.on('mcp:list', (_p: unknown, cb?: (r: unknown) => void) => {
      try { cb?.({ status: host.mcpStatus() }) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    socket.on('mcp:ensure', async (_p: unknown, cb?: (r: unknown) => void) => {
      try { cb?.({ status: await host.mcpEnsure() }) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    socket.on('mcp:tools', (_p: unknown, cb?: (r: unknown) => void) => {
      try { cb?.({ tools: host.mcpTools() }) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    socket.on('mcp:templates', (_p: unknown, cb?: (r: unknown) => void) => {
      try { cb?.({ templates: host.mcpTemplates() }) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    socket.on('mcp:save', async (p: {
      name?: string; command?: string; args?: unknown; env?: unknown; enabled?: boolean; description?: string
    }, cb?: (r: unknown) => void) => {
      try { cb?.(await host.mcpSave(p ?? {})) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    socket.on('mcp:remove', async (p: { name?: string }, cb?: (r: unknown) => void) => {
      try { cb?.(await host.mcpRemove(String(p?.name ?? ''))) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    socket.on('mcp:toggle', async (p: { name?: string }, cb?: (r: unknown) => void) => {
      try { cb?.(await host.mcpToggle(String(p?.name ?? ''))) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    /* ----------------------------- plugins ------------------------------ */
    socket.on('plugins:list', (_p: unknown, cb?: (r: unknown) => void) => {
      try { cb?.({ plugins: host.pluginsList() }) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    socket.on('plugins:scaffold', (p: { name?: string }, cb?: (r: unknown) => void) => {
      try { cb?.(host.pluginScaffold(String(p?.name ?? 'my-plugin'))) } catch (e) { cb?.({ error: (e as Error).message }) }
    })

    socket.on('plugins:commands', async (_p: unknown, cb?: (r: unknown) => void) => {
      try { cb?.({ commands: await host.pluginCommandList() }) } catch (e) { cb?.({ error: (e as Error).message }) }
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
      log(`daemon ready on ${opts.host ?? '127.0.0.1'}:${opts.port} (workspace: ${host.root})`)
      if (guiDir) log(`serving GUI from ${guiDir} (websocket: ${socketIoPath})`)
      // background model discovery — warms ~/.tagent/models.json so the
      // pickers show live model lists without anyone waiting on it
      setTimeout(() => { host.providersRefresh().catch(() => {}) }, 2000)
      resolve({
        server,
        io,
        host,
        close: async () => {
          io.close()
          host.close() // kill MCP server processes — no orphans
          await new Promise<void>((r) => server.close(() => r()))
        },
      })
    })
  })
}
