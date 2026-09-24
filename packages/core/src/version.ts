/**
 * Tagent version + update check.
 *
 * The daemon checks for a newer release on startup (and at most once a day —
 * the result is cached in ~/.tagent/update-check.json). A stale version only
 * ever prints a warning: Tagent stays fully usable.
 *
 * Endpoints, tried in order until one answers — raw.githubusercontent is
 * unreliable on many networks (DNS-hijacking ISPs, slow peering), so the
 * check never depends on a single host:
 *   1. TAGENT_UPDATE_URL (explicit override)
 *   2. website/public/latest.json on GitHub (raw)
 *   3. the same file via jsDelivr's CDN (fast in Asia, rarely blocked)
 *   4. the GitHub releases API (api.github.com — no auth for public repos)
 */
import fs from 'node:fs'
import path from 'node:path'
import { GLOBAL_DIR } from './config'

export const CURRENT_VERSION = '0.28.0'

const REPO_SLUG = 'asysurya/tagent'

const LATEST_JSON_URLS = [
  `https://raw.githubusercontent.com/${REPO_SLUG}/main/website/public/latest.json`,
  `https://cdn.jsdelivr.net/gh/${REPO_SLUG}@main/website/public/latest.json`,
]
const RELEASES_API_URL = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`

const CHECK_TTL_MS = 24 * 60 * 60 * 1000 // once per day

export interface UpdateInfo {
  current: string
  latest: string
  outdated: boolean
  notes?: string
  url?: string
}

interface LatestFile {
  version: string
  date?: string
  notes?: string
  url?: string
}

/** very small semver-ish compare: '0.10.0' > '0.9.2' > '0.9' > '0.9-beta' */
export function isNewer(candidate: string, base: string): boolean {
  const num = (v: string) =>
    v.split(/[.+-]/).map((p) => Number(p.replace(/[^0-9]/g, '')) || 0)
  const a = num(candidate)
  const b = num(base)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

function cachePath() {
  return path.join(GLOBAL_DIR, 'update-check.json')
}

/** fetch one URL with a timeout; null on any failure */
async function fetchJson(url: string, timeoutMs: number, accept?: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'user-agent': `tagent/${CURRENT_VERSION}`,
        ...(accept ? { accept } : {}),
      },
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null // offline / blocked / whatever — try the next endpoint
  }
}

/** normalize the answer of any endpoint into a LatestFile */
function toLatest(data: unknown): LatestFile | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  // latest.json shape: { version, notes, url }
  if (typeof d.version === 'string' && d.version) {
    return { version: d.version, notes: asStr(d.notes), url: asStr(d.url) }
  }
  // GitHub API shape: { tag_name: "v0.27.0", name, body, html_url }
  if (typeof d.tag_name === 'string' && d.tag_name) {
    return {
      version: d.tag_name.replace(/^v/i, ''),
      notes: asStr(d.name) || asStr(d.body)?.split('\n').find((l) => l.trim().startsWith('##')),
      url: asStr(d.html_url),
    }
  }
  return undefined
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/**
 * Non-blocking, never throws. Returns null when we can't or don't need to
 * check (offline, checked recently, every endpoint down…).
 */
export async function checkUpdate(force = false): Promise<UpdateInfo | null> {
  try {
    const cacheFile = cachePath()
    if (!force && fs.existsSync(cacheFile)) {
      const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as {
        at: number
        latest: string
        notes?: string
        url?: string
      }
      if (Date.now() - cache.at < CHECK_TTL_MS) {
        const outdated = isNewer(cache.latest, CURRENT_VERSION)
        return {
          current: CURRENT_VERSION,
          latest: cache.latest,
          outdated,
          notes: cache.notes,
          url: cache.url,
        }
      }
    }

    // endpoint chain — first one that answers wins. TAGENT_UPDATE_URLS
    // replaces the whole chain (test hook: fully hermetic checks)
    const urls = process.env.TAGENT_UPDATE_URLS
      ? process.env.TAGENT_UPDATE_URLS.split(',').map((s) => s.trim()).filter(Boolean)
      : [...(process.env.TAGENT_UPDATE_URL ? [process.env.TAGENT_UPDATE_URL] : []), ...LATEST_JSON_URLS]
    let data: LatestFile | undefined
    for (const url of urls) {
      data = toLatest(await fetchJson(url, 8000))
      if (data?.version) break
    }
    if (!data?.version) {
      // last resort: the GitHub releases API (survives raw/CDN blocks).
      // TAGENT_RELEASE_API overrides the endpoint; when TAGENT_UPDATE_URLS
      // replaced the chain, the DEFAULT api is skipped (hermetic tests) but
      // an explicit TAGENT_RELEASE_API still applies.
      const api = process.env.TAGENT_RELEASE_API || (process.env.TAGENT_UPDATE_URLS ? undefined : RELEASES_API_URL)
      if (api) data = toLatest(await fetchJson(api, 8000, 'application/vnd.github+json'))
    }
    if (!data?.version) return null

    try {
      fs.mkdirSync(GLOBAL_DIR, { recursive: true })
      fs.writeFileSync(
        cacheFile,
        JSON.stringify({ at: Date.now(), latest: data.version, notes: data.notes, url: data.url }),
      )
    } catch {
      /* cache write is best-effort */
    }

    return {
      current: CURRENT_VERSION,
      latest: data.version,
      outdated: isNewer(data.version, CURRENT_VERSION),
      notes: data.notes,
      url: data.url,
    }
  } catch {
    return null // never break startup
  }
}
