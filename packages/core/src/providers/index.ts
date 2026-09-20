import type { CustomProviderConfig, ModelInfo, ProviderInfo, Role, TagentConfig, TokenUsage } from '../types'
import {
  CATALOG,
  catalogById,
  modelsFor,
  modelsForCustom,
  resolveApiKey,
} from './registry'

/** Tool definition in OpenAI "function calling" shape. */
export interface NativeToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** A tool call the model made via native function calling (already JSON-parsed). */
export interface NativeToolCall {
  id?: string
  tool: string
  input: unknown
}

export interface CompletionRequest {
  messages: WireMessage[]
  model: string
  signal?: AbortSignal
  maxTokens?: number
  temperature?: number
  /** native tool definitions — used by adapters that support function calling */
  tools?: NativeToolDef[]
  /**
   * Streaming callback — receives the FULL text so far (not a delta), so the
   * consumer can replace state idempotently. Called ~every few tokens.
   */
  onText?: (fullSoFar: string) => void
}

/** Wire-level message — text plus optional image parts (base64, no data URLs). */
export interface WireMessage {
  role: Role
  content: string
  /** base64 image parts — sent to models that accept image input, dropped otherwise */
  images?: { data: string; mediaType: string }[]
}

export interface CompletionResult {
  text: string
  /** actions requested through native tool-calling, if any */
  toolCalls?: NativeToolCall[]
  /** token usage reported in the stream, when the provider sends it */
  usage?: TokenUsage
}

export interface ProviderAdapter {
  id: string
  label: string
  models: ModelInfo[]
  /** true when the adapter can pass tools natively (OpenAI/Anthropic/Google/custom) */
  supportsNativeTools: boolean
  /** legacy one-shot completion (kept for compatibility) */
  complete(req: CompletionRequest): Promise<string>
  /** streaming completion; returns final text + any native tool calls */
  completeStream(req: CompletionRequest): Promise<CompletionResult>
}

/* ------------------------------------------------------------------ */
/* image input (screenshots) — visual test verification                  */
/* ------------------------------------------------------------------ */

/** Model ids that accept image input — best-effort heuristic for discovery-cached models. */
const MULTIMODAL_RE =
  /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|\bo3\b|o4-|chatgpt|claude-3|claude-4|claude-5|claude-opus|claude-sonnet|claude-haiku|gemini|glm-4v|glm-4\.\dv|qwen[^ ]*vl|qwen2-vl|-vl-|vision|pixtral|grok-4|grok[^ ]*vision|llama[^ ]*vision|step-1v|internvl|minicpm-v|moondream|llava|granite-vision|mistral-small-latest/i

/** Does this adapter+model accept image parts? (registry seed flag, or id heuristic) */
export function acceptsImages(adapter: ProviderAdapter, model: string): boolean {
  const seed = adapter.models.find((m) => m.id === model)
  if (seed?.vision === true) return true
  if (seed?.vision === false) return false
  return MULTIMODAL_RE.test(model)
}

/** Strip image parts from a request (for adapters that cannot send them). */
export function withoutImages(req: CompletionRequest): CompletionRequest {
  return { ...req, messages: req.messages.map((m) => ({ role: m.role, content: m.content })) }
}

/* ------------------------------------------------------------------ */
/* SSE helpers                                                          */
/* ------------------------------------------------------------------ */

/** Yield the payload of every `data:` line in an SSE response body. */
async function* sseData(res: Response, signal?: AbortSignal): AsyncGenerator<string> {
  if (!res.body) throw new Error('no response body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      if (signal?.aborted) throw new Error('aborted')
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        if (line.startsWith('data:')) yield line.slice(5).trim()
      }
    }
  } finally {
    try { await reader.cancel() } catch { /* noop */ }
  }
}

function safeJson(s: string): any {
  try { return JSON.parse(s) } catch { return undefined }
}

function truncBody(s: string): string {
  return s.slice(0, 400).replace(/\s+/g, ' ')
}

/* ------------------------------------------------------------------ */
/* message → wire mapping per protocol (text-only or with image parts)  */
/* ------------------------------------------------------------------ */

/** OpenAI chat-completions content blocks (image_url with base64 data URL). */
function openaiMessage(m: WireMessage): { role: Role; content: unknown } {
  if (!m.images?.length) return { role: m.role, content: m.content }
  return {
    role: m.role,
    content: [
      { type: 'text', text: m.content },
      ...m.images.map((i) => ({
        type: 'image_url',
        image_url: { url: `data:${i.mediaType};base64,${i.data}` },
      })),
    ],
  }
}

/** Anthropic Messages API — image blocks must come BEFORE the text block. */
function anthropicMessage(m: WireMessage): { role: 'user' | 'assistant'; content: unknown } {
  if (!m.images?.length) return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }
  return {
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: [
      ...m.images.map((i) => ({
        type: 'image',
        source: { type: 'base64', media_type: i.mediaType, data: i.data },
      })),
      { type: 'text', text: m.content },
    ],
  }
}

/** Google Gemini — inlineData parts before the text part. */
function googleMessage(m: WireMessage): { role: 'model' | 'user'; parts: unknown[] } {
  const parts: unknown[] = []
  for (const i of m.images ?? []) parts.push({ inlineData: { mimeType: i.mediaType, data: i.data } })
  parts.push({ text: m.content })
  return { role: m.role === 'assistant' ? 'model' : 'user', parts }
}

/* ------------------------------------------------------------------ */
/* OpenAI-compatible — OpenAI, OpenRouter, Groq, Ollama, LM Studio, …     */
/* ------------------------------------------------------------------ */

export class OpenAICompatibleAdapter implements ProviderAdapter {
  supportsNativeTools = true

  constructor(
    public id: string,
    public label: string,
    private baseUrl: string,
    private apiKey: string,
    public models: ModelInfo[],
  ) {}

  async complete(req: CompletionRequest): Promise<string> {
    const r = await this.completeStream(req)
    return r.text
  }

  async completeStream(req: CompletionRequest): Promise<CompletionResult> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`
    const headers = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    }
    const base = (tools?: NativeToolDef[], usage?: boolean) => ({
      model: req.model,
      messages: req.messages.map(openaiMessage),
      max_tokens: req.maxTokens ?? 8192,
      temperature: req.temperature ?? 0.2,
      stream: true,
      // usage arrives in a final SSE chunk (OpenAI, OpenRouter, Groq, …)
      ...(usage ? { stream_options: { include_usage: true } } : {}),
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    })

    let res = await fetch(url, { method: 'POST', signal: req.signal, headers, body: JSON.stringify(base(req.tools, true)) })
    // Compatibility ladder — some OpenAI-compatible endpoints reject newer
    // fields: drop stream_options first, then tools (markdown protocol still
    // works as a last resort).
    if (!res.ok && res.status >= 400 && res.status < 500) {
      res = await fetch(url, { method: 'POST', signal: req.signal, headers, body: JSON.stringify(base(req.tools, false)) })
    }
    if (!res.ok && res.status >= 400 && res.status < 500 && req.tools?.length) {
      res = await fetch(url, { method: 'POST', signal: req.signal, headers, body: JSON.stringify(base(undefined, false)) })
    }
    if (!res.ok) throw new Error(`${this.label} HTTP ${res.status}: ${truncBody(await res.text())}`)

    let text = ''
    let usage: TokenUsage | undefined
    // accumulate streamed tool-call fragments: index → { id, name, args }
    const toolAcc = new Map<number, { id?: string; name: string; args: string }>()
    for await (const data of sseData(res, req.signal)) {
      if (data === '[DONE]') break
      const json = safeJson(data)
      const choice = json?.choices?.[0]
      if (json?.usage) {
        usage = {
          input: json.usage.prompt_tokens ?? 0,
          output: json.usage.completion_tokens ?? 0,
          cacheRead: json.usage.prompt_tokens_details?.cached_tokens ?? undefined,
        }
      }
      if (!choice) continue
      const delta = choice.delta ?? {}
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content
        req.onText?.(text)
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0
          const cur = toolAcc.get(idx) ?? { id: undefined, name: '', args: '' }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name += tc.function.name
          if (tc.function?.arguments) cur.args += tc.function.arguments
          toolAcc.set(idx, cur)
        }
      }
    }

    const toolCalls: NativeToolCall[] = []
    for (const [, acc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
      if (!acc.name) continue
      const input = safeJson(acc.args || '{}') ?? {}
      toolCalls.push({ id: acc.id, tool: acc.name, input })
    }
    return { text, toolCalls: toolCalls.length ? toolCalls : undefined, usage }
  }
}

/* ------------------------------------------------------------------ */
/* Anthropic Messages API                                               */
/* ------------------------------------------------------------------ */

export class AnthropicAdapter implements ProviderAdapter {
  supportsNativeTools = true
  models: ModelInfo[] = [
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'anthropic' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic' },
    { id: 'claude-opus-4-1', label: 'Claude Opus 4.1', provider: 'anthropic' },
    { id: 'claude-3-7-sonnet-latest', label: 'Claude 3.7 Sonnet', provider: 'anthropic' },
    { id: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku (fast)', provider: 'anthropic' },
  ]
  constructor(
    public id = 'anthropic',
    public label = 'Anthropic',
    private apiKey: string,
    private baseUrl = 'https://api.anthropic.com',
  ) {}

  async complete(req: CompletionRequest): Promise<string> {
    const r = await this.completeStream(req)
    return r.text
  }

  private buildBody(req: CompletionRequest, withTools: boolean, cacheControl: boolean) {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const rest = req.messages
      .filter((m) => m.role !== 'system')
      .map(anthropicMessage)
    return {
      model: req.model,
      // prompt caching: mark the system block ephemeral-cacheable → the big
      // static prefix (personality + tool docs) bills at ~10% on every turn
      system: system
        ? cacheControl
          ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
          : system
        : undefined,
      messages: rest,
      max_tokens: req.maxTokens ?? 8192,
      temperature: req.temperature ?? 0.2,
      stream: true,
      ...(withTools && req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              name: t.function.name,
              description: t.function.description,
              input_schema: t.function.parameters,
            })),
          }
        : {}),
    }
  }

  async completeStream(req: CompletionRequest): Promise<CompletionResult> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/v1/messages`
    const call = async (withTools: boolean, cacheControl: boolean) =>
      fetch(url, {
        method: 'POST',
        signal: req.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(this.buildBody(req, withTools, cacheControl)),
      })
    let res = await call(true, true)
    if (!res.ok && res.status >= 400 && res.status < 500) {
      // old proxies may not know cache_control — drop it first
      res = await call(true, false)
    }
    if (!res.ok && res.status >= 400 && res.status < 500 && req.tools?.length) {
      res = await call(false, false) // fall back to the markdown action protocol
    }
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${truncBody(await res.text())}`)

    let text = ''
    let usage: TokenUsage | undefined
    const toolBlocks = new Map<number, { id?: string; name: string; json: string }>()
    let blockIndex = -1
    for await (const data of sseData(res, req.signal)) {
      const ev = safeJson(data)
      if (!ev?.type) continue
      if (ev.type === 'message_start') {
        const u = ev.message?.usage
        if (u) {
          usage = {
            input: u.input_tokens ?? 0,
            output: u.output_tokens ?? 0,
            cacheRead: u.cache_read_input_tokens ?? undefined,
          }
        }
      } else if (ev.type === 'message_delta') {
        // cumulative output count at the end of the stream
        if (ev.usage?.output_tokens && usage) usage.output = ev.usage.output_tokens
      } else if (ev.type === 'content_block_start') {
        blockIndex = typeof ev.index === 'number' ? ev.index : blockIndex + 1
        if (ev.content_block?.type === 'tool_use') {
          toolBlocks.set(blockIndex, { id: ev.content_block.id, name: ev.content_block.name, json: '' })
        }
      } else if (ev.type === 'content_block_delta') {
        const d = ev.delta ?? {}
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          text += d.text
          req.onText?.(text)
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          const b = toolBlocks.get(blockIndex)
          if (b) b.json += d.partial_json
        }
      } else if (ev.type === 'message_stop') {
        break
      }
    }

    const toolCalls: NativeToolCall[] = [...toolBlocks.values()]
      .filter((b) => b.name)
      .map((b) => ({ id: b.id, tool: b.name, input: safeJson(b.json || '{}') ?? {} }))
    return { text, toolCalls: toolCalls.length ? toolCalls : undefined, usage }
  }
}

/* ------------------------------------------------------------------ */
/* Google Gemini (Generative Language API)                              */
/* ------------------------------------------------------------------ */

export class GoogleAdapter implements ProviderAdapter {
  supportsNativeTools = true
  models: ModelInfo[] = [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'google' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'google' },
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', provider: 'google' },
  ]
  constructor(
    public id = 'google',
    public label = 'Google Gemini',
    private apiKey: string,
    private baseUrl = 'https://generativelanguage.googleapis.com',
  ) {}

  async complete(req: CompletionRequest): Promise<string> {
    const r = await this.completeStream(req)
    return r.text
  }

  async completeStream(req: CompletionRequest): Promise<CompletionResult> {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const rest = req.messages
      .filter((m) => m.role !== 'system')
      .map(googleMessage)
    const body = {
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: rest,
      generationConfig: {
        maxOutputTokens: req.maxTokens ?? 8192,
        temperature: req.temperature ?? 0.2,
      },
      // Gemini rejects `additionalProperties` / `$schema` keys — strip them.
      ...(req.tools?.length
        ? {
            tools: [{
              functionDeclarations: req.tools.map((t) => ({
                name: t.function.name,
                description: t.function.description,
                parameters: cleanSchemaForGemini(t.function.parameters),
              })),
            }],
          }
        : {}),
    }
    const url = `${this.baseUrl.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse&key=${this.apiKey}`
    const res = await fetch(url, {
      method: 'POST',
      signal: req.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Google HTTP ${res.status}: ${truncBody(await res.text())}`)

    let text = ''
    let usage: TokenUsage | undefined
    const toolCalls: NativeToolCall[] = []
    for await (const data of sseData(res, req.signal)) {
      const json = safeJson(data)
      if (json?.usageMetadata) {
        usage = {
          input: json.usageMetadata.promptTokenCount ?? 0,
          output: json.usageMetadata.candidatesTokenCount ?? 0,
          cacheRead: json.usageMetadata.cachedContentTokenCount ?? undefined,
        }
      }
      const parts = json?.candidates?.[0]?.content?.parts ?? []
      for (const p of parts) {
        if (typeof p?.text === 'string' && p.text) {
          text += p.text
          req.onText?.(text)
        }
        if (p?.functionCall?.name) {
          toolCalls.push({ tool: p.functionCall.name, input: p.functionCall.args ?? {} })
        }
      }
    }
    return { text, toolCalls: toolCalls.length ? toolCalls : undefined, usage }
  }
}

function cleanSchemaForGemini(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties' || k === '$schema') continue
    if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {}
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] = typeof pv === 'object' && pv !== null ? cleanSchemaForGemini(pv as Record<string, unknown>) : pv
      }
      out[k] = props
      continue
    }
    if (k === 'items' && v && typeof v === 'object') {
      out[k] = cleanSchemaForGemini(v as Record<string, unknown>)
      continue
    }
    out[k] = v
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Z.ai built-in adapter (sandbox / z.ai environments). No key needed.  */
/* ------------------------------------------------------------------ */

export class ZaiAdapter implements ProviderAdapter {
  id = 'zai'
  label = 'Z.ai (built-in)'
  supportsNativeTools = false // markdown action protocol only
  models: ModelInfo[] = [
    { id: 'glm-4.7', label: 'GLM-4.7 (default)', provider: 'zai' },
    { id: 'glm-4.6', label: 'GLM-4.6', provider: 'zai' },
  ]
  private zai: any = null

  private async client(): Promise<any> {
    if (!this.zai) {
      const mod: any = await import('z-ai-web-dev-sdk')
      const ZAI = mod.default
      this.zai = await ZAI.create()
    }
    return this.zai
  }

  /** sandbox endpoints rate-limit bursts — back off and retry (8s, 16s). */
  private async with429Retry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn()
      } catch (e) {
        const msg = (e as Error).message ?? ''
        if (attempt >= 2 || !/status 429|Too many requests/i.test(msg)) throw e
        await new Promise((r) => setTimeout(r, 8_000 * (attempt + 1)))
      }
    }
  }

  async complete(req: CompletionRequest): Promise<string> {
    const r = await this.completeStream(req)
    return r.text
  }

  async completeStream(req: CompletionRequest): Promise<CompletionResult> {
    const zai = await this.client()
    // The SDK expects the system prompt as an 'assistant' message.
    const messages = req.messages.map((m) =>
      m.role === 'system' ? { role: 'assistant', content: m.content } : m,
    )
    // Try real token streaming first; some SDK builds may not support it.
    try {
      const stream = await this.with429Retry(() =>
        zai.chat.completions.create({
          messages,
          thinking: { type: 'disabled' },
          stream: true,
        }),
      )
      let text = ''
      for await (const chunk of stream) {
        const delta: string | undefined = chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.message?.content
        if (delta) {
          text += delta
          req.onText?.(text)
        }
      }
      if (text) return { text }
    } catch {
      /* fall through to the non-streaming path */
    }
    const completion = await this.with429Retry(() =>
      zai.chat.completions.create({
        messages,
        thinking: { type: 'disabled' },
      }),
    )
    const text = completion?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text) throw new Error('Z.ai: empty completion')
    req.onText?.(text)
    return { text }
  }
}

/* ------------------------------------------------------------------ */
/* catalog — see registry.ts for the ~35 built-in providers             */
/* ------------------------------------------------------------------ */

/**
 * All providers the user can pick: the zero-config Z.ai adapter, the full
 * catalog (key from config or env) and custom endpoints. Models are the
 * registry seeds merged with the discovery cache.
 */
export function listProviderInfos(cfg: TagentConfig): ProviderInfo[] {
  const infos: ProviderInfo[] = [
    { id: 'zai', label: 'Z.ai (built-in)', kind: 'builtin', needsKey: false, hasKey: true, models: new ZaiAdapter().models },
  ]
  for (const entry of CATALOG) {
    const key = resolveApiKey(entry, cfg)
    infos.push({
      id: entry.id,
      label: entry.label,
      kind: entry.kind,
      needsKey: entry.needsKey,
      hasKey: entry.needsKey ? !!key : true,
      models: modelsFor(entry),
      docsUrl: entry.docsUrl,
      envVar: entry.envVars[0],
      popular: entry.popular === true,
    })
  }
  for (const cp of cfg.customProviders ?? []) {
    infos.push({
      id: cp.id,
      label: cp.label,
      kind: cp.kind ?? 'openai',
      custom: true,
      needsKey: !cp.apiKey && !cfg.apiKeys?.[cp.id],
      hasKey: !!(cp.apiKey || cfg.apiKeys?.[cp.id]),
      models: modelsForCustom(cp),
    })
  }
  return infos
}

export function getAdapter(providerId: string, cfg: TagentConfig): ProviderAdapter {
  const custom = (cfg.customProviders ?? []).find((p) => p.id === providerId)
  if (custom) {
    const key = custom.apiKey || cfg.apiKeys?.[custom.id] || ''
    const models = modelsForCustom(custom)
    if ((custom.kind ?? 'openai') === 'anthropic') {
      return new AnthropicAdapter(custom.id, custom.label, key, custom.baseUrl)
    }
    if (custom.kind === 'google') {
      return new GoogleAdapter(custom.id, custom.label, key, custom.baseUrl)
    }
    return new OpenAICompatibleAdapter(custom.id, custom.label, custom.baseUrl, key, models)
  }
  if (providerId === 'zai') return new ZaiAdapter()
  const entry = catalogById(providerId)
  if (entry) {
    const key = resolveApiKey(entry, cfg)
    const models = modelsFor(entry)
    if (entry.kind === 'anthropic') return new AnthropicAdapter(entry.id, entry.label, key, entry.baseUrl)
    if (entry.kind === 'google') return new GoogleAdapter(entry.id, entry.label, key, entry.baseUrl)
    return new OpenAICompatibleAdapter(entry.id, entry.label, entry.baseUrl, key, models)
  }
  throw new Error(`Unknown provider: ${providerId} — run \`tagent models\` to list what's available`)
}
