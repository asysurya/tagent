/**
 * Tagent provider registry — opencode-style catalog.
 *
 * Every known provider lives here as data: endpoint, auth env vars, docs URL
 * and a few seed models. Live model discovery (`GET /models`) fills the rest
 * and is cached in ~/.tagent/models.json (refreshed explicitly via the GUI,
 * the TUI `/model refresh` command or `tagent models --refresh`).
 *
 * API keys resolve in this order: config (~/.tagent + workspace) first, then
 * the provider's env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) — so
 * `export OPENAI_API_KEY=…` just works, like opencode.
 *
 * Anything not in the catalog can still be added as a custom provider
 * (Settings → Providers → Add custom), pointing at any OpenAI-compatible,
 * Anthropic-compatible or Google-compatible endpoint.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { CustomProviderConfig, ModelInfo, TagentConfig } from '../types'
import { GLOBAL_DIR } from '../config'

export type AdapterKind = 'openai' | 'anthropic' | 'google'

export interface CatalogEntry {
  id: string
  label: string
  /** which wire protocol the endpoint speaks */
  kind: AdapterKind
  baseUrl: string
  docsUrl: string
  /** env vars checked (in order) when no key is stored in config */
  envVars: string[]
  /** false for local runtimes that need no auth (ollama, vllm, llamacpp…) */
  needsKey: boolean
  /** endpoint exposes a model list we can discover */
  listable: boolean
  /** featured in the UI picker */
  popular?: boolean
  /** static seed models — discovery adds more */
  models: ModelInfo[]
}

const m = (id: string, label: string, p: string): ModelInfo => ({ id, label, provider: p })

export const CATALOG: CatalogEntry[] = [
  /* ---------------- big three ---------------- */
  {
    id: 'openai', label: 'OpenAI', kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    docsUrl: 'https://platform.openai.com/api-keys',
    envVars: ['OPENAI_API_KEY'], needsKey: true, listable: true, popular: true,
    models: [
      m('gpt-5', 'GPT-5', 'openai'),
      m('gpt-5-mini', 'GPT-5 Mini', 'openai'),
      m('gpt-4.1', 'GPT-4.1', 'openai'),
      m('gpt-4o', 'GPT-4o', 'openai'),
      m('o3', 'o3 (reasoning)', 'openai'),
    ],
  },
  {
    id: 'anthropic', label: 'Anthropic', kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    envVars: ['ANTHROPIC_API_KEY'], needsKey: true, listable: true, popular: true,
    models: [
      m('claude-sonnet-4-5', 'Claude Sonnet 4.5', 'anthropic'),
      m('claude-haiku-4-5', 'Claude Haiku 4.5', 'anthropic'),
      m('claude-opus-4-1', 'Claude Opus 4.1', 'anthropic'),
      m('claude-3-7-sonnet-latest', 'Claude 3.7 Sonnet', 'anthropic'),
      m('claude-3-5-haiku-latest', 'Claude 3.5 Haiku (fast)', 'anthropic'),
    ],
  },
  {
    id: 'google', label: 'Google Gemini', kind: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com',
    docsUrl: 'https://aistudio.google.com/apikey',
    envVars: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'],
    needsKey: true, listable: true, popular: true,
    models: [
      m('gemini-2.5-pro', 'Gemini 2.5 Pro', 'google'),
      m('gemini-2.5-flash', 'Gemini 2.5 Flash', 'google'),
      m('gemini-2.0-flash', 'Gemini 2.0 Flash', 'google'),
    ],
  },

  /* ---------------- aggregators ---------------- */
  {
    id: 'openrouter', label: 'OpenRouter', kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    docsUrl: 'https://openrouter.ai/keys',
    envVars: ['OPENROUTER_API_KEY'], needsKey: true, listable: true, popular: true,
    models: [
      m('anthropic/claude-sonnet-4.5', 'Claude Sonnet 4.5 (OR)', 'openrouter'),
      m('openai/gpt-5', 'GPT-5 (OR)', 'openrouter'),
      m('google/gemini-2.5-pro', 'Gemini 2.5 Pro (OR)', 'openrouter'),
      m('deepseek/deepseek-chat-v3.1', 'DeepSeek V3.1 (OR)', 'openrouter'),
      m('qwen/qwen3-coder', 'Qwen3 Coder (OR)', 'openrouter'),
    ],
  },
  {
    id: 'vercel-ai-gateway', label: 'Vercel AI Gateway', kind: 'openai',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    docsUrl: 'https://vercel.com/ai-gateway',
    envVars: ['VERCEL_AI_GATEWAY_API_KEY', 'AI_GATEWAY_API_KEY'],
    needsKey: true, listable: true,
    models: [
      m('openai/gpt-5', 'GPT-5 (gateway)', 'vercel-ai-gateway'),
      m('anthropic/claude-sonnet-4.5', 'Sonnet 4.5 (gateway)', 'vercel-ai-gateway'),
      m('google/gemini-2.5-pro', 'Gemini 2.5 Pro (gateway)', 'vercel-ai-gateway'),
    ],
  },
  {
    id: 'glama', label: 'Glama', kind: 'openai',
    baseUrl: 'https://api.glama.ai/v1',
    docsUrl: 'https://glama.ai/settings/api-keys',
    envVars: ['GLAMA_API_KEY'], needsKey: true, listable: true,
    models: [m('openai/gpt-4o', 'GPT-4o (Glama)', 'glama')],
  },
  {
    id: 'aihubmix', label: 'AIHubMix', kind: 'openai',
    baseUrl: 'https://aihubmix.com/v1',
    docsUrl: 'https://aihubmix.com/token',
    envVars: ['AIHUBMIX_API_KEY'], needsKey: true, listable: true,
    models: [
      m('gpt-5', 'GPT-5 (AIHubMix)', 'aihubmix'),
      m('claude-sonnet-4-5', 'Sonnet 4.5 (AIHubMix)', 'aihubmix'),
    ],
  },

  /* ---------------- fast / cheap clouds ---------------- */
  {
    id: 'groq', label: 'Groq', kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    docsUrl: 'https://console.groq.com/keys',
    envVars: ['GROQ_API_KEY'], needsKey: true, listable: true, popular: true,
    models: [
      m('llama-3.3-70b-versatile', 'Llama 3.3 70B (Groq)', 'groq'),
      m('llama-3.1-8b-instant', 'Llama 3.1 8B instant (Groq)', 'groq'),
      m('openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)', 'groq'),
      m('moonshotai/kimi-k2-instruct', 'Kimi K2 (Groq)', 'groq'),
    ],
  },
  {
    id: 'xai', label: 'xAI (Grok)', kind: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    docsUrl: 'https://console.x.ai',
    envVars: ['XAI_API_KEY', 'GROK_API_KEY'], needsKey: true, listable: true, popular: true,
    models: [
      m('grok-4', 'Grok 4', 'xai'),
      m('grok-4-fast-reasoning', 'Grok 4 Fast', 'xai'),
      m('grok-code-fast-1', 'Grok Code Fast', 'xai'),
    ],
  },
  {
    id: 'deepseek', label: 'DeepSeek', kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    docsUrl: 'https://platform.deepseek.com/api_keys',
    envVars: ['DEEPSEEK_API_KEY'], needsKey: true, listable: true, popular: true,
    models: [
      m('deepseek-chat', 'DeepSeek V3 chat', 'deepseek'),
      m('deepseek-reasoner', 'DeepSeek R1 reasoner', 'deepseek'),
    ],
  },
  {
    id: 'mistral', label: 'Mistral', kind: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    docsUrl: 'https://console.mistral.ai/api-keys',
    envVars: ['MISTRAL_API_KEY'], needsKey: true, listable: true, popular: true,
    models: [
      m('mistral-large-latest', 'Mistral Large', 'mistral'),
      m('mistral-medium-latest', 'Mistral Medium', 'mistral'),
      m('codestral-latest', 'Codestral', 'mistral'),
      m('ministral-8b-latest', 'Ministral 8B', 'mistral'),
    ],
  },
  {
    id: 'perplexity', label: 'Perplexity', kind: 'openai',
    baseUrl: 'https://api.perplexity.ai',
    docsUrl: 'https://www.perplexity.ai/settings/api',
    envVars: ['PERPLEXITY_API_KEY'], needsKey: true, listable: false,
    models: [
      m('sonar-pro', 'Sonar Pro (search)', 'perplexity'),
      m('sonar', 'Sonar (search)', 'perplexity'),
      m('sonar-reasoning-pro', 'Sonar Reasoning Pro', 'perplexity'),
      m('sonar-deep-research', 'Sonar Deep Research', 'perplexity'),
    ],
  },
  {
    id: 'cohere', label: 'Cohere', kind: 'openai',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    docsUrl: 'https://dashboard.cohere.com/api-keys',
    envVars: ['COHERE_API_KEY'], needsKey: true, listable: true,
    models: [
      m('command-a-03-2025', 'Command A', 'cohere'),
      m('command-r-08-2024', 'Command R', 'cohere'),
    ],
  },
  {
    id: 'ai21', label: 'AI21', kind: 'openai',
    baseUrl: 'https://api.ai21.com/studio/v1',
    docsUrl: 'https://console.ai21.com/settings/api-key',
    envVars: ['AI21_API_KEY'], needsKey: true, listable: true,
    models: [
      m('jamba-large-1.7', 'Jamba Large 1.7', 'ai21'),
      m('jamba-mini-1.7', 'Jamba Mini 1.7', 'ai21'),
    ],
  },

  /* ---------------- GPU clouds / marketplaces ---------------- */
  {
    id: 'together', label: 'Together', kind: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    docsUrl: 'https://api.together.ai/settings/api-keys',
    envVars: ['TOGETHER_API_KEY'], needsKey: true, listable: true,
    models: [
      m('deepseek-ai/DeepSeek-V3', 'DeepSeek V3 (Together)', 'together'),
      m('meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Llama 3.3 70B (Together)', 'together'),
      m('Qwen/Qwen2.5-Coder-32B-Instruct-Turbo', 'Qwen2.5 Coder 32B (Together)', 'together'),
    ],
  },
  {
    id: 'fireworks', label: 'Fireworks', kind: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    docsUrl: 'https://fireworks.ai/settings/users',
    envVars: ['FIREWORKS_API_KEY'], needsKey: true, listable: true,
    models: [
      m('accounts/fireworks/models/kimi-k2-instruct', 'Kimi K2 (Fireworks)', 'fireworks'),
      m('accounts/fireworks/models/llama-v3p3-70b-instruct', 'Llama 3.3 70B (Fireworks)', 'fireworks'),
    ],
  },
  {
    id: 'cerebras', label: 'Cerebras', kind: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    docsUrl: 'https://cloud.cerebras.ai',
    envVars: ['CEREBRAS_API_KEY'], needsKey: true, listable: true,
    models: [
      m('llama3.3-70b', 'Llama 3.3 70B (Cerebras)', 'cerebras'),
      m('gpt-oss-120b', 'GPT-OSS 120B (Cerebras)', 'cerebras'),
      m('qwen-3-235b-a22b-instruct-2507', 'Qwen3 235B (Cerebras)', 'cerebras'),
    ],
  },
  {
    id: 'deepinfra', label: 'DeepInfra', kind: 'openai',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    docsUrl: 'https://deepinfra.com/dashboards/api',
    envVars: ['DEEPINFRA_API_KEY'], needsKey: true, listable: true,
    models: [m('deepseek-ai/DeepSeek-V3-0324', 'DeepSeek V3 (DeepInfra)', 'deepinfra')],
  },
  {
    id: 'nebius', label: 'Nebius', kind: 'openai',
    baseUrl: 'https://api.studio.nebius.ai/v1',
    docsUrl: 'https://studio.nebius.ai/settings/api-keys',
    envVars: ['NEBIUS_API_KEY'], needsKey: true, listable: true,
    models: [m('deepseek-ai/DeepSeek-V3', 'DeepSeek V3 (Nebius)', 'nebius')],
  },
  {
    id: 'novita', label: 'Novita', kind: 'openai',
    baseUrl: 'https://api.novita.ai/v3/openai',
    docsUrl: 'https://novita.ai/dashboard/settings/api',
    envVars: ['NOVITA_API_KEY'], needsKey: true, listable: true,
    models: [
      m('deepseek/deepseek-v3.1-turbo', 'DeepSeek V3.1 Turbo (Novita)', 'novita'),
      m('qwen/qwen3-235b-a22b', 'Qwen3 235B (Novita)', 'novita'),
    ],
  },
  {
    id: 'hyperbolic', label: 'Hyperbolic', kind: 'openai',
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    docsUrl: 'https://app.hyperbolic.xyz/settings',
    envVars: ['HYPERBOLIC_API_KEY'], needsKey: true, listable: true,
    models: [m('deepseek-ai/DeepSeek-V3', 'DeepSeek V3 (Hyperbolic)', 'hyperbolic')],
  },
  {
    id: 'baseten', label: 'Baseten', kind: 'openai',
    baseUrl: 'https://inference.baseten.co/v1',
    docsUrl: 'https://www.baseten.co/dashboard/',
    envVars: ['BASETEN_API_KEY'], needsKey: true, listable: true,
    models: [m('deepseek-ai/DeepSeek-V3-0324', 'DeepSeek V3 (Baseten)', 'baseten')],
  },
  {
    id: 'featherless', label: 'Featherless', kind: 'openai',
    baseUrl: 'https://api.featherless.ai/v1',
    docsUrl: 'https://featherless.ai/account/api-keys',
    envVars: ['FEATHERLESS_API_KEY'], needsKey: true, listable: true,
    models: [],
  },
  {
    id: 'nvidia', label: 'NVIDIA NIM', kind: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    docsUrl: 'https://build.nvidia.com/settings/api-keys',
    envVars: ['NVIDIA_API_KEY', 'NVIDIA_NIM_API_KEY'], needsKey: true, listable: true,
    models: [
      m('nvidia/llama-3.3-nemotron-super-49b-v1', 'Nemotron Super 49B', 'nvidia'),
      m('nvidia/llama-3.1-nemotron-70b-instruct', 'Nemotron 70B', 'nvidia'),
    ],
  },
  {
    id: 'turing', label: 'Turing', kind: 'openai',
    baseUrl: 'https://api.turing.ai/ml-services/v1',
    docsUrl: 'https://turing.ai/settings/api-keys',
    envVars: ['TURING_API_KEY'], needsKey: true, listable: true,
    models: [],
  },

  /* ---------------- China / APAC ---------------- */
  {
    id: 'qwen', label: 'Qwen (DashScope)', kind: 'openai',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    docsUrl: 'https://bailian.console.alibabacloud.com/?apiKey=1',
    envVars: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'], needsKey: true, listable: true, popular: true,
    models: [
      m('qwen3-max', 'Qwen3 Max', 'qwen'),
      m('qwen3-coder-plus', 'Qwen3 Coder+', 'qwen'),
      m('qwen-plus', 'Qwen Plus', 'qwen'),
      m('qwen-turbo', 'Qwen Turbo', 'qwen'),
    ],
  },
  {
    id: 'moonshot', label: 'Moonshot (Kimi)', kind: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    docsUrl: 'https://platform.moonshot.ai/console/api-keys',
    envVars: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'], needsKey: true, listable: true,
    models: [
      m('kimi-k2-0905-preview', 'Kimi K2', 'moonshot'),
      m('kimi-k2-turbo-preview', 'Kimi K2 Turbo', 'moonshot'),
    ],
  },
  {
    id: 'zhipu', label: 'Zhipu (open.bigmodel.cn)', kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    envVars: ['ZHIPU_API_KEY', 'GLM_API_KEY'], needsKey: true, listable: true, popular: true,
    models: [
      m('glm-4.6', 'GLM-4.6', 'zhipu'),
      m('glm-4.5-air', 'GLM-4.5 Air', 'zhipu'),
      m('glm-4.5v', 'GLM-4.5V (vision)', 'zhipu'),
    ],
  },
  {
    id: 'zai-api', label: 'Z.ai API (api.z.ai)', kind: 'openai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    docsUrl: 'https://z.ai/manage-apikey/apikey',
    envVars: ['ZAI_API_KEY'], needsKey: true, listable: true,
    models: [
      m('glm-4.6', 'GLM-4.6 (Z.ai)', 'zai-api'),
      m('glm-4.5-air', 'GLM-4.5 Air (Z.ai)', 'zai-api'),
    ],
  },
  {
    id: 'siliconflow', label: 'SiliconFlow', kind: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    docsUrl: 'https://cloud.siliconflow.cn/account/ak',
    envVars: ['SILICONFLOW_API_KEY'], needsKey: true, listable: true,
    models: [
      m('Qwen/Qwen3-235B-A22B', 'Qwen3 235B (SF)', 'siliconflow'),
      m('deepseek-ai/DeepSeek-V3.1', 'DeepSeek V3.1 (SF)', 'siliconflow'),
    ],
  },
  {
    id: 'volcengine', label: 'Volcengine Ark (Doubao)', kind: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    docsUrl: 'https://console.volcengine.com/ark',
    envVars: ['ARK_API_KEY', 'VOLCENGINE_API_KEY'], needsKey: true, listable: true,
    models: [
      m('doubao-seed-1-6-250615', 'Doubao Seed 1.6', 'volcengine'),
      m('doubao-1-5-pro-32k-250115', 'Doubao 1.5 Pro', 'volcengine'),
    ],
  },
  {
    id: 'byteplus', label: 'BytePlus ModelArk', kind: 'openai',
    baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    docsUrl: 'https://console.byteplus.com/ark',
    envVars: ['BYTEPLUS_ARK_API_KEY'], needsKey: true, listable: true,
    models: [m('doubao-seed-1-6-250615', 'Doubao Seed 1.6 (BytePlus)', 'byteplus')],
  },

  /* ---------------- European ---------------- */
  {
    id: 'ovh', label: 'OVHcloud AI Endpoints', kind: 'openai',
    baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    docsUrl: 'https://endpoints.ai.cloud.ovh.net/',
    envVars: ['OVH_AI_ENDPOINTS_ACCESS_TOKEN'], needsKey: true, listable: true,
    models: [],
  },
  {
    id: 'scaleway', label: 'Scaleway Generative APIs', kind: 'openai',
    baseUrl: 'https://api.scaleway.ai/v1',
    docsUrl: 'https://www.scaleway.com/en/docs/ai-gateway/',
    envVars: ['SCW_SECRET_KEY', 'SCALEWAY_API_KEY'], needsKey: true, listable: true,
    models: [],
  },

  /* ---------------- GitHub / local ---------------- */
  {
    id: 'github-models', label: 'GitHub Models', kind: 'openai',
    baseUrl: 'https://models.github.ai/inference',
    docsUrl: 'https://github.com/marketplace/models',
    envVars: ['GITHUB_TOKEN', 'GH_TOKEN'], needsKey: true, listable: true,
    models: [
      m('openai/gpt-4o', 'GPT-4o (GitHub)', 'github-models'),
      m('openai/gpt-4.1', 'GPT-4.1 (GitHub)', 'github-models'),
    ],
  },
  {
    id: 'ollama', label: 'Ollama (local)', kind: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    docsUrl: 'https://ollama.com/library',
    envVars: [], needsKey: false, listable: true, popular: true,
    models: [
      m('qwen3:8b', 'Qwen3 8B (local)', 'ollama'),
      m('llama3.2', 'Llama 3.2 (local)', 'ollama'),
      m('devstral', 'Devstral (local)', 'ollama'),
    ],
  },
  {
    id: 'lmstudio', label: 'LM Studio (local)', kind: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    docsUrl: 'https://lmstudio.ai',
    envVars: ['LMSTUDIO_API_KEY'], needsKey: false, listable: true,
    models: [],
  },
  {
    id: 'vllm', label: 'vLLM (local)', kind: 'openai',
    baseUrl: 'http://127.0.0.1:8000/v1',
    docsUrl: 'https://docs.vllm.ai',
    envVars: [], needsKey: false, listable: true,
    models: [],
  },
  {
    id: 'llamacpp', label: 'llama.cpp (local)', kind: 'openai',
    baseUrl: 'http://127.0.0.1:8080/v1',
    docsUrl: 'https://github.com/ggml-org/llama.cpp',
    envVars: [], needsKey: false, listable: true,
    models: [],
  },
]

export function catalogById(id: string): CatalogEntry | undefined {
  return CATALOG.find((c) => c.id === id)
}

/* ------------------------------------------------------------------ */
/* API key resolution — config first, env second                        */
/* ------------------------------------------------------------------ */

/** Config-stored key wins; otherwise the first env var that is set. */
export function resolveApiKey(entry: CatalogEntry, cfg: TagentConfig): string {
  const stored = cfg?.apiKeys?.[entry.id]
  if (stored) return stored
  for (const v of entry.envVars) {
    const val = process.env[v]
    if (val) return val
  }
  return ''
}

/* ------------------------------------------------------------------ */
/* model reference parsing — "provider/model" like opencode             */
/* ------------------------------------------------------------------ */

export interface ModelRef {
  provider: string
  model: string
}

/**
 * Parse `provider/model` (opencode style) or `provider:model` (legacy TUI
 * style). The first segment is only treated as a provider id when it is one
 * we know — OpenRouter model ids like `openai/gpt-5` then stay intact when
 * the current provider is openrouter.
 */
export function parseModelRef(ref: string, cfg: TagentConfig): ModelRef | null {
  const sep = ref.includes('/') ? '/' : ref.includes(':') ? ':' : ''
  if (!sep) return null
  const [prov, ...rest] = ref.split(sep)
  if (!prov || !rest.length) return null
  const known =
    prov === 'zai' ||
    catalogById(prov) !== undefined ||
    (cfg?.customProviders ?? []).some((c) => c.id === prov)
  if (!known) return null
  return { provider: prov, model: rest.join(sep) }
}

/* ------------------------------------------------------------------ */
/* model discovery + cache (~/.tagent/models.json)                      */
/* ------------------------------------------------------------------ */

interface ModelCache {
  at: number
  providers: Record<string, string[]>
}

function cacheFile(): string {
  return path.join(GLOBAL_DIR, 'models.json')
}

export function readModelCache(): Record<string, string[]> {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) as ModelCache
    return raw?.providers ?? {}
  } catch {
    return {}
  }
}

function writeModelCache(providers: Record<string, string[]>): void {
  try {
    fs.mkdirSync(GLOBAL_DIR, { recursive: true })
    fs.writeFileSync(cacheFile(), JSON.stringify({ at: Date.now(), providers }, null, 2))
  } catch {
    /* best-effort */
  }
}

/** ids that are clearly not chat models — never shown as pickable */
const NON_CHAT = /embed|whisper|tts|rerank|moderation|guard|image|dall-e|flux|sdxl|stable-diffusion|sora|veo|imagen|voice|audio|video|clip|vision-encoder|guardrail|bge-|e5-|gte-/i

export function cleanModelIds(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    const s = String(id ?? '').trim()
    if (!s || seen.has(s) || NON_CHAT.test(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out.sort((a, b) => a.localeCompare(b)).slice(0, 80)
}

/** Fetch the live model list from one provider. Never throws. */
async function fetchProviderModels(
  kind: AdapterKind,
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  const headers: Record<string, string> = {}
  let url = ''
  if (kind === 'openai') {
    url = `${baseUrl.replace(/\/$/, '')}/models`
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
  } else if (kind === 'anthropic') {
    url = `${baseUrl.replace(/\/$/, '')}/v1/models`
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    url = `${baseUrl.replace(/\/$/, '')}/v1beta/models`
    headers['x-goog-api-key'] = apiKey
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json: any = await res.json()
  let ids: string[] = []
  if (kind === 'google') {
    const models: any[] = json?.models ?? []
    ids = models
      .filter((mm) => (mm?.supportedGenerationMethods ?? ['generateContent']).includes('generateContent'))
      .map((mm) => String(mm?.name ?? '').replace(/^models\//, ''))
  } else {
    const data: any[] = json?.data ?? (Array.isArray(json) ? json : [])
    ids = data.map((d) => (typeof d === 'string' ? d : String(d?.id ?? '')))
  }
  return cleanModelIds(ids)
}

export interface DiscoveryResult {
  updated: string[]
  failed: string[]
  models: Record<string, string[]>
}

/**
 * Discover models for every listable provider that has a key (catalog +
 * customs). Updates ~/.tagent/models.json. Parallel, per-provider failures
 * are collected, never thrown.
 */
export async function refreshModelCache(cfg: TagentConfig): Promise<DiscoveryResult> {
  const cache = readModelCache()
  const jobs: { id: string; kind: AdapterKind; baseUrl: string; key: string }[] = []

  for (const entry of CATALOG) {
    if (!entry.listable) continue
    // local runtimes need no key, but an optional key (env/config) is sent anyway
    const key = resolveApiKey(entry, cfg)
    if (entry.needsKey && !key) continue
    jobs.push({ id: entry.id, kind: entry.kind, baseUrl: entry.baseUrl, key })
  }
  for (const cp of cfg.customProviders ?? []) {
    if (cp.baseUrl) jobs.push({ id: cp.id, kind: cp.kind ?? 'openai', baseUrl: cp.baseUrl, key: cp.apiKey ?? resolveApiKeyForCustom(cp, cfg) })
  }

  const settled = await Promise.allSettled(
    jobs.map((j) => fetchProviderModels(j.kind, j.baseUrl, j.key)),
  )

  const updated: string[] = []
  const failed: string[] = []
  settled.forEach((r, i) => {
    const job = jobs[i]
    if (r.status === 'fulfilled' && r.value.length) {
      cache[job.id] = r.value
      updated.push(job.id)
    } else if (r.status === 'rejected') {
      failed.push(job.id)
      // keep whatever was cached before on failure
    }
  })
  writeModelCache(cache)
  return { updated, failed, models: cache }
}

/** Custom providers can also read their key from cfg.apiKeys[cp.id]. */
function resolveApiKeyForCustom(cp: CustomProviderConfig, cfg: TagentConfig): string {
  return cp.apiKey || cfg?.apiKeys?.[cp.id] || ''
}

/** Seed models + cached discovery, deduped — seeds keep their labels first. */
export function modelsFor(entry: CatalogEntry): ModelInfo[] {
  const seeds = entry.models
  const discovered = (readModelCache()[entry.id] ?? []).filter((id) => !seeds.some((s) => s.id === id))
  return [
    ...seeds,
    ...discovered.map((id) => ({ id, label: id, provider: entry.id })),
  ]
}

/** Same merge for custom providers. */
export function modelsForCustom(cp: CustomProviderConfig): ModelInfo[] {
  const seeds = cp.models ?? []
  const discovered = (readModelCache()[cp.id] ?? []).filter((id) => !seeds.includes(id))
  return [
    ...seeds.map((id) => ({ id, label: id, provider: cp.id })),
    ...discovered.map((id) => ({ id, label: id, provider: cp.id })),
  ]
}
