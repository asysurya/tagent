/**
 * Relay tests — live read-only session sharing over the network.
 * Covers: host relay CRUD, the /relay/<code> viewer page, viewer auth,
 * snapshot on connect, session-filtered live events, read-only enforcement,
 * GUI room isolation, revoke kick — against BOTH daemon flavors
 * (with guiDir → /socket, and headless relay-only).
 *
 * Run: bun scripts/test-relay.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { io } from 'socket.io-client'

const { AgentHost } = await import('../packages/cli/src/host')
const { createDaemon } = await import('../packages/cli/src/daemon')
const { SessionStore } = await import('../packages/core/src/index')

let fails = 0
function assert(cond: boolean, label: string) {
  console.log(cond ? '✓' : '✗', label)
  if (!cond) fails++
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** first free TCP port (listen :0) */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function call<T>(socket: ReturnType<typeof io>, event: string, payload?: unknown, timeoutMs = 8000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} timed out`)), timeoutMs)
    socket.emit(event, payload, (res: T) => {
      clearTimeout(t)
      resolve(res)
    })
  })
}

const TMP = '/tmp/tagent-relay-test'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(path.join(TMP, '.tagent'), { recursive: true })
fs.writeFileSync(path.join(TMP, '.tagent', 'config.json'), JSON.stringify({
  version: 1,
  defaultProvider: 'zai',
  defaultModel: 'glm-4.7',
  apiKeys: {},
  customProviders: [],
  permissions: { defaultMode: 'ask', tools: {} },
  tools: { bash: true, browser: false },
  github: {},
  mega: { enabled: false },
  autoCheckpoint: true,
  maxTurns: 40,
  nativeTools: true,
  worklog: { enabled: true },
}))

/* ---------------- host-level relay CRUD ---------------- */

const host = new AgentHost({ workspaceRoot: TMP })
const session = host.newSession('build')
session.title = 'relay test session'
session.messages.push(
  { id: 'm1', role: 'user', content: 'hello there', createdAt: Date.now() },
  { id: 'm2', role: 'assistant', content: 'hi! working on it', createdAt: Date.now(), toolCalls: [{ id: 't1', tool: 'write_file', input: { path: 'a.txt' }, output: 'written', status: 'done', startedAt: Date.now(), endedAt: Date.now() }] },
)
;(session as { messageCount: number }).messageCount = 2
// persist the mutated session, then re-activate from disk
new SessionStore(TMP, TMP).save(session as never)
host.loadSession(session.id)

const r1 = host.relayCreate(session.id)
assert(r1.ok && !!r1.code && r1.url === `/relay/${r1.code}`, 'relayCreate returns code + url')
const r2 = host.relayCreate(session.id)
assert(r2.code === r1.code, 'relayCreate is idempotent per session')
assert(host.relayList().length === 1, 'relayList shows one entry')
assert(host.relayCreate('nope').ok === false, 'relayCreate of unknown session fails')

// persistence: a fresh host sees the SAME code (relay survives restarts)
const hostB = new AgentHost({ workspaceRoot: TMP })
assert(hostB.relayCreate(session.id).code === r1.code, 'relays persist across hosts (same code)')

/* ---------------- daemon: with guiDir (socket at /socket) ---------------- */

const PORT = await freePort()
const guiDir = fs.existsSync('gui-dist/index.html') ? 'gui-dist' : undefined
const daemon = await createDaemon({ port: PORT, workspaceRoot: TMP, guiDir, agentHost: host, quiet: true })
const base = `http://127.0.0.1:${PORT}`

// viewer page
const page = await fetch(`${base}${r1.url}`)
const pageHtml = await page.text()
assert(page.status === 200 && pageHtml.includes('<!doctype html>'), 'viewer page served at /relay/<code>')
assert(pageHtml.includes('/socket/socket.io.js'), 'viewer page loads the socket.io client from /socket')
assert(pageHtml.includes(r1.code!), 'viewer page embeds the relay code')
const bad = await fetch(`${base}/relay/zzzznotreal99`)
assert(bad.status === 404, 'unknown relay code → 404')
const trav = await fetch(`${base}/relay/..%2Fconfig.json`)
assert(trav.status === 404, 'path traversal relay code rejected')

// socket.io client bundle reachable
const cli = await fetch(`${base}/socket/socket.io.js`)
assert(cli.status === 200 && (await cli.text()).includes('Socket.IO'), 'socket.io client served at /socket/socket.io.js')

// connect a viewer
const viewer = io(base, { path: '/socket', query: { relay: r1.code }, transports: ['websocket', 'polling'] })
const helloP = new Promise<any>((resolve) => viewer.on('relay:hello', resolve))
await new Promise<void>((resolve, reject) => {
  viewer.on('connect', resolve)
  viewer.on('connect_error', (e: Error) => reject(new Error('viewer connect: ' + e.message)))
})
const hello = await helloP
assert(hello?.session?.id === session.id, 'relay:hello carries the session snapshot')
assert(hello?.session?.messages?.length === 2, 'snapshot includes both messages')
assert(hello?.session?.title === 'relay test session', 'snapshot includes the title')
assert(typeof hello?.version === 'string', 'snapshot includes the server version')

// a second session the viewer must NOT see
const other = host.newSession('plan')
host.loadSession(other.id)
host.loadSession(session.id) // back to the relayed one

// live events: matching session reaches the viewer, other sessions don't
const gotMatch = new Promise<boolean>((r) => viewer.once('message:new', (p: any) => r(p.sessionId === session.id)))
host.bus.emit('message:new', {
  sessionId: other.id,
  message: { id: 'x1', role: 'user', content: 'other session secret', createdAt: Date.now() },
})
host.bus.emit('message:new', {
  sessionId: session.id,
  message: { id: 'x2', role: 'assistant', content: 'live relay works', createdAt: Date.now() },
})
assert(await gotMatch, 'viewer receives live events for its session (not others)')
await wait(300)
// read-only: a viewer cannot run the agent (no RPC handlers registered)
let rpcLeak = false
try {
  await call(viewer, 'hello', {}, 1200)
  rpcLeak = true
} catch { /* expected: no ack */ }
assert(!rpcLeak, 'viewer RPC calls are ignored (read-only)')

// gui room: a normal client gets broadcasts
const gui = io(base, { path: '/socket', transports: ['websocket'] })
await new Promise<void>((resolve, reject) => {
  gui.on('connect', resolve)
  gui.on('connect_error', (e: Error) => reject(new Error('gui connect: ' + e.message)))
})
const guiGot = new Promise<boolean>((r) => gui.once('notify', (p: any) => r(p.message === 'ping-gui')))
host.bus.emit('notify', { level: 'info', message: 'ping-gui' })
assert(await guiGot, 'normal clients still receive broadcasts (gui room)')

// relay:list shows the relay with 1 viewer
const list = await call<{ relays: any[] }>(gui, 'relay:list')
const entry = list.relays?.find((e: any) => e.code === r1.code)
assert(!!entry && entry.viewers === 1, 'relay:list reports 1 connected viewer')

// revoke kicks the viewer
const kicked = new Promise<boolean>((r) => viewer.once('relay:revoked', () => r(true)))
const revoked = await call<{ ok: boolean }>(gui, 'relay:revoke', { code: r1.code })
assert(revoked.ok === true, 'relay:revoke succeeds')
assert(await Promise.race([kicked, wait(3000).then(() => false)]), 'revoked viewer receives relay:revoked')
await wait(300)
const afterList = await call<{ relays: any[] }>(gui, 'relay:list')
assert((afterList.relays ?? []).length === 0, 'relay list empty after revoke')
viewer.close()
gui.close()

/* ---------------- daemon: headless (no guiDir) ---------------- */

const PORT2 = await freePort()
const host2 = new AgentHost({ workspaceRoot: TMP })
const s2 = host2.listSessions().find((s: any) => s.id === session.id)!
const r3 = host2.relayCreate(session.id)
assert(r3.ok && r3.code !== r2.code, 'a fresh relay code is issued after the old one was revoked')
const daemon2 = await createDaemon({ port: PORT2, workspaceRoot: TMP, agentHost: host2, quiet: true })
const base2 = `http://127.0.0.1:${PORT2}`

const page2 = await fetch(`${base2}${r3.url}`)
assert(page2.status === 200 && (await page2.text()).includes('/socket/socket.io.js'), 'headless daemon serves the viewer page too')
const v2 = io(base2, { path: '/socket', query: { relay: r3.code }, transports: ['websocket'] })
const hello2P = new Promise<any>((resolve) => v2.on('relay:hello', resolve))
await new Promise<void>((resolve, reject) => {
  v2.on('connect', resolve)
  v2.on('connect_error', (e: Error) => reject(new Error('headless viewer connect: ' + e.message)))
})
const hello2 = await hello2P
assert(hello2?.session?.messages?.length === 2, 'headless viewer gets the snapshot')
v2.close()

// invalid relay code: connection refused
const bogus = io(base2, { path: '/socket', query: { relay: 'not-a-real-code' }, transports: ['websocket'], reconnection: false })
const refused = await new Promise<boolean>((resolve) => {
  bogus.on('connect_error', () => resolve(true))
  setTimeout(() => resolve(false), 3000)
})
assert(refused, 'invalid relay code is refused at connect')
bogus.close()

// cleanup: the second host sees zero relays after revoke
assert(host2.relayRevoke(r3.code).ok, 'revoke via second host works')

await daemon.close()
await daemon2.close()

console.log(fails ? `\nFAILS: ${fails}` : '\nRELAY TESTS ALL OK')
process.exit(fails ? 1 : 0)
