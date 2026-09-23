'use client'

import { useState } from 'react'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Check, Eye, Layers, Search, X } from 'lucide-react'
import { useTagent } from '@/lib/tagent/store'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

/**
 * Model roles — the 3-category model config:
 *   main (the picker in the topbar) · subagent (task-tool subs) ·
 *   media.vision / .audio / .video / .pdf (screenshot & media analysis).
 * Each role runs on its own model; unset roles follow the main model.
 */

type MediaRole = 'vision' | 'audio' | 'video' | 'pdf'
export type ModelRole = 'subagent' | MediaRole

const ROLES: { role: ModelRole; label: string; hint: string; icon: typeof Layers }[] = [
  { role: 'subagent', label: 'Subagent', hint: 'what task-tool subagents run on', icon: Layers },
  { role: 'vision', label: 'Media · vision', hint: 'screenshot & image QA reports (the vision tool)', icon: Eye },
  { role: 'audio', label: 'Media · audio', hint: 'reserved slot — audio analysis', icon: Layers },
  { role: 'video', label: 'Media · video', hint: 'reserved slot — video analysis', icon: Layers },
  { role: 'pdf', label: 'Media · pdf', hint: 'reserved slot — document analysis', icon: Layers },
]

export function ModelRolesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const config = useTagent((s) => s.config)
  const setModelRole = useTagent((s) => s.setModelRole)
  const [picking, setPicking] = useState<ModelRole | null>(null)
  const [q, setQ] = useState('')

  if (!config) return null

  const refFor = (role: ModelRole) =>
    role === 'subagent' ? config.models?.subagent : config.models?.media?.[role]

  const currentRef = (role: ModelRole) =>
    refFor(role) ?? '(follows main model)'

  const save = async (role: ModelRole, ref: string) => {
    await setModelRole(role, ref)
    setPicking(null)
    setQ('')
    toast(ref ? `${role} → ${ref} ✓` : `${role} cleared — follows main ✓`)
  }

  const query = q.trim().toLowerCase()
  const ready = (config.providers ?? []).filter((p) => !p.needsKey || p.hasKey)

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { setPicking(null); setQ('') } }}>
      <DialogContent className="max-w-md bg-zinc-900 border-zinc-800">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Layers className="size-4 text-orange-400" /> Model roles
          </DialogTitle>
          <DialogDescription className="text-xs">
            Each category runs on its own model — unset roles follow the main model
            ({config.defaultProvider}/{config.defaultModel}).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          {ROLES.map(({ role, label, hint, icon: Icon }) => {
            const ref = refFor(role)
            const isPicking = picking === role
            return (
              <div key={role} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5">
                <div className="flex items-center gap-2">
                  <Icon className={cn('size-3.5 shrink-0', ref ? 'text-orange-400' : 'text-zinc-600')} />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-zinc-200 flex items-center gap-1.5">
                      {label}
                      {ref && <Badge variant="outline" className="text-[9px] h-4 px-1 border-orange-800/60 text-orange-400">set</Badge>}
                    </div>
                    <div className="text-[10px] text-zinc-600 truncate">{hint}</div>
                  </div>
                  <code className={cn('font-mono text-[11px] truncate max-w-32', ref ? 'text-zinc-300' : 'text-zinc-600')}>
                    {currentRef(role)}
                  </code>
                  {ref ? (
                    <button
                      className="text-zinc-600 hover:text-red-400 shrink-0"
                      title="clear — follow the main model"
                      onClick={() => void save(role, '')}
                    >
                      <X className="size-3.5" />
                    </button>
                  ) : (
                    <Button
                      size="sm" variant="outline"
                      className="h-6 px-2 text-[11px] border-zinc-700 text-zinc-300 shrink-0"
                      onClick={() => setPicking(isPicking ? null : role)}
                    >
                      {isPicking ? 'cancel' : 'pick'}
                    </Button>
                  )}
                </div>

                {isPicking && (
                  <div className="mt-2 space-y-1.5">
                    <div className="relative">
                      <Search className="size-3 absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" />
                      <input
                        autoFocus
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="search models… (or type provider/model)"
                        className="w-full h-7 bg-zinc-950 border border-zinc-800 rounded-md pl-8 pr-2 text-xs font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-700"
                      />
                    </div>
                    {/^[a-z0-9_-]+\/[\w.-]+$/i.test(query) && (
                      <button
                        className="w-full text-left px-2 py-1 rounded text-[11px] font-mono border border-orange-800/60 bg-orange-500/10 text-orange-300 hover:bg-orange-500/20"
                        onClick={() => void save(role, query)}
                      >
                        use custom ref: {query}
                      </button>
                    )}
                    <ScrollArea className="max-h-44 rounded border border-zinc-800">
                      <div className="p-1">
                        {ready.flatMap((p) =>
                          p.models
                            .filter((m) => !query || m.id.toLowerCase().includes(query) || p.id.includes(query))
                            .slice(0, query ? 30 : 6)
                            .map((m) => (
                              <button
                                key={p.id + m.id}
                                className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-mono text-zinc-300 hover:bg-zinc-800/60 text-left"
                                onClick={() => void save(role, `${p.id}/${m.id}`)}
                              >
                                <span className="text-zinc-600 shrink-0">{p.id}</span>
                                <span className="truncate">{m.id}</span>
                                {refFor(role) === `${p.id}/${m.id}` && <Check className="size-3 text-orange-400 ml-auto shrink-0" />}
                              </button>
                            )),
                        )}
                        {ready.length === 0 && (
                          <p className="px-2 py-3 text-[11px] text-zinc-600">no providers with keys — add one in settings</p>
                        )}
                      </div>
                    </ScrollArea>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <p className="text-[10px] text-zinc-600 leading-relaxed">
          Subagents spawn through the task tool and run in this workspace; the vision tool routes
          screenshots to media · vision — a separate reviewer, so the coding agent stays on its own model.
        </p>
      </DialogContent>
    </Dialog>
  )
}
