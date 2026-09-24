/**
 * Session rename tests — SessionStore.rename (persistence, trimming, clamp,
 * empty-title fallback, unknown id) + the AgentHost.renameSession wiring
 * (active-session swap, session:list / session:active events, non-active
 * sessions untouched).
 *
 * Run: bun scripts/test-session-rename.ts
 */
import fs from 'node:fs'
import path from 'node:path'

const { SessionStore } = await import('../packages/core/src/index')
const { AgentHost } = await import('../packages/cli/src/host')

let fails = 0
function assert(cond: boolean, label: string) {
  console.log(cond ? '✓' : '✗', label)
  if (!cond) fails++
}

/* ---------------- SessionStore.rename ---------------- */

const TMP = '/tmp/tagent-rename-test'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

const store = new SessionStore(TMP, 'ws-rename')

const s = store.create('Original title', 'glm-4.7', 'build')
s.messages.push({ id: 'm1', role: 'user', content: 'hi', createdAt: Date.now() })
store.save(s)

const r = store.rename(s.id, 'Renamed title')
assert(r?.title === 'Renamed title', 'rename returns the renamed session')
assert(store.load(s.id)?.title === 'Renamed title', 'rename persists to disk')
assert(store.list().find((x) => x.id === s.id)?.title === 'Renamed title', 'renamed title visible in list()')
assert(store.load(s.id)?.messages.length === 1, 'messages survive the rename')

const r2 = store.rename(s.id, '  lots   of \n\t spaces  ')
assert(r2?.title === 'lots of spaces', 'whitespace collapsed + trimmed')

const r3 = store.rename(s.id, 'x'.repeat(200))
assert(r3?.title.length === 80, 'title clamped to 80 chars')

const r4 = store.rename(s.id, '   ')
assert(r4?.title === 'Untitled', 'empty title falls back to "Untitled"')
assert(store.load(s.id)?.title === 'Untitled', 'fallback persisted')

assert(store.rename('does-not-exist', 'nope') === undefined, 'unknown id returns undefined')

const other = store.create('Other session', 'glm-4.7', 'plan')
store.rename(s.id, 'Only me changes')
assert(store.load(other.id)?.title === 'Other session', 'renaming one session leaves others untouched')

/* ---------------- AgentHost.renameSession ---------------- */

const TMP2 = '/tmp/tagent-rename-host-test'
fs.rmSync(TMP2, { recursive: true, force: true })
fs.mkdirSync(TMP2, { recursive: true })
fs.mkdirSync(path.join(TMP2, '.tagent'), { recursive: true })
fs.writeFileSync(path.join(TMP2, '.tagent', 'config.json'), JSON.stringify({
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

const host = new AgentHost({ workspaceRoot: TMP2 })
const a = host.newSession('build')
const b = host.newSession('build') // second session — now the active one

let listEvents = 0
const activeTitles: string[] = []
host.bus.on('session:list', () => listEvents++)
host.bus.on('session:active', (p: unknown) => activeTitles.push((p as { title: string }).title))

// rename the ACTIVE session (b)
const hr = host.renameSession(b.id, 'Via host')
assert(hr?.title === 'Via host', 'host.renameSession returns the renamed session')
assert(host.session?.id === b.id && host.session?.title === 'Via host', 'active session object swapped with renamed one')
assert(listEvents >= 1, 'session:list emitted on rename')
assert(activeTitles.includes('Via host'), 'session:active emitted for the renamed ACTIVE session')
assert(host.listSessions().find((x) => x.id === b.id)?.title === 'Via host', 'renamed title in host list')

// rename a NON-active session (a) — must not emit session:active
const beforeActive = activeTitles.length
const beforeList = listEvents
const nr = host.renameSession(a.id, 'Background rename')
assert(nr?.title === 'Background rename', 'non-active session renames too')
assert(listEvents === beforeList + 1, 'session:list emitted for non-active rename')
assert(activeTitles.length === beforeActive, 'session:active NOT emitted for non-active rename')
assert(host.session?.id === b.id, 'active session unchanged by non-active rename')

// unknown id
assert(host.renameSession('nope', 'x') === null, 'host.renameSession of unknown id → null')

console.log(fails ? `\nFAILS: ${fails}` : '\nSESSION RENAME TESTS ALL OK')
process.exit(fails ? 1 : 0)
