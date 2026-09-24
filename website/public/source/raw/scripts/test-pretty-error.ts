/** v0.19.0 — provider HTTP errors rendered for humans, not raw JSON dumps */
import { prettyHttpError } from '../packages/core/src/providers/index'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean) => { cond ? pass++ : fail++; console.log(`${cond ? '✔' : '✗'} ${name}`) }

// the exact shape the user hit live (OpenRouter 402 credits)
const openrouter = JSON.stringify({
  error: {
    message: 'This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens, but can only afford 1578.',
    code: 402,
    metadata: {
      limit_source: 'openrouter_credits',
      remedy_hint: 'Add credits at https://openrouter.ai/settings/credits, or lower max_tokens / prompt size to fit your credits',
    },
  },
})
const r1 = prettyHttpError('OpenRouter', 402, openrouter)
ok('openrouter 402: human message on line one', r1.startsWith('OpenRouter HTTP 402 — This request requires more credits'))
ok('openrouter 402: no raw JSON in the output', !r1.includes('{"') && !r1.includes('"code"'))
ok('openrouter 402: remedy on its own line', r1.includes('\n→ Add credits at https://openrouter.ai/settings/credits'))

// OpenAI shape (no metadata)
const r2 = prettyHttpError('OpenAI', 401, JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }))
ok('openai 401: message extracted', r2 === 'OpenAI HTTP 401 — Incorrect API key provided')

// Anthropic shape (nested differently)
const r3 = prettyHttpError('Anthropic', 529, JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))
ok('anthropic 529: message extracted', r3 === 'Anthropic HTTP 529 — Overloaded')

// error as a plain string
const r4 = prettyHttpError('Groq', 429, JSON.stringify({ error: 'rate limited, slow down' }))
ok('string error body', r4 === 'Groq HTTP 429 — rate limited, slow down')

// top-level message
const r5 = prettyHttpError('Z.ai', 400, JSON.stringify({ message: 'model not found' }))
ok('top-level message body', r5 === 'Z.ai HTTP 400 — model not found')

// non-JSON keeps the classic form
const r6 = prettyHttpError('vLLM', 500, '<html>Internal Server Error</html>')
ok('non-JSON body keeps truncation', r6 === 'vLLM HTTP 500: <html>Internal Server Error</html>')

// missing message falls back to raw
const r7 = prettyHttpError('X', 418, JSON.stringify({ error: { code: 418 } }))
ok('no message → raw JSON fallback', r7.includes('X HTTP 418'))

// multi-line provider messages are flattened for the one-line notify path
const r8 = prettyHttpError('T', 400, JSON.stringify({ error: { message: 'line one\nline two' } }))
ok('newlines inside the message collapse', !r8.includes('\nline two') && r8.includes('line one line two'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
