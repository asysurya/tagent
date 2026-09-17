/** Debug: does zai streaming work? Direct adapter test with events. */
import { ZaiAdapter } from '../packages/core/src/providers'

const adapter = new ZaiAdapter()
console.log('testing zai completeStream (5s budget for first chunk, 120s total)...')

const t0 = Date.now()
let chunks = 0
let first = 0

const timeout = setTimeout(() => {
  console.log(`TIMEOUT after 120s — chunks: ${chunks}`)
  process.exit(1)
}, 120000)

try {
  const result = await adapter.completeStream({
    model: 'glm-4.7',
    messages: [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'Say exactly: hello streaming world' },
    ],
    onText: (full) => {
      chunks++
      if (!first) { first = Date.now() - t0; console.log(`first chunk after ${first}ms`) }
      if (chunks <= 3 || chunks % 20 === 0) console.log(`chunk#${chunks}: ${JSON.stringify(full.slice(0, 40))}`)
    },
  })
  clearTimeout(timeout)
  console.log('DONE in', Date.now() - t0, 'ms | chunks:', chunks)
  console.log('text:', JSON.stringify(result.text))
  console.log('toolCalls:', result.toolCalls)
  process.exit(0)
} catch (e) {
  clearTimeout(timeout)
  console.log('ERROR after', Date.now() - t0, 'ms:', (e as Error).message)
  process.exit(1)
}
