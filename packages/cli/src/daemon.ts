import http from 'node:http'
import { Server as SocketIOServer } from 'socket.io'
import path from 'node:path'
import fs from 'node:fs'
import type { Server as HttpServer } from 'node:http'

import { readShareFile } from '@tagent/core'

import { AgentHost } from './host'

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

  // When a built GUI directory exists we serve it as a static SPA and move
  // the websocket to /socket so it never collides with static assets.
  const guiDir = opts.guiDir && fs.existsSync(path.join(opts.guiDir, 'index.html'))
    ? path.resolve(opts.guiDir as string)
    : null
  const socketIoPath = opts.socketPath ?? (guiDir ? '/socket' : '/')

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

  // host events broadcast to every attached frontend (browser tabs alike)
  const forward = [
    'agent:status', 'message:new', 'agent:chunk', 'tool:start', 'tool:end',
    'todos:update', 'subagent:update', 'files:changed', 'notify',
    'permission:request', 'chat:done', 'session:active', 'session:list',
    'workspace:changed',
  ]
  for (const event of forward) host.bus.on(event, (payload) => io.emit(event, payload))

  io.on('connection', (socket) => {
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
    socket.on('session:new', (p: { mode?: 'build' | 'plan' }, cb?: (s: unknown) => void) => {
      cb?.(host.newSession(p?.mode ?? 'build'))
    })

    socket.on('session:load', (p: { id: string }, cb?: (s: unknown) => void) => {
      cb?.(host.loadSession(p?.id) ?? null)
    })

    socket.on('session:delete', (p: { id: string }) => {
      host.deleteSession(p?.id)
    })

    socket.on('session:mode', (p: { mode: 'build' | 'plan' }) => {
      host.setSessionMode(p?.mode ?? 'build')
    })

    socket.on('session:timeline', (p: { sessionId?: string }, cb?: (r: unknown) => void) => {
      cb?.({ timeline: host.timeline(p?.sessionId) })
    })

    socket.on('session:share', (p: { id?: string }, cb?: (r: unknown) => void) => {
      cb?.(host.share(p?.id))
    })

    /* ------------------------------- chat ------------------------------ */
    socket.on('chat:send', (p: { text: string; mode?: 'build' | 'plan' }, cb?: (ok: boolean) => void) => {
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

    /* ----------------------------- terminal ----------------------------- */
    socket.on('terminal:exec', async (p: { command: string }, cb?: (r: unknown) => void) => {
      cb?.({ output: await host.terminalExec(p?.command) })
    })

    socket.on('workspace:stats', (_p: unknown, cb?: (r: unknown) => void) => {
      cb?.(host.stats())
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
      resolve({
        server,
        io,
        host,
        close: async () => {
          io.close()
          await new Promise<void>((r) => server.close(() => r()))
        },
      })
    })
  })
}
