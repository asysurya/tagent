'use client'

import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ClipboardList, PencilLine, Rocket } from 'lucide-react'
import { useTagent } from '@/lib/tagent/store'

/**
 * Plan approval — the daemon finished plan mode with a draft and asks how to
 * proceed (`plan:ready` → `plan:approve { execute }`).
 */
export function PlanDialog() {
  const plan = useTagent((s) => s.planOffer)
  const respondPlan = useTagent((s) => s.respondPlan)

  return (
    <Dialog open={!!plan} onOpenChange={(o) => { if (!o) respondPlan(false) }}>
      <DialogContent className="bg-zinc-900 border-zinc-800 max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-zinc-100">
            <span className="grid place-items-center size-8 rounded-lg bg-sky-500/15 text-sky-400">
              <ClipboardList className="size-4.5" />
            </span>
            Plan ready
          </DialogTitle>
          <DialogDescription className="text-zinc-400">
            The agent drafted an implementation plan. Execute it as-is, or keep planning to refine it first.
          </DialogDescription>
        </DialogHeader>

        <pre className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 text-[12px] font-mono text-zinc-300 whitespace-pre-wrap break-words max-h-72 overflow-auto pretty-scroll">
          {plan ?? ''}
        </pre>

        <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2">
          <p className="text-[10px] text-zinc-600 leading-relaxed">
            writes PRD.md · switches to build mode · starts implementation
          </p>
          <div className="flex gap-2 sm:justify-end">
            <Button variant="outline" className="border-zinc-700 gap-1.5" onClick={() => respondPlan(false)}>
              <PencilLine className="size-4" /> Keep planning
            </Button>
            <Button className="bg-orange-500 hover:bg-orange-400 text-zinc-950 gap-1.5" onClick={() => respondPlan(true)}>
              <Rocket className="size-4" /> Execute plan
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
