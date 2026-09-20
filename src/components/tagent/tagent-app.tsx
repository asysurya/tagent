'use client'

import { useEffect, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { Toaster, toast } from 'sonner'
import { ChevronDown, CloudUpload, Github, Loader2, LogOut, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTagent } from '@/lib/tagent/store'
import { TopBar } from './topbar'
import { Sidebar } from './sidebar'
import { ChatPanel } from './chat-panel'
import { RightPanel } from './right-panel'
import { MobileShell } from './mobile-shell'
import { PermissionDialog } from './permission-dialog'
import { PlanDialog } from './plan-dialog'
import { SettingsDialog } from './settings-dialog'
import { LoginDialog, ConfirmLogoutDialog, GuestBadge, relTime, repoUrl, useGithubAuth } from './login-dialog'
import { SyncPrompt, type SyncChoice } from './sync-prompt'

export function TagentApp() {
  const boot = useTagent((s) => s.boot)
  const connection = useTagent((s) => s.connection)
  const authStatus = useTagent((s) => s.authStatus)

  useEffect(() => {
    void boot()
  }, [boot])

  /* fire-and-forget auth refresh (boot() re-checks after hello; this covers
   * the rare ready-before-mount case). Never blocks the UI — guests first. */
  useEffect(() => {
    if (connection === 'ready') void authStatus()
  }, [connection, authStatus])

  /* guest→login chrome + the one-time sync offer */
  const [loginOpen, setLoginOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /* after a terminal choice (synced / never) we never re-offer this session */
  const [promptDone, setPromptDone] = useState(false)
  /* the offer's visibility is derived from the store flag: every terminal
   * choice (synced / refused / dismissed) clears it, a fresh login may set
   * it again — no local open state, no effects */
  const promptLink = useTagent((s) => s.promptLink)
  /* desktop only: when the right panel is closed it UNMOUNTS — otherwise the
   * hidden Panel would still occupy 34% of the layout as an empty strip
   * (react-resizable-panels renormalizes the remaining space for us) */
  const rightOpen = useTagent((s) => s.rightOpen)

  const handleSyncChoice = (choice: SyncChoice) => {
    if (choice === 'sync' || choice === 'never') setPromptDone(true)
    /* 'notnow' → the store keeps it dismissed; the daemon re-offers on the
     * next login (workspace still unlinked + not refused) */
  }

  return (
    <div className="h-dvh flex flex-col bg-zinc-950 text-zinc-200 overflow-hidden">
      <TopBar />
      <AuthStrip onLogin={() => setLoginOpen(true)} onSettings={() => setSettingsOpen(true)} />
      <div className="flex-1 min-h-0 hidden md:block">
        <PanelGroup direction="horizontal">
          <Panel id="sidebar" order={1} defaultSize={17} minSize={12} maxSize={26} className="min-w-0">
            <Sidebar />
          </Panel>
          <PanelResizeHandle className="w-px bg-zinc-800/60 hover:bg-orange-500/60 transition-colors data-[resize-handle-active]:bg-orange-500" />
          <Panel id="chat" order={2} defaultSize={49} minSize={30} className="min-w-0">
            <ChatPanel />
          </Panel>
          {rightOpen && (
            <PanelResizeHandle className="w-px bg-zinc-800/60 hover:bg-orange-500/60 transition-colors data-[resize-handle-active]:bg-orange-500" />
          )}
          {rightOpen && (
            <Panel id="right" order={3} defaultSize={34} minSize={22} maxSize={55} className="min-w-0">
              <RightPanel />
            </Panel>
          )}
        </PanelGroup>
      </div>
      {/* mobile: tabbed phone layout (UserLAnd on Android, small windows) */}
      <div className="flex-1 min-h-0 md:hidden">
        <MobileShell />
      </div>

      <PermissionDialog />
      <PlanDialog />

      <LoginDialog open={loginOpen} onOpenChange={setLoginOpen} />
      <SyncPrompt open={!!promptLink && !promptDone} onChoose={handleSyncChoice} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} defaultTab="integrations" />

      {connection === 'demo' && (
        <div className="px-3 py-1 text-[11px] bg-amber-500/10 text-amber-300 border-t border-amber-500/20 text-center">
          demo mode — daemon unreachable; start it with{' '}
          <code className="text-amber-200">bun mini-services/tagent-daemon</code> for a live agent
        </div>
      )}
      <Toaster
        richColors
        position="bottom-right"
        theme="dark"
        toastOptions={{ style: { background: '#18181b', border: '1px solid #27272a', color: '#e4e4e7' } }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Guest / account strip — GitHub login + cloud sync, guest-first      */
/* (rendered from tagent-app so the TopBar stays untouched; guests are */
/*  never blocked — the strip is informational, all features stay on)  */
/* ------------------------------------------------------------------ */

function AuthStrip({ onLogin, onSettings }: { onLogin: () => void; onSettings: () => void }) {
  const { loggedIn, loginName } = useGithubAuth()
  const linkedRepo = useTagent((s) => s.linkedRepo)
  const lastSyncAt = useTagent((s) => s.lastSyncAt)
  const syncing = useTagent((s) => s.syncing)
  const syncPush = useTagent((s) => s.syncPush)
  const [confirmOut, setConfirmOut] = useState(false)

  const pushNow = async () => {
    const r = await syncPush()
    if (r.ok) {
      const url = r.url ?? (r.repo ? repoUrl(r.repo) : null)
      toast.success('Workspace synced', {
        duration: 8000,
        description: url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 break-all"
          >
            {r.repo ?? url}
          </a>
        ) : (
          'Continue this project on any device.'
        ),
      })
    }
    /* errors (incl. 'not logged in') are toasted by the store */
  }

  if (!loggedIn) {
    return (
      <div className="shrink-0 flex items-center justify-between gap-2 border-b border-zinc-800/60 bg-zinc-900/40 px-3 min-h-9 md:min-h-8">
        <div className="flex min-w-0 items-center gap-2 text-[11px] text-zinc-500">
          <GuestBadge />
          <span className="hidden min-[420px]:inline truncate">
            working locally — log in to sync projects to GitHub
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-md border-orange-500/40 bg-orange-500/10 px-3 text-[11px] font-medium text-orange-300 hover:bg-orange-500/20 hover:text-orange-200"
          onClick={onLogin}
        >
          <Github className="size-3.5" /> Log in
        </Button>
      </div>
    )
  }

  return (
    <div className="shrink-0 flex items-center justify-between gap-2 border-b border-zinc-800/60 bg-zinc-900/40 px-3 min-h-9 md:min-h-8">
      <div className="flex min-w-0 items-center gap-2 text-[11px] text-zinc-500">
        <Github className="size-3.5 shrink-0 text-zinc-400" />
        {/* the ONE click target for GitHub settings / logout */}
        <DropdownAccount name={loginName} onSettings={onSettings} onLogout={() => setConfirmOut(true)} />
        <span className="hidden sm:inline truncate">
          {linkedRepo ? `synced ${relTime(lastSyncAt)}` : '· not linked yet'}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 border-zinc-700/80 bg-zinc-900/60 px-2.5 text-[11px]"
          disabled={syncing}
          onClick={() => void pushNow()}
          title={linkedRepo ? `Push this workspace to ${linkedRepo}` : 'Push this workspace to a new private GitHub repo'}
        >
          {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <CloudUpload className="size-3.5" />}
          <span className="hidden min-[420px]:inline">{syncing ? 'Syncing…' : 'Sync'}</span>
        </Button>
      </div>
      <ConfirmLogoutDialog open={confirmOut} onOpenChange={setConfirmOut} />
    </div>
  )
}

function DropdownAccount({ name, onSettings, onLogout }: { name: string | null; onSettings: () => void; onLogout: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          className="flex h-7 items-center gap-1 rounded-md px-1.5 -ml-1 text-zinc-300 transition-colors hover:bg-zinc-800/70"
          title="GitHub account"
        >
          <span className="max-w-32 truncate font-medium">{name ? `@${name}` : 'GitHub'}</span>
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52 border-zinc-800 bg-zinc-900">
        <DropdownMenuItem
          className="text-xs"
          onClick={() => {
            setOpen(false)
            onSettings()
          }}
        >
          <Settings className="mr-2 size-3.5" /> GitHub & sync settings
        </DropdownMenuItem>
        <DropdownMenuSeparator className="bg-zinc-800" />
        <DropdownMenuItem
          className="text-xs text-red-300/90"
          onClick={() => {
            setOpen(false)
            onLogout()
          }}
        >
          <LogOut className="mr-2 size-3.5" /> Log out…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
