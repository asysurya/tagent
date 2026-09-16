'use client'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Plus, MessageSquare, Trash2, Clock, RotateCcw } from 'lucide-react'
import { useTagent } from '@/lib/tagent/store'
import { cn } from '@/lib/utils'
import type { SessionMeta } from '@/lib/tagent/types'

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function SessionRow({ s }: { s: SessionMeta }) {
  const active = useTagent((st) => st.session?.id === s.id)
  const loadSession = useTagent((st) => st.loadSession)
  const deleteSession = useTagent((st) => st.deleteSession)
  const running = useTagent((st) => st.running && active)

  return (
    <div
      className={cn(
        'group relative rounded-md border px-2.5 py-2 cursor-pointer transition-colors',
        active
          ? 'bg-orange-500/10 border-orange-500/30'
          : 'bg-zinc-900/40 border-transparent hover:bg-zinc-900 hover:border-zinc-800',
      )}
      onClick={() => void loadSession(s.id)}
    >
      <div className="flex items-start gap-2">
        <MessageSquare className={cn('size-3.5 mt-0.5 shrink-0', active ? 'text-orange-400' : 'text-zinc-500')} />
        <div className="min-w-0 flex-1">
          <p className={cn('text-xs truncate', active ? 'text-orange-200' : 'text-zinc-300')}>{s.title}</p>
          <div className="flex items-center gap-2 mt-1 text-[10px] text-zinc-500">
            <span className="inline-flex items-center gap-0.5"><Clock className="size-2.5" />{timeAgo(s.updatedAt)}</span>
            <span>{s.messageCount} msg</span>
            {s.mode === 'plan' && <Badge variant="outline" className="h-3.5 px-1 text-[9px] border-sky-700/50 text-sky-400">plan</Badge>}
          </div>
        </div>
        {running && <span className="size-1.5 rounded-full bg-orange-400 animate-pulse mt-1" />}
      </div>
      <button
        className="absolute right-1.5 top-1.5 opacity-0 group-hover:opacity-100 transition-opacity text-zinc-500 hover:text-red-400"
        onClick={(e) => {
          e.stopPropagation()
          void deleteSession(s.id)
        }}
        title="Delete session"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  )
}

export function Sidebar() {
  const sessions = useTagent((s) => s.sessions)
  const newSession = useTagent((s) => s.newSession)
  const checkpoints = useTagent((s) => s.checkpoints)
  const undo = useTagent((s) => s.undo)
  const workspace = useTagent((s) => s.workspace)
  const skills = useTagent((s) => s.skills)
  const config = useTagent((s) => s.config)

  return (
    <aside className="h-full flex flex-col bg-zinc-950/60 border-r border-zinc-800/60">
      <div className="p-2">
        <Button
          onClick={() => void newSession()}
          size="sm"
          className="w-full justify-start gap-2 bg-orange-500 hover:bg-orange-400 text-zinc-950 font-medium"
        >
          <Plus className="size-4" /> New session
        </Button>
      </div>

      <ScrollArea className="flex-1 px-2">
        <div className="space-y-1 pb-2">
          {sessions.length === 0 && (
            <p className="text-[11px] text-zinc-600 text-center pt-6 px-3 leading-relaxed">
              No sessions yet.<br />Start a conversation to begin.
            </p>
          )}
          {sessions.map((s) => <SessionRow key={s.id} s={s} />)}
        </div>
      </ScrollArea>

      <div className="border-t border-zinc-800/60 p-2 space-y-1.5">
        <button
          onClick={() => void undo()}
          className="w-full flex items-center justify-between text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors group"
          title="Restore the latest checkpoint"
        >
          <span className="inline-flex items-center gap-1.5"><RotateCcw className="size-3" /> undo checkpoint</span>
          <span className="font-mono text-zinc-600 group-hover:text-zinc-400">{checkpoints.length}</span>
        </button>
        <div className="flex items-center justify-between text-[11px] text-zinc-600">
          <span>skills</span>
          <span className="font-mono">{skills.length}</span>
        </div>
        <div className="flex items-center justify-between text-[11px] text-zinc-600">
          <span>model</span>
          <span className="font-mono truncate max-w-28">{config?.defaultModel ?? '—'}</span>
        </div>
        <p className="text-[10px] text-zinc-700 truncate font-mono" title={workspace?.path}>
          {workspace?.path ?? ''}
        </p>
      </div>
    </aside>
  )
}
