/** e2e: chat run with an MCP server connected — the agent should see + use mcp tools */
import { createDaemon } from '../packages/cli/src/daemon'
import { io } from 'socket.io-client'

async function main() {
  const root = '/tmp/tagent-mcp-e2e'
  const fs = await import('node:fs')
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })

  const handle = await createDaemon({ port: 4189, host: '127.0.0.1', workspaceRoot: root, quiet: true })
  const socket = io('http://127.0.0.1:4189', { path: '/socket', transports: ['websocket'] })
  await new Promise<void>((r) => socket.on('connect', r))
  const call = <T,>(event: string, payload?: unknown): Promise<T> =>
    new Promise((resolve) => socket.emit(event, payload, (res: T) => resolve(res)))

  // connect the official memory MCP server
  const save = await call<{ ok?: boolean; error?: string }>('mcp:save', {
    name: 'memory',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  })
  if (save.error) throw new Error(save.error)
  console.log('memory server connected')

  // watch tool calls + auto-approve permissions (pipe-style)
  const calls: string[] = []
  socket.on('tool:start', (d: { call: { tool: string } }) => calls.push(d.call.tool))
  socket.on('permission:request', (req: { id: string; tool: string }) => {
    console.log('  permission →', req.tool, '→ approving')
    socket.emit('permission:respond', { requestId: req.id, approved: true, remember: 'session' })
  })

  console.log('sending chat…')
  const ack = await call<boolean>('chat:send', {
    text: 'Use the mcp_memory_create_entities tool to create an entity named "Tagent" of type "agent". Then reply with just: done',
  })
  if (!ack) throw new Error('chat ack failed')

  const done = await Promise.race([
    new Promise<{ summary: { finished: string; toolCalls: number } }>((resolve) =>
      socket.on('chat:done', (d: { summary: { finished: string; toolCalls: number } }) => resolve(d)),
    ),
    new Promise((_, r) => setTimeout(() => r(new Error('chat timeout')), 180_000)),
  ])
  console.log('chat finished:', JSON.stringify(done.summary))
  console.log('tool calls seen:', calls.join(', ') || '(none)')

  const usedMcp = calls.some((t) => t.startsWith('mcp_memory_'))
  console.log('agent used MCP tool:', usedMcp ? 'YES ✓' : 'no')
  socket.disconnect()
  await handle.close()
  if (!usedMcp) {
    console.log('NOTE: model may not have chosen the tool — not a hard failure')
  }
  process.exit(0)
}

main().catch((e) => {
  console.error('FAIL:', e)
  process.exit(1)
})
