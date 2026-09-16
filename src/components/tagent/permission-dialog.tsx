'use client'

import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { useTagent } from '@/lib/tagent/store'
import { useState } from 'react'

export function PermissionDialog() {
  const pending = useTagent((s) => s.pendingPermission)
  const respond = useTagent((s) => s.respondPermission)
  const [remember, setRemember] = useState<'once' | 'session' | 'always'>('once')

  const tool = pending?.tool ?? ''
  const input = pending?.input as Record<string, unknown> | undefined

  // preview of the most interesting fields
  const preview = input
    ? Object.entries(input)
        .slice(0, 4)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 120) : JSON.stringify(v)?.slice(0, 160)}`)
        .join('\n')
    : ''

  return (
    <Dialog open={!!pending} onOpenChange={(o) => { if (!o) respond(false, 'once') }}>
      <DialogContent className="bg-zinc-900 border-zinc-800 max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-zinc-100">
            <span className="grid place-items-center size-8 rounded-lg bg-orange-500/15 text-orange-400">
              <ShieldAlert className="size-4.5" />
            </span>
            Permission requested
          </DialogTitle>
          <DialogDescription className="text-zinc-400">
            The agent wants to run <code className="text-orange-300 font-mono">{tool}</code>. Review before allowing —
            this affects your workspace.
          </DialogDescription>
        </DialogHeader>

        <pre className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 text-[12px] font-mono text-zinc-300 whitespace-pre-wrap break-words max-h-48 overflow-auto pretty-scroll">
          {preview}
        </pre>

        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="shrink-0">Remember for</span>
          <div className="flex rounded-md border border-zinc-800 overflow-hidden">
            {(['once', 'session', 'always'] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRemember(r)}
                className={`px-2.5 py-1 text-[11px] transition-colors ${
                  remember === r ? 'bg-orange-500/20 text-orange-300' : 'hover:bg-zinc-800 text-zinc-500'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" className="border-zinc-700" onClick={() => respond(false, remember)}>
            Deny
          </Button>
          <Button className="bg-orange-500 hover:bg-orange-400 text-zinc-950 gap-1.5" onClick={() => respond(true, remember)}>
            <ShieldCheck className="size-4" /> Allow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
