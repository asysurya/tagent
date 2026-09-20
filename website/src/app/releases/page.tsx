import type { Metadata } from "next"
import { RELEASES, LATEST } from "@/data/releases"

export const metadata: Metadata = {
  title: "Releases — Tagent",
  description: "Every Tagent release with its changelog.",
}

export default function ReleasesPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-12">
      <h1 className="text-4xl font-bold tracking-tight">Releases</h1>
      <p className="mt-3 text-zinc-400">
        Latest: <span className="rounded-md border border-orange-500/40 bg-orange-500/10 px-2 py-0.5 font-mono text-sm text-orange-300">v{LATEST}</span>
        {" "}· every version stays usable — the CLI only ever warns about updates, never blocks.
      </p>

      <div className="mt-12 space-y-10">
        {RELEASES.map((r) => (
          <article
            key={r.version}
            className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6"
          >
            <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="font-mono text-2xl font-bold text-zinc-100">v{r.version}</h2>
              {r.version === LATEST && (
                <span className="rounded-full border border-orange-500/40 bg-orange-500/10 px-2 py-0.5 text-[11px] font-semibold text-orange-300">
                  latest
                </span>
              )}
              {r.unreleased && (
                <span className="rounded-full border border-zinc-700 bg-zinc-800/60 px-2 py-0.5 text-[11px] font-semibold text-zinc-400">
                  upcoming
                </span>
              )}
              {r.stable && !r.unreleased && (
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-400">
                  stable
                </span>
              )}
              <span className="text-sm text-zinc-500">{r.date}</span>
              {!r.unreleased && (
                <a
                  className="ml-auto text-sm text-zinc-500 hover:text-zinc-300"
                  href={`https://github.com/asysurya/tagent/releases/tag/v${r.version}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  tag ↗
                </a>
              )}
            </header>
            <h3 className="mt-2 text-lg font-semibold text-zinc-200">{r.title}</h3>
            <p className="mt-2 text-zinc-400">{r.summary}</p>

            {r.sections.map((s) => (
              <section key={s.name} className="mt-5">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{s.name}</h4>
                <ul className="mt-2 space-y-1.5 text-sm text-zinc-300">
                  {s.items.map((item) => (
                    <li key={item} className="flex gap-2">
                      <span className="mt-0.5 text-orange-500" aria-hidden>▸</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </article>
        ))}
      </div>
    </div>
  )
}
