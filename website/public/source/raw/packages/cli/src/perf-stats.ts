/**
 * perf-stats.ts — machine performance stats for the navbar.
 *
 * The navbar (headerRows) shows live CPU / system RAM / process RSS next to
 * the session title: "🖥 12% · 💾 62% · 210M". Sampling is cheap (os.cpus()
 * reads /proc/stat, os.freemem a syscall) but it must never run per frame —
 * renderNow fires every ~100ms while a run streams, so the numbers come from
 * a background interval and get() is a pure O(1) read of the last sample.
 *
 * CPU% is a delta between two os.cpus() snapshots — the first sample after
 * start() carries the delta since construction, so it is meaningful from the
 * first frame onward. A stale sample (laptop suspended, timer starved) is
 * recomputed on read; its CPU delta window is whatever elapsed, which is
 * exactly right.
 *
 * v0.31.2: the loop's own reported numbers stay untouched — this is display
 * telemetry only, it never gates behavior.
 */
import os from 'node:os'

/** one machine snapshot — all fields are display-ready */
export interface PerfSample {
  /** CPU load across all cores, 0..100 (delta window since the previous tick) */
  cpuPct: number
  /** system RAM in use, 0..100 */
  ramPct: number
  /** total system RAM, GB (one decimal) */
  ramTotalGb: number
  /** this tagent process's resident set, MB (rounded) */
  rssMb: number
  /** process uptime, seconds */
  uptimeS: number
  /** Date.now() of the sample — staleness detection */
  at: number
}

/** aggregate CPU counters (idle + total ticks across cores) */
interface CpuSnapshot {
  idle: number
  total: number
}

function cpuSnapshot(): CpuSnapshot {
  let idle = 0
  let total = 0
  for (const c of os.cpus()) {
    const t = c.times
    idle += t.idle
    total += t.idle + t.user + t.nice + t.sys + t.irq
  }
  return { idle, total }
}

/** a sample older than this is recomputed on read (suspend / starvation) */
const STALE_MS = 15_000

export class PerfSampler {
  private timer: ReturnType<typeof setInterval> | undefined
  private prev: CpuSnapshot = cpuSnapshot()
  private last: PerfSample = { cpuPct: 0, ramPct: 0, ramTotalGb: 0, rssMb: 0, uptimeS: 0, at: Date.now() }

  /** begin sampling; intervalMs default 2s (the navbar ticks at 1s — twice
   *  per paint is plenty, and /proc/stat stays cold). Idempotent. */
  start(intervalMs = 2_000): this {
    if (this.timer) return this
    this.tick()
    this.timer = setInterval(() => this.tick(), intervalMs)
    // never keep the process alive just for the sampler
    ;(this.timer as unknown as { unref?: () => void }).unref?.()
    return this
  }

  private tick(): void {
    const now = cpuSnapshot()
    const dTotal = now.total - this.prev.total
    const dIdle = now.idle - this.prev.idle
    this.prev = now
    const cpuPct = dTotal > 0 ? Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100))) : 0
    const totalB = os.totalmem()
    const freeB = os.freemem()
    const usedB = Math.max(0, totalB - freeB)
    this.last = {
      cpuPct,
      ramPct: totalB > 0 ? Math.max(0, Math.min(100, Math.round((usedB / totalB) * 100))) : 0,
      ramTotalGb: Math.round((totalB / 1024 ** 3) * 10) / 10,
      rssMb: Math.max(0, Math.round(process.memoryUsage().rss / 1024 / 1024)),
      uptimeS: Math.max(0, Math.round(process.uptime())),
      at: Date.now(),
    }
  }

  /** the latest sample (recomputed when stale). Never throws, never blocks. */
  get(): PerfSample {
    if (Date.now() - this.last.at > STALE_MS) this.tick()
    return this.last
  }

  /** stop the interval; get() keeps returning the last sample */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }
}

/** "2h 13m" / "13m" / "42s" — uptime for /stats */
export function fmtUptime(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}
