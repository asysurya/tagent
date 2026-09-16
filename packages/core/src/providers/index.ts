import type { CustomProviderConfig, ModelInfo, Role, TagentConfig } from '../types'

export interface CompletionRequest {
  messages: { role: Role; content: string }[]
  model: string
  signal?: AbortSignal
  maxTokens?: number
  temperature?: number
}

export interface ProviderAdapter {
  id: string
  label: string
  models: ModelInfo[]
  complete(req: CompletionRequest): Promise<string>
}

/* ------------------------------------------------------------------ */

/** OpenAI-compatible adapter — covers OpenAI, OpenRouter, Groq, Ollama, LM Studio, … */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  constructor(
    public id: string,
    public label: string,
    private baseUrl: string,
    private apiKey: string,
    public models: ModelInfo[],
  ) {}

  async complete(req: CompletionRequest): Promise<string> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: req.signal,
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        max_tokens: req.maxTokens ?? 8192,
        temperature: req.temperature ?? 0.2,
        stream: false,
      }),
    })
    if (!res.ok) {
      throw new Error(`${this.label} HTTP ${res.status}: ${truncBody(await res.text())}`)
    }
    const json = (await res.json()) as any
    const text = json?.choices?.[0]?.message?.content
    if (typeof text !== 'string') throw new Error(`${this.label}: empty completion`)
    return text
  }
}

function truncBody(s: string): string {
  return s.slice(0, 400).replace(/\s+/g, ' ')
}

/* ------------------------------------------------------------------ */

/** Anthropic Messages API adapter. */
export class AnthropicAdapter implements ProviderAdapter {
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
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const rest = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: req.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: req.model,
        system: system || undefined,
        messages: rest,
        max_tokens: req.maxTokens ?? 8192,
        temperature: req.temperature ?? 0.2,
      }),
    })
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${truncBody(await res.text())}`)
    const json = (await res.json()) as any
    const text = (json?.content ?? [])
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text)
      .join('\n')
    if (!text) throw new Error('Anthropic: empty completion')
    return text
  }
}

/* ------------------------------------------------------------------ */

/** Google Gemini adapter (Generative Language API). */
export class GoogleAdapter implements ProviderAdapter {
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
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const rest = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        signal: req.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          contents: rest,
          generationConfig: {
            maxOutputTokens: req.maxTokens ?? 8192,
            temperature: req.temperature ?? 0.2,
          },
        }),
      },
    )
    if (!res.ok) throw new Error(`Google HTTP ${res.status}: ${truncBody(await res.text())}`)
    const json = (await res.json()) as any
    const text = (json?.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p?.text ?? '')
      .join('')
    if (!text) throw new Error('Google: empty completion')
    return text
  }
}

/* ------------------------------------------------------------------ */

/** Z.ai built-in adapter (sandbox / z.ai environments). No key required. */
export class ZaiAdapter implements ProviderAdapter {
  id = 'zai'
  label = 'Z.ai (built-in)'
  models: ModelInfo[] = [
    { id: 'glm-4.7', label: 'GLM-4.7 (default)', provider: 'zai' },
    { id: 'glm-4.6', label: 'GLM-4.6', provider: 'zai' },
  ]
  private zai: any = null

  async complete(req: CompletionRequest): Promise<string> {
    if (!this.zai) {
      const mod: any = await import('z-ai-web-dev-sdk')
      const ZAI = mod.default
      this.zai = await ZAI.create()
    }
    // The SDK expects the system prompt as an 'assistant' message.
    const messages = req.messages.map((m) =>
      m.role === 'system' ? { role: 'assistant', content: m.content } : m,
    )
    const completion = await this.zai.chat.completions.create({
      messages,
      thinking: { type: 'disabled' },
    })
    const text = completion?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text) throw new Error('Z.ai: empty completion')
    return text
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
