/**
 * Test suite — smart caching + economical loop (v0.8.0 "token economist").
 *
 * Run: bun scripts/test-cache.ts
 * Covers:
 *   1. FileStateCache     — fresh / changed / new + persistence across instances
 *   2. read_file          — cached "UNCHANGED" stub + changed detection + force
 *   3. read_files         — batch reads, one call for N files
 *   4. write_file/edit    — cache invalidation
 *   5. task fast-path     — "read X" prompts served without a subagent
 *   6. TTL web cache      — set/get/expire
 *   7. credentials store  — set/get/mask/delete
 *   8. AgentLoop          — @path mention attachment + usage accumulation
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const m = await import('../packages/core/src/index.ts')
const {
  AgentLoop, PermissionManager, ALL_TOOLS,
  fileStateFor, cacheStats, resetCacheStats,
  setCredential, getCredential, deleteCredential, listCredentialsMasked,
  webCacheSet, webCacheGet,
  defaultConfig, GLOBAL_DIR,
} = m as any

let passed = 0
let failed = 0
function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed++
    console.log(`  ✔ ${name}`)
  } else {
    failed++
    console.log(`  ✘ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

const tool = (name: string) => ALL_TOOLS.find((t: any) => t.name === name)

// ---------------------------------------------------------------- setup
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-cache-'))
const cfg = defaultConfig()
const ctx: any = {
  workspaceRoot: root,
  sessionId: 'test-session',
  depth: 0,
  config: cfg,
  events: {},
  todos: [],
}
fs.writeFileSync(path.join(root, 'a.txt'), 'alpha content\n'.repeat(10))
fs.writeFileSync(path.join(root, 'b.md'), '# bravo\nsome markdown\n')
fs.writeFileSync(path.join(root, 'c.json'), '{"n":1}\n')
fs.writeFileSync(path.join(root, 'big.log'), 'x'.repeat(150_000))

console.log('\n1) FileStateCache — fresh / changed / new')
{
  const st = fileStateFor(root)
  const a = path.join(root, 'a.txt')
  ok('unknown file is "new"', st.check(a) === 'new')
  st.record(a)
  ok('recorded file is "fresh"', st.check(a) === 'fresh')
  fs.writeFileSync(a, 'changed\n')
  ok('modified file is "changed"', st.check(a) === 'changed')
  // persistence: a brand-new instance must hydrate from file-state.json
  const again = fileStateFor(root)
  ok('external edit detected across instances', again.check(a) === 'changed')
  fs.rmSync(a, { force: true })
  ok('deleted file is "new" again', again.check(a) === 'new')
}

console.log('\n2) read_file — smart cache')
{
  resetCacheStats()
  fs.writeFileSync(path.join(root, 'a.txt'), 'alpha content v2\n'.repeat(5))
  const r1 = await tool('read_file').run({ path: 'a.txt' }, ctx)
  ok('first read serves content', r1.includes('alpha content v2'))
  const r2 = await tool('read_file').run({ path: 'a.txt' }, ctx)
  ok('second read → UNCHANGED stub', r2.includes('[cached]') && r2.includes('UNCHANGED'))
  ok('stub is tiny', r2.length < 500, `len=${r2.length}`)
  fs.writeFileSync(path.join(root, 'a.txt'), 'alpha content v3\n')
  const r3 = await tool('read_file').run({ path: 'a.txt' }, ctx)
  ok('changed file re-served with note', r3.includes('changed since your last read') && r3.includes('v3'))
  const r4 = await tool('read_file').run({ path: 'a.txt', force: true }, ctx)
  ok('force bypasses the cache', r4.includes('v3') && !r4.includes('UNCHANGED'))
  const stats = cacheStats()
  ok('stats: 1 hit + misses counted', stats.fileHits >= 1 && stats.fileMisses >= 2, JSON.stringify(stats))
  const r5 = await tool('read_file').run({ path: 'nope.txt' }, ctx)
  ok('missing file → friendly error', r5.startsWith('Error: file not found'))
}

console.log('\n3) read_files — batch (one call, N files)')
{
  const out = await tool('read_files').run({ paths: ['b.md', 'c.json'] }, ctx)
  ok('both files served in one call', out.includes('# bravo') && out.includes('"n":1'))
  ok('sections separated', out.includes('===== b.md =====') && out.includes('===== c.json ====='))
  const out2 = await tool('read_files').run({ paths: ['b.md', 'c.json'] }, ctx)
  ok('repeat batch → both UNCHANGED stubs', out2.includes('UNCHANGED'))
  ok('repeat batch stays small', out2.length < 900, `len=${out2.length}`)
  const out3 = await tool('read_files').run({ paths: ['big.log'] }, ctx)
  ok('single path in array still works', out3.includes('xxxxx'))
}

console.log('\n4) write_file / edit_file — invalidation')
{
  await tool('read_files').run({ paths: ['b.md'] }, ctx)
  await tool('write_file').run({ path: 'b.md', content: '# bravo v2\n' }, ctx)
  const r = await tool('read_file').run({ path: 'b.md' }, ctx)
  ok('write_file invalidates cache', r.includes('v2') && !r.includes('UNCHANGED'))
  await tool('edit_file').run({ path: 'b.md', old: 'v2', new: 'v3' }, ctx)
  const r2 = await tool('read_file').run({ path: 'b.md' }, ctx)
  ok('edit_file invalidates cache', r2.includes('v3'))
}

console.log('\n5) task fast-path — direct reads, no subagent')
{
  let spawned = 0
  const ctx2: any = {
    ...ctx,
    spawnSubagent: async () => {
      spawned++
      return 'SUBAGENT RAN'
    },
  }
  const fast = await tool('task').run(
    { description: 'read config', prompt: 'read a.txt and b.md' },
    ctx2,
  )
  ok('"read X and Y" served directly', fast.includes('[fast-path]') && fast.includes('# bravo v3'))
  ok('no subagent spawned', spawned === 0)
  const fast2 = await tool('task').run(
    { description: 'cat file', prompt: 'cat b.md' },
    ctx2,
  )
  ok('"cat X" also fast-pathed', fast2.includes('[fast-path]'))
  const missing = await tool('task').run(
    { description: 'read', prompt: 'read package.json' },
    ctx2,
  )
  ok('nonexistent path → real subagent (better error)', spawned === 1 && !missing.includes('[fast-path]'))
  const normal = await tool('task').run(
    { description: 'analyze', prompt: 'read b.md and explain what the markdown means in detail' },
    ctx2,
  )
  ok('prose prompt still goes to the subagent', spawned === 2 && !normal.includes('[fast-path]'))
}

console.log('\n6) TTL web cache')
{
  webCacheSet('fetch:text:https://example.com', 'EXAMPLE BODY')
  ok('hit inside TTL', webCacheGet('fetch:text:https://example.com', 60_000) === 'EXAMPLE BODY')
  webCacheSet('fetch:text:https://old.com', 'OLD', )
  // simulate expiry: negative TTL
  ok('expired entry returns undefined', webCacheGet('fetch:text:https://old.com', -1) === undefined)
}

console.log('\n7) credentials store')
{
  setCredential('github', 'ghp_testtoken1234567890')
  ok('roundtrip', getCredential('github') === 'ghp_testtoken1234567890')
  const masked = listCredentialsMasked()
  ok('masked listing hides the secret', !JSON.stringify(masked).includes('testtoken1234567890') && !!masked.github)
  const file = path.join(GLOBAL_DIR, 'credentials.json')
  ok('file exists', fs.existsSync(file))
  if (process.platform !== 'win32') {
    const mode = (fs.statSync(file).mode & 0o777).toString(8)
    ok('file mode 600', mode === '600', `mode=${mode}`)
  }
  deleteCredential('github')
  ok('delete works', !getCredential('github'))
}

console.log('\n8) AgentLoop — @path mention + usage accumulation')
{
  const fakeProvider = {
    id: 'fake', label: 'fake', supportsNativeTools: false, models: [],
    async complete() { return '' },
    async completeStream(req: any) {
      // echo the LAST user message so we can inspect what the loop rendered
      const last = req.messages.filter((x: any) => x.role === 'user').pop()
      ;(fakeProvider as any).lastUserMessage = last?.content ?? ''
      return { text: 'done, nothing to do', usage: { input: 100, output: 20, cacheRead: 50 } }
    },
  }
  const session = {
    id: 's1', workspaceId: root, title: 't', model: 'fake', mode: 'build',
    createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, messages: [], todos: [],
  }
  let usageEvents = 0
  const loop = new AgentLoop({
    session, provider: fakeProvider as any, model: 'fake',
    events: { onUsage: () => usageEvents++ } as any,
    permissions: new PermissionManager(cfg),
    config: cfg, mode: 'build',
  })
  const summary = await loop.run('check @b.md for me please')
  const seen = (fakeProvider as any).lastUserMessage as string
  ok('@mention expanded to attachment', seen.includes('(attached below)') && seen.includes('# bravo v3'))
  ok('attachment recorded in file-state (later read = UNCHANGED)', true)
  const after = await tool('read_file').run({ path: 'b.md' }, ctx)
  ok('attached file reads as cached afterwards', after.includes('UNCHANGED'))
  ok('usage accumulated in summary', summary.usage?.input === 100 && summary.usage?.output === 20 && summary.usage?.cacheRead === 50, JSON.stringify(summary.usage))
  ok('onUsage fired', usageEvents === 1)
}

console.log('\n9) Context compaction — old tool results become stubs')
{
  // build a session with many large tool-result messages, render via a loop run
  const session = {
    id: 's2', workspaceId: root, title: 't', model: 'fake', mode: 'build',
    createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0,
    todos: [],
    messages: [
      { id: 'u0', role: 'user', content: 'start', createdAt: Date.now() },
      ...Array.from({ length: 12 }, (_, i) => ([
        { id: 'a' + i, role: 'assistant', content: 'step ' + i, createdAt: Date.now() },
        { id: 't' + i, role: 'user', content: 'TOOL RESULTS:\n\n### read_file (done)\n' + 'x'.repeat(20_000), createdAt: Date.now(), meta: { toolResults: true } },
      ])).flat(),
    ],
  }
  const fakeProvider = {
    id: 'fake', label: 'fake', supportsNativeTools: false, models: [],
    async complete() { return '' },
    async completeStream(req: any) {
      const msgs = req.messages.map((x: any) => x.content).join('')
      ;(fakeProvider as any).sawCompact = msgs.includes('[older tool results compacted')
      ;(fakeProvider as any).sawRaw = msgs.includes('x'.repeat(500))
      return { text: 'ok done' }
    },
  }
  const loop = new AgentLoop({
    session, provider: fakeProvider as any, model: 'fake',
    events: {} as any, permissions: new PermissionManager(cfg), config: cfg, mode: 'build',
  })
  await loop.run('finish up')
  ok('old tool results compacted', (fakeProvider as any).sawCompact === true)
  ok('newest results stay full', (fakeProvider as any).sawRaw === true)
}

/* ------------------------------------------------------------------ */
console.log(`\n${'='.repeat(50)}\nRESULT: ${passed} passed, ${failed} failed\n`)
try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(failed > 0 ? 1 : 0)
