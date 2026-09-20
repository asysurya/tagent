'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Brain, Plus, Save, Trash2 } from 'lucide-react'
import { useTagent } from '@/lib/tagent/store'
import { cn } from '@/lib/utils'

/** Keyed per (which) so switching tabs remounts with fresh state — no effect needed. */
function AgentsEditor({ which }: { which: 'workspace' | 'global' }) {
  const initial = useTagent((s) => s.memory.agents[which])
  const saveAgents = useTagent((s) => s.saveAgents)
  const [text, setText] = useState(initial)
  const [dirty, setDirty] = useState(false)

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Brain className="size-3.5 text-orange-400" />
        <span className="text-xs font-medium text-zinc-200">AGENTS.md</span>
        <div className="flex-1" />
        <Button
          size="sm"
          className={cn('h-7 px-2 text-[10px] gap-1', dirty ? 'bg-orange-500 hover:bg-orange-400 text-zinc-950' : 'bg-zinc-800 text-zinc-400')}
          disabled={!dirty}
          onClick={async () => {
            await saveAgents(which, text)
            setDirty(false)
          }}
        >
          <Save className="size-3" /> save
        </Button>
      </div>
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setDirty(true) }}
        rows={6}
        spellCheck={false}
        placeholder="# Instructions the agent reads every session…"
        className="w-full resize-y rounded-md border border-zinc-800 bg-zinc-950/60 p-2 font-mono text-[11px] leading-5 text-zinc-300 focus:outline-none focus:border-orange-500/40 pretty-scroll"
      />
    </div>
  )
}

export function MemoryPanel() {
  const memory = useTagent((s) => s.memory)
  const addFact = useTagent((s) => s.addFact)
  const deleteFact = useTagent((s) => s.deleteFact)
  const [which, setWhich] = useState<'workspace' | 'global'>('workspace')
  const [fact, setFact] = useState('')

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 border-b border-zinc-800/60 px-3 py-2 space-y-2">
        <div className="flex items-center gap-2">
          <div className="flex-1" />
          <div className="flex rounded border border-zinc-800 overflow-hidden text-[10px]">
            {(['workspace', 'global'] as const).map((w) => (
              <button
                type="button"
                key={w}
                aria-pressed={which === w}
                onClick={() => setWhich(w)}
                className={cn('px-3 py-1.5', which === w ? 'bg-orange-500/20 text-orange-300' : 'text-zinc-500 hover:text-zinc-300')}
              >
                {w}
              </button>
            ))}
          </div>
        </div>
        <AgentsEditor key={which} which={which} />
      </div>

      <div className="shrink-0 px-3 py-2 border-b border-zinc-800/60">
        <p className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1.5">facts ({memory.facts.length})</p>
        <div className="flex gap-2">
          <input
            value={fact}
            onChange={(e) => setFact(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && fact.trim()) {
                void addFact(fact.trim())
                setFact('')
              }
            }}
            placeholder="remember: prefers tabs over spaces…"
            className="flex-1 rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1.5 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-orange-500/40"
          />
          <Button
            size="sm" className="h-8 px-2.5 text-[10px] bg-orange-500 hover:bg-orange-400 text-zinc-950"
            disabled={!fact.trim()}
            aria-label="Add fact"
            onClick={() => { void addFact(fact.trim()); setFact('') }}
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1 pretty-scroll">
        <div className="p-3 space-y-1.5">
          {memory.facts.length === 0 && (
            <p className="text-[11px] text-zinc-600 text-center pt-4">
              The agent saves durable notes here via the <code>memory</code> tool.
            </p>
          )}
          {memory.facts.map((f) => (
            <div key={f.id} className="group flex items-start gap-2 rounded-md border border-zinc-800/60 bg-zinc-950/40 px-2.5 py-1.5">
              <p className="flex-1 text-[11px] text-zinc-300 leading-relaxed break-words">{f.text}</p>
              {/* visible on touch (no hover state there) */}
              <button
                type="button"
                className="text-zinc-600 hover:text-red-400 p-1.5 -m-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity shrink-0"
                onClick={() => void deleteFact(f.id)}
                aria-label="Delete fact"
                title="Delete fact"
              >
                <Trash2 className="size-3" />
              </button>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
