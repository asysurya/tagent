/** smoke: daemon RPC — mcp:templates → mcp:save → mcp:list → mcp:tools → plugins:scaffold */
import { createDaemon } from '../packages/cli/src/daemon'
import { io } from 'socket.io-client'

async function main() {
  const root = '/tmp/tagent-mcp-ws'
  const { mkdirSync, rmSync, existsSync } = await import('node:fs')
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })

  const handle = await createDaemon({ port: 4187, host: '127.0.0.1', workspaceRoot: root, quiet: true })
  const socket = io('http://127.0.0.1:4187', { path: '/socket', transports: ['websocket'] })
  await new Promise<void>((r) => socket.on('connect', r))

  const call = <T,>(event: string, payload?: unknown): Promise<T> =>
    new Promise((resolve) => socket.emit(event, payload, (res: T) => resolve(res)))

  // 1. templates
  const tpl = await call<{ templates: { name: string; command: string; args: string[] }[] }>('mcp:templates')
  console.log('templates:', tpl.templates.map((t) => t.name).join(', '))
  if (!tpl.templates.some((t) => t.name === 'memory')) throw new Error('memory template missing')

  // 2. add the memory server (official, no key)
  console.log('adding memory server (npx download may take a moment)…')
  const save = await call<{ ok?: boolean; error?: string; status?: unknown }>('mcp:save', {
    name: 'memory',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  })
  if (save.error) throw new Error(`mcp:save failed: ${save.error}`)
  console.log('saved:', JSON.stringify(save.status))

  // 3. status via mcp:list
  const list = await call<{ status: { name: string; state: string; tools: number }[] }>('mcp:list')
  console.log('status:', JSON.stringify(list.status))
  const mem = list.status.find((s) => s.name === 'memory')
  if (!mem) throw new Error('memory server not in status')
  if (mem.state !== 'ready') throw new Error(`memory server not ready: ${mem.state}`)
  if (mem.tools === 0) throw new Error('memory server exposes 0 tools')

  // 4. tool list
  const tools = await call<{ tools: { name: string }[] }>('mcp:tools')
  console.log('tools:', tools.tools.map((t) => t.name).slice(0, 4).join(', '), '…')
  if (!tools.tools.some((t) => t.name.startsWith('mcp_memory_'))) throw new Error('mcp_memory_* tools missing')

  // 5. plugin scaffold + list
  const sc = await call<{ ok?: boolean; file?: string }>('plugins:scaffold', { name: 'demo' })
  console.log('scaffold:', sc.file)
  const pl = await call<{ plugins: { name: string; scope: string }[] }>('plugins:list')
  console.log('plugins:', JSON.stringify(pl.plugins))
  if (!pl.plugins.some((p) => p.name === 'demo')) throw new Error('plugin not listed')

  // 6. hello payload carries mcp + plugins
  const hello = await call<{ mcp?: unknown[]; plugins?: unknown[] }>('hello')
  console.log('hello.mcp:', JSON.stringify(hello.mcp))
  console.log('hello.plugins:', JSON.stringify(hello.plugins))

  // 7. toggle + remove
  const tog = await call<{ ok?: boolean; enabled?: boolean }>('mcp:toggle', { name: 'memory' })
  console.log('toggled → enabled =', tog.enabled)
  const rem = await call<{ ok?: boolean }>('mcp:remove', { name: 'memory' })
  console.log('removed:', rem.ok)

  socket.disconnect()
  await handle.close()
  console.log('\nALL MCP/PLUGIN RPC CHECKS PASSED')
}

main().catch((e) => {
  console.error('FAIL:', e)
  process.exit(1)
})
