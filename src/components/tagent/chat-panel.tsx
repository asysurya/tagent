'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ArrowUp, Bot, CircleStop, ListChecks, Loader2, Sparkles, Zap } from 'lucide-react'
import { useTagent } from '@/lib/tagent/store'
import { cn } from '@/lib/utils'
import { AssistantMessage, UserMessage } from './message'
import type { TodoItem } from '@/lib/tagent/types'

function TodosWidget({ todos }: { todos: TodoItem[] }) {
  if (!todos.length) return null
  return (
    <div className="mx-4 mt-2 rounded-lg border border-zinc-800/70 bg-zinc-900/30 p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1.5 flex items-center gap-1.5">
        <ListChecks className="size-3" /> plan
      </p>
      <ul className="space-y-1">
        {todos.map((t) => (
          <li key={t.id} className="flex items-center gap-2 text-[12px]">
            <span className={cn('size-1.5 rounded-full shrink-0',
              t.status === 'completed' ? 'bg-emerald-500'
              : t.status === 'in_progress' ? 'bg-orange-400 animate-pulse'
              : 'bg-zinc-600')} />
            <span className={cn(t.status === 'completed' ? 'text-zinc-600 line-through' : 'text-zinc-300',
              t.status === 'in_progress' && 'text-orange-200')}>
              {t.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SubagentStrip() {
  const subagents = useTagent((s) => s.subagents)
  if (!subagents.length) return null
  const running = subagents.filter((s) => s.status === 'running').length
  return (
    <div className="mx-4 mt-2 flex items-center gap-2 text-[11px] text-zinc-500">
      <Bot className="size-3.5 text-violet-400" />
      <span>
        {running > 0 ? `${running} subagent${running > 1 ? 's' : ''} working` : `${subagents.length} subagent run`}
      </span>
      <span className="text-zinc-600 truncate">
        {subagents[subagents.length - 1]?.description}
      </span>
    </div>
  )
}

function StatusLine() {
  const status = useTagent((s) => s.status)
  const running = useTagent((s) => s.running)
  if (!running || !status) return null
  return (
    <div className="px-4 py-1.5 flex items-center gap-2 text-[11px] text-zinc-500">
      <Loader2 className="size-3 text-orange-400 animate-spin" />
      <span className="font-mono">
        {status.phase}
        {status.detail ? ` — ${status.detail}` : ''}
      </span>
    </div>
  )
}

function StreamMessage() {
  const stream = useTagent((s) => s.stream)
  const status = useTagent((s) => s.status)
  if (!stream || status?.phase !== 'thinking') return null
  return (
    <div className="px-4 py-2 flex gap-3">
      <span className="text-[10px] font-mono text-orange-400/80 pt-1 w-16 shrink-0 text-right select-none">tagent</span>
      <div className="min-w-0 flex-1 text-sm text-zinc-400 whitespace-pre-wrap break-words leading-relaxed">
        {stream}
      </div>
    </div>
  )
}

const SUGGESTIONS = [
  { icon: Zap, label: 'Fix the bugs in this workspace', text: 'Read README.md, then find and fix the bugs described there.' },
  { icon: Sparkles, label: 'Explain this project', text: 'Explore the workspace and explain what this project does, file by file.' },
  { icon: Bot, label: 'Spawn a subagent to review', text: 'Spawn a subagent to review the code quality of app.js and report findings.' },
]

function EmptyState() {
  const send = useTagent((s) => s.send)
  const connection = useTagent((s) => s.connection)
  return (
    <div className="flex-1 grid place-items-center p-8">
      <div className="max-w-md text-center space-y-6">
        <span className="inline-grid place-items-center size-14 rounded-2xl bg-orange-500 text-zinc-950 shadow-lg shadow-orange-500/20">
          <Zap className="size-7" />
        </span>
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">What should we build?</h1>
          <p className="text-sm text-zinc-500 mt-1.5 leading-relaxed">
            {connection === 'ready'
              ? 'The agent can read, edit, and search your workspace — every write asks permission first.'
              : connection === 'demo'
                ? 'Daemon offline — you are seeing a scripted demo of the interface.'
                : 'Connecting to the daemon…'}
          </p>
        </div>
        <div className="grid gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              onClick={() => void send(s.text)}
              className="flex items-center gap-3 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3.5 py-2.5 text-left hover:border-orange-500/40 hover:bg-zinc-900 transition-colors"
            >
              <s.icon className="size-4 text-orange-400 shrink-0" />
              <span className="text-sm text-zinc-300">{s.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export function ChatPanel() {
  const session = useTagent((s) => s.session)
  const running = useTagent((s) => s.running)
  const stream = useTagent((s) => s.stream)
  const send = useTagent((s) => s.send)
  const interrupt = useTagent((s) => s.interrupt)
  const [text, setText] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const messages = session?.messages ?? []

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, session?.todos.length, running, stream])

  const submit = () => {
    const t = text.trim()
    if (!t || running) return
    setText('')
    void handleCommand(t)
  }

  const handleCommand = async (t: string) => {
    const store = useTagent.getState()
    if (t === '/undo') return void store.undo()
    if (t === '/new') return void store.newSession()
    if (t === '/plan') return void store.setMode('plan')
    if (t === '/build') return void store.setMode('build')
    if (t === '/skills') return store.setRightTab('skills')
    if (t === '/files') return store.setRightTab('files')
    if (t === '/memory') return store.setRightTab('memory')
    if (t === '/terminal') return store.setRightTab('terminal')
    if (t === '/worklog' || t === '/log') return store.setRightTab('worklog')
    if (t === '/caveman') return void store.setCaveman(!store.config?.caveman)
    if (t === '/worklog-on') return void store.setWorklog(true)
    if (t === '/worklog-off') return void store.setWorklog(false)
    return store.send(t)
  }

  return (
    <div className="h-full flex flex-col bg-zinc-950 min-w-0">
      {/* mini header */}
      <div className="h-9 shrink-0 flex items-center gap-2 px-4 border-b border-zinc-800/40 text-xs text-zinc-500">
        <span className="truncate max-w-64">{session?.title ?? 'no session'}</span>
        {session?.mode && (
          <Badge variant="outline" className={cn('text-[10px] h-4.5 px-1.5',
            session.mode === 'plan' ? 'border-sky-700/50 text-sky-400' : 'border-orange-700/40 text-orange-400/90')}>
            {session.mode}
          </Badge>
        )}
        <div className="flex-1" />
        {session?.todos?.length ? (
          <span className="text-[10px] text-zinc-600">
            {session.todos.filter((t) => t.status === 'completed').length}/{session.todos.length} done
          </span>
        ) : null}
      </div>

      {/* messages */}
      <div className="flex-1 overflow-y-auto pretty-scroll" >
        {messages.length === 0 && !running ? (
          <EmptyState />
        ) : (
          <div className="py-2">
            <TodosWidget todos={session?.todos ?? []} />
            <SubagentStrip />
            {messages.map((m) =>
              m.role === 'user' ? <UserMessage key={m.id} m={m} /> :
              m.role === 'assistant' ? <AssistantMessage key={m.id} m={m} /> : null,
            )}
            <StreamMessage />
            <StatusLine />
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* composer */}
      <div className="shrink-0 border-t border-zinc-800/60 bg-zinc-950/90 p-3">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 focus-within:border-orange-500/50 transition-colors">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            rows={2}
            placeholder="Describe a task… (Enter to send, Shift+Enter for newline)"
            className="w-full resize-none bg-transparent px-3.5 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none font-mono"
          />
          <div className="flex items-center justify-between px-2 pb-2">
            <span className="text-[10px] text-zinc-600 font-mono pl-1.5">
              /undo · /new · /plan · /build · /worklog · /caveman
            </span>
            {running ? (
              <Button size="sm" variant="destructive" className="h-7 gap-1 text-xs" onClick={interrupt}>
                <CircleStop className="size-3.5" /> stop
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-7 gap-1 text-xs bg-orange-500 hover:bg-orange-400 text-zinc-950"
                disabled={!text.trim()}
                onClick={submit}
              >
                <ArrowUp className="size-3.5" /> send
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
