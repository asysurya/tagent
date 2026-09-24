'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SourceFileMeta, SourceSnapshot } from '@/data/source-snapshot'
import { FileTree } from './file-tree'
import { CodeView } from './code-view'

interface Sym {
  n: string
  f: string
  l: number
  k: string
}

const QUICK_LINKS = [
  'README.md',
  'WORKLOG.md',
  'packages/core/src/loop.ts',
  'packages/core/src/system-prompt.ts',
  'packages/cli/src/tui-app.ts',
  'website/src/app/page.tsx',
]

const SITE = 'https://tagent-website.vercel.app'

function fmtBytes(b: number) {
  return b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`
}

/* ------------------------------------------------------------ copy chip -- */

function CopyChip({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text.startsWith('/') ? `${SITE}${text}` : text)
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        } catch {
          /* clipboard unavailable — the text is selectable anyway */
        }
      }}
      className="shrink-0 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] font-medium text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
    >
      {done ? '✓' : 'copy'}
    </button>
  )
}

/* --------------------------------------------------------- search box -- */

function SearchBox({
  value,
  onChange,
  onEnter,
  inputRef,
}: {
  value: string
  onChange: (v: string) => void
  onEnter: () => void
  inputRef: React.RefObject<HTMLInputElement | null>
}) {
  return (
    <div className="relative shrink-0 p-2">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className="pointer-events-none absolute left-4.5 top-1/2 -translate-y-1/2 text-zinc-500"
      >
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onEnter()
          else if (e.key === 'Escape') onChange('')
        }}
        placeholder="Search files & symbols…"
        aria-label="Search files and symbols"
        className="w-full rounded-lg border border-zinc-800 bg-zinc-950/70 py-2 pl-8 pr-12 text-[13px] text-zinc-200 placeholder:text-zinc-600 focus:border-orange-500/50 focus:outline-none"
      />
      <kbd className="pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 rounded border border-zinc-700 bg-zinc-900 px-1.5 text-[10px] text-zinc-500 sm:block">/</kbd>
    </div>
  )
}

/* ------------------------------------------------------------- states -- */

function Loading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden p-4" aria-busy="true" aria-label="Loading file">
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className="h-3.5 animate-pulse rounded bg-zinc-800/70" style={{ width: `${45 + ((i * 37) % 50)}%` }} />
      ))}
    </div>
  )
}

function NotFound({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="mono text-sm text-orange-300">404 — file not found in this snapshot</p>
      <p className="max-w-md text-sm leading-relaxed text-zinc-400">
        The file is not part of the snapshot: it may be binary, a lockfile, larger than 512 KB, or it was renamed
        after this snapshot was generated. See <code className="rounded bg-zinc-800 px-1 text-xs text-orange-300">/source/index.json</code> for what is included.
      </p>
      <button
        type="button"
        onClick={onBack}
        className="mt-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-orange-500/60 hover:text-orange-300"
      >
        ← back to the source browser
      </button>
    </div>
  )
}

function LoadError({ onRetry, rawUrl }: { onRetry: () => void; rawUrl: string | null }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-sm font-medium text-red-400">Could not load the file.</p>
      <p className="max-w-md text-sm leading-relaxed text-zinc-400">
        The fetch failed (network or server error). Retry, or open the raw file directly.
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-orange-500/60 hover:text-orange-300"
        >
          ↻ retry
        </button>
        {rawUrl && (
          <a
            href={rawUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-orange-500/60 hover:text-orange-300"
          >
            open raw ↗
          </a>
        )}
      </div>
    </div>
  )
}

/* ----------------------------------------------------------- welcome -- */

function Welcome({ snapshot, onSelect }: { snapshot: SourceSnapshot; onSelect: (p: string) => void }) {
  const c = snapshot.counts
  const endpoints: [string, string][] = [
    ['GET /source/index.json', 'every file — path · size · lines · language · rawUrl · jsonUrl'],
    ['GET /source/raw/<path>', 'the raw file contents (text/plain)'],
    ['GET /source/json/<path>.json', 'JSON-wrapped: { path, content, language, lines, bytes }'],
    ['GET /source/symbols.json', 'symbol index — name · file · line · kind'],
  ]
  return (
    <div className="pretty-scroll min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold text-zinc-100">The Tagent codebase</h2>
          <span className="rounded-full border border-orange-500/25 bg-orange-500/10 px-2 py-0.5 text-[10px] font-medium text-orange-300">
            v{snapshot.version} · {snapshot.generatedAt}
          </span>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            [c.files.toLocaleString(), 'files'],
            [c.lines.toLocaleString(), 'lines'],
            [fmtBytes(c.bytes), 'source'],
            [c.symbols.toLocaleString(), 'symbols'],
          ].map(([v, l]) => (
            <div key={l} className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
              <div className="text-lg font-semibold text-zinc-100">{v}</div>
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">{l}</div>
            </div>
          ))}
        </div>

        <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-zinc-400">Jump in</h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {QUICK_LINKS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onSelect(p)}
              className="mono rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-[11.5px] text-zinc-300 transition-colors hover:border-orange-500/50 hover:text-orange-200"
            >
              {p}
            </button>
          ))}
        </div>

        <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Fetch the source — an API for agents
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          Every file is served statically — no auth, no rate-limit games. Point any agent (or curl)
          at these endpoints:
        </p>
        <div className="mt-3 space-y-1.5">
          {endpoints.map(([ep, desc]) => (
            <div key={ep} className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
              <code className="mono min-w-0 flex-1 truncate text-[12px] text-orange-300">{ep}</code>
              <span className="hidden shrink-0 text-[11px] text-zinc-500 sm:block">{desc}</span>
              <CopyChip text={ep.replace('GET ', '')} />
            </div>
          ))}
        </div>
        <div className="relative mt-3">
          <CopyChip text={`curl -s ${SITE}/source/raw/packages/core/src/version.ts`} />
          <pre className="mono pretty-scroll overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/70 p-4 pr-16 text-[12px] leading-relaxed text-zinc-300">
            <code>{`curl -s ${SITE}/source/index.json | head -c 400
curl -s ${SITE}/source/raw/packages/core/src/version.ts
curl -s ${SITE}/source/json/README.md.json | jq -r .content | head -20`}</code>
          </pre>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-zinc-500">
          Prefer git? <code className="rounded bg-zinc-800 px-1 text-zinc-400">git clone https://github.com/asysurya/tagent</code> —
          the same paths exist in the repo. Not included: node_modules, lockfiles, binaries, build
          output, secrets — see the <code className="rounded bg-zinc-800 px-1 text-zinc-400">excluded</code> list in index.json.
        </p>
      </div>
    </div>
  )
}

/* -------------------------------------------------------- the browser -- */

export function SourceBrowser({ snapshot }: { snapshot: SourceSnapshot }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'error' | 'notfound'>('idle')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [drawer, setDrawer] = useState(false)
  const [symbols, setSymbols] = useState<Sym[] | null>(null)
  const [symbolsFailed, setSymbolsFailed] = useState(false)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const meta: SourceFileMeta | null = useMemo(
    () => (selected ? snapshot.files.find((f) => f.path === selected) ?? null : null),
    [selected, snapshot.files],
  )

  /* deep link on mount: /source?file=<path> */
  useEffect(() => {
    const file = new URLSearchParams(window.location.search).get('file')
    if (file && snapshot.files.some((f) => f.path === file)) {
      setSelected(file)
      expandAncestors(file)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* load the selected file */
  useEffect(() => {
    if (!selected) {
      setContent(null)
      setState('idle')
      return
    }
    const m = snapshot.files.find((f) => f.path === selected)
    if (!m) {
      setContent(null)
      setState('notfound')
      return
    }
    let alive = true
    setState('loading')
    setContent(null)
    fetch(m.rawUrl)
      .then((res) => {
        if (!alive) return undefined
        if (res.status === 404) throw new Error('notfound')
        if (!res.ok) throw new Error(String(res.status))
        return res.text()
      })
      .then((text) => {
        if (!alive || text === undefined) return
        setContent(text)
        setState('ok')
      })
      .catch(() => {
        if (!alive) return
        setState((s) => (s === 'notfound' ? s : 'error'))
      })
    return () => {
      alive = false
    }
  }, [selected, reloadKey, snapshot.files])

  /* after load: honor #L<n> from the URL / search results */
  useEffect(() => {
    if (state !== 'ok') return
    const h = window.location.hash
    if (/^#L\d+$/.test(h)) {
      requestAnimationFrame(() => document.getElementById(h.slice(1))?.scrollIntoView({ block: 'center' }))
    }
  }, [state, selected])

  /* lazy-load the symbol index on first search */
  useEffect(() => {
    if (!query.trim() || symbols || symbolsFailed) return
    let alive = true
    fetch('/source/symbols.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { symbols: Sym[] }) => alive && setSymbols(d.symbols))
      .catch(() => alive && setSymbolsFailed(true))
    return () => {
      alive = false
    }
  }, [query, symbols, symbolsFailed])

  /* '/' focuses search · Escape clears */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === 'Escape') {
        if (query) setQuery('')
        else if (drawer) setDrawer(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [query, drawer])

  const expandAncestors = (path: string) => {
    const parts = path.split('/')
    setExpanded((e) => {
      const next = new Set(e)
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join('/'))
      return next
    })
  }

  const select = useCallback(
    (path: string, line?: number) => {
      setSelected(path)
      setQuery('')
      setDrawer(false)
      expandAncestors(path)
      const q = `?file=${encodeURIComponent(path)}`
      window.history.replaceState(null, '', line ? `${q}#L${line}` : q)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const toggle = useCallback((path: string) => {
    setExpanded((e) => {
      const next = new Set(e)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const back = () => {
    setSelected(null)
    window.history.replaceState(null, '', '/source')
  }

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const files = snapshot.files.filter((f) => f.path.toLowerCase().includes(q)).slice(0, 80)
    const syms = (symbols ?? []).filter((s) => s.n.toLowerCase().includes(q)).slice(0, 40)
    return { files, syms }
  }, [query, snapshot.files, symbols])

  const openFirst = () => {
    if (!results) return
    if (results.files[0]) select(results.files[0].path)
    else if (results.syms[0]) select(results.syms[0].f, results.syms[0].l)
  }

  /* sidebar content — shared by the desktop aside and the mobile drawer */
  const sidebar = (
    <>
      <SearchBox value={query} onChange={setQuery} onEnter={openFirst} inputRef={searchRef} />
      {results ? (
        <div className="pretty-scroll min-h-0 flex-1 overflow-y-auto p-2">
          <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Files · {results.files.length}
            {results.files.length >= 80 ? '+' : ''}
          </div>
          {results.files.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => select(f.path)}
              title={f.path}
              className="block w-full truncate rounded-md px-2 py-1.5 text-left text-[12.5px] text-zinc-300 transition-colors hover:bg-zinc-800/60 hover:text-zinc-100"
            >
              {f.path}
            </button>
          ))}
          <div className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Symbols · {results.syms.length}
            {results.syms.length >= 40 ? '+' : ''}
          </div>
          {symbolsFailed && <p className="px-2 py-1 text-[11px] text-zinc-600">symbol index unavailable</p>}
          {results.syms.map((s, i) => (
            <button
              key={`${s.f}:${s.l}:${i}`}
              type="button"
              onClick={() => select(s.f, s.l)}
              className="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-zinc-800/60"
            >
              <span className="shrink-0 rounded border border-zinc-700 px-1 text-[9px] uppercase text-zinc-500">{s.k}</span>
              <span className="truncate text-[12.5px] text-zinc-200">{s.n}</span>
              <span className="mono ml-auto shrink-0 truncate text-[10.5px] text-zinc-600">{s.f}:{s.l}</span>
            </button>
          ))}
          {results.files.length === 0 && results.syms.length === 0 && (
            <p className="px-2 py-3 text-[12.5px] text-zinc-500">
              No matches for “{query}”. Symbols index loads on first search — try a file name.
            </p>
          )}
        </div>
      ) : (
        <FileTree root={snapshot.tree} expanded={expanded} selected={selected} onToggle={toggle} onSelect={select} />
      )}
    </>
  )

  return (
    <div className="flex h-[75vh] min-h-[540px] gap-4 lg:h-[78vh]">
      {/* desktop sidebar */}
      <aside className="hidden w-80 shrink-0 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40 lg:flex">
        {sidebar}
      </aside>

      {/* viewer */}
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
        {state === 'ok' && meta && content !== null ? (
          <CodeView meta={meta} content={content} onOpenTree={() => setDrawer(true)} />
        ) : state === 'loading' ? (
          <Loading />
        ) : state === 'notfound' ? (
          <NotFound onBack={back} />
        ) : state === 'error' ? (
          <LoadError onRetry={() => setReloadKey((k) => k + 1)} rawUrl={meta?.rawUrl ?? null} />
        ) : (
          <Welcome snapshot={snapshot} onSelect={(p) => select(p)} />
        )}
      </section>

      {/* mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="File tree">
          <button type="button" aria-hidden tabIndex={-1} onClick={() => setDrawer(false)} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="absolute inset-y-0 left-0 flex w-[85vw] max-w-80 flex-col border-r border-zinc-800 bg-zinc-950">
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-zinc-800 pl-4 pr-2">
              <span className="text-sm font-medium text-zinc-200">Source files</span>
              <button
                type="button"
                onClick={() => setDrawer(false)}
                aria-label="Close file tree"
                className="inline-flex size-8 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>
            {sidebar}
          </div>
        </div>
      )}
    </div>
  )
}
