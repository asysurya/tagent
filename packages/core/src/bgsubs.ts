import type { BgSubInfo } from './types'

/**
 * Background subagents (task background:true) — the host-owned registry.
 *
 * The loop spawns a detached sub and hands it over here; the agent keeps
 * working immediately (the task tool returns the id, not the report). When
 * the sub finishes, the loop marks the entry and fires the host callback —
 * mid-run reports are injected into the running loop's next turn, late
 * reports wake the agent in a fresh run. Either way: no user confirmation.
 *
 * The registry outlives individual runs (a sub started in run 1 may deliver
 * its report in run 2), so it lives on the host, not on the loop.
 */
export class BackgroundSubagents {
  /** live entries — id → state (finished ones stay for the subs tool) */
  private entries = new Map<string, BgSubInfo>()
  private counter = 0
  /** finished entries are trimmed so the listing stays useful */
  private static MAX_FINISHED = 20

  constructor(
    /** the live parallel limit — read through config each time so
     *  /config changes apply without rebuilding the registry */
    private maxParallel: () => number,
  ) {}

  /** how many subs may run at once (config subagents.maxParallel, default 4) */
  get limit(): number {
    const n = Math.floor(this.maxParallel())
    return Number.isFinite(n) && n > 0 ? Math.min(n, 16) : 4
  }

  get runningCount(): number {
    let n = 0
    for (const e of this.entries.values()) if (e.status === 'running') n++
    return n
  }

  /** register a spawn; refuses when the parallel limit is hit */
  register(description: string, kind: string): { id: string } | { error: string } {
    if (this.runningCount >= this.limit) {
      const running = [...this.entries.values()].filter((e) => e.status === 'running').map((e) => e.id)
      return {
        error:
          `parallel limit reached (${this.runningCount}/${this.limit} background subagents running: ${running.join(', ')}). ` +
          `Wait for one to finish (check with the subs tool), or raise the limit: config subagents.maxParallel.`,
      }
    }
    const id = `a${++this.counter}`
    this.entries.set(id, {
      id,
      description: description.slice(0, 120),
      kind,
      status: 'running',
      startedAt: Date.now(),
      turns: 0,
    })
    this.trimFinished()
    return { id }
  }

  /** mark a sub finished (done | error) and store its report */
  finish(id: string, status: 'done' | 'error', report: string): BgSubInfo | undefined {
    const e = this.entries.get(id)
    if (!e) return undefined
    e.status = status
    e.finishedAt = Date.now()
    e.report = report
    return { ...e }
  }

  get(id: string): BgSubInfo | undefined {
    const e = this.entries.get(id)
    return e ? { ...e } : undefined
  }

  list(): BgSubInfo[] {
    return [...this.entries.values()].map((e) => ({ ...e }))
  }

  /** keep the newest finished entries; running ones are never dropped */
  private trimFinished(): void {
    const finished = [...this.entries.values()]
      .filter((e) => e.status !== 'running')
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    for (const old of finished.slice(BackgroundSubagents.MAX_FINISHED)) {
      this.entries.delete(old.id)
    }
  }
}
