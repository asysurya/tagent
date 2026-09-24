import type { ToolContext, ToolDefinition } from '../types'
import { decodeEntities, htmlToText, trunc } from '../util'
import { bumpStat, webCacheGet, webCacheSet, webTtlMs } from '../cache'

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const MAX_TEXT = 20_000

/**
 * TLS-resilient fetch. Some networks (captive portals, corporate MITM proxies,
 * broken clocks) present certificates Bun cannot verify — the classic
 * "unknown certificate verification error". On such failures we retry ONCE
 * with verification relaxed (tagent tools already run behind a permission
 * gate). TAGENT_TLS_SKIP=1 forces relaxed mode from the start.
 */
async function resilientFetch(url: string, init: RequestInit): Promise<Response> {
  const relaxed = () =>
    fetch(url, { ...init, tls: { rejectUnauthorized: false } } as RequestInit & {
      tls: { rejectUnauthorized: boolean }
    })
  if (process.env.TAGENT_TLS_SKIP === '1') return relaxed()
  try {
    return await fetch(url, init)
  } catch (e) {
    const msg = `${(e as Error)?.message ?? e}`
    if (/certificate|CERT_|tls|ssl|handshake/i.test(msg)) return relaxed()
    throw e
  }
}

function isTlsError(e: unknown): boolean {
  return /certificate|CERT_|tls|ssl|handshake/i.test(`${(e as Error)?.message ?? e}`)
}

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description:
    'Fetch a URL and return readable text (HTML is stripped) or raw JSON. Max ~20KB. Use for docs, APIs, and raw files.',
  risk: 'low',
  params: { url: 'string (required) — http(s) URL', raw: 'boolean — return raw body without HTML stripping' },
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http(s) URL to fetch' },
      raw: { type: 'boolean', description: 'Return raw body without HTML stripping' },
    },
    required: ['url'],
  },
  async run(input, ctx) {
    const url = String(input.url ?? '')
    if (!/^https?:\/\//.test(url)) return 'Error: url must start with http(s)://'
    // TTL cache — same URL twice in a session = one network round-trip
    const ttl = webTtlMs(ctx.config?.cache?.webTtlMin)
    const key = `fetch:${input.raw === true ? 'raw' : 'text'}:${url}`
    if (ctx.config?.cache?.web !== false) {
      const hit = webCacheGet(key, ttl)
      if (hit !== undefined) {
        bumpStat('webHits')
        return `[cached, fetched less than ${Math.round(ttl / 60000)} min ago — network saved]\n${hit}`
      }
    }
    bumpStat('webMisses')
    const res = await resilientFetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/json,text/plain,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return `HTTP ${res.status} ${res.statusText} — ${url}`
    const ct = res.headers.get('content-type') ?? ''
    const body = await res.text()
    let out: string
    if (input.raw === true || ct.includes('json') || ct.includes('text/plain')) {
      out = trunc(body, MAX_TEXT)
    } else if (ct.includes('html')) {
      const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim()
      const text = htmlToText(body)
      out = trunc(`${title ? `# ${decodeEntities(title)}\n\n` : ''}${text}`, MAX_TEXT)
    } else {
      return `Content-Type ${ct} — not text.`
    }
    if (ctx.config?.cache?.web !== false && ttl > 0) webCacheSet(key, out)
    return out
  },
}

interface DDGHit {
  title: string
  url: string
  snippet: string
}

function parseDDGHtml(html: string): DDGHit[] {
  const hits: DDGHit[] = []
  const blockRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(html)) && hits.length < 10) {
    let url = decodeEntities(m[1])
    const dd = /uddg=([^&]+)/.exec(url)
    if (dd) {
      try { url = decodeURIComponent(dd[1]) } catch { /* keep raw */ }
    }
    const title = htmlToText(m[2])
    hits.push({ title, url, snippet: '' })
  }
  // attach snippets
  const snipRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/g
  let s: RegExpExecArray | null
  let i = 0
  while ((s = snipRe.exec(html)) && i < hits.length) {
    hits[i].snippet = htmlToText(s[1]).slice(0, 300)
    i++
  }
  return hits
}

export const ddgSearchTool: ToolDefinition = {
  name: 'ddg_search',
  description:
    'Search the web with DuckDuckGo (no API key needed). Returns top results with title, URL, and snippet. Good for finding docs and error solutions.',
  risk: 'low',
  params: { query: 'string (required)', max: 'number — max results (default 5, max 10)' },
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      max: { type: 'number', description: 'Max results (default 5, max 10)' },
    },
    required: ['query'],
  },
  async run(input, ctx) {
    const q = String(input.query ?? '')
    if (!q.trim()) return 'Error: query is required'
    const max = Math.min(Number(input.max ?? 5), 10)
    // TTL cache — identical searches within the window don't re-hit DuckDuckGo
    const ttl = webTtlMs(ctx.config?.cache?.webTtlMin)
    const key = `ddg:${max}:${q}`
    if (ctx.config?.cache?.web !== false) {
      const hit = webCacheGet(key, ttl)
      if (hit !== undefined) {
        bumpStat('webHits')
        return `[cached — results from the last ${Math.round(ttl / 60000)} min]\n${hit}`
      }
    }
    bumpStat('webMisses')
    let html = ''
    try {
      const res = await resilientFetch('https://html.duckduckgo.com/html/', {
        method: 'POST',
        headers: {
          'user-agent': UA,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'text/html',
        },
        body: new URLSearchParams({ q }).toString(),
        signal: AbortSignal.timeout(15_000),
      })
      html = await res.text()
    } catch (e) {
      if (isTlsError(e)) {
        return `Error: search failed — the network's TLS certificate for duckduckgo.com could not be verified even with the built-in retry. Set TAGENT_TLS_SKIP=1 or fix the system clock / proxy CA, then retry.`
      }
      return `Error: search failed — ${(e as Error).message}`
    }
    let hits = parseDDGHtml(html)
    if (hits.length === 0) {
      // fallback: lite endpoint
      try {
        const res = await resilientFetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, {
          headers: { 'user-agent': UA },
          signal: AbortSignal.timeout(15_000),
        })
        hits = parseDDGHtml(await res.text())
      } catch { /* ignore */ }
    }
    if (hits.length === 0) return `No results for "${q}" (DuckDuckGo may be rate-limiting — try again or use web_fetch on a specific URL).`
    const out = hits
      .slice(0, max)
      .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`)
      .join('\n\n')
    if (ctx.config?.cache?.web !== false && ttl > 0) webCacheSet(key, out)
    return out
  },
}
