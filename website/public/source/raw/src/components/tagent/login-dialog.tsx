'use client'

/**
 * LoginDialog — "Log in with GitHub" modal (v0.13 guest→login flow).
 *
 * The app is guest-first: everything works locally without an account.
 * This dialog is the entry point to GitHub project sync — paste a PAT
 * (repo scope), the daemon validates it and stores it in the local
 * credential store. On success the store sets `promptLink` when the
 * workspace has work and isn't linked yet — tagent-app watches that flag
 * and opens the one-time SyncPrompt (sync-prompt.tsx).
 */

import { useState } from 'react'
import { ExternalLink, Eye, EyeOff, Github, Loader2 } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useTagent } from '@/lib/tagent/store'

/* ------------------------------------------------------------------ */
/* Shared auth helpers (used by the top strip + settings GitHub tab)    */
/* ------------------------------------------------------------------ */

/**
 * Auth view for the header strip / settings. The v0.13 store is the source
 * of truth, but a login made via the legacy browser device flow keeps its
 * token only in the workspace config — count that as logged in too.
 */
export function useGithubAuth(): { loggedIn: boolean; loginName: string | null } {
  const guest = useTagent((s) => s.guest)
  const loginName = useTagent((s) => s.loginName)
  const gh = useTagent((s) => s.config?.github)
  const legacyLogin = gh?.connected ? (gh.login ?? null) : null
  return {
    loggedIn: !guest || !!legacyLogin,
    loginName: loginName ?? legacyLogin,
  }
}

/** Compact relative time for "synced 2h ago" style labels. */
export function relTime(ts: number | null | undefined): string {
  if (!ts) return 'never'
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 45) return 'just now'
  if (s < 90) return '1m ago'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 7200) return '1h ago'
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 172800) return 'yesterday'
  return `${Math.floor(s / 86400)}d ago`
}

/** "owner/name" → clickable GitHub URL. */
export function repoUrl(repo: string): string {
  return /^https?:\/\//.test(repo) ? repo : `https://github.com/${repo}`
}

/** Guest badge used by the header strip. */
export function GuestBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="outline"
      className={`h-5 px-1.5 text-[9px] font-medium border-zinc-700 text-zinc-400 ${className ?? ''}`}
    >
      Guest
    </Badge>
  )
}

/* ------------------------------------------------------------------ */
/* Login dialog                                                        */
/* ------------------------------------------------------------------ */

export function LoginDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const login = useTagent((s) => s.login)
  const connection = useTagent((s) => s.connection)
  const [pat, setPat] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /* reset the form each time the dialog opens — state adjusted during render
   * (the React-blessed "reset on prop change" pattern, no effect needed) */
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setPat('')
      setShow(false)
      setBusy(false)
      setError(null)
    }
  }

  const submit = async () => {
    const token = pat.trim()
    if (!token || busy) return
    setBusy(true)
    setError(null)
    const r = await login(token)
    setBusy(false)
    if (r.ok) {
      toast.success(r.login ? `Logged in as @${r.login}` : 'Logged in to GitHub')
      onOpenChange(false)
      // no prompt here — the store flips `promptLink` when the daemon wants
      // the one-time "sync this project?" offer; tagent-app opens SyncPrompt.
    } else {
      setError(r.error ?? 'Login failed — check the token and try again.')
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (busy && !o) return; onOpenChange(o) }}>
      <DialogContent className="bg-zinc-900 border-zinc-800 max-w-[calc(100vw-2rem)] sm:max-w-md p-0 gap-0">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle className="text-zinc-100 flex items-center gap-2">
            <Github className="size-4" /> Log in with GitHub
          </DialogTitle>
          <DialogDescription className="text-zinc-500 leading-relaxed">
            Save your projects to GitHub and continue them on any device — private, yours alone.
          </DialogDescription>
        </DialogHeader>

        <div className="p-5 space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="tagent-pat" className="block text-xs font-medium text-zinc-300">
              Personal access token
            </label>
            <div className="relative">
              <Input
                id="tagent-pat"
                autoFocus
                type={show ? 'text' : 'password'}
                placeholder="ghp_… or github_pat_…"
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
                autoComplete="off"
                spellCheck={false}
                className="h-10 bg-zinc-950 border-zinc-800 font-mono text-xs pr-12"
              />
              <button
                type="button"
                aria-label={show ? 'Hide token' : 'Show token'}
                onClick={() => setShow((v) => !v)}
                className="absolute right-1 top-1/2 -translate-y-1/2 grid size-10 place-items-center rounded-md text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-zinc-500">
            Create a token with the <code className="text-zinc-400">repo</code> scope at{' '}
            <a
              href="https://github.com/settings/tokens/new?scopes=repo&description=tagent"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 text-orange-400/90 hover:text-orange-300 underline underline-offset-2"
            >
              github.com/settings/tokens
              <ExternalLink className="size-3 shrink-0" />
            </a>
            . It never leaves this machine. Terminal folks: <code className="text-zinc-400">tagent auth</code> does the same.
          </p>

          {error && (
            <p
              role="alert"
              className="rounded-md border border-red-900/70 bg-red-950/40 px-3 py-2 text-xs text-red-300 break-words"
            >
              {error}
            </p>
          )}
          {connection === 'demo' && !busy && !error && (
            <p className="rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-300/90">
              Daemon offline (demo mode) — logging in needs a running daemon.
            </p>
          )}
        </div>

        <DialogFooter className="px-5 pb-5 pt-0">
          <Button
            variant="outline"
            size="sm"
            className="h-10 sm:h-8 text-xs border-zinc-700 text-zinc-300"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Continue as guest
          </Button>
          <Button
            size="sm"
            className="h-10 sm:h-8 text-xs bg-orange-500 hover:bg-orange-400 text-zinc-950"
            disabled={busy || !pat.trim()}
            onClick={() => void submit()}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Github className="size-3.5" />}
            {busy ? 'Logging in…' : 'Log in'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */
/* Logout confirm                                                      */
/* ------------------------------------------------------------------ */

export function ConfirmLogoutDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const logout = useTagent((s) => s.logout)
  const [busy, setBusy] = useState(false)

  /* reset on open — state adjusted during render (see LoginDialog) */
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setBusy(false)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (busy && !o) return; onOpenChange(o) }}>
      <DialogContent className="bg-zinc-900 border-zinc-800 max-w-[calc(100vw-2rem)] sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-zinc-100">Log out of GitHub?</DialogTitle>
          <DialogDescription className="text-zinc-500 leading-relaxed">
            Only removes the local token; your GitHub repos are untouched.
            Log in again any time to keep syncing.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            className="h-10 sm:h-8 text-xs border-zinc-700"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-10 sm:h-8 text-xs border-red-900/70 text-red-300 hover:bg-red-950/40 hover:text-red-200"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              await logout()
              setBusy(false)
              onOpenChange(false)
            }}
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />} Log out
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
