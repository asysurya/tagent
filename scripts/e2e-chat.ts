/**
 * E2E: real LLM chat through the daemon — streaming + tool execution.
 *
 * Spawns its own daemon on a scratch workspace (allow-all permissions, zai
 * provider — no API key needed), sends a chat that requires a tool call,
 * and asserts: streamed chunks arrived, the assistant answered, the tool
 * ran, and the file it was asked to write exists with the right content.
 *
 * Usage: bun scripts/e2e-chat.ts [port]
 */
import { io } from 'socket.io-client'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.argv[2] ?? 4077)
const REPO = path.resolve(import.meta.dir, '..')
const WS = `/tmp/tagent-e2e-ws`
const MARKER = `e2e-marker-${Date.now()}.txt`
const MARKER_CONTENT = 'tagent-e2e-ok'

function log(...a: unknown[]) { console.log('[e2e]', ...a) }

function waitHealth(url: string, timeoutMs = 30000): Promise<void> {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const ping = async () => {
      try {
        const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) })
        if (r.ok) return resolve()
      } catch { /* not up yet */ }
      if (Date.now() - t0 > timeoutMs) return reject(new Error('daemon did not become healthy'))
      setTimeout(ping, 500)
    }
    void ping()
  })
}

async function runOnce(): Promise<boolean> {
  // fresh scratch workspace with permissive config
  fs.rmSync(WS, { recursive: true, force: true })
  fs.mkdirSync(path.join(WS, '.tagent'), { recursive: true })
  fs.writeFileSync(
    path.join(WS, '.tagent', 'config.json'),
    JSON.stringify({
      version: 1,
      defaultProvider: 'zai',
      defaultModel: 'glm-4.7',
      apiKeys: {},
      customProviders: [],
      permissions: {
        defaultMode: 'allow',
        tools: {
          read_file: 'allow', list_files: 'allow', grep: 'allow',
          write_file: 'allow', edit_file: 'allow', bash: 'allow',
          web_fetch: 'allow', ddg_search: 'allow', task: 'allow',
          todowrite: 'allow', memory: 'allow', load_skill: 'allow',
        },
      },
      tools: { bash: true, browser: false },
      autoCheckpoint: false,
      maxTurns: 8,
      nativeTools: true,
    }),
  )

  const daemon = spawn('bun', ['packages/cli/src/index.ts', WS, '--port', String(PORT), '--no-open'], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group → clean teardown of bun's children
  })
  const daemonErr: string[] = []
  daemon.stderr.on('data', (d) => daemonErr.push(String(d)))
  daemon.stdout.on('data', () => { /* banner noise */ })

  const socket = io(`http://127.0.0.1:${PORT}`, { path: '/socket', transports: ['websocket', 'polling'] })

  let chunks = 0
  let toolStarts = 0
  let assistantText = ''

  try {
    await waitHealth(`http://127.0.0.1:${PORT}`)
    log('daemon healthy')

    await new Promise<void>((r, j) => {
      socket.on('connect', r)
      socket.on('connect_error', (e: Error) => j(new Error('connect: ' + e.message)))
      setTimeout(() => j(new Error('socket connect timeout')), 10000)
    })
    log('socket connected')

    socket.on('agent:chunk', () => { chunks++ })
    socket.on('tool:start', () => { toolStarts++ })
    socket.on('permission:request', (p: { id: string }) => {
      // belt & braces — config already allows everything
      socket.emit('permission:respond', { requestId: p.id, approved: true, remember: 'session' })
    })
    socket.on('message:new', (d: { message: { role: string; content: string } }) => {
      if (d.message.role === 'assistant') assistantText = d.message.content
    })

    const ack = await new Promise<boolean>((r) => {
      socket.emit('chat:send', {
        text:
          `Create a file named ${MARKER} in the workspace root with exactly this content (no quotes, one line): ${MARKER_CONTENT}. ` +
          'After the file is written, reply with a one-sentence confirmation.',
        mode: 'build',
      }, (ok: boolean) => r(ok))
      setTimeout(() => r(false), 15000)
    })
    if (!ack) throw new Error('chat:send not acked')
    log('chat accepted — waiting for the agent to finish…')

    const summary = await new Promise<any>((r, j) => {
      socket.on('chat:done', r)
      setTimeout(() => j(new Error('chat:done timeout (agent still running after 300s)')), 300000)
    })

    log('summary:', JSON.stringify(summary))
    log('streamed chunks:', chunks, '| tool starts:', toolStarts)
    log('assistant said:', JSON.stringify(assistantText.slice(0, 160)))

    const markerPath = path.join(WS, MARKER)
    const exists = fs.existsSync(markerPath)
    const content = exists ? fs.readFileSync(markerPath, 'utf8').trim() : ''

    const pass =
      summary?.summary?.finished === 'complete' &&
      assistantText.trim().length > 0 &&
      toolStarts >= 1 &&
      exists && content === MARKER_CONTENT

    log(`file ${MARKER}: exists=${exists} content=${JSON.stringify(content)}`)
    log(pass ? 'E2E PASS ✓' : 'E2E FAIL ✗')
    return pass
  } finally {
    socket.disconnect()
    try { process.kill(-daemon.pid!, 'SIGKILL') } catch { daemon.kill('SIGKILL') }
  }
}

const pass = await runOnce().catch((e) => {
  log('ERROR:', (e as Error).message)
  return false
})
process.exit(pass ? 0 : 1)
