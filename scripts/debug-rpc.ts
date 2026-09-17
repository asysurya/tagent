/** Debug RPC: connect → hello → log every step with per-step timeout */
import { io } from 'socket.io-client'

const port = process.argv[2] ?? '4020'
const sockPath = process.argv[3] ?? '/'
const socket = io(`http://localhost:${port}`, { path: sockPath, transports: ['websocket', 'polling'] })

const stepTimeout = (ms: number, label: string) =>
  new Promise<never>((_, r) => setTimeout(() => r(new Error(`STEP TIMEOUT: ${label}`)), ms))

async function main() {
  console.log('[debug] connecting…')
  await Promise.race([
    new Promise<void>((r, j) => {
      socket.on('connect', () => { console.log('[debug] connected'); r() })
      socket.on('connect_error', (e: any) => j(new Error('connect_error: ' + e?.message)))
    }),
    stepTimeout(8000, 'connect'),
  ])

  const hello = await Promise.race([
    new Promise<any>((resolve) => socket.emit('hello', (resp: any) => resolve(resp))),
    stepTimeout(10000, 'hello'),
  ])
  console.log('[debug] hello keys:', Object.keys(hello ?? {}))
  console.log('[debug] server:', hello?.server, '| workspace:', hello?.workspace?.name)
  console.log('[debug] providers:', hello?.config?.providers?.length)
  console.log('[debug] skills:', hello?.skills?.length)
  console.log('[debug] tools:', hello?.tools?.length)
  console.log('[debug] sessions:', hello?.sessions?.length)
  console.log('[debug] memory facts:', hello?.memory?.facts?.length)

  const tree = await Promise.race([
    new Promise<any>((resolve) => socket.emit('files:list', {}, (r: any) => resolve(r))),
    stepTimeout(8000, 'files:list'),
  ])
  console.log('[debug] files:list →', JSON.stringify(tree).slice(0, 200))

  console.log('\n[debug] ALL OK')
  socket.disconnect()
  process.exit(0)
}

main().catch((e) => { console.error('[debug] FAILED:', e?.message ?? e); socket.disconnect(); process.exit(1) })
