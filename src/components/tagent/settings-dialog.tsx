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
import { Check, ChevronDown, ChevronUp, ExternalLink, Eye, EyeOff, Github, Key, Loader2, Plus, RefreshCw, Search, ShieldAlert, Terminal, Globe, Bot, Bone, ScrollText, Coins, MonitorSmartphone, Trash2, Plug, Puzzle, Power, FileCode2, Waypoints, Zap } from 'lucide-react'
import { useTagent } from '@/lib/tagent/store'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { Checkbox } from '@/components/ui/checkbox'
import type { FallbackEntry } from '@/lib/tagent/types'

type Tab = 'providers' | 'mcp' | 'permissions' | 'agent' | 'integrations' | 'plugins'

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
            ['mcp', 'MCP', Plug],
            ['plugins', 'Plugins', Puzzle],
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
            {tab === 'mcp' && <McpTab />}
            {tab === 'plugins' && <PluginsTab />}
            {tab === 'permissions' && <PermissionsTab />}
            {tab === 'agent' && <AgentTab />}
            {tab === 'integrations' && <IntegrationsTab />}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */
/* MCP — Model Context Protocol servers                                */
/* ------------------------------------------------------------------ */

function McpTab() {
  const mcpStatus = useTagent((s) => s.mcpStatus)
  const mcpTemplates = useTagent((s) => s.mcpTemplates)
  const mcpRefresh = useTagent((s) => s.mcpRefresh)
  const mcpAddServer = useTagent((s) => s.mcpAddServer)
  const mcpRemoveServer = useTagent((s) => s.mcpRemoveServer)
  const mcpToggleServer = useTagent((s) => s.mcpToggleServer)
  const [busy, setBusy] = useState<string | null>(null)
  const [showCustom, setShowCustom] = useState(false)
  const [form, setForm] = useState({ name: '', command: 'npx', args: '-y @modelcontextprotocol/server-memory' })

  useEffect(() => {
    if (mcpStatus.length === 0 && mcpTemplates.length === 0) void mcpRefresh()
  }, [mcpStatus.length, mcpTemplates.length, mcpRefresh])

  const add = async (tpl: (typeof mcpTemplates)[number]) => {
    setBusy(tpl.name)
    const r = await mcpAddServer({ name: tpl.name, command: tpl.command, args: tpl.args })
    setBusy(null)
    if (r.error) toast.error(r.error)
    else toast(`${tpl.name} added — starting…`)
    await mcpRefresh()
  }

  const addCustom = async () => {
    if (!form.name.trim() || !form.command.trim()) {
      toast.error('name and command are required')
      return
    }
    setBusy('__custom')
    const r = await mcpAddServer({
      name: form.name.trim(),
      command: form.command.trim(),
      args: form.args.trim() ? form.args.trim().split(/\s+/) : undefined,
    })
    setBusy(null)
    if (r.error) toast.error(r.error)
    else {
      toast(`${form.name.trim()} added ✓`)
      setShowCustom(false)
      setForm({ name: '', command: 'npx', args: '-y @modelcontextprotocol/server-memory' })
    }
    await mcpRefresh()
  }

  const stateBadge = (s: (typeof mcpStatus)[number]) => {
    if (s.state === 'ready') return <Badge className="text-[9px] h-4 px-1.5 bg-emerald-500/15 text-emerald-400 border-emerald-800/50 hover:bg-emerald-500/15">{s.tools} tools</Badge>
    if (s.state === 'error') return <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-red-800/60 text-red-400">error</Badge>
    if (s.state === 'disabled') return <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-zinc-700 text-zinc-500">off</Badge>
    return <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-amber-800/60 text-amber-400"><Loader2 className="size-2.5 animate-spin" /></Badge>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <p className="text-xs text-zinc-500 flex-1">
          Model Context Protocol servers — extra tools for the agent (stdio, local). Tools appear as <code className="font-mono text-[10px] text-orange-300">mcp_&lt;server&gt;_&lt;tool&gt;</code> and go through the same permission gates.
        </p>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void mcpRefresh()}>
          <RefreshCw className="size-3" /> Refresh
        </Button>
      </div>

      {/* configured servers */}
      {mcpStatus.length > 0 && (
        <div className="space-y-2">
          {mcpStatus.map((s) => (
            <div key={s.name} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
              <div className="flex items-center gap-2">
                <Plug className="size-3.5 text-orange-400" />
                <span className="text-sm text-zinc-200 font-medium">{s.name}</span>
                {stateBadge(s)}
                <span className="font-mono text-[10px] text-zinc-600 truncate flex-1">{s.command}</span>
                <button
                  className="text-zinc-500 hover:text-orange-300"
                  title={s.enabled ? 'disable' : 'enable'}
                  onClick={() => void mcpToggleServer(s.name)}
                >
                  <Power className="size-3.5" />
                </button>
                <button className="text-zinc-600 hover:text-red-400" title="remove" onClick={() => void mcpRemoveServer(s.name)}>
                  <Trash2 className="size-3.5" />
                </button>
              </div>
              {s.error && <p className="mt-1.5 text-[11px] text-red-400/80 font-mono">{s.error.slice(0, 120)}</p>}
            </div>
          ))}
        </div>
      )}
      {mcpStatus.length === 0 && (
        <p className="text-xs text-zinc-600">No servers configured — add one below.</p>
      )}

      {/* templates */}
      <div>
        <p className="text-[11px] font-medium text-zinc-400 mb-2">Add a server</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {mcpTemplates.map((t) => (
            <button
              key={t.name}
              disabled={busy === t.name || mcpStatus.some((s) => s.name === t.name)}
              onClick={() => void add(t)}
              className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5 text-left transition-colors hover:border-orange-500/40 disabled:opacity-40"
            >
              <div className="text-xs text-zinc-200 font-medium flex items-center gap-1.5">
                {busy === t.name ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
                {t.label}
              </div>
              <p className="mt-0.5 text-[10px] text-zinc-500 line-clamp-2">{t.note}</p>
              <p className="mt-1 font-mono text-[9px] text-zinc-600 truncate">{t.command} {t.args.join(' ')}</p>
            </button>
          ))}
          <button
            onClick={() => setShowCustom((v) => !v)}
            className="rounded-lg border border-dashed border-zinc-700 p-2.5 text-left transition-colors hover:border-orange-500/40"
          >
            <div className="text-xs text-zinc-300 font-medium flex items-center gap-1.5">
              <FileCode2 className="size-3" /> Custom server…
            </div>
            <p className="mt-0.5 text-[10px] text-zinc-500">any stdio MCP server — command + args</p>
          </button>
        </div>
      </div>

      {/* custom form */}
      {showCustom && (
        <div className="rounded-lg border border-orange-500/30 bg-zinc-950/40 p-3 space-y-2">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Input
              className="h-8 text-xs bg-zinc-900 border-zinc-800"
              placeholder="name (e.g. my-tools)"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <Input
            className="h-8 text-xs bg-zinc-900 border-zinc-800"
            placeholder="command (npx / uvx / node / path)"
            value={form.command}
            onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
          />
          <Input
            className="h-8 text-xs font-mono bg-zinc-900 border-zinc-800"
            placeholder="args (space separated)"
            value={form.args}
            onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowCustom(false)}>Cancel</Button>
            <Button size="sm" className="h-7 text-xs bg-orange-500 hover:bg-orange-400" disabled={busy === '__custom'} onClick={() => void addCustom()}>
              {busy === '__custom' ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />} Add server
            </Button>
          </div>
        </div>
      )}

      <p className="text-[10px] text-zinc-600">
        TUI equivalent: <code className="font-mono">/mcp</code> · servers live in <code className="font-mono">.tagent/config.json</code> · every tool call still asks permission by default
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Plugins                                                             */
/* ------------------------------------------------------------------ */

function PluginsTab() {
  const plugins = useTagent((s) => s.plugins)
  const pluginsRefresh = useTagent((s) => s.pluginsRefresh)
  const pluginNew = useTagent((s) => s.pluginNew)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const connection = useTagent((s) => s.connection)

  useEffect(() => {
    if (connection === 'ready') void pluginsRefresh()
  }, [connection, pluginsRefresh])

  const create = async () => {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    const r = await pluginNew(name)
    setBusy(false)
    if (r.error) toast.error(r.error)
    else {
      toast(`Scaffold created — ${r.file}`)
      setNewName('')
    }
    await pluginsRefresh()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <p className="text-xs text-zinc-500 flex-1">
          Plugins are <code className="font-mono text-[10px] text-orange-300">.mjs</code> files exporting hooks, custom agent tools (<code className="font-mono text-[10px] text-orange-300">plugin_&lt;name&gt;_&lt;tool&gt;</code>) and slash commands. They hot-reload every turn.
        </p>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void pluginsRefresh()}>
          <RefreshCw className="size-3" /> Refresh
        </Button>
      </div>

      {plugins.length === 0 ? (
        <p className="text-xs text-zinc-600">No plugins installed yet.</p>
      ) : (
        <div className="space-y-2">
          {plugins.map((p) => (
            <div key={p.file} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 flex items-center gap-2">
              <Puzzle className="size-3.5 text-orange-400" />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-zinc-200 font-medium flex items-center gap-2">
                  {p.name}
                  <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-zinc-700 text-zinc-500">{p.scope}</Badge>
                </div>
                <p className="font-mono text-[10px] text-zinc-600 truncate">{p.file}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 space-y-2">
        <p className="text-[11px] font-medium text-zinc-400">New plugin scaffold</p>
        <div className="flex gap-2">
          <Input
            className="h-8 text-xs bg-zinc-900 border-zinc-800"
            placeholder="my-plugin"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
          />
          <Button size="sm" className="h-8 text-xs bg-orange-500 hover:bg-orange-400" disabled={busy || !newName.trim()} onClick={() => void create()}>
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />} Create
          </Button>
        </div>
        <p className="text-[10px] text-zinc-600">
          Creates <code className="font-mono">.tagent/plugins/&lt;name&gt;.mjs</code> with hooks + a sample tool + a sample command. Edit it, no restart needed.
        </p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function ProvidersTab() {
  const config = useTagent((s) => s.config)
  const setApiKey = useTagent((s) => s.setApiKey)
  const setModel = useTagent((s) => s.setModel)
  const providersRefresh = useTagent((s) => s.providersRefresh)
  const saveCustomProvider = useTagent((s) => s.saveCustomProvider)
  const removeCustomProvider = useTagent((s) => s.removeCustomProvider)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [reveal, setReveal] = useState<Record<string, boolean>>({})
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [customForm, setCustomForm] = useState<null | { id: string; label: string; baseUrl: string; apiKey: string; kind: 'openai' | 'anthropic' | 'google'; models: string }>(null)

  if (!config) return <p className="text-sm text-zinc-500">No config loaded.</p>

  const query = q.trim().toLowerCase()
  const matches = (p: (typeof config.providers)[number]) =>
    !query || p.id.includes(query) || p.label.toLowerCase().includes(query) || p.models.some((m) => m.id.toLowerCase().includes(query))
  const ready = config.providers.filter((p) => (!p.needsKey || p.hasKey) && !p.custom && matches(p))
  const locked = config.providers.filter((p) => p.needsKey && !p.hasKey && !p.custom && matches(p))
  const customs = config.providers.filter((p) => p.custom && matches(p))

  const runRefresh = async () => {
    setBusy(true)
    const r = await providersRefresh()
    setBusy(false)
    if (r?.error) toast.error(r.error)
    else if (r?.updated?.length) toast(`Discovered models from ${r.updated.length} provider(s) ✓`)
    else toast('No new models found — keys present are up to date')
  }

  const saveCustom = async () => {
    if (!customForm) return
    if (!customForm.id.trim() || !customForm.baseUrl.trim()) {
      toast.error('id and base URL are required')
      return
    }
    const r = await saveCustomProvider({
      id: customForm.id.trim(),
      label: customForm.label.trim() || customForm.id.trim(),
      baseUrl: customForm.baseUrl.trim(),
      apiKey: customForm.apiKey.trim() || undefined,
      kind: customForm.kind,
      models: customForm.models.split(',').map((s) => s.trim()).filter(Boolean),
    })
    if (r?.ok || !r?.error) {
      toast('Custom provider saved ✓')
      setCustomForm(null)
    } else toast.error(r?.error ?? 'failed')
  }

  const ProviderCard = ({ p }: { p: (typeof config.providers)[number] }) => {
    const draft = drafts[p.id] ?? ''
    const models = expanded[p.id] ? p.models : p.models.slice(0, 8)
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 space-y-2.5">
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-200 font-medium">{p.label}</span>
          <span className="font-mono text-[10px] text-zinc-600">{p.id}</span>
          {p.hasKey && !p.custom && <Badge className="text-[9px] h-4 px-1.5 bg-emerald-500/15 text-emerald-400 border-emerald-800/50 hover:bg-emerald-500/15">connected</Badge>}
          {p.custom && <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-orange-800/60 text-orange-400">custom</Badge>}
          {!p.needsKey && !p.custom && <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-zinc-700 text-zinc-400">no key needed</Badge>}
          {p.needsKey && p.hasKey && p.envVar && !drafts[p.id] && (
            <span className="text-[10px] text-zinc-600 font-mono">via {p.envVar}</span>
          )}
          <div className="flex-1" />
          {p.docsUrl && (
            <a href={p.docsUrl} target="_blank" rel="noreferrer" className="text-[10px] text-zinc-500 hover:text-zinc-300 inline-flex items-center gap-1">
              get key <ExternalLink className="size-3" />
            </a>
          )}
          {p.custom && (
            <button className="text-zinc-600 hover:text-red-400" title="remove custom provider" onClick={() => { void removeCustomProvider(p.id); setCustomForm(null) }}>
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
        {p.needsKey && !p.custom && (
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={reveal[p.id] ? 'text' : 'password'}
                placeholder={p.hasKey ? 'key saved — paste a new one to replace' : p.envVar ? `paste API key (or export ${p.envVar})…` : 'paste API key…'}
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
            {models.map((m) => (
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
            {p.models.length > 8 && !expanded[p.id] && (
              <button className="px-2 py-0.5 rounded text-[11px] border border-zinc-800 text-zinc-500 hover:text-zinc-300" onClick={() => setExpanded((e) => ({ ...e, [p.id]: true }))}>
                +{p.models.length - 8} more
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2 items-center">
        <div className="relative flex-1">
          <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`search ${config.providers.length} providers & models…`}
            className="h-8 bg-zinc-900 border-zinc-800 text-xs pl-8"
          />
        </div>
        <Button size="sm" variant="outline" className="h-8 text-xs border-zinc-700 gap-1.5 shrink-0" disabled={busy} onClick={() => void runRefresh()}>
          <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} /> {busy ? 'discovering…' : 'Refresh models'}
        </Button>
      </div>
      <p className="text-xs text-zinc-500 leading-relaxed">
        Bring your own key — stored locally in <code className="text-zinc-400">.tagent/config.json</code>, or picked up from
        environment variables (<code className="text-zinc-400">OPENAI_API_KEY</code>, <code className="text-zinc-400">ANTHROPIC_API_KEY</code>, …).
        <b className="text-zinc-400"> Refresh models</b> discovers the provider's live model list.
      </p>

      {(ready.length > 0 || customs.length > 0) && (
        <div className="space-y-2.5">
          <p className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">Ready to use</p>
          {ready.map((p) => <ProviderCard key={p.id} p={p} />)}
          {customs.map((p) => <ProviderCard key={p.id} p={p} />)}
        </div>
      )}

      {locked.length > 0 && (
        <div className="space-y-2.5">
          <p className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">Catalog — add a key to use</p>
          {locked.map((p) => <ProviderCard key={p.id} p={p} />)}
        </div>
      )}

      {/* custom provider form */}
      {customForm ? (
        <div className="rounded-lg border border-orange-800/40 bg-zinc-950/60 p-3 space-y-2.5">
          <p className="text-[11px] font-semibold text-orange-300 uppercase tracking-wider">Custom provider</p>
          <div className="grid grid-cols-2 gap-2">
            <Input autoFocus placeholder="id (e.g. my-proxy)" value={customForm.id} onChange={(e) => setCustomForm({ ...customForm, id: e.target.value })} className="h-8 bg-zinc-900 border-zinc-800 font-mono text-xs" />
            <Input placeholder="label (e.g. My Proxy)" value={customForm.label} onChange={(e) => setCustomForm({ ...customForm, label: e.target.value })} className="h-8 bg-zinc-900 border-zinc-800 text-xs" />
          </div>
          <div className="flex gap-2">
            {(['openai', 'anthropic', 'google'] as const).map((k) => (
              <button key={k} onClick={() => setCustomForm({ ...customForm, kind: k })}
                className={cn('px-2 py-1 rounded text-[11px] font-mono border transition-colors',
                  customForm.kind === k ? 'border-orange-500/50 bg-orange-500/10 text-orange-300' : 'border-zinc-800 text-zinc-500 hover:text-zinc-300')}>
                {k === 'openai' ? 'OpenAI-compatible' : k}
              </button>
            ))}
          </div>
          <Input placeholder="base URL — e.g. https://my-gateway.example.com/v1" value={customForm.baseUrl} onChange={(e) => setCustomForm({ ...customForm, baseUrl: e.target.value })} className="h-8 bg-zinc-900 border-zinc-800 font-mono text-xs" />
          <Input type="password" placeholder="API key (optional — empty for local servers)" value={customForm.apiKey} onChange={(e) => setCustomForm({ ...customForm, apiKey: e.target.value })} className="h-8 bg-zinc-900 border-zinc-800 font-mono text-xs" />
          <Input placeholder="models, comma-separated (refresh discovers the rest)" value={customForm.models} onChange={(e) => setCustomForm({ ...customForm, models: e.target.value })} className="h-8 bg-zinc-900 border-zinc-800 font-mono text-xs" />
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="outline" className="h-8 text-xs border-zinc-700" onClick={() => setCustomForm(null)}>Cancel</Button>
            <Button size="sm" className="h-8 text-xs bg-orange-500 hover:bg-orange-400 text-zinc-950" onClick={() => void saveCustom()}>Save provider</Button>
          </div>
          <p className="text-[10px] text-zinc-600 leading-relaxed">
            Works with any OpenAI-compatible endpoint (vLLM, llama.cpp, Azure's /openai/v1, LiteLLM, OneAPI…),
            Anthropic-compatible proxies and Google-compatible gateways.
          </p>
        </div>
      ) : (
        <button onClick={() => setCustomForm({ id: '', label: '', baseUrl: '', apiKey: '', kind: 'openai', models: '' })}
          className="w-full rounded-lg border border-dashed border-zinc-800 hover:border-zinc-700 p-3 text-xs text-zinc-500 hover:text-zinc-300 inline-flex items-center justify-center gap-1.5 transition-colors">
          <Plus className="size-3.5" /> Add custom provider — any endpoint, any model
        </button>
      )}

      <FallbackCard />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Provider fallback — ordered failover chain                          */
/* ------------------------------------------------------------------ */

function FallbackCard() {
  const config = useTagent((s) => s.config)
  const saveFallback = useTagent((s) => s.saveFallback)
  // edits stay local until "Save chain"; resets from config on dialog open
  const [chain, setChain] = useState<FallbackEntry[] | null>(null)
  const [busy, setBusy] = useState(false)

  if (!config) return null
  const rows = chain ?? config.fallback ?? []

  const update = (i: number, patch: Partial<FallbackEntry>) =>
    setChain(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= rows.length) return
    const next = [...rows]
    ;[next[i], next[j]] = [next[j], next[i]]
    setChain(next)
  }
  const add = () => setChain([...rows, { provider: config.providers[0]?.id ?? '', model: '', enabled: true }])
  const remove = (i: number) => setChain(rows.filter((_, j) => j !== i))

  const save = async () => {
    setBusy(true)
    await saveFallback(rows.map((r) => ({ ...r, apiKey: r.apiKey?.trim() || undefined })))
    setBusy(false)
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <Waypoints className="size-4 text-orange-400" />
        <span className="text-sm font-medium text-zinc-200">Provider fallback</span>
        <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-zinc-700 text-zinc-500">ordered failover chain</Badge>
      </div>
      <p className="text-xs text-zinc-500 leading-relaxed">
        If the primary model fails (rate limit, outage, bad key), the run falls through this chain top-down —
        same conversation, next provider.
      </p>

      {rows.length === 0 && (
        <p className="text-xs text-zinc-600">No fallbacks — the run stops when the primary provider fails.</p>
      )}

      <div className="space-y-2">
        {rows.map((f, i) => (
          <div key={i} className="rounded-lg border border-zinc-800/70 bg-zinc-900/30 p-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-zinc-600 w-4 shrink-0 text-center">{i + 1}</span>
              <Checkbox
                checked={f.enabled !== false}
                onCheckedChange={(v) => update(i, { enabled: v === true })}
                title="enabled"
              />
              <select
                value={f.provider}
                onChange={(e) => update(i, { provider: e.target.value })}
                className="h-7 rounded-md border border-zinc-800 bg-zinc-900 px-1.5 text-[11px] text-zinc-200 focus:outline-none focus:border-orange-500/50"
              >
                {config.providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
              <Input
                placeholder="model"
                value={f.model}
                onChange={(e) => update(i, { model: e.target.value })}
                className="h-7 text-[11px] font-mono bg-zinc-900 border-zinc-800 flex-1 min-w-0"
              />
              <div className="flex items-center gap-0.5 shrink-0">
                <Button variant="ghost" size="icon" className="size-6 text-zinc-500" disabled={i === 0} onClick={() => move(i, -1)} title="move up">
                  <ChevronUp className="size-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="size-6 text-zinc-500" disabled={i === rows.length - 1} onClick={() => move(i, 1)} title="move down">
                  <ChevronDown className="size-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="size-6 text-zinc-600 hover:text-red-400" onClick={() => remove(i)} title="remove">
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
            <div className="flex gap-2 pl-6">
              <Input
                type="password"
                placeholder={f.apiKey ? 'key saved — paste to replace' : 'API key (optional — uses stored key)'}
                value={f.apiKey ?? ''}
                onChange={(e) => update(i, { apiKey: e.target.value })}
                className="h-7 text-[11px] font-mono bg-zinc-900 border-zinc-800"
              />
              <Input
                placeholder="label (optional)"
                value={f.label ?? ''}
                onChange={(e) => update(i, { label: e.target.value })}
                className="h-7 text-[11px] bg-zinc-900 border-zinc-800 w-32 shrink-0"
              />
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <Button size="sm" variant="outline" className="h-7 text-xs border-dashed border-zinc-700" onClick={add}>
          <Plus className="size-3" /> Add fallback
        </Button>
        <Button size="sm" className="h-7 text-xs bg-orange-500 hover:bg-orange-400" disabled={busy} onClick={() => void save()}>
          {busy ? <Loader2 className="size-3 animate-spin" /> : null} Save chain
        </Button>
      </div>
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
  const setCacheFileState = useTagent((s) => s.setCacheFileState)
  const setCacheWeb = useTagent((s) => s.setCacheWeb)
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

      {/* Smart cache — the token economist */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Zap className="size-4 text-orange-400" />
          <span className="text-sm font-medium text-zinc-200">Smart cache</span>
          {config.cache.fileState || config.cache.web ? (
            <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-800/50 hover:bg-emerald-500/15 text-[9px] h-4 px-1.5">saving tokens</Badge>
          ) : (
            <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-zinc-700 text-zinc-500">off</Badge>
          )}
        </div>
        <p className="text-xs text-zinc-500 leading-relaxed">
          <b className="text-zinc-300">The token economist.</b> Re-reading an <b className="text-zinc-300">unchanged file</b>
          returns a tiny "already in your context" stub instead of resending the whole file. The agent batches
          known paths into one <code className="text-zinc-400">read_files</code> call, never spawns a subagent just to
          read a file, and old tool outputs are compacted automatically when the context grows.
        </p>
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs text-zinc-300">File-state cache</span>
            <p className="text-[10px] text-zinc-600">persists per workspace in .tagent/file-state.json</p>
          </div>
          <Switch aria-label="File-state cache" checked={config.cache.fileState} onCheckedChange={(v) => void setCacheFileState(v)} />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs text-zinc-300">Web cache (fetch + search)</span>
            <p className="text-[10px] text-zinc-600">TTL {config.cache.webTtlMin} min · in-memory per session</p>
          </div>
          <Switch aria-label="Web cache" checked={config.cache.web} onCheckedChange={(v) => void setCacheWeb(v)} />
        </div>
        <p className="text-[10px] text-zinc-600 leading-relaxed">
          Tip: <code className="text-zinc-500">tagent cache</code> in the terminal shows what is cached;
          <code className="text-zinc-500"> tagent cache clear</code> wipes it.
        </p>
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
