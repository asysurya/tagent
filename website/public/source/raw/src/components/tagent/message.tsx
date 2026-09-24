'use client'

import { memo, useState } from 'react'
import {
  BookOpen, Bot, Brain, CheckCircle2, ChevronRight, FileSearch, Globe,
  ListChecks, Loader2, Terminal, Wrench, XCircle,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { cn } from '@/lib/utils'
import type { ChatMessage, ToolCallRecord } from '@/lib/tagent/types'

const TOOL_ICONS: Record<string, typeof FileSearch> = {
  read_file: FileSearch,
  list_files: FileSearch,
  grep: FileSearch,
  write_file: Wrench,
  edit_file: Wrench,
  bash: Terminal,
  web_fetch: Globe,
  ddg_search: Globe,
  task: Bot,
  todowrite: ListChecks,
  memory: Brain,
  load_skill: BookOpen,
  browser: Globe,
}

function toolSummary(c: ToolCallRecord): string {
  const i = c.input as Record<string, unknown> | undefined
  if (!i) return ''
  const s = String(
    i.path ?? i.pattern ?? i.query ?? i.url ?? i.name ?? i.command ?? i.action ?? i.description ?? '',
  )
  return s.length > 72 ? s.slice(0, 72) + '…' : s
}

function toolSummaryFull(c: ToolCallRecord): string {
  const i = c.input as Record<string, unknown> | undefined
  if (!i) return c.tool
  return String(
    i.path ?? i.pattern ?? i.query ?? i.url ?? i.name ?? i.command ?? i.action ?? i.description ?? '',
  ) || c.tool
}

export const ToolCard = memo(function ToolCard({ call }: { call: ToolCallRecord }) {
  const [open, setOpen] = useState(false)
  const Icon = TOOL_ICONS[call.tool] ?? Wrench
  const status = call.status
  return (
    <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 overflow-hidden my-1.5">
      <button
        type="button"
        aria-expanded={open}
        title={toolSummaryFull(call)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-zinc-900/70 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon className={cn('size-3.5 shrink-0',
          status === 'running' ? 'text-orange-400 animate-pulse'
          : status === 'error' ? 'text-red-400'
          : status === 'denied' ? 'text-zinc-500'
          : 'text-zinc-400')} />
        <span className="text-[11px] font-mono text-zinc-300">{call.tool}</span>
        <span className="text-[11px] text-zinc-500 truncate flex-1" title={toolSummaryFull(call)}>{toolSummary(call)}</span>
        {status === 'running' ? (
          <Loader2 className="size-3.5 text-orange-400 animate-spin shrink-0" />
        ) : status === 'error' ? (
          <XCircle className="size-3.5 text-red-400 shrink-0" />
        ) : status === 'denied' ? (
          <span className="text-[10px] text-zinc-500 font-medium shrink-0">denied</span>
        ) : (
          <CheckCircle2 className="size-3.5 text-emerald-500/80 shrink-0" />
        )}
        <ChevronRight className={cn('size-3 text-zinc-600 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="border-t border-zinc-800/80 px-3 py-2 space-y-2">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-zinc-600 mb-1">input</p>
            <pre className="text-[11px] font-mono text-zinc-400 whitespace-pre-wrap break-all max-h-40 overflow-auto pretty-scroll">
              {JSON.stringify(call.input, null, 2)}
            </pre>
          </div>
          {call.output && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-zinc-600 mb-1">output</p>
              <pre className={cn(
                'text-[11px] font-mono whitespace-pre-wrap break-words max-h-56 overflow-auto pretty-scroll',
                status === 'error' ? 'text-red-300/90' : 'text-zinc-400',
              )}>
                {call.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
})

export function UserMessage({ m }: { m: ChatMessage }) {
  return (
    <div className="px-4 py-3">
      <div className="flex gap-3">
        <span className="text-[10px] font-mono text-zinc-500 pt-1 w-12 sm:w-16 shrink-0 text-right select-none">you</span>
        <div className="min-w-0 flex-1 rounded-lg bg-zinc-900/60 border border-zinc-800/60 px-3 py-2 text-sm text-zinc-200 whitespace-pre-wrap break-words leading-relaxed">
          {m.content}
        </div>
      </div>
    </div>
  )
}

export function AssistantMessage({ m }: { m: ChatMessage }) {
  const hasTools = (m.toolCalls?.length ?? 0) > 0
  return (
    <div className="px-4 py-3">
      <div className="flex gap-3">
        <span className="text-[10px] font-mono text-orange-400/80 pt-1 w-12 sm:w-16 shrink-0 text-right select-none">tagent</span>
        <div className="min-w-0 flex-1 space-y-2">
          {m.content && (
            <div className="prose-chat text-sm text-zinc-300 leading-relaxed">
              <ReactMarkdown>{m.content}</ReactMarkdown>
            </div>
          )}
          {hasTools && (
            <div className="space-y-0.5">
              {m.toolCalls!.map((c) => <ToolCard key={c.id} call={c} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
