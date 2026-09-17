/**
 * Visual test rig for the relay viewer page: sets up a workspace with a
 * session, starts the daemon, creates a relay, then simulates live agent
 * activity (stream + tool + message + todos) so a browser can watch it.
 *
 * Usage: bun scripts/relay-visual.ts [port]
 * Prints the viewer URL and keeps running for ~4 minutes.
 */
import fs from 'node:fs'
import path from 'node:path'

const { AgentHost } = await import('../packages/cli/src/host')
const { createDaemon } = await import('../packages/cli/src/daemon')
const { SessionStore } = await import('../packages/core/src/index')

const PORT = Number(process.argv[2] ?? 4177)
const TMP = '/tmp/tagent-relay-visual'

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

const host = new AgentHost({ workspaceRoot: TMP })
const session = host.newSession('build')
session.title = 'v0.5.0 release prep'
session.messages.push(
  { id: 'm1', role: 'user', content: 'ship the relay feature today', createdAt: Date.now() },
  { id: 'm2', role: 'assistant', content: 'on it — tests first, then docs.', createdAt: Date.now() },
)
;(session as { messageCount: number }).messageCount = 2
new SessionStore(TMP, TMP).save(session as never)
host.loadSession(session.id)

const relay = host.relayCreate(session.id)!
const daemon = await createDaemon({ port: PORT, workspaceRoot: TMP, guiDir: 'gui-dist', agentHost: host, quiet: true })
const url = `http://127.0.0.1:${PORT}${relay.url}`
console.log('VIEWER_URL=' + url)

// simulate a live run a few seconds in, so the browser sees it happen
setTimeout(() => {
  host.bus.emit('agent:status', { phase: 'thinking', detail: 'turn 1' })
  host.bus.emit('message:new', { sessionId: session.id, message: { id: 'm3', role: 'user', content: 'and check the phone view too', createdAt: Date.now() } })
}, 6000)
setTimeout(() => {
  host.bus.emit('agent:chunk', { sessionId: session.id, text: 'checking ' })
  host.bus.emit('agent:chunk', { sessionId: session.id, text: 'the responsive layout…' })
}, 9000)
setTimeout(() => {
  host.bus.emit('tool:start', { sessionId: session.id, call: { id: 'vt1', tool: 'list_files', input: { path: '.' }, status: 'running', startedAt: Date.now() } })
}, 11000)
setTimeout(() => {
  host.bus.emit('tool:end', { sessionId: session.id, call: { id: 'vt1', tool: 'list_files', input: { path: '.' }, output: 'relay.ts\nindex.ts\n…', status: 'done', startedAt: Date.now(), endedAt: Date.now() } })
  host.bus.emit('message:new', { sessionId: session.id, message: { id: 'm4', role: 'assistant', content: 'all files look good — layout is responsive.', createdAt: Date.now() } })
  host.bus.emit('todos:update', { sessionId: session.id, todos: [
    { content: 'core relay module', status: 'completed', priority: 'high' },
    { content: 'viewer page', status: 'completed', priority: 'high' },
    { content: 'release v0.5.0', status: 'in_progress', priority: 'high' },
  ] })
}, 14000)

setTimeout(() => {
  daemon.close().then(() => process.exit(0))
}, 240000)
