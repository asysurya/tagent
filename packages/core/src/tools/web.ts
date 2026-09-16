import type { ToolDefinition } from '../types'
import { decodeEntities, htmlToText, trunc } from '../util'

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const MAX_TEXT = 20_000

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description:
    'Fetch a URL and return readable text (HTML is stripped) or raw JSON. Max ~20KB. Use for docs, APIs, and raw files.',
  risk: 'low',
  params: { url: 'string (required) — http(s) URL', raw: 'boolean — return raw body without HTML stripping' },
  async run(input) {
    const url = String(input.url ?? '')
    if (!/^https?:\/\//.test(url)) return 'Error: url must start with http(s)://'
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/json,text/plain,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return `HTTP ${res.status} ${res.statusText} — ${url}`
    const ct = res.headers.get('content-type') ?? ''
    const body = await res.text()
    if (input.raw === true || ct.includes('json') || ct.includes('text/plain')) {
      return trunc(body, MAX_TEXT)
    }
    if (ct.includes('html')) {
      const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim()
      const text = htmlToText(body)
      return trunc(`${title ? `# ${decodeEntities(title)}\n\n` : ''}${text}`, MAX_TEXT)
    }
    return `Content-Type ${ct} — not text.`
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
  async run(input) {
    const q = String(input.query ?? '')
    if (!q.trim()) return 'Error: query is required'
    const max = Math.min(Number(input.max ?? 5), 10)
    let html = ''
    try {
      const res = await fetch('https://html.duckduckgo.com/html/', {
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
      return `Error: search failed — ${(e as Error).message}`
    }
    let hits = parseDDGHtml(html)
    if (hits.length === 0) {
      // fallback: lite endpoint
      try {
        const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, {
          headers: { 'user-agent': UA },
          signal: AbortSignal.timeout(15_000),
        })
        hits = parseDDGHtml(await res.text())
      } catch { /* ignore */ }
    }
    if (hits.length === 0) return `No results for "${q}" (DuckDuckGo may be rate-limiting — try again or use web_fetch on a specific URL).`
    return hits
      .slice(0, max)
      .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`)
      .join('\n\n')
  },
}
