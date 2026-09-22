/**
 * Tagent version + update check.
 *
 * The daemon checks for a newer release on startup (and at most once a day —
 * the result is cached in ~/.tagent/update-check.json). A stale version only
 * ever prints a warning: Tagent stays fully usable.
 *
 * Endpoint: website/public/latest.json on GitHub (raw) so the check works
 * without depending on Vercel being up. Override with TAGENT_UPDATE_URL.
 */
import fs from 'node:fs'
import path from 'node:path'
import { GLOBAL_DIR } from './config'

export const CURRENT_VERSION = '0.23.1'

const DEFAULT_UPDATE_URL =
  'https://raw.githubusercontent.com/asysurya/tagent/main/website/public/latest.json'

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

/**
 * Non-blocking, never throws. Returns null when we can't or don't need to
 * check (offline, checked recently, endpoint down…).
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

    const res = await fetch(process.env.TAGENT_UPDATE_URL || DEFAULT_UPDATE_URL, {
      signal: AbortSignal.timeout(4000),
      headers: { 'user-agent': `tagent/${CURRENT_VERSION}` },
    })
    if (!res.ok) return null
    const data = (await res.json()) as LatestFile
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
    return null // offline / blocked / whatever — never break startup
  }
}
