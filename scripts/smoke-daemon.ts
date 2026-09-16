/**
 * Smoke test: connect to the Tagent daemon and run a real agent turn.
 * Usage: bun scripts/smoke-daemon.ts
 */
import { io } from 'socket.io-client'

const socket = io('http://localhost:3001', { path: '/', transports: ['websocket'] })

const timeout = (ms: number) => new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))

async function main() {
  console.log('connecting…')
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', resolve)
    socket.on('connect_error', reject)
  }).catch((e) => { throw e })
  console.log('✓ connected')

  const hello = await new Promise<any>((resolve) => socket.emit('hello', resolve))
  console.log('✓ hello →', JSON.stringify({
    server: hello.server,
    workspace: hello.workspace?.name,
    providers: hello.config?.providers?.map((p: any) => `${p.id}${p.hasKey ? '(key)' : ''}`),
    skills: hello.skills?.map((s: any) => s.name),
    tools: hello.tools?.map((t: any) => t.name),
  }, null, 1))

  const events: string[] = []
  socket.on('agent:status', (d) => events.push(`status:${d.phase}${d.detail ? `(${d.detail})` : ''}`))
  socket.on('message:new', (d) => events.push(`msg:${d.message?.role}:${String(d.message?.content ?? '').slice(0, 60).replace(/\n/g, ' ')}`))
  socket.on('tool:start', (d) => events.push(`tool>${d.call?.tool}`))
  socket.on('tool:end', (d) => events.push(`tool<${d.call?.tool}:${d.call?.status}`))
  socket.on('permission:request', (req) => {
    console.log('  ⚠ permission request:', req.tool, JSON.stringify(req.input).slice(0, 120))
    socket.emit('permission:respond', { requestId: req.id, approved: true, remember: 'once' })
  })
  socket.on('todos:update', (d) => events.push(`todos:${d.todos?.length}`))
  socket.on('files:changed', (d) => events.push(`files:${d.paths?.join(',')}`))
  socket.on('notify', (d) => events.push(`notify[${d.level}]:${d.message?.slice(0, 80)}`))

  console.log('\nsending chat…')
  const ack = await new Promise<boolean>((resolve) => socket.emit('chat:send', {
    text: 'Read README.md and app.js in the workspace, then fix BOTH bugs described in the README: (1) update the "N tasks left" counter in renderTasks(), (2) wire up the "Clear completed" button so it removes completed tasks. Keep the code style.',
    mode: 'build',
  }, (ok: boolean) => resolve(ok)))
  console.log('✓ chat ack:', ack)

  const done = await Promise.race([
    new Promise<any>((resolve) => socket.on('chat:done', resolve)),
    timeout(240_000),
  ])
  console.log('\n✓ chat done:', JSON.stringify(done?.summary))
  console.log('\nevent log:')
  for (const e of events) console.log(' ', e)

  // verify the fix landed
  const file = await new Promise<any>((resolve) => socket.emit('file:read', { path: 'app.js' }, resolve))
  const ok1 = /task-count/.test(file.content) && /(textContent\s*=|innerText)/.test(file.content)
  const ok2 = /clearBtn\.addEventListener/.test(file.content)
  console.log('\nfix check — counter:', ok1 ? '✓' : '✗', '| clear button:', ok2 ? '✓' : '✗')

  socket.disconnect()
  process.exit(ok1 && ok2 && done?.summary?.finished === 'complete' ? 0 : 1)
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e)
  process.exit(1)
})
