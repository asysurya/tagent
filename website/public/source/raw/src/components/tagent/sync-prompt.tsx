'use client'

/**
 * SyncPrompt — the one-time "sync this project to GitHub?" offer.
 *
 * Opened by tagent-app when the store flips `promptLink` to true after a
 * successful login (the daemon offers it once per workspace that has work,
 * isn't linked yet, and wasn't refused). Every terminal choice clears the
 * flag in the store, so it never nags:
 *   [Sync now]              → syncLink() (ensure private repo + registry link)
 *                             then syncPush() — toast with the repo URL
 *   [Not now]  / ESC / X    → dismissPromptLink() — re-offered on the next login
 *   [Never for this project]→ refuseSync() — never asked again for this workspace
 */

import { useState } from 'react'
import { CloudUpload, ExternalLink, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTagent } from '@/lib/tagent/store'
import { repoUrl } from './login-dialog'

export type SyncChoice = 'sync' | 'notnow' | 'never'

export function SyncPrompt({
  open,
  onChoose,
}: {
  open: boolean
  /** 'sync' = linked + pushed · 'notnow' = re-offer on next login · 'never' = refused */
  onChoose?: (choice: SyncChoice) => void
}) {
  const workspace = useTagent((s) => s.workspace)
  const syncLink = useTagent((s) => s.syncLink)
  const syncPush = useTagent((s) => s.syncPush)
  const refuseSync = useTagent((s) => s.refuseSync)
  const dismissPromptLink = useTagent((s) => s.dismissPromptLink)
  const linking = useTagent((s) => s.linking)
  const syncing = useTagent((s) => s.syncing)
  const [phase, setPhase] = useState<'idle' | 'link' | 'push'>('idle')
  const [error, setError] = useState<string | null>(null)

  /* reset each time the prompt opens — state adjusted during render
   * (React's "reset on prop change" pattern; no effect needed) */
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setPhase('idle')
      setError(null)
    }
  }

  const busy = linking || syncing || phase !== 'idle'

  /** every close path flips `promptLink` in the store, which is what the
   * `open` prop is derived from — no callback needed to actually close */
  const close = (choice: SyncChoice) => {
    if (choice === 'notnow') dismissPromptLink()
    onChoose?.(choice)
  }

  const syncNow = async () => {
    if (busy) return
    setError(null)
    setPhase('link')
    const link = await syncLink() // ensures the private repo + links the registry
    if (!link.ok) {
      setPhase('idle')
      setError(link.error ?? 'Could not create the GitHub repo — try again in a moment.')
      return
    }
    setPhase('push')
    const r = await syncPush('sync: initial upload from tagent')
    setPhase('idle')
    if (!r.ok) {
      setError(r.error ?? 'Push failed — your work is safe locally. Try again.')
      return
    }
    onChoose?.('sync')
    const url = r.url ?? (r.repo ? repoUrl(r.repo) : null)
    toast.success('Project synced to GitHub', {
      duration: 8000,
      description: url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 underline underline-offset-2 break-all"
        >
          {r.repo ?? url}
          <ExternalLink className="size-3 shrink-0" />
        </a>
      ) : (
        'Continue this project on any device.'
      ),
    })
  }

  // the default repo name the daemon will ensure: tagent-<workspace>
  const slug = (workspace?.name ?? 'workspace')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workspace'

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) return
        if (busy) return // don't abandon a push mid-flight
        close('notnow') // ESC / overlay / X all mean "not now"
      }}
    >
      <DialogContent className="bg-zinc-900 border-zinc-800 max-w-[calc(100vw-2rem)] sm:max-w-md p-0 gap-0">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle className="text-zinc-100 flex items-center gap-2">
            <CloudUpload className="size-4 text-orange-400" />
            Sync this project to GitHub?
          </DialogTitle>
          <DialogDescription className="text-zinc-500 leading-relaxed">
            Push{' '}
            <span className="text-zinc-300 font-medium">{workspace?.name ?? 'this workspace'}</span> to a new
            private repo{' '}
            <code className="text-zinc-400">tagent-{slug}</code> under your GitHub account, so you can continue
            it on any device (<code className="text-zinc-400">tagent clone</code>). The repo is private —
            nothing is shared.
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 pb-1 space-y-2">
          {busy && (
            <p className="flex items-center gap-2 text-xs text-zinc-400">
              <Loader2 className="size-3.5 animate-spin" />
              {phase === 'link' ? 'Creating the GitHub repo…' : 'Uploading the workspace…'}
            </p>
          )}
          {error && !busy && (
            <p
              role="alert"
              className="rounded-md border border-red-900/70 bg-red-950/40 px-3 py-2 text-xs text-red-300 break-words"
            >
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="px-5 pb-5 pt-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-10 sm:h-8 text-xs text-zinc-500 hover:text-zinc-300"
            disabled={busy}
            onClick={() => {
              void refuseSync()
              close('never')
            }}
          >
            Never for this project
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-10 sm:h-8 text-xs border-zinc-700"
            disabled={busy}
            onClick={() => close('notnow')}
          >
            Not now
          </Button>
          <Button
            size="sm"
            className="h-10 sm:h-8 text-xs bg-orange-500 hover:bg-orange-400 text-zinc-950"
            disabled={busy}
            onClick={() => void syncNow()}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <CloudUpload className="size-3.5" />}
            {phase === 'link' ? 'Creating repo…' : phase === 'push' ? 'Uploading…' : 'Sync now'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
