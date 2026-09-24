'use client'

import { useEffect, useMemo, useState } from 'react'
import type { SourceFileMeta } from '@/data/source-snapshot'
import { tokenizeLines } from '@/lib/highlight'

/** semantic class key → Tailwind (site palette: zinc base, orange accent) */
const TOK_CLS: Record<string, string> = {
  com: 'text-zinc-500 italic',
  str: 'text-emerald-300',
  num: 'text-amber-200',
  kw: 'text-orange-300',
  typ: 'text-teal-300',
  fn: 'text-yellow-200',
  key: 'text-orange-300',
  lit: 'text-amber-200',
  var: 'text-amber-200',
  tag: 'text-orange-300',
  attr: 'text-amber-200',
  sel: 'text-orange-300',
  at: 'text-orange-300',
  hd: 'text-zinc-100 font-semibold',
  fence: 'text-orange-300',
  link: 'text-emerald-300',
  bold: 'text-zinc-100 font-semibold',
}

/** keep the DOM light on huge files; expand on demand */
const LINE_CAP = 1500

function fmtKB(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function CodeView({ meta, content, onOpenTree }: { meta: SourceFileMeta; content: string; onOpenTree: () => void }) {
  const [showAll, setShowAll] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setShowAll(false)
    setCopied(false)
  }, [meta.path])

  const lines = useMemo(() => tokenizeLines(content, meta.language), [content, meta.language])
  const visible = showAll ? lines : lines.slice(0, LINE_CAP)
  const hidden = lines.length - visible.length

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard unavailable (http, permissions) — the Raw link is the fallback */
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* header: path + actions */}
      <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-b border-zinc-800 px-3 py-1.5">
        <button
          type="button"
          onClick={onOpenTree}
          className="mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900 text-zinc-300 transition-colors hover:border-zinc-600 hover:text-zinc-100 lg:hidden"
          aria-label="Open file tree"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 6h16" />
            <path d="M4 12h16" />
            <path d="M4 18h16" />
          </svg>
        </button>
        <span className="mono min-w-0 flex-1 truncate text-[12.5px] text-zinc-300" title={meta.path}>
          {meta.path}
        </span>
        <span className="shrink-0 rounded-full border border-zinc-800 bg-zinc-900/70 px-2 py-0.5 text-[10px] font-medium text-zinc-400">
          {meta.language}
        </span>
        <span className="shrink-0 text-[11px] text-zinc-500">
          {meta.lines.toLocaleString()} lines · {fmtKB(meta.bytes)}
        </span>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
        >
          {copied ? '✓ copied' : 'copy'}
        </button>
        <a
          href={meta.rawUrl}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:border-orange-500/60 hover:text-orange-300"
        >
          raw ↗
        </a>
        <a
          href={meta.jsonUrl}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:border-orange-500/60 hover:text-orange-300"
        >
          json ↗
        </a>
      </div>

      {/* body: line-numbered code */}
      <div className="pretty-scroll min-h-0 flex-1 overflow-auto bg-zinc-950/60">
        <pre className="mono min-w-max py-2 text-[12.5px] leading-[1.55]">
          {visible.map((toks, i) => (
            <div key={i} id={`L${i + 1}`} className="flex target:bg-orange-500/10">
              <a
                href={`#L${i + 1}`}
                onClick={(e) => {
                  e.preventDefault()
                  window.history.replaceState(null, '', `#L${i + 1}`)
                  document.getElementById(`L${i + 1}`)?.scrollIntoView({ block: 'center' })
                }}
                className="w-14 shrink-0 select-none pr-3 text-right text-zinc-600 transition-colors hover:text-orange-300"
                aria-label={`Line ${i + 1}`}
              >
                {i + 1}
              </a>
              <code className="whitespace-pre pr-8 text-zinc-300">
                {toks.length === 0
                  ? '\u00A0'
                  : toks.map((t, j) =>
                      t.c ? (
                        <span key={j} className={TOK_CLS[t.c]}>
                          {t.text}
                        </span>
                      ) : (
                        <span key={j}>{t.text}</span>
                      ),
                    )}
              </code>
            </div>
          ))}
        </pre>
        {hidden > 0 && (
          <div className="sticky bottom-0 flex justify-center border-t border-zinc-800 bg-zinc-950/90 py-2.5 backdrop-blur">
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-orange-500/60 hover:text-orange-300"
            >
              Show all {lines.length.toLocaleString()} lines ({hidden.toLocaleString()} hidden)
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
