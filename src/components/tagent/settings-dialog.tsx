'use client'

import { useEffect, useState } from 'react'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Check, ExternalLink, Eye, EyeOff, Github, Key, Loader2, ShieldAlert, Terminal, Globe, Bot, Bone, ScrollText, Coins, MonitorSmartphone } from 'lucide-react'
import { useTagent } from '@/lib/tagent/store'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

type Tab = 'providers' | 'permissions' | 'agent' | 'integrations'

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [tab, setTab] = useState<Tab>('providers')
  const config = useTagent((s) => s.config)
  const connection = useTagent((s) => s.connection)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-zinc-900 border-zinc-800 max-w-2xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-0">
          <DialogTitle className="text-zinc-100">Settings</DialogTitle>
          <DialogDescription className="text-zinc-500">
            {connection === 'ready' ? 'Live — stored in your workspace config (.tagent/config.json)' : 'Daemon offline — settings require a live connection'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 px-5 pt-3 pb-2 border-b border-zinc-800/60">
          {([
            ['providers', 'Providers', Key],
            ['permissions', 'Permissions', ShieldAlert],
            ['agent', 'Agent', Bot],
            ['integrations', 'Integrations', Github],
          ] as const).map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                tab === id ? 'bg-orange-500/15 text-orange-300' : 'text-zinc-500 hover:text-zinc-300')}
            >
              <Icon className="size-3.5" /> {label}
            </button>
          ))}
        </div>

        <ScrollArea className="max-h-[60vh]">
          <div className="p-5 pt-4">
            {tab === 'providers' && <ProvidersTab />}
            {tab === 'permissions' && <PermissionsTab />}
            {tab === 'agent' && <AgentTab />}
            {tab === 'integrations' && <IntegrationsTab />}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

function ProvidersTab() {
  const config = useTagent((s) => s.config)
  const setApiKey = useTagent((s) => s.setApiKey)
  const setModel = useTagent((s) => s.setModel)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [reveal, setReveal] = useState<Record<string, boolean>>({})

  if (!config) return <p className="text-sm text-zinc-500">No config loaded.</p>

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500 leading-relaxed">
        Bring your own key — keys are stored locally in <code className="text-zinc-400">.tagent/config.json</code> (gitignored)
        and never leave your machine.
      </p>
      {config.providers.map((p) => {
        const draft = drafts[p.id] ?? ''
        return (
          <div key={p.id} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 space-y-2.5">
            <div className="flex items-center gap-2">
              <span className="text-sm text-zinc-200 font-medium">{p.label}</span>
              {p.hasKey && <Badge className="text-[9px] h-4 px-1.5 bg-emerald-500/15 text-emerald-400 border-emerald-800/50 hover:bg-emerald-500/15">connected</Badge>}
              {!p.needsKey && <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-zinc-700 text-zinc-400">no key needed</Badge>}
              <div className="flex-1" />
              {p.docsUrl && (
                <a href={p.docsUrl} target="_blank" rel="noreferrer" className="text-[10px] text-zinc-500 hover:text-zinc-300 inline-flex items-center gap-1">
                  get key <ExternalLink className="size-3" />
                </a>
              )}
            </div>
            {p.needsKey && (
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    type={reveal[p.id] ? 'text' : 'password'}
                    placeholder={p.hasKey ? 'key saved — paste a new one to replace' : 'paste API key…'}
                    value={draft}
                    onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                    className="h-8 bg-zinc-900 border-zinc-800 font-mono text-xs pr-8"
                  />
                  <button className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300" onClick={() => setReveal((r) => ({ ...r, [p.id]: !r[p.id] }))}>
                    {reveal[p.id] ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                </div>
                <Button
                  size="sm" className="h-8 text-xs bg-orange-500 hover:bg-orange-400 text-zinc-950"
                  disabled={!draft.trim()}
                  onClick={async () => {
                    await setApiKey(p.id, draft.trim())
                    setDrafts((d) => ({ ...d, [p.id]: '' }))
                    toast('Key saved locally ✓')
                  }}
                >
                  Save
                </Button>
              </div>
            )}
            {p.models.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {p.models.map((m) => (
                  <button
                    key={m.id}
                    disabled={p.needsKey && !p.hasKey}
                    onClick={() => void setModel(p.id, m.id)}
                    className={cn('px-2 py-0.5 rounded text-[11px] font-mono border transition-colors',
                      m.id === config.defaultModel && p.id === config.defaultProvider
                        ? 'border-orange-500/50 bg-orange-500/10 text-orange-300'
                        : 'border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 disabled:opacity-40')}
                  >
                    {m.id === config.defaultModel && p.id === config.defaultProvider && <Check className="size-2.5 inline mr-1" />}
                    {m.id}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function PermissionsTab() {
  const config = useTagent((s) => s.config)
  const setToolPermission = useTagent((s) => s.setToolPermission)
  const setToolEnabled = useTagent((s) => s.setToolEnabled)
  const availableTools = useTagent((s) => s.availableTools)

  if (!config) return null

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500 leading-relaxed">
        Per-tool policy: <b className="text-zinc-300">ask</b> confirms every call, <b className="text-zinc-300">allow</b> runs silently,
        <b className="text-zinc-300"> deny</b> blocks it.
      </p>
      <div className="space-y-1.5">
        {availableTools.map((t) => {
          const mode = config.permissions.tools[t.name] ?? 'ask'
          return (
            <div key={t.name} className="flex items-center gap-3 rounded-lg border border-zinc-800/70 bg-zinc-950/40 px-3 py-2">
              <span className="font-mono text-xs text-zinc-300 w-28 shrink-0">{t.name}</span>
              <span className="text-[11px] text-zinc-600 truncate flex-1">{t.description.slice(0, 80)}</span>
              <div className="flex rounded-md border border-zinc-800 overflow-hidden shrink-0">
                {(['ask', 'allow', 'deny'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => void setToolPermission(t.name, m)}
                    className={cn('px-2 py-0.5 text-[10px] transition-colors',
                      mode === m
                        ? m === 'allow' ? 'bg-emerald-500/20 text-emerald-300'
                          : m === 'deny' ? 'bg-red-500/20 text-red-300'
                          : 'bg-orange-500/20 text-orange-300'
                        : 'text-zinc-600 hover:text-zinc-300')}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-zinc-200">
            <Terminal className="size-4 text-orange-400" /> bash tool
          </div>
          <Switch checked={config.tools.bash} onCheckedChange={(v) => void setToolEnabled('bash', v)} />
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-zinc-200">
            <Globe className="size-4 text-orange-400" /> browser tool <span className="text-[10px] text-zinc-600">(needs playwright)</span>
          </div>
          <Switch checked={config.tools.browser} onCheckedChange={(v) => void setToolEnabled('browser', v)} />
        </div>
      </div>
    </div>
  )
}

function AgentTab() {
  const config = useTagent((s) => s.config)
  const setCaveman = useTagent((s) => s.setCaveman)
  const setWorklog = useTagent((s) => s.setWorklog)
  const setWebGui = useTagent((s) => s.setWebGui)
  const setMaxTurns = useTagent((s) => s.setMaxTurns)
  const setRightTab = useTagent((s) => s.setRightTab)
  const [turns, setTurns] = useState('')

  if (!config) return null

  return (
    <div className="space-y-5">
      <p className="text-xs text-zinc-500 leading-relaxed">
        How the agent behaves on every run — progress tracking and token frugality.
      </p>

      {/* Worklog + todos */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <ScrollText className="size-4 text-orange-400" />
          <span className="text-sm font-medium text-zinc-200">Worklog + todos</span>
          {config.worklog.enabled ? (
            <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-800/50 hover:bg-emerald-500/15 text-[9px] h-4 px-1.5">on</Badge>
          ) : (
            <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-zinc-700 text-zinc-500">off</Badge>
          )}
        </div>
        <p className="text-xs text-zinc-500 leading-relaxed">
          The agent plans multi-step work as a <b className="text-zinc-300">live todo list</b> in the chat, then
          appends a timestamped entry to <code className="text-zinc-400">WORKLOG.md</code> after every completed step —
          a durable journal you (or a future session) can pick back up. Entries show up in the
          <b className="text-zinc-300"> Log</b> tab of the side panel.
        </p>
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-300">Keep the journal</span>
          <Switch aria-label="Worklog and todos" checked={config.worklog.enabled} onCheckedChange={(v) => void setWorklog(v)} />
        </div>
        <Button size="sm" variant="outline" className="h-7 text-xs border-zinc-700 gap-1.5" onClick={() => setRightTab('worklog')}>
          <ScrollText className="size-3.5" /> Open the Log tab
        </Button>
      </div>

      {/* Caveman mode */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Bone className="size-4 text-orange-400" />
          <span className="text-sm font-medium text-zinc-200">Caveman mode</span>
          {config.caveman ? (
            <Badge className="bg-orange-500/15 text-orange-300 border-orange-700/50 hover:bg-orange-500/15 text-[9px] h-4 px-1.5">me talk short</Badge>
          ) : (
            <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-zinc-700 text-zinc-500">off</Badge>
          )}
        </div>
        <p className="text-xs text-zinc-500 leading-relaxed">
          Omni-route style <b className="text-zinc-300">token saver</b>: ultra-terse replies (telegraphic, no filler,
          summaries capped at 5 bullets) plus a compact system prompt, one-line tool docs and tighter tool-output
          budgets. Same tools, same safety — far fewer tokens in and out.
        </p>
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-300 flex items-center gap-1.5">
            <Coins className="size-3.5 text-zinc-500" /> Terse everything
          </span>
          <Switch aria-label="Caveman mode" checked={config.caveman} onCheckedChange={(v) => void setCaveman(v)} />
        </div>
        <p className="text-[10px] text-zinc-600 leading-relaxed">
          Tip: toggle it any time from the top bar (bone icon) or with <code className="text-zinc-500">/caveman</code> in chat.
        </p>
      </div>

      {/* Max turns */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-zinc-200" />
          <span className="text-sm font-medium text-zinc-200">Turn budget</span>
        </div>
        <p className="text-xs text-zinc-500 leading-relaxed">
          Hard cap on agent loop turns per message (1–80). Lower = cheaper and safer for small tasks.
        </p>
        <div className="flex gap-2 items-center">
          <Input
            type="number" min={1} max={80}
            value={turns || String(config.maxTurns)}
            onChange={(e) => setTurns(e.target.value)}
            className="h-8 bg-zinc-900 border-zinc-800 font-mono text-xs w-24"
          />
          <Button
            size="sm" className="h-8 text-xs bg-orange-500 hover:bg-orange-400 text-zinc-950"
            disabled={!turns.trim() || Number(turns) === config.maxTurns}
            onClick={async () => { await setMaxTurns(Number(turns)); setTurns('') }}
          >
            Save
          </Button>
          <span className="text-[11px] text-zinc-600">current: {config.maxTurns}</span>
        </div>
      </div>

      {/* Web GUI companion */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <MonitorSmartphone className="size-4 text-orange-400" />
          <span className="text-sm font-medium text-zinc-200">Web GUI companion</span>
          {config.webGui ? (
            <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-800/50 hover:bg-emerald-500/15 text-[9px] h-4 px-1.5">auto-start</Badge>
          ) : (
            <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-zinc-700 text-zinc-500">off</Badge>
          )}
        </div>
        <p className="text-xs text-zinc-500 leading-relaxed">
          <b className="text-zinc-300">The TUI is the primary interface</b> — same engine, same sessions, same
          permissions in the terminal and the browser. Turn this on to also launch the web GUI with
          <code className="text-zinc-400"> tagent start</code> (any run can override with
          <code className="text-zinc-400"> --web-gui</code>). Saved globally.
        </p>
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-300">Start the web GUI together with the TUI</span>
          <Switch aria-label="Web GUI auto-start" checked={config.webGui} onCheckedChange={(v) => void setWebGui(v)} />
        </div>
      </div>
    </div>
  )
}

function IntegrationsTab() {
  const config = useTagent((s) => s.config)
  const saveGithubPat = useTagent((s) => s.saveGithubPat)
  const githubPush = useTagent((s) => s.githubPush)
  const githubBusy = useTagent((s) => s.githubBusy)
  const saveMega = useTagent((s) => s.saveMega)
  const megaSync = useTagent((s) => s.megaSync)
  const megaPull = useTagent((s) => s.megaPull)
  const [pat, setPat] = useState('')
  const [busy, setBusy] = useState(false)
  const [megaEmail, setMegaEmail] = useState('')
  const [megaKey, setMegaKey] = useState('')
  const [megaBusy, setMegaBusy] = useState(false)
  const [device, setDevice] = useState<{ user_code: string; verification_uri: string } | null>(null)
  const [deviceBusy, setDeviceBusy] = useState(false)

  if (!config) return null

  const { socket, connection } = useTagent.getState()
  const callRpc = async <T,>(event: string, payload: unknown, ms = 20000): Promise<T> => {
    if (!socket || connection !== 'ready') throw new Error('daemon not connected')
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(undefined as T), ms)
      socket.emit(event, payload, (res: T) => { clearTimeout(t); resolve(res) })
    })
  }

  const startDeviceFlow = async (pollOnly: boolean) => {
    setDeviceBusy(true)
    try {
      if (!pollOnly || !device) {
        const start = await callRpc<{ user_code: string; verification_uri: string; error?: string }>('github:device:start', {})
        if (!start?.user_code) throw new Error(start?.error ?? 'device flow unavailable — set TAGENT_GH_CLIENT_ID or use a PAT')
        setDevice(start)
        window.open(start.verification_uri, '_blank')
      }
      const r = await callRpc<{ ok?: boolean; login?: string; error?: string }>('github:device:poll', {}, 300000)
      if (r?.ok) {
        toast(`Connected as @${r.login}`)
        setDevice(null)
        window.location.reload()
      } else {
        throw new Error(r?.error ?? 'device flow timed out')
      }
    } catch (e) {
      toast.error((e as Error).message)
      setDeviceBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      {/* GitHub */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Github className="size-4 text-zinc-200" />
          <span className="text-sm font-medium text-zinc-200">GitHub</span>
          {config.github.connected ? (
            <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-800/50 hover:bg-emerald-500/15 text-[9px] h-4 px-1.5">
              @{config.github.login}
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-zinc-700 text-zinc-500">not connected</Badge>
          )}
        </div>
        <p className="text-xs text-zinc-500 leading-relaxed">
          Paste a Personal Access Token (<code className="text-zinc-400">repo</code> scope) — or use the device flow:
          open the link, type the code, done. Also available in the CLI: <code className="text-zinc-400">tagent auth</code>.
          The token stays in local config and is used to create a private repo and push your workspace.
        </p>
        {!config.github.connected && (
          <>
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder="ghp_…"
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                className="h-8 bg-zinc-900 border-zinc-800 font-mono text-xs"
              />
              <Button
                size="sm" className="h-8 text-xs bg-orange-500 hover:bg-orange-400 text-zinc-950"
                disabled={!pat.trim() || busy}
                onClick={async () => {
                  setBusy(true)
                  const r = await saveGithubPat(pat.trim())
                  setBusy(false)
                  setPat('')
                  if (r.ok) toast(`Connected as @${r.login}`)
                  else toast.error(r.error ?? 'failed')
                }}
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : 'Connect'}
              </Button>
            </div>
            <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/30 p-3 space-y-2">
              <p className="text-[11px] text-zinc-500">No token at hand? Login in your browser instead:</p>
              {device ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-[10px] text-zinc-500 truncate">{device.verification_uri}</p>
                      <p className="font-mono text-sm text-orange-300 tracking-wider">{device.user_code}</p>
                    </div>
                    <Button
                      size="sm" variant="outline" className="h-7 text-xs border-zinc-700 shrink-0"
                      onClick={() => window.open(device.verification_uri, '_blank')}
                    >
                      <Globe className="size-3.5" /> Open
                    </Button>
                  </div>
                  <p className="text-[11px] text-zinc-500 flex items-center gap-1.5">
                    {deviceBusy ? <Loader2 className="size-3 animate-spin" /> : null}
                    {deviceBusy ? 'waiting for authorization…' : 'polling paused — press Retry if it expires'}
                  </p>
                  {!deviceBusy && (
                    <Button
                      size="sm" variant="outline" className="h-7 text-xs border-zinc-700"
                      onClick={() => void startDeviceFlow(true)}
                    >
                      Retry
                    </Button>
                  )}
                </div>
              ) : (
                <Button
                  size="sm" variant="outline" className="h-7 text-xs border-zinc-700"
                  disabled={deviceBusy}
                  onClick={() => void startDeviceFlow(false)}
                >
                  {deviceBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Globe className="size-3.5" />}
                  Login with browser (device flow)
                </Button>
              )}
            </div>
          </>
        )}
        {config.github.connected && (
          <Button size="sm" variant="outline" className="h-8 text-xs border-zinc-700 gap-1.5" disabled={githubBusy} onClick={() => void githubPush()}>
            {githubBusy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Push workspace → GitHub
          </Button>
        )}
      </div>

      {/* MEGA */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <span className="grid place-items-center size-5 rounded bg-red-500/15 text-red-400 text-[10px] font-bold">M</span>
          <span className="text-sm font-medium text-zinc-200">MEGA cloud sync</span>
          {config.mega.enabled ? (
            <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-800/50 hover:bg-emerald-500/15 text-[9px] h-4 px-1.5">
              {config.mega.email ?? 'enabled'}
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-zinc-700 text-zinc-500">off</Badge>
          )}
        </div>
        <p className="text-xs text-zinc-500 leading-relaxed">
          End-to-end encrypted memory backup (AGENTS.md drafts + facts) synced across your devices.
          Needs <code className="text-zinc-400">bun add megajs</code> once, then your MEGA email + password.
        </p>
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-300">Enable cloud sync</span>
          <Switch
            checked={config.mega.enabled}
            onCheckedChange={(v) => void saveMega(v, megaEmail || config.mega.email || '', megaKey)}
          />
        </div>
        <div className="grid grid-cols-1 gap-2">
          <Input
            type="email"
            placeholder={config.mega.email ?? 'MEGA email'}
            value={megaEmail}
            onChange={(e) => setMegaEmail(e.target.value)}
            className="h-8 bg-zinc-900 border-zinc-800 text-xs"
          />
          <div className="flex gap-2">
            <Input
              type="password"
              placeholder="MEGA password / session key…"
              value={megaKey}
              onChange={(e) => setMegaKey(e.target.value)}
              className="h-8 bg-zinc-900 border-zinc-800 font-mono text-xs"
            />
            <Button
              size="sm" className="h-8 text-xs bg-orange-500 hover:bg-orange-400 text-zinc-950 shrink-0"
              disabled={(!megaEmail.trim() && !config.mega.email) || !megaKey.trim()}
              onClick={async () => {
                setBusy(true)
                await saveMega(true, megaEmail.trim() || config.mega.email || '', megaKey.trim())
                setMegaKey('')
                setBusy(false)
              }}
            >
              Save
            </Button>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm" variant="outline" className="h-8 text-xs border-zinc-700 gap-1.5"
            disabled={!config.mega.enabled || megaBusy}
            onClick={async () => { setMegaBusy(true); await megaSync(); setMegaBusy(false) }}
          >
            {megaBusy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Sync memory ↑
          </Button>
          <Button
            size="sm" variant="outline" className="h-8 text-xs border-zinc-700"
            disabled={!config.mega.enabled}
            onClick={() => void megaPull()}
          >
            Restore ↓
          </Button>
        </div>
      </div>
    </div>
  )
}
