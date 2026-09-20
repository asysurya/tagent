/**
 * test-compact.ts — the deterministic compaction engine + context utilities.
 *
 * Contract under test (the "caveman rework"):
 *  - compressOutput SUMMARIZES instead of truncating: JSON minify is lossless,
 *    repeated lines collapse with a ×N marker, big blobs keep head+tail with
 *    an elision marker that states exactly how much was skipped.
 *  - slimActionInput keeps old write_file/edit_file echoes auditable (path +
 *    preview) without re-sending whole file contents forever.
 *  - compactSession turns old turns into ONE digest message: 100k-ish
 *    histories land near 10k, recent turns stay verbatim, and NOTHING in
 *    the digest is generated — every line is copied from the transcript.
 *  - modelContextWindow resolves zai json → registry → heuristics → env.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  compressOutput,
  slimActionInput,
  compactSession,
  estimateTokens,
  estimateMessageTokens,
  modelContextWindow,
  guessContextWindow,
  renderContextBar,
  contextPct,
  fmtTokens,
  type SessionData,
  type ChatMessage,
} from '../packages/core/src/index'

let pass = 0
let fail = 0
function ok(cond: boolean, label: string, extra = ''): void {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`) }
}

/* ---------------- estimateTokens ---------------- */
console.log('estimateTokens:')
ok(estimateTokens('') === 0, 'empty → 0')
ok(estimateTokens('a'.repeat(400)) === 100, '400 ascii chars ≈ 100 tokens')
const cjk = '汉字'.repeat(150) // 300 CJK chars
ok(estimateTokens(cjk) === 200, `300 CJK chars ≈ 200 tokens (got ${estimateTokens(cjk)})`)
ok(estimateTokens('x'.repeat(7)) === 2, 'tiny strings still ≥ 1 token')
ok(estimateMessageTokens('hello', [{ input: { a: 1 }, output: 'done' }]) > 2, 'tool calls add tokens')

/* ---------------- renderContextBar ---------------- */
console.log('\nrenderContextBar:')
ok(renderContextBar(0, 0) === '', 'unknown limit → no bar')
const bar = renderContextBar(1000, 100_000, 10)
ok(bar === '1k/100k [█░░░░░░░░░] 1%', 'exact format: used/limit [blocks] pct', bar)
ok(renderContextBar(80_000, 100_000, 10).endsWith('80%'), '80% renders')
ok(renderContextBar(100_000, 100_000, 10).endsWith('100%'), 'full → 100%')
ok(renderContextBar(120_000, 100_000, 10).endsWith('100%'), 'over-limit clamps to 100%')
ok(contextPct(50, 0) === 0, 'pct with unknown limit → 0')
ok(fmtTokens(999) === '999' && fmtTokens(12_345) === '12.3k' && fmtTokens(10_000) === '10k', 'fmtTokens compact')

/* ---------------- modelContextWindow ---------------- */
console.log('\nmodelContextWindow:')
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-ctx-'))
process.env.HOME = HOME
delete process.env.TAGENT_CONTEXT_WINDOW
const { zaiModels } = await import('../packages/core/src/providers/zai-models')
ok(zaiModels().some((m) => m.id === 'glm-4.7' && m.contextWindow === 131_072), 'zai catalog carries contextWindow')
ok(modelContextWindow('zai', 'glm-4.7', path.join(HOME, 'nonexistent-ws')) === 131_072, 'zai glm-4.7 → 131072')
ok(modelContextWindow('openai', 'gpt-4o') === 128_000, 'registry seed gpt-4o → 128k')
ok(modelContextWindow('anthropic', 'claude-sonnet-4-5') === 200_000, 'claude seed → 200k')
ok(modelContextWindow('unknown-provider', 'deepseek-chat') === 128_000, 'heuristic fallback deepseek → 128k')
ok(modelContextWindow('unknown-provider', 'totally-unknown-model') === 0, 'unknown → 0 (no bar)')
ok(guessContextWindow('glm-4.9-ultra') === 131_072, 'glm-4.x heuristic')
// user override via ~/.tagent/zai-models.json
fs.mkdirSync(path.join(HOME, '.tagent'), { recursive: true })
fs.writeFileSync(path.join(HOME, '.tagent', 'zai-models.json'), JSON.stringify({
  models: [{ id: 'glm-custom-x', label: 'Custom X', contextWindow: 65_536 }],
}))
ok(modelContextWindow('zai', 'glm-custom-x') === 65_536, 'user json override wins')
process.env.TAGENT_CONTEXT_WINDOW = '500000'
ok(modelContextWindow('anything', 'whatever') === 500_000, 'env TAGENT_CONTEXT_WINDOW overrides all')
delete process.env.TAGENT_CONTEXT_WINDOW
process.env.HOME = os.homedir()

/* ---------------- compressOutput ---------------- */
console.log('\ncompressOutput:')
ok(compressOutput('short output', 1000) === 'short output', 'under budget → untouched')
// JSON minify (lossless)
const pretty = JSON.stringify({ a: [1, 2, 3], b: { c: 'x'.repeat(50) } }, null, 2)
ok(compressOutput(pretty, 10_000).length < pretty.length, 'pretty JSON gets minified')
// dedupe repeated lines
const rep = Array.from({ length: 50 }, () => 'identical warning line').join('\n')
const z = compressOutput(rep, 10_000)
ok(z.includes('(×50)'), '50 identical lines collapse to one with ×N marker', z.slice(0, 80))
// head+tail with elision marker
const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n')
const c = compressOutput(big, 1000)
ok(c.startsWith('line 0\n'), 'head kept')
ok(c.trimEnd().endsWith('line 1999'), 'tail kept')
const m = /compacted: (\d+) chars elided/.exec(c)
ok(!!m && Number(m[1]) > 5000, 'elision marker states the skipped size', m?.[1])
ok(c.length < 1500, 'output is actually near the budget', String(c.length))
// blank collapse
ok(!/\n\n\n/.test(compressOutput('a\n\n\n\n\nb\n\n\nc', 100)), '3+ blank lines collapse')
// tiny budget still keeps content
ok(compressOutput('abcdef', 3).length >= 3, 'tiny budget does not return empty')

/* ---------------- slimActionInput ---------------- */
console.log('\nslimActionInput:')
const fat = slimActionInput('write_file', {
  path: 'src/app.ts',
  content: 'export const x = 1\n'.repeat(400),
})
ok(typeof fat.path === 'string' && fat.path === 'src/app.ts', 'path preserved')
ok(typeof fat.content === 'string' && fat.content.length < 500, 'content slimmed', String((fat.content as string).length))
ok((fat.content as string).includes('elided'), 'elision marker present')
const lean = slimActionInput('grep', { pattern: 'foo', glob: '*.ts' })
ok(lean.pattern === 'foo' && lean.glob === '*.ts', 'small inputs untouched')

/* ---------------- compactSession ---------------- */
console.log('\ncompactSession:')
function msg(role: 'user' | 'assistant', content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: Math.random().toString(36).slice(2), role, content, createdAt: Date.now(), ...extra }
}
function bigSession(): SessionData {
  const messages: ChatMessage[] = []
  for (let i = 0; i < 12; i++) {
    messages.push(msg('user', `user request number ${i} — please fix the login flow and also check ${'detail '.repeat(300)}`))
    messages.push(msg('assistant', `working on ${i}`, {
      toolCalls: i % 2 === 0
        ? [{ id: `t${i}`, tool: 'write_file', input: { path: `src/file${i}.ts`, content: 'code\n'.repeat(500) }, status: 'done' }]
        : undefined,
    }))
    if (i % 2 === 0) messages.push(msg('user', `TOOL RESULTS:\n\n### write_file (done)\ninput: {"path":"src/file${i}.ts"}\noutput:\nwrote it`, { meta: { toolResults: true } }))
    messages.push(msg('assistant', `step ${i} summary — ` + 'result '.repeat(200)))
  }
  return {
    id: 's1', workspaceId: '/tmp/x', title: 't', model: 'glm-4.7', mode: 'build',
    createdAt: 0, updatedAt: 0, messageCount: messages.length, messages, todos: [],
  }
}
const s1 = bigSession()
const before1 = s1.messages.length
const r1 = compactSession(s1, { keepTokens: 1000 })
ok(!!r1, 'compacts a long session')
ok(r1!.after < r1!.before / 3, `big drop: ${r1!.before} → ${r1!.after} tokens`)
ok(s1.messages.length === r1!.keptMessages && s1.messages.length < before1, 'messages replaced by digest + kept tail')
ok(s1.messages[0].meta?.compacted === true, 'first message is the digest')
ok(s1.messages[0].role === 'user', 'digest rides as a user message')
const digest = s1.messages[0].content
ok(digest.includes('[CONTEXT COMPACTED'), 'digest header explains itself')
ok(digest.includes('USER:'), 'digest lists user turns')
ok(digest.includes('write_file(src/file'), 'digest preserves tool + path facts')
ok(!digest.includes('code\n'.repeat(10)), 'digest does not carry file contents')
ok(s1.messages.at(-1)!.content.includes('step 11'), 'the newest turn stays verbatim')
// re-compaction: idempotent-ish, prior digest is folded in, no duplication
const r2 = compactSession(s1, { keepTokens: 200 })
ok(!r2 || (r2.recompacted === true && s1.messages.filter((m) => m.meta?.compacted).length === 1), 're-compaction keeps ONE digest message')
// small session → null (nothing worth doing)
const tiny: SessionData = {
  id: 's2', workspaceId: '/tmp/x', title: 't', model: 'm', mode: 'build',
  createdAt: 0, updatedAt: 0, messageCount: 2,
  messages: [msg('user', 'hi'), msg('assistant', 'hello')], todos: [],
}
ok(compactSession(tiny, { keepTokens: 10_000 }) === null, 'small session → not worth compacting')
// attachments slimmed in digest lines
const withAttach: SessionData = {
  id: 's3', workspaceId: '/tmp/x', title: 't', model: 'm', mode: 'build',
  createdAt: 0, updatedAt: 0, messageCount: 8,
  messages: [
    msg('user', 'check this\n\n===== @src/big.ts (user-attached, 500 bytes) =====\n' + 'content\n'.repeat(200)),
    ...Array.from({ length: 6 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `turn text ${i} ` + 'x'.repeat(600))),
    msg('user', 'latest message'),
  ],
  todos: [],
}
const r3 = compactSession(withAttach, { keepTokens: 100 })
ok(!!r3, 'attachment session compacts')
ok(!withAttach.messages[0].content.includes('content\n'.repeat(20)), '@attachment bodies dropped from the digest')
ok(withAttach.messages[0].content.includes('(@files attached)'), 'attachment mention kept')

console.log(`\ncompact tests: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
