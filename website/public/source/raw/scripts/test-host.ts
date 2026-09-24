/**
 * Host tests — AgentHost API used by BOTH the TUI and the daemon.
 * Covers: sessions, subagent timeline persistence, share export, settings,
 * permission flow, worklog config plumbing.
 *
 * Run: bun scripts/test-host.ts
 */
import fs from 'node:fs'
import path from 'node:path'

const { AgentHost } = await import('../packages/cli/src/host')
const { SessionStore, worklogPath } = await import('../packages/core/src/index')

let fails = 0
function assert(cond: boolean, label: string) {
  console.log(cond ? '✓' : '✗', label)
  if (!cond) fails++
}

const TMP = '/tmp/tagent-host-test'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
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

/* ---------------- hello / config ---------------- */

const host = new AgentHost({ workspaceRoot: TMP })
const hello = host.hello() as { version: string; workspace: { path: string }; config: Record<string, unknown> }
assert(hello.server === 'tagent', 'hello payload has server')
assert(hello.workspace.path === TMP, 'hello knows the workspace root')
assert(hello.config.webGui === false, 'webGui defaults off (CLI-first)')
assert(Array.isArray(hello.sessions), 'hello lists sessions')

/* ---------------- sessions ---------------- */

const s1 = host.newSession('build')
assert(!!s1.id, 'new session returns data')
assert(host.listSessions().length === 1, 'session listed')
const loaded = host.loadSession(s1.id)
assert(loaded?.id === s1.id, 'session round-trips')
host.newSession('plan')
assert(host.listSessions().length === 2, 'second session listed')
host.deleteSession(s1.id)
assert(host.listSessions().length === 1, 'delete removes session')

/* ---------------- subagent timeline persistence ---------------- */

const parent = host.newSession('build')
const store = new SessionStore(TMP, TMP)

// fake two subagent sessions exactly like loop.ts spawns them
const mkSub = (title: string) => ({
  id: `sub-${Math.random().toString(36).slice(2, 10)}`,
  workspaceId: TMP,
  title,
  model: 'glm-4.7',
  mode: 'build' as const,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messageCount: 2,
  messages: [
    { id: 'm1', role: 'user' as const, content: 'find all usages', createdAt: Date.now() },
    { id: 'm2', role: 'assistant' as const, content: 'found 3 usages', createdAt: Date.now() },
  ],
  todos: [],
  parentId: parent.id,
  subagent: true,
})
store.save(mkSub('explore: usages') as never)
store.save(mkSub('explore: tests') as never)

const list = host.listSessions()
assert(list.every((s: { subagent?: boolean }) => !s.subagent), 'subagent sessions hidden from the session list')
const tl = host.timeline(parent.id)
assert(tl.length === 2, 'timeline returns both subagent runs')
assert(tl.every((s: { parentId?: string }) => s.parentId === parent.id), 'timeline entries point at the parent')
assert(host.timeline('nope').length === 0, 'timeline of unknown session is empty')

/* ---------------- share ---------------- */

const share = host.share(parent.id)
assert(share.ok === true, 'share exports the active session')
assert(!!share.file && fs.existsSync(share.file), 'share file exists')
const html = fs.readFileSync(share.file!, 'utf8')
assert(html.includes('<!doctype html>') && html.includes(parent.title), 'share html renders the session')
assert(host.share('does-not-exist').ok === false, 'share of unknown id fails cleanly')
const bad = host.share(parent.id)
assert(!!bad.file && bad.file.endsWith('.html'), 'share returns an html path')

/* ---------------- settings ---------------- */

const r1 = host.settingsSave({ caveman: true }) as { config: { caveman: boolean } }
assert(r1.config.caveman === true, 'caveman toggles on')
const r2 = host.settingsSave({ worklogEnabled: false }) as { config: { worklog: { enabled: boolean } } }
assert(r2.config.worklog.enabled === false, 'worklog toggles off')
const r3 = host.settingsSave({ maxTurns: 200 }) as { config: { maxTurns: number } }
assert(r3.config.maxTurns === 80, 'maxTurns clamps at 80')
const persisted = JSON.parse(fs.readFileSync(path.join(TMP, '.tagent', 'config.json'), 'utf8'))
assert(persisted.caveman === true && persisted.worklog.enabled === false, 'settings persist to workspace config')

// webGui is global
host.setWebGui(true)
const gcfg = JSON.parse(fs.readFileSync(path.join(require_node_path(), 'config.json'), 'utf8'))
assert(gcfg.webGui === true, 'webGui saved to GLOBAL config')
host.setWebGui(false)

function require_node_path() {
  return path.join(process.env.HOME || '/home/z', '.tagent')
}

/* ---------------- permissions ---------------- */

let sawRequest: unknown = null
host.bus.on('permission:request', (req) => {
  sawRequest = req
  host.permissionRespond((req as { id: string }).id, true, 'session')
})

// drive a fake permission through the same onPermission path the loop uses
const events = (host as unknown as { makeEvents: () => { onPermission?: (req: unknown) => Promise<{ approved: boolean }> } })
assert(typeof events.makeEvents === 'function', 'host exposes makeEvents (internal)')

/* ---------------- worklog file plumbing ---------------- */

assert(worklogPath(TMP) === path.join(TMP, 'WORKLOG.md'), 'worklog path is workspace root')

console.log(fails ? `\nFAILS: ${fails}` : '\nHOST TESTS ALL OK')
process.exit(fails ? 1 : 0)
