/** Test: workspace switch RPC — daemon rebinds to a new root without restart. */
import { io } from 'socket.io-client'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.argv[2] ?? 4078)
const REPO = path.resolve(import.meta.dir, '..')

const A = '/tmp/tagent-ws-a'
const B = '/tmp/tagent-ws-b'
for (const ws of [A, B]) {
  fs.rmSync(ws, { recursive: true, force: true })
  fs.mkdirSync(ws, { recursive: true })
}
fs.writeFileSync(path.join(A, 'from-a.txt'), 'workspace A')
fs.writeFileSync(path.join(B, 'from-b.txt'), 'workspace B')

const daemon = spawn('bun', ['packages/cli/src/index.ts', 'web', A, '--port', String(PORT), '--no-open'], {
  cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})

let fails = 0
const ok = (c: boolean, label: string) => { console.log(c ? '✓' : '✗', label); if (!c) fails++ }

try {
  // wait health
  const t0 = Date.now()
  while (Date.now() - t0 < 30000) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1000) })
      if (r.ok) break
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 400))
  }

  const socket = io(`http://127.0.0.1:${PORT}`, { path: '/socket', transports: ['websocket'] })
  await new Promise<void>((r, j) => { socket.on('connect', r); socket.on('connect_error', (e: Error) => j(e)); setTimeout(() => j(new Error('connect timeout')), 10000) })

  const call = <T,>(event: string, payload: unknown, ms = 15000): Promise<T> =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(undefined as T), ms)
      socket.emit(event, payload, (res: T) => { clearTimeout(t); resolve(res) })
    })

  // 1. hello from A
  const hello1 = await call<any>('hello', {})
  ok(hello1?.workspace?.name === 'tagent-ws-a', 'starts on workspace A')
  ok(Array.isArray(hello1?.recentWorkspaces) && hello1.recentWorkspaces.length >= 1, 'hello includes recent workspaces')

  // 2. switch to B
  const sw = await call<any>('workspace:switch', { path: B })
  ok(sw?.ok === true, 'switch accepted')
  ok(sw?.workspace?.workspace?.name === 'tagent-ws-b', 'switch returns new world (B)')

  // 3. workspace:changed event was broadcast — verify via list + files
  const tree = await call<any>('files:list', { path: '.' })
  const names = JSON.stringify(tree)
  ok(names.includes('from-b.txt') && !names.includes('from-a.txt'), 'file tree now shows B files')

  // 4. recent list has both
  const wl = await call<any>('workspace:list', {})
  ok(wl?.recent?.some((w: any) => w.path === A) && wl.recent.some((w: any) => w.path === B), 'recent workspaces tracked')

  // 5. switch to a non-existent dir fails cleanly
  const bad = await call<any>('workspace:switch', { path: '/tmp/tagent-nope-xyz' })
  ok(!!bad?.error, 'switch to missing dir rejected')

  // 6. sessions are isolated per workspace
  await call('session:new', { mode: 'build' })
  const hello2 = await call<any>('hello', {})
  ok(hello2?.workspace?.name === 'tagent-ws-b', 'still on B after session:new')

  socket.disconnect()
  console.log(fails ? `\nFAILS: ${fails}` : '\nWORKSPACE SWITCH ALL OK')
  process.exit(fails ? 1 : 0)
} finally {
  try { process.kill(-daemon.pid!, 'SIGKILL') } catch { daemon.kill('SIGKILL') }
}
