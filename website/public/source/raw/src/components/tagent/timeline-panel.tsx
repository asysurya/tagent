'use client'

import { useEffect } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { GitBranch, RotateCcw, Waypoints } from 'lucide-react'
import { useTagent } from '@/lib/tagent/store'
import { cn } from '@/lib/utils'

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/**
 * Multi-agent timeline — the subagent runs of the active session.
 * Sessions spawn subagents (task tool); their transcripts are persisted with
 * `subagent: true` + `parentId` and land here after every run.
 */
export function TimelinePanel() {
  const timeline = useTagent((s) => s.timeline)
  const refreshTimeline = useTagent((s) => s.refreshTimeline)
  const connection = useTagent((s) => s.connection)
  const session = useTagent((s) => s.session)
  const subagents = useTagent((s) => s.subagents)

  useEffect(() => {
    if (connection === 'ready') void refreshTimeline()
  }, [connection, session?.id, refreshTimeline])

  // live runs (this process) + persisted runs
  const live = subagents.filter((sa) => sa.status === 'running')

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* header */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-zinc-800/60">
        <Waypoints className="size-3.5 text-orange-400" />
        <span className="text-[11px] font-medium text-zinc-300">Timeline</span>
        <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-zinc-700 text-zinc-500">
          {timeline.length} run{timeline.length === 1 ? '' : 's'}
        </Badge>
        {live.length > 0 && (
          <span className="inline-flex items-center gap-1 text-[10px] text-orange-400">
            <span className="size-1.5 rounded-full bg-orange-400 animate-pulse" />
            {live.length} live
          </span>
        )}
        <div className="flex-1" />
        <Button
          variant="ghost" size="icon" className="size-6 text-zinc-500"
          onClick={() => void refreshTimeline()} title="Refresh"
        >
          <RotateCcw className="size-3" />
        </Button>
      </div>

      {/* list */}
      <div className="flex-1 min-h-0 overflow-y-auto pretty-scroll p-3 space-y-2">
        {timeline.length === 0 && live.length === 0 && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
            <p className="text-xs text-zinc-400 leading-relaxed">
              No subagent runs yet. When the agent splits work with the <b className="text-zinc-200">task</b> tool,
              each subagent gets its own session — persisted here as a timeline you can inspect after the fact.
            </p>
            <p className="text-[10px] text-zinc-600 mt-2 font-mono">
              tip: ask the agent to “explore first, then implement” and watch the timeline fill up
            </p>
          </div>
        )}

        {timeline.map((run, i) => {
          const isLast = i === timeline.length - 1
          return (
            <div key={run.id} className="relative pl-6">
              {/* rail */}
              <span className={cn(
                'absolute left-1.5 top-1 bottom-0 w-px',
                isLast ? 'bg-transparent' : 'bg-zinc-800',
              )} />
              <span className="absolute left-0.5 top-1.5 size-2.5 rounded-full bg-zinc-700 border border-zinc-600" />
              <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/30 p-2.5">
                <div className="flex items-center gap-2">
                  <GitBranch className="size-3 text-zinc-500" />
                  <p className="text-xs text-zinc-200 font-medium truncate flex-1">{run.title}</p>
                </div>
                <p className="mt-1 text-[10px] text-zinc-500">
                  {run.messageCount} msgs · {run.mode} · {timeAgo(run.createdAt)}
                </p>
              </div>
            </div>
          )
        })}

        {live.map((sa) => (
          <div key={sa.id} className="relative pl-6">
            <span className="absolute left-0.5 top-1.5 size-2.5 rounded-full bg-orange-400 border border-orange-300 animate-pulse" />
            <div className="rounded-lg border border-orange-800/40 bg-orange-500/5 p-2.5">
              <div className="flex items-center gap-2">
                <GitBranch className="size-3 text-orange-400" />
                <p className="text-xs text-orange-200 font-medium truncate flex-1">{sa.description}</p>
              </div>
              <p className="mt-1 text-[10px] text-orange-400/70">running · turn {sa.turns}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
