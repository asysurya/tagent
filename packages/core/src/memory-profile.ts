import os from 'node:os'
import type { TagentConfig } from './types'

/**
 * memory-profile.ts — the small-RAM stability profile (v0.31.1).
 *
 * The ask, verbatim from the field: "bikin agar tagent tetap berjalan di ram
 * yang kecil, jadi user bisa set mau make stable untuk ram brp, 4, 8, dst".
 * The user pins the machine's RAM budget (or tagent auto-detects it) and
 * every memory-shaped buffer scales to stay comfortably inside it:
 *
 *   knob                        default   8 GB     4 GB
 *   --------------------------  -------   ------   ------
 *   tuiLogLines                 4000      2500     1500
 *   subagentParallelDefault     4         3        2
 *   webCacheMax                  128       96       48
 *   compactThresholdChars        150k      120k     100k
 *
 * Explicit user config always wins where it is STRICTER (min()): an explicit
 * `subagents.maxParallel: 1` on a 64 GB box stays 1, and a profile can only
 * lower a default, never raise a user-set limit. What the profile does NOT
 * pretend to fix: the provider API payloads, MCP child processes (each is
 * its own OS process, user-configured) and the Bun runtime baseline — those
 * are reported in the v0.31.1 audit notes, not silently "tuned".
 */

export interface MemoryProfile {
  /** the effective budget this run derived (never 0 — auto-detect falls back
   *  to the default profile when the OS reports something absurd) */
  ramGb: number
  /** where the number came from — shown by /config ram */
  source: 'auto' | 'user'
  /** TUI transcript retention (this.log cap in TuiApp.addLine) */
  tuiLogLines: number
  /** default for subagents.maxParallel when the user has not set it */
  subagentParallelDefault: number
  /** MAX_WEB_ENTRIES for the web-fetch/search TTL cache */
  webCacheMax: number
  /** context-diet threshold in chars (loop.ts) — old tool results are
   *  digested above this total */
  compactThresholdChars: number
}

/** detected once per process — os.totalmem() is not going to change under us
 *  (hotplug aside, and if it does the next restart re-detects) */
let detectedRamGb: number | undefined

/** total system RAM in GiB, rounded. Never throws. */
export function detectRamGb(): number {
  if (detectedRamGb === undefined) {
    try {
      const gb = Math.round(os.totalmem() / (1024 * 1024 * 1024))
      detectedRamGb = gb > 0 && Number.isFinite(gb) ? gb : 16
    } catch {
      detectedRamGb = 16
    }
  }
  return detectedRamGb
}

/** the knobs for a given RAM budget (GB). Monotone: less RAM → every number
 *  at or below the next tier up. */
export function profileForRam(ramGb: number): Omit<MemoryProfile, 'ramGb' | 'source'> {
  if (!Number.isFinite(ramGb) || ramGb <= 0) {
    return { tuiLogLines: 4000, subagentParallelDefault: 4, webCacheMax: 128, compactThresholdChars: 150_000 }
  }
  if (ramGb <= 4) {
    return { tuiLogLines: 1500, subagentParallelDefault: 2, webCacheMax: 48, compactThresholdChars: 100_000 }
  }
  if (ramGb <= 8) {
    return { tuiLogLines: 2500, subagentParallelDefault: 3, webCacheMax: 96, compactThresholdChars: 120_000 }
  }
  return { tuiLogLines: 4000, subagentParallelDefault: 4, webCacheMax: 128, compactThresholdChars: 150_000 }
}

/** resolve the effective profile from the merged config. `performance.ramGb`
 *  pins the budget (0 = auto-detect); anything absent falls back to detect. */
export function resolveMemoryProfile(cfg?: TagentConfig): MemoryProfile {
  const raw = cfg?.performance?.ramGb
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return { ramGb: Math.floor(raw), source: 'user', ...profileForRam(raw) }
  }
  const auto = detectRamGb()
  return { ramGb: auto, source: 'auto', ...profileForRam(auto) }
}
