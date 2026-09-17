import type { CustomProviderConfig, ModelInfo, Role, TagentConfig } from '../types'

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
  messages: { role: Role; content: string }[]
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

export interface CompletionResult {
  text: string
  /** actions requested through native tool-calling, if any */
  toolCalls?: NativeToolCall[]
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
    const base = (tools?: NativeToolDef[]) => ({
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens ?? 8192,
      temperature: req.temperature ?? 0.2,
      stream: true,
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    })

    let res = await fetch(url, { method: 'POST', signal: req.signal, headers, body: JSON.stringify(base(req.tools)) })
    // Some OpenAI-compatible endpoints reject `tools` (older models, proxies).
    // A 4xx with tools sent → retry once without them (markdown protocol still works).
    if (!res.ok && res.status >= 400 && res.status < 500 && req.tools?.length) {
      res = await fetch(url, { method: 'POST', signal: req.signal, headers, body: JSON.stringify(base(undefined)) })
    }
    if (!res.ok) throw new Error(`${this.label} HTTP ${res.status}: ${truncBody(await res.text())}`)

    let text = ''
    // accumulate streamed tool-call fragments: index → { id, name, args }
    const toolAcc = new Map<number, { id?: string; name: string; args: string }>()
    for await (const data of sseData(res, req.signal)) {
      if (data === '[DONE]') break
      const json = safeJson(data)
      const choice = json?.choices?.[0]
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
    return { text, toolCalls: toolCalls.length ? toolCalls : undefined }
  }
}

/* ------------------------------------------------------------------ */
/* Anthropic Messages API                                               */
/* ------------------------------------------------------------------ */

export class AnthropicAdapter implements ProviderAdapter {
  supportsNativeTools = true
  models: ModelInfo[] = [
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'anthropic' },
    { id: 'claude-opus-4-1', label: 'Claude Opus 4.1', provider: 'anthropic' },
    { id: 'claude-3-7-sonnet-latest', label: 'Claude 3.7 Sonnet', provider: 'anthropic' },
    { id: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku (fast)', provider: 'anthropic' },
  ]
  constructor(
    public id = 'anthropic',
    public label = 'Anthropic',
    private apiKey: string,
  ) {}

  async complete(req: CompletionRequest): Promise<string> {
    const r = await this.completeStream(req)
    return r.text
  }

  private buildBody(req: CompletionRequest, withTools: boolean) {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const rest = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
    return {
      model: req.model,
      system: system || undefined,
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
    const call = async (withTools: boolean) =>
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: req.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(this.buildBody(req, withTools)),
      })
    let res = await call(true)
    if (!res.ok && res.status >= 400 && res.status < 500 && req.tools?.length) {
      res = await call(false) // fall back to the markdown action protocol
    }
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${truncBody(await res.text())}`)

    let text = ''
    const toolBlocks = new Map<number, { id?: string; name: string; json: string }>()
    let blockIndex = -1
    for await (const data of sseData(res, req.signal)) {
      const ev = safeJson(data)
      if (!ev?.type) continue
      if (ev.type === 'content_block_start') {
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
    return { text, toolCalls: toolCalls.length ? toolCalls : undefined }
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
  ) {}

  async complete(req: CompletionRequest): Promise<string> {
    const r = await this.completeStream(req)
    return r.text
  }

  async completeStream(req: CompletionRequest): Promise<CompletionResult> {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const rest = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
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
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse&key=${this.apiKey}`
    const res = await fetch(url, {
      method: 'POST',
      signal: req.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Google HTTP ${res.status}: ${truncBody(await res.text())}`)

    let text = ''
    const toolCalls: NativeToolCall[] = []
    for await (const data of sseData(res, req.signal)) {
      const json = safeJson(data)
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
    return { text, toolCalls: toolCalls.length ? toolCalls : undefined }
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
      const stream = await zai.chat.completions.create({
        messages,
        thinking: { type: 'disabled' },
        stream: true,
      })
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
    const completion = await zai.chat.completions.create({
      messages,
      thinking: { type: 'disabled' },
    })
    const text = completion?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text) throw new Error('Z.ai: empty completion')
    req.onText?.(text)
    return { text }
  }
}

/* ------------------------------------------------------------------ */

const OPENAI_MODELS: ModelInfo[] = [
  { id: 'gpt-5', label: 'GPT-5', provider: 'openai' },
  { id: 'gpt-5-mini', label: 'GPT-5 Mini', provider: 'openai' },
  { id: 'gpt-4.1', label: 'GPT-4.1', provider: 'openai' },
  { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
  { id: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'openai' },
]

const OPENROUTER_MODELS: ModelInfo[] = [
  { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5 (OR)', provider: 'openrouter' },
  { id: 'openai/gpt-5', label: 'GPT-5 (OR)', provider: 'openrouter' },
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro (OR)', provider: 'openrouter' },
  { id: 'deepseek/deepseek-chat', label: 'DeepSeek V3 (OR)', provider: 'openrouter' },
]

const GROQ_MODELS: ModelInfo[] = [
  { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (Groq)', provider: 'groq' },
  { id: 'qwen-2.5-32b', label: 'Qwen 2.5 32B (Groq)', provider: 'groq' },
]

export function listProviderInfos(cfg: TagentConfig): {
  id: string
  label: string
  kind: 'builtin' | 'openai' | 'anthropic' | 'google' | 'custom'
  needsKey: boolean
  hasKey: boolean
  models: ModelInfo[]
  docsUrl?: string
}[] {
  const infos: {
    id: string
    label: string
    kind: 'builtin' | 'openai' | 'anthropic' | 'google' | 'custom'
    needsKey: boolean
    hasKey: boolean
    models: ModelInfo[]
    docsUrl?: string
  }[] = [
    { id: 'zai', label: 'Z.ai (built-in)', kind: 'builtin', needsKey: false, hasKey: true, models: new ZaiAdapter().models },
    {
      id: 'openai',
      label: 'OpenAI',
      kind: 'openai',
      needsKey: true,
      hasKey: !!cfg.apiKeys.openai,
      models: OPENAI_MODELS,
      docsUrl: 'https://platform.openai.com/api-keys',
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      kind: 'anthropic',
      needsKey: true,
      hasKey: !!cfg.apiKeys.anthropic,
      models: new AnthropicAdapter('x', 'x', 'x').models,
      docsUrl: 'https://console.anthropic.com/settings/keys',
    },
    {
      id: 'google',
      label: 'Google Gemini',
      kind: 'google',
      needsKey: true,
      hasKey: !!cfg.apiKeys.google,
      models: new GoogleAdapter('x', 'x', 'x').models,
      docsUrl: 'https://aistudio.google.com/apikey',
    },
    {
      id: 'openrouter',
      label: 'OpenRouter',
      kind: 'openai',
      needsKey: true,
      hasKey: !!cfg.apiKeys.openrouter,
      models: OPENROUTER_MODELS,
      docsUrl: 'https://openrouter.ai/keys',
    },
    {
      id: 'groq',
      label: 'Groq',
      kind: 'openai',
      needsKey: true,
      hasKey: !!cfg.apiKeys.groq,
      models: GROQ_MODELS,
      docsUrl: 'https://console.groq.com/keys',
    },
    {
      id: 'ollama',
      label: 'Ollama (local)',
      kind: 'openai',
      needsKey: false,
      hasKey: true,
      models: [
        { id: 'qwen3:8b', label: 'Qwen3 8B (local)', provider: 'ollama' },
        { id: 'llama3.2', label: 'Llama 3.2 (local)', provider: 'ollama' },
      ],
    },
  ]
  for (const cp of cfg.customProviders ?? []) {
    infos.push({
      id: cp.id,
      label: cp.label,
      kind: 'custom',
      needsKey: !cp.apiKey,
      hasKey: !!cp.apiKey,
      models: cp.models.map((m) => ({ id: m, label: m, provider: cp.id })),
    })
  }
  return infos
}

export function getAdapter(providerId: string, cfg: TagentConfig): ProviderAdapter {
  const custom = (cfg.customProviders ?? []).find((p) => p.id === providerId)
  if (custom) {
    return new OpenAICompatibleAdapter(custom.id, custom.label, custom.baseUrl, custom.apiKey ?? '', custom.models.map((m) => ({ id: m, label: m, provider: custom.id })))
  }
  switch (providerId) {
    case 'zai':
      return new ZaiAdapter()
    case 'openai':
      return new OpenAICompatibleAdapter('openai', 'OpenAI', 'https://api.openai.com/v1', cfg.apiKeys.openai ?? '', OPENAI_MODELS)
    case 'anthropic':
      return new AnthropicAdapter('anthropic', 'Anthropic', cfg.apiKeys.anthropic ?? '')
    case 'google':
      return new GoogleAdapter('google', 'Google Gemini', cfg.apiKeys.google ?? '')
    case 'openrouter':
      return new OpenAICompatibleAdapter('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', cfg.apiKeys.openrouter ?? '', OPENROUTER_MODELS)
    case 'groq':
      return new OpenAICompatibleAdapter('groq', 'Groq', 'https://api.groq.com/openai/v1', cfg.apiKeys.groq ?? '', GROQ_MODELS)
    case 'ollama':
      return new OpenAICompatibleAdapter('ollama', 'Ollama', 'http://127.0.0.1:11434/v1', '', [
        { id: 'qwen3:8b', label: 'Qwen3 8B (local)', provider: 'ollama' },
        { id: 'llama3.2', label: 'Llama 3.2 (local)', provider: 'ollama' },
      ])
    default:
      throw new Error(`Unknown provider: ${providerId}`)
  }
}
