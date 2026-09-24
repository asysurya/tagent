'use client'

import { useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { BookOpen, ChevronLeft } from 'lucide-react'
import { useTagent } from '@/lib/tagent/store'
import ReactMarkdown from 'react-markdown'
import { cn } from '@/lib/utils'

export function SkillsPanel() {
  const skills = useTagent((s) => s.skills)
  const readSkill = useTagent((s) => s.readSkill)
  const [open, setOpen] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [error, setError] = useState<string | null>(null)

  const view = async (name: string) => {
    setOpen(name)
    setError(null)
    setContent('loading…')
    try {
      setContent(await readSkill(name))
    } catch (e) {
      // never leave the panel stuck on "loading…" forever
      setContent('')
      setError(e instanceof Error ? e.message : 'failed to read skill')
    }
  }

  if (open) {
    return (
      <div className="h-full flex flex-col min-h-0">
        <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-zinc-800/60">
          <button
            type="button"
            className="text-zinc-500 hover:text-zinc-200 p-1 -m-0.5"
            onClick={() => setOpen(null)}
            aria-label="Back to skill list"
            title="Back to skill list"
          >
            <ChevronLeft className="size-4" />
          </button>
          <span className="font-mono text-xs text-zinc-300 truncate" title={open}>{open}</span>
          <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-zinc-700 text-zinc-500 shrink-0">SKILL.md</Badge>
        </div>
        {error ? (
          <div className="p-3 text-[11px] text-red-400/90 font-mono break-words">{error}</div>
        ) : (
          <ScrollArea className="flex-1 pretty-scroll">
            <div className="p-3 prose-chat text-xs text-zinc-300 leading-relaxed">
              <ReactMarkdown>{content}</ReactMarkdown>
            </div>
          </ScrollArea>
        )}
      </div>
    )
  }

  return (
    <ScrollArea className="h-full pretty-scroll">
      <div className="p-3 space-y-1.5">
        <p className="text-[11px] text-zinc-500 leading-relaxed pb-1">
          Reusable playbooks. The agent sees name + description in its system prompt and loads the full
          instructions on demand (<code className="text-zinc-400">load_skill</code>).
        </p>
        {skills.length === 0 && (
          <p className="text-[11px] text-zinc-600 text-center pt-4">No skills installed.</p>
        )}
        {skills.map((s) => (
          <button
            type="button"
            key={s.name}
            onClick={() => void view(s.name)}
            className="w-full text-left rounded-lg border border-zinc-800/70 bg-zinc-950/40 px-3 py-2.5 hover:border-orange-500/40 transition-colors group"
          >
            <div className="flex items-center gap-2">
              <BookOpen className="size-3.5 text-orange-400/80 shrink-0" />
              <span className="font-mono text-xs text-zinc-200 group-hover:text-orange-200 transition-colors">{s.name}</span>
              <div className="flex-1" />
              <Badge
                variant="outline"
                className={cn('text-[9px] h-4 px-1.5',
                  s.source === 'builtin' ? 'border-zinc-700 text-zinc-500'
                  : s.source === 'workspace' ? 'border-emerald-800/60 text-emerald-400/90'
                  : 'border-violet-800/60 text-violet-400/90')}
              >
                {s.source}
              </Badge>
            </div>
            <p className="text-[11px] text-zinc-500 mt-1 leading-snug line-clamp-2">{s.description}</p>
          </button>
        ))}
      </div>
    </ScrollArea>
  )
}
