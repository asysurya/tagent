import type { Metadata } from 'next'
import { SOURCE_SNAPSHOT } from '@/data/source-snapshot'
import { SourceBrowser } from '@/components/source/source-browser'

export const metadata: Metadata = {
  title: 'Source — Tagent',
  description:
    'Browse the full Tagent source code — file tree, syntax highlighting, search. Agents fetch it via /source/ls (queryable directory listings), raw + JSON file endpoints.',
}

function fmtBytes(b: number) {
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

export default function SourcePage() {
  const c = SOURCE_SNAPSHOT.counts
  return (
    <div className="mx-auto max-w-[88rem] px-4 py-10">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-100">Source</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
            The whole Tagent codebase — browse it below, or fetch it: every file is served
            raw (<code className="rounded bg-zinc-800 px-1 text-xs text-orange-300">/source/raw/&lt;path&gt;</code>),
            JSON-wrapped, and every directory lists its contents
            (<code className="rounded bg-zinc-800 px-1 text-xs text-orange-300">/source/dir/&lt;path&gt;.json</code>).
            Same content as the{' '}
            <a
              className="text-orange-400 hover:text-orange-300"
              href="https://github.com/asysurya/tagent"
              target="_blank"
              rel="noreferrer"
            >
              GitHub repo
            </a>.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-[11px] text-zinc-400">
          <span className="rounded-full border border-orange-500/25 bg-orange-500/10 px-2 py-0.5 font-medium text-orange-300">
            v{SOURCE_SNAPSHOT.version}
          </span>
          <span className="rounded-full border border-zinc-800 bg-zinc-900/70 px-2 py-0.5">
            {c.files.toLocaleString()} files
          </span>
          <span className="rounded-full border border-zinc-800 bg-zinc-900/70 px-2 py-0.5">
            {c.lines.toLocaleString()} lines
          </span>
          <span className="rounded-full border border-zinc-800 bg-zinc-900/70 px-2 py-0.5">
            {fmtBytes(c.bytes)}
          </span>
          <span className="rounded-full border border-zinc-800 bg-zinc-900/70 px-2 py-0.5">
            {c.symbols.toLocaleString()} symbols
          </span>
        </div>
      </header>

      <SourceBrowser snapshot={SOURCE_SNAPSHOT} />
    </div>
  )
}
