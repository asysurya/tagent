'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { CalendarDays, FilePenLine, RotateCcw, ScrollText } from 'lucide-react'
import { useTagent } from '@/lib/tagent/store'
import { cn } from '@/lib/utils'

/** Light-weight renderer for the WORKLOG.md journal the agent maintains. */
export function WorklogPanel() {
  const content = useTagent((s) => s.worklogContent)
  const exists = useTagent((s) => s.worklogExists)
  const config = useTagent((s) => s.config)
  const refreshWorklog = useTagent((s) => s.refreshWorklog)
  const openFile = useTagent((s) => s.openFile)
  const setRightTab = useTagent((s) => s.setRightTab)
  const setWorklog = useTagent((s) => s.setWorklog)
  const connection = useTagent((s) => s.connection)

  useEffect(() => {
    if (connection === 'ready') void refreshWorklog()
  }, [connection, refreshWorklog])

  if (!config) return null

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* header */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-zinc-800/60">
        <ScrollText className="size-3.5 text-orange-400" />
        <span className="text-[11px] font-medium text-zinc-300">WORKLOG.md</span>
        {config.worklog.enabled ? (
          <Badge className="text-[9px] h-4 px-1.5 bg-emerald-500/15 text-emerald-400 border-emerald-800/50 hover:bg-emerald-500/15">agent journals here</Badge>
        ) : (
          <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-zinc-700 text-zinc-500">off</Badge>
        )}
        <div className="flex-1" />
        <Button
          variant="ghost" size="icon" className="size-6 text-zinc-500"
          onClick={() => void refreshWorklog()} title="Refresh"
        >
          <RotateCcw className="size-3" />
        </Button>
        <Button
          variant="ghost" size="icon" className="size-6 text-zinc-500"
          disabled={!exists}
          onClick={() => { void openFile('WORKLOG.md'); setRightTab('files') }}
          title="Open in editor"
        >
          <FilePenLine className="size-3" />
        </Button>
      </div>

      {/* disabled hint */}
      {!config.worklog.enabled && (
        <div className="m-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 space-y-2.5">
          <p className="text-xs text-zinc-400 leading-relaxed">
            Worklog + todos is <b className="text-zinc-200">off</b>. Turn it on and the agent will keep a
            live plan in the chat and append timestamped entries to <code className="text-zinc-400">WORKLOG.md</code> after every step.
          </p>
          <Button
            size="sm" className="h-7 text-xs bg-orange-500 hover:bg-orange-400 text-zinc-950"
            onClick={() => void setWorklog(true)}
          >
            Enable worklog + todos
          </Button>
        </div>
      )}

      {/* entries */}
      <div className="flex-1 overflow-y-auto pretty-scroll px-3 py-2">
        {!exists ? (
          <div className="h-full grid place-items-center">
            <div className="text-center space-y-1.5">
              <CalendarDays className="size-6 text-zinc-700 mx-auto" />
              <p className="text-xs text-zinc-500">No entries yet.</p>
              <p className="text-[11px] text-zinc-600">
                Give the agent a task — completed steps land here automatically.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {content.split('\n').map((line, i) => {
              if (line.startsWith('# ')) return null
              if (line.startsWith('## '))
                return (
                  <p key={i} className="pt-3 pb-1 text-[10px] uppercase tracking-wide text-zinc-500 flex items-center gap-1.5 sticky top-0 bg-zinc-950/90 backdrop-blur">
                    <CalendarDays className="size-3" /> {line.replace(/^##\s+/, '')}
                  </p>
                )
              if (line.startsWith('- **'))
                return (
                  <p key={i} className="text-[12px] text-zinc-300 leading-relaxed font-mono">
                    <span className="text-orange-400/90">{line.match(/\*\*([^*]+)\*\*/)?.[1] ?? ''}</span>
                    <span className="text-zinc-300">{line.replace(/^-?\s*\*\*[^*]+\*\*\s*/, ' ')}</span>
                  </p>
                )
              if (!line.trim()) return null
              return (
                <p key={i} className="text-[12px] text-zinc-400 leading-relaxed font-mono">{line}</p>
              )
            })}
          </div>
        )}
      </div>

      {/* footer */}
      <div className={cn('shrink-0 px-3 py-2 border-t border-zinc-800/60 flex items-center justify-between',
        !config.worklog.enabled && 'hidden')}>
        <span className="text-[10px] text-zinc-600">
          entries are appended by the agent via the <code className="text-zinc-500">worklog</code> tool
        </span>
        <Switch
          aria-label="Worklog and todos"
          checked={config.worklog.enabled}
          onCheckedChange={(v) => void setWorklog(v)}
          title="Toggle worklog + todos"
        />
      </div>
    </div>
  )
}
