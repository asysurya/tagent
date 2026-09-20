/**
 * context.ts — the context-window economist.
 *
 * Three jobs, all pure code (no AI anywhere):
 *  1. resolve a model's context-window size (explicit config → heuristic);
 *  2. estimate token counts for text when the provider reports no usage;
 *  3. render the compact usage bar shown under the chat input, e.g.
 *
 *      12.3k/131k [██████░░░░░░░░] 9%
 *
 * The bar mirrors opencode's context display: the user always sees how much
 * of the window a session eats, and the host offers deterministic compaction
 * when it crosses the threshold (default 80%).
 */
import { zaiModels } from './providers/zai-models'
import { catalogById } from './providers/registry'
import type { ModelInfo } from './types'

/** env override for models we don't know — power users set this once */
export function envContextWindow(): number {
  const v = Number(process.env.TAGENT_CONTEXT_WINDOW ?? '')
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}

/**
 * Heuristic defaults by model id (approx input windows, tokens).
 * Explicit values in zai-models.json / provider seeds always win.
 */
const HEURISTICS: [RegExp, number][] = [
  [/^gpt-5/, 272_000],
  [/^gpt-5-mini/, 272_000],
  [/^gpt-4\.1/, 1_000_000],
  [/^gpt-4o/, 128_000],
  [/^o[134]\b|^o[134]-/, 200_000],
  [/^chatgpt-4o/, 128_000],
  [/claude-(opus|sonnet|haiku)-?[45]/, 200_000],
  [/claude-3/, 200_000],
  [/^gemini-2\.[05]/, 1_000_000],
  [/^gemini-1\.5/, 1_000_000],
  [/^glm-4/, 131_072],
  [/^glm-4\.5-air/, 131_072],
  [/^deepseek/, 128_000],
  [/^kimi-k2/, 131_072],
  [/^kimi-kimi/, 131_072],
  [/^qwen3/, 131_072],
  [/^qwen-?max/, 131_072],
  [/^qwen-?turbo/, 131_072],
  [/^qwen-?plus/, 131_072],
  [/^grok-4/, 256_000],
  [/^grok-3/, 131_072],
  [/llama-?3\.[123]/, 128_000],
  [/^mistral-(large|medium)/, 128_000],
  [/^ministral/, 128_000],
  [/^sonar/, 128_000],
  [/^doubao/, 128_000],
  [/^jamba/, 128_000],
]

/** Best-effort window for a model id we have no explicit data for. */
export function guessContextWindow(modelId: string): number {
  const id = String(modelId ?? '')
  for (const [re, tokens] of HEURISTICS) if (re.test(id)) return tokens
  return 0
}

function fromModels(models: ModelInfo[], modelId: string): number {
  const hit = models.find((m) => m.id === modelId)
  const w = hit?.contextWindow ?? 0
  return Number.isFinite(w) && w > 0 ? w : 0
}

/**
 * The effective context window for a provider+model, in tokens.
 * Resolution: env override → Z.ai catalog (user-editable json) → provider
 * registry seeds → id heuristics → 0 (unknown — UI falls back to counters).
 */
export function modelContextWindow(providerId: string, modelId: string, root?: string): number {
  const env = envContextWindow()
  if (env) return env
  if (providerId === 'zai') {
    const w = fromModels(zaiModels(root), modelId)
    if (w) return w
  }
  const entry = catalogById(providerId)
  if (entry) {
    const w = fromModels(entry.models, modelId)
    if (w) return w
  }
  return guessContextWindow(modelId)
}

/* ------------------------------------------------------------------ */
/* token estimation                                                     */
/* ------------------------------------------------------------------ */

/**
 * Local token estimate — no tokenizer dependency, CJK-aware.
 * ASCII-heavy text ≈ 4 chars/token; CJK ≈ 1.5 chars/token.
 * Only used when the provider does not report usage in its stream.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u{20000}-\u{2A6DF}]/gu) ?? []).length
  const total = text.length
  const ascii = total - cjk
  return Math.max(1, Math.ceil(ascii / 4) + Math.ceil(cjk / 1.5))
}

/** Estimate the tokens of one chat-ish message (content + action echoes). */
export function estimateMessageTokens(content: string, toolCalls?: { input?: unknown; output?: string }[]): number {
  let n = estimateTokens(content)
  for (const c of toolCalls ?? []) {
    n += estimateTokens(typeof c.input === 'string' ? c.input : JSON.stringify(c.input ?? {}))
    n += estimateTokens(c.output ?? '')
  }
  return n
}

/* ------------------------------------------------------------------ */
/* the bar                                                              */
/* ------------------------------------------------------------------ */

/** 12345 → "12.3k", 999 → "999" */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(Math.max(0, Math.round(n)))
}

/**
 * Render the usage bar, opencode-style:
 *   used/limit [██████░░░░░░░░] 9%
 * `width` = bar cells (default 10). Returns '' when the limit is unknown.
 */
export function renderContextBar(used: number, limit: number, width = 10): string {
  if (!limit || limit <= 0) return ''
  const u = Math.max(0, used)
  const pct = Math.max(0, Math.min(100, Math.round((u / limit) * 100)))
  const cells = Math.max(3, width)
  const filled = Math.max(u > 0 ? 1 : 0, Math.min(cells, Math.round((pct / 100) * cells)))
  const bar = '█'.repeat(filled) + '░'.repeat(cells - filled)
  return `${fmtTokens(u)}/${fmtTokens(limit)} [${bar}] ${pct}%`
}

/** percentage helper — 0 when the limit is unknown */
export function contextPct(used: number, limit: number): number {
  if (!limit || limit <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)))
}
