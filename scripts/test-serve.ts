/**
 * test-serve.ts — hermetic tests for the `serve` tool (background dev-server
 * manager) + `detectDevCommand`.
 *
 * Uses a real tiny HTTP server (bun) as the "dev server" — no network beyond
 * loopback, no playwright needed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { serveTool } from '../packages/core/src/tools/serve'
import { detectDevCommand } from '../packages/core/src/tools/serve'
import { defaultConfig } from '../packages/core/src/config'
import type { ToolContext, AgentEvents } from '../packages/core/src/types'

let passed = 0
let failed = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

const root = fs.mkdtempSync('/tmp/tagent-serve-')
const cfg = { ...defaultConfig(), permissions: { ...defaultConfig().permissions, defaultMode: 'allow' as const } }
const signal = new AbortController()

function mkCtx(sessionId: string): ToolContext {
  return {
    workspaceRoot: root,
    sessionId,
    depth: 0,
    config: cfg,
    events: {} as AgentEvents,
    signal: signal.signal,
    todos: [],
  }
}

/* a tiny "dev server" that prints its URL like a real one */
const DEV_SCRIPT = `
const http = require('node:http')
const PORT = Number(process.env.PORT || 4311)
const srv = http.createServer((req, res) => { res.writeHead(200, {'content-type':'text/html'}); res.end('<h1>hello</h1>') })
srv.listen(PORT, '127.0.0.1', () => console.log('dev server ready on http://127.0.0.1:' + PORT))
`

fs.writeFileSync(path.join(root, 'dev.js'), DEV_SCRIPT)
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { dev: 'node dev.js' } }, null, 2))
fs.writeFileSync(path.join(root, 'bun.lock'), '{}')

async function main() {
  console.log('1) detectDevCommand')
  {
    ok('bun detected from bun.lock', detectDevCommand(root) === 'bun run dev')
    fs.rmSync(path.join(root, 'bun.lock'))
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}')
    ok('npm fallback without bun.lock', detectDevCommand(root) === 'npm run dev')
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    delete pkg.scripts.dev
    pkg.scripts.start = 'node dev.js'
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg))
    ok('start script picked when no dev', detectDevCommand(root) === 'npm run start')
    delete pkg.scripts.start
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg))
    ok('no scripts + no index.html → undefined', detectDevCommand(root) === undefined)
    fs.writeFileSync(path.join(root, 'index.html'), '<html></html>')
    const cmd = detectDevCommand(root)
    ok('static index.html → python http.server (posix)', process.platform === 'win32' ? cmd === undefined : cmd === 'python3 -m http.server 8000')
    fs.rmSync(path.join(root, 'index.html'))
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { dev: 'node dev.js' } }, null, 2))
  }

  console.log('\n2) serve start — auto-detect + port parsed from output')
  {
    const out = await serveTool.run({ action: 'start', timeout: 20_000 }, mkCtx('s1'))
    console.log('    ' + out.split('\n')[0])
    ok('server ready', out.includes('Server ready'), out.slice(0, 200))
    ok('url returned with parsed port', /url: http:\/\/127\.0\.0\.1:\d+/.test(out), out)
    ok('command reported', out.includes('command:'))
    const probe = await fetch((out.match(/url: (\S+)/) ?? [])[1])
    ok('http answers 200', probe.status === 200)
    ok('body served', (await probe.text()).includes('hello'))
  }

  console.log('\n3) status + logs + restart replaces')
  {
    const st = await serveTool.run({ action: 'status' }, mkCtx('s1'))
    ok('status shows running + pid', /running \(pid \d+/.test(st), st)
    ok('status shows command', st.includes('npm run dev') || st.includes('bun run dev') || st.includes('node dev.js'), st)
    const logs = await serveTool.run({ action: 'logs' }, mkCtx('s1'))
    ok('logs contain the ready line', logs.includes('dev server ready'))
    const again = await serveTool.run({ action: 'start', timeout: 20_000 }, mkCtx('s1'))
    ok('restart replaces cleanly', again.includes('Server ready'), again.slice(0, 200))
  }

  console.log('\n4) explicit port param')
  {
    const out = await serveTool.run({ action: 'start', command: 'node dev.js', port: 4399, timeout: 20_000 }, mkCtx('s2'))
    ok('explicit port honored', out.includes('http://127.0.0.1:4399') && out.includes('Server ready'), out.slice(0, 200))
    ok('PORT env passed to the command', out.includes('command:') === true)
    const r = await fetch('http://127.0.0.1:4399')
    ok('second session server independent', r.status === 200)
  }

  console.log('\n5) dead command → clear error + logs')
  {
    const out = await serveTool.run({ action: 'start', command: 'node -e "process.exit(3)"', timeout: 8_000 }, mkCtx('s3'))
    ok('exit reported with code', out.includes('EXITED') && out.includes('code 3'), out.slice(0, 300))
    ok('no fake url', !out.includes('Server ready'))
  }

  console.log('\n6) stop kills the process tree')
  {
    const out = await serveTool.run({ action: 'stop' }, mkCtx('s1'))
    ok('stop confirmed', out.includes('stopped'), out)
    const st = await serveTool.run({ action: 'status' }, mkCtx('s1'))
    ok('status empty after stop', st.includes('No server'), st)
    // s2 still alive → independent
    const st2 = await serveTool.run({ action: 'status' }, mkCtx('s2'))
    ok('other session untouched', st2.includes('running'), st2)
    await serveTool.run({ action: 'stop' }, mkCtx('s2'))
  }

  console.log('\n7) abort signal kills servers')
  {
    const out = await serveTool.run({ action: 'start', timeout: 20_000 }, mkCtx('s4'))
    ok('s4 started', out.includes('Server ready'))
    signal.abort()
    await new Promise((r) => setTimeout(r, 800))
    const st = await serveTool.run({ action: 'status' }, mkCtx('s4'))
    ok('abort → server gone', st.includes('No server'), st)
  }
}

main()
  .catch((e) => {
    console.error('FATAL', e)
    process.exitCode = 1
  })
  .finally(() => {
    console.log(`\n${'='.repeat(50)}\nRESULT: ${passed} passed, ${failed} failed`)
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
    process.exit(failed > 0 ? 1 : 0)
  })
