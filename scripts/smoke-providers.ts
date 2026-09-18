/**
 * RPC smoke: daemon hello (provider catalog), providers:refresh, custom provider upsert/remove.
 * Usage: bun scripts/smoke-providers.ts
 */
import { io } from 'socket.io-client'

const URL = process.env.TAGENT_URL ?? 'http://localhost:4031'
const socket = io(URL, { path: '/socket', transports: ['websocket'] })
const call = <T,>(event: string, payload: unknown, ms = 30000) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} timeout`)), ms)
    socket.emit(event, payload, (r: T) => { clearTimeout(t); resolve(r) })
  })

const timeout = (ms: number) => new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))

async function main() {
  console.log('connecting to', URL, '…')
  await Promise.race([
    new Promise<void>((resolve) => socket.on('connect', resolve)),
    timeout(10000),
  ])
  console.log('✓ connected')

  const hello = await call<any>('hello', {})
  const providers = hello.config?.providers ?? []
  console.log('✓ hello → server:', hello.server, '· workspace:', hello.workspace?.name)
  console.log('  providers:', providers.length)
  for (const p of providers.slice(0, 8)) {
    console.log(`   - ${p.id} kind=${p.kind} needsKey=${p.needsKey} hasKey=${p.hasKey} models=${p.models?.length ?? 0} envVar=${p.envVar ?? '-'} custom=${p.custom ?? false}`)
  }

  // 1. custom provider upsert
  const save = await call<any>('settings:save', {
    customProvider: {
      id: 'rpc-test',
      label: 'RPC Test',
      baseUrl: 'https://example.com/v1',
      models: ['m1', 'm2'],
      kind: 'anthropic',
    },
  })
  const added = save.config?.providers?.find((p: any) => p.id === 'rpc-test')
  console.log('✓ custom provider upsert →', JSON.stringify({ kind: added?.kind, custom: added?.custom, models: added?.models?.map((m: any) => m.id) }))

  // 2. model select on custom provider
  const sel = await call<any>('settings:save', { defaultProvider: 'rpc-test', defaultModel: 'm2' })
  console.log('✓ set model →', sel.config?.defaultProvider, '/', sel.config?.defaultModel)

  // 3. providers:refresh (will fail all fetches — fine, must not throw)
  const refresh = await call<any>('providers:refresh', {}, 60000)
  console.log('✓ providers:refresh → updated:', refresh.updated?.length, '· failed:', refresh.failed?.length, '· ok:', refresh.ok)

  // 4. remove custom provider (defaults fall back)
  const rm = await call<any>('settings:save', { customProviderRemove: 'rpc-test' })
  const gone = !rm.config?.providers?.some((p: any) => p.id === 'rpc-test')
  console.log('✓ custom provider removed:', gone, '· default now:', rm.config?.defaultProvider, '/', rm.config?.defaultModel)

  socket.close()
  process.exit(0)
}

main().catch((e) => { console.error('✗', e.message); process.exit(1) })
