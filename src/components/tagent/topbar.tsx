'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Bone, Check, ChevronDown, Cpu, Files, FolderInput, FolderOpen, Github, History, ListTodo,
  PanelRightClose, PanelRightOpen, Search, Settings, Terminal, TerminalSquare, Zap,
} from 'lucide-react'
import { useTagent } from '@/lib/tagent/store'
import { cn } from '@/lib/utils'
import { SettingsDialog } from './settings-dialog'
import { CommandPalette } from './command-palette'

export function TopBar() {
  const connection = useTagent((s) => s.connection)
  const workspace = useTagent((s) => s.workspace)
  const config = useTagent((s) => s.config)
  const session = useTagent((s) => s.session)
  const setMode = useTagent((s) => s.setMode)
  const rightOpen = useTagent((s) => s.rightOpen)
  const toggleRight = useTagent((s) => s.toggleRight)
  const setRightTab = useTagent((s) => s.setRightTab)
  const githubBusy = useTagent((s) => s.githubBusy)
  const githubPush = useTagent((s) => s.githubPush)
  const caveman = useTagent((s) => s.config?.caveman ?? false)
  const setCaveman = useTagent((s) => s.setCaveman)
  const running = useTagent((s) => s.running)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [openDialog, setOpenDialog] = useState(false)
  const [modelQuery, setModelQuery] = useState('')

  const provider = config?.providers.find((p) => p.id === config.defaultProvider)
  const modelLabel = provider?.models.find((m) => m.id === config?.defaultModel)?.label ?? config?.defaultModel ?? 'no model'
  const mode = session?.mode ?? 'build'

  return (
    <header className="h-12 shrink-0 flex items-center gap-2 px-3 border-b border-zinc-800/60 bg-zinc-950/80 backdrop-blur">
      <div className="flex items-center gap-2 font-semibold tracking-tight">
        <span className="grid place-items-center size-6 rounded-md bg-orange-500 text-zinc-950">
          <TerminalSquare className="size-4" />
        </span>
        <span className="text-zinc-100">tagent</span>
      </div>

      {/* workspace switcher */}
      <WorkspaceSwitcher openDialog={openDialog} setOpenDialog={setOpenDialog} />

      <div className="flex-1" />

      {/* agent mode */}
      <div className="flex items-center rounded-md border border-zinc-800 p-0.5 text-xs font-medium">
        <button
          onClick={() => void setMode('build')}
          className={cn('px-2.5 py-1 rounded flex items-center gap-1 transition-colors',
            mode === 'build' ? 'bg-orange-500/15 text-orange-400' : 'text-zinc-500 hover:text-zinc-300')}
          title="Build mode — agent may edit files (permission-gated)"
        >
          <Zap className="size-3.5" /> Build
        </button>
        <button
          onClick={() => void setMode('plan')}
          className={cn('px-2.5 py-1 rounded flex items-center gap-1 transition-colors',
            mode === 'plan' ? 'bg-sky-500/15 text-sky-400' : 'text-zinc-500 hover:text-zinc-300')}
          title="Plan mode — read-only investigation"
        >
          <ListTodo className="size-3.5" /> Plan
        </button>
      </div>

      {/* model picker */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1.5 border-zinc-800 bg-zinc-900/50 text-xs font-mono">
            <Cpu className="size-3.5 text-orange-400" />
            <span className="max-w-36 truncate">{modelLabel}</span>
            <ChevronDown className="size-3 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72 bg-zinc-900 border-zinc-800">
          <div className="p-2 sticky top-0 bg-zinc-900 z-10 border-b border-zinc-800/60">
            <div className="relative">
              <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" />
              <input
                value={modelQuery}
                onChange={(e) => setModelQuery(e.target.value)}
                placeholder="search providers & models…"
                className="w-full h-7 bg-zinc-950 border border-zinc-800 rounded-md pl-8 pr-2 text-xs font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-700"
              />
            </div>
          </div>
          <ScrollArea className="max-h-72">
            <ModelMenuGroups query={modelQuery} onSelect={() => setModelQuery('')} />
          </ScrollArea>
          <DropdownMenuSeparator className="bg-zinc-800" />
          <DropdownMenuItem className="text-xs text-zinc-400" onClick={() => setSettingsOpen(true)}>
            <Settings className="size-3.5 mr-2" /> Provider settings — keys & custom endpoints
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* connection */}
      <span
        className={cn('size-2 rounded-full shrink-0',
          connection === 'ready' ? 'bg-emerald-500 shadow-[0_0_6px] shadow-emerald-500/60'
          : connection === 'connecting' ? 'bg-amber-400 animate-pulse'
          : 'bg-zinc-600')}
        title={connection}
      />

      <Button variant="ghost" size="icon" className="size-7 text-zinc-400" onClick={() => void setCaveman(!caveman)} title={caveman ? 'Caveman mode ON — terse replies, fewer tokens. Click to turn off.' : 'Caveman mode — terse replies, fewer tokens. Click to turn on.'}>
        <Bone className={cn('size-4', caveman ? 'text-orange-400' : 'text-zinc-400 opacity-50')} />
      </Button>
      <Button variant="ghost" size="icon" className="size-7 text-zinc-400" onClick={() => void githubPush()} disabled={githubBusy || !config?.github.connected} title="Push workspace to GitHub">
        <Github className={cn('size-4', config?.github.connected ? 'text-zinc-200' : 'opacity-40')} />
      </Button>
      <Button variant="ghost" size="icon" className="size-7 text-zinc-400" onClick={() => setPaletteOpen(true)} title="Command palette (⌘K)">
        <History className="size-4" />
      </Button>
      <Button variant="ghost" size="icon" className="size-7 text-zinc-400" onClick={() => setSettingsOpen(true)} title="Settings">
        <Settings className="size-4" />
      </Button>
      <Button variant="ghost" size="icon" className="size-7 text-zinc-400 hidden md:inline-flex" onClick={toggleRight} title="Toggle side panel">
        {rightOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
      </Button>
      {/* mobile quick tabs */}
      <div className="md:hidden flex items-center gap-0.5">
        <Button variant="ghost" size="icon" className="size-7 text-zinc-400" onClick={() => setRightTab('files')}><Files className="size-4" /></Button>
        <Button variant="ghost" size="icon" className="size-7 text-zinc-400" onClick={() => setRightTab('terminal')}><Terminal className="size-4" /></Button>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <OpenFolderDialog open={openDialog} onOpenChange={setOpenDialog} />
      {running && (
        <span className="absolute bottom-0 left-0 h-px w-full overflow-hidden">
          <span className="block h-full w-1/3 bg-orange-500 animate-[slide_1.2s_ease-in-out_infinite]" />
        </span>
      )}
    </header>
  )
}

function ModelMenuGroups({ query, onSelect }: { query: string; onSelect: () => void }) {
  const config = useTagent((s) => s.config)
  const setModel = useTagent((s) => s.setModel)
  if (!config) return null
  const q = query.trim().toLowerCase()
  const ready = config.providers.filter((p) => !p.needsKey || p.hasKey)

  if (q) {
    const hits = config.providers
      .flatMap((p) => p.models
        .filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
        .map((m) => ({ p, m })))
      .slice(0, 30)
    if (hits.length === 0) {
      return <p className="px-3 py-4 text-xs text-zinc-600 text-center">no model matches “{query}”</p>
    }
    return (
      <DropdownMenuGroup>
        {hits.map(({ p, m }) => (
          <DropdownMenuItem
            key={p.id + m.id}
            disabled={p.needsKey && !p.hasKey}
            onClick={() => { void setModel(p.id, m.id); onSelect() }}
            className={cn('text-xs font-mono', m.id === config.defaultModel && p.id === config.defaultProvider && 'text-orange-400')}
          >
            <span className="text-zinc-600 mr-1.5 shrink-0">{p.id}</span>
            <span className="truncate">{m.id}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>
    )
  }

  return (
    <>
      {ready.map((p) => (
        <DropdownMenuGroup key={p.id}>
          <DropdownMenuLabel className="text-[11px] text-zinc-500 flex items-center justify-between">
            <span>{p.label}</span>
            {!p.needsKey && <Badge variant="outline" className="text-[9px] h-4 px-1 border-zinc-700 text-zinc-400">free</Badge>}
          </DropdownMenuLabel>
          {p.models.slice(0, 10).map((m) => (
            <DropdownMenuItem
              key={m.id}
              onClick={() => { void setModel(p.id, m.id); onSelect() }}
              className={cn('text-xs font-mono', m.id === config.defaultModel && p.id === config.defaultProvider && 'text-orange-400')}
            >
              <span className="truncate">{m.id}</span>
            </DropdownMenuItem>
          ))}
          {p.models.length > 10 && (
            <DropdownMenuItem disabled className="text-[10px] text-zinc-600">
              +{p.models.length - 10} more — type to search
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator className="bg-zinc-800" />
        </DropdownMenuGroup>
      ))}
      {config.providers.length > ready.length && (
        <DropdownMenuItem disabled className="text-[11px] text-zinc-600">
          {config.providers.length - ready.length} more providers need a key — see settings
        </DropdownMenuItem>
      )}
    </>
  )
}

function WorkspaceSwitcher({ openDialog, setOpenDialog }: { openDialog: boolean; setOpenDialog: (v: boolean) => void }) {
  const workspace = useTagent((s) => s.workspace)
  const workspaces = useTagent((s) => s.workspaces)
  const switchWorkspace = useTagent((s) => s.switchWorkspace)
  const connection = useTagent((s) => s.connection)
  const recent = workspaces.filter((w) => w.path !== workspace?.path)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 border-l border-zinc-800 pl-2 ml-1 transition-colors"
          title={workspace?.path ?? 'workspace'}
        >
          <FolderOpen className="size-3.5" />
          <span className="font-mono max-w-40 truncate">{workspace?.name ?? '…'}</span>
          <ChevronDown className="size-3 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 bg-zinc-900 border-zinc-800">
        <DropdownMenuLabel className="text-[11px] text-zinc-500">Current workspace</DropdownMenuLabel>
        <DropdownMenuItem className="text-xs font-mono text-orange-400" disabled>
          <Check className="size-3.5 mr-2" /> {workspace?.name ?? '…'}
        </DropdownMenuItem>
        {recent.length > 0 && (
          <>
            <DropdownMenuSeparator className="bg-zinc-800" />
            <DropdownMenuLabel className="text-[11px] text-zinc-500">Recent</DropdownMenuLabel>
            <DropdownMenuGroup>
              {recent.slice(0, 6).map((w) => (
                <DropdownMenuItem
                  key={w.path}
                  disabled={!w.exists || connection !== 'ready'}
                  onClick={() => void switchWorkspace(w.path)}
                  className="text-xs"
                  title={w.path}
                >
                  <span className="font-mono truncate flex-1">{w.name}</span>
                  {!w.exists && <Badge variant="outline" className="text-[9px] h-4 px-1 border-zinc-700 text-zinc-600">gone</Badge>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
        <DropdownMenuSeparator className="bg-zinc-800" />
        <DropdownMenuItem className="text-xs text-zinc-300" onClick={() => setOpenDialog(true)}>
          <FolderInput className="size-3.5 mr-2" /> Open folder…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function OpenFolderDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const switchWorkspace = useTagent((s) => s.switchWorkspace)
  const [path, setPath] = useState('')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-zinc-900 border-zinc-800 max-w-md">
        <DialogHeader>
          <DialogTitle className="text-zinc-100">Open workspace</DialogTitle>
          <DialogDescription className="text-zinc-500">
            Absolute path to a folder on the machine running the Tagent daemon.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          placeholder="/home/you/projects/my-app"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && path.trim()) {
              void switchWorkspace(path.trim())
              setPath('')
              onOpenChange(false)
            }
          }}
          className="bg-zinc-900 border-zinc-800 font-mono text-xs"
        />
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8 text-xs border-zinc-700" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            size="sm"
            className="h-8 text-xs bg-orange-500 hover:bg-orange-400 text-zinc-950"
            disabled={!path.trim()}
            onClick={() => {
              void switchWorkspace(path.trim())
              setPath('')
              onOpenChange(false)
            }}
          >
            Switch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
