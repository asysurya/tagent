/** runtime failover: adapter 1 throws → adapter 2 serves; abort rethrows */
import { completeWithFallback, type ResolvedChainEntry } from '../packages/core/src/index'
import type { ProviderAdapter, CompletionRequest, CompletionResult } from '../packages/core/src/providers'

let pass = 0, fail = 0
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? '✔' : '✗'} ${n}`) }

const mk = (behavior: 'throw' | 'ok', name: string): ProviderAdapter => ({
  supportsNativeTools: false,
  async completeStream(req: CompletionRequest): Promise<CompletionResult> {
    if (behavior === 'throw') throw new Error(`${name} exploded (simulated 500)`)
    return { text: `served by ${name}` }
  },
} as unknown as ProviderAdapter)

const log: string[] = []
const chain: ResolvedChainEntry[] = [
  { adapter: mk('throw', 'primary'), model: 'm', label: 'primary' },
  { adapter: mk('throw', 'fb1'), model: 'm', label: 'fb1' },
  { adapter: mk('ok', 'fb2'), model: 'm', label: 'fb2' },
]
const r = await completeWithFallback(chain, { model: 'm', messages: [] }, (i) => log.push(`${i.failed}→${i.next}`))
ok('served by third entry', r.text === 'served by fb2')
ok('two failovers logged in order', log.length === 2 && log[0] === 'primary→fb1' && log[1] === 'fb1→fb2')

// all fail → throws last error
try {
  await completeWithFallback([
    { adapter: mk('throw', 'a'), model: 'm', label: 'a' },
    { adapter: mk('throw', 'b'), model: 'm', label: 'b' },
  ], { model: 'm', messages: [] })
  ok('all-fail throws', false)
} catch (e) { ok('all-fail throws last error', (e as Error).message.includes('b exploded')) }

// aborted signal → immediate rethrow, no next provider
const ctrl = new AbortController()
ctrl.abort()
let triedSecond = false
try {
  await completeWithFallback([
    { adapter: mk('throw', 'x'), model: 'm', label: 'x' },
    { adapter: { supportsNativeTools: false, completeStream: async () => { triedSecond = true; return { text: '' } } } as unknown as ProviderAdapter, model: 'm', label: 'y' },
  ], { model: 'm', messages: [], signal: ctrl.signal })
  ok('abort rethrows', false)
} catch { ok('abort rethrows without trying next', !triedSecond) }

console.log(`\n${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
