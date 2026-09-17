import Link from "next/link"
import { Code } from "@/components/code"
import { RELEASES, LATEST } from "@/data/releases"

const FEATURES = [
  { icon: "🔁", title: "Agentic loop", body: "Prompt → model → tool actions → results → repeat. Max-turns, interrupt & steer, auto-compaction on the roadmap." },
  { icon: "🤖", title: "Subagents", body: "The task tool spawns isolated explore/general agents with their own budget — research while you keep building." },
  { icon: "🔐", title: "Permissions", body: "Every write asks first. Per-tool ask/allow/deny, remembered once, per session, or always. One-click /undo via checkpoints." },
  { icon: "🧠", title: "Memory & skills", body: "AGENTS.md + durable facts injected into every prompt; SKILL.md playbooks with progressive disclosure." },
  { icon: "🔌", title: "Multi-provider BYOK", body: "Z.ai, OpenAI, Anthropic, Google, OpenRouter, Groq, Ollama — or any OpenAI-compatible endpoint. Your keys stay local." },
  { icon: "🧩", title: "Plugins", body: "Hook into session start, tool calls, results and agent done — custom tools and slash commands included." },
  { icon: "🌐", title: "Web & browser tools", body: "web_fetch and ddg_search work with zero API keys; an optional Playwright browser tool gives the agent eyes." },
  { icon: "📱", title: "Runs on a phone", body: "Ubuntu via UserLAnd (no root) — the GUI has a dedicated mobile layout with bottom tabs. localhost:4020 in Chrome." },
]

export default function Home() {
  const [newest] = RELEASES
  return (
    <>
      {/* hero */}
      <section className="relative overflow-hidden">
        <div className="hero-grid absolute inset-0" aria-hidden />
        <div className="glow absolute -top-32 left-1/2 h-96 w-[52rem] -translate-x-1/2" aria-hidden />
        <div className="relative mx-auto max-w-6xl px-4 pb-20 pt-24 text-center sm:pt-32">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1 text-xs text-zinc-400">
            <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
            v{LATEST} is out — {newest.title.toLowerCase()}
          </div>
          <h1 className="mx-auto max-w-3xl text-4xl font-bold tracking-tight text-zinc-100 sm:text-6xl">
            The coding agent that lives in your{" "}
            <span className="text-orange-400">terminal</span>, driven from your{" "}
            <span className="text-orange-400">browser</span>.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-zinc-400">
            Tagent runs the engine on your machine — loop, subagents, skills, memory,
            permissions — and you steer it from a real web GUI. Open source, BYOK,
            guest-first. Works on laptops and Android phones.
          </p>

          <div className="mx-auto mt-8 max-w-xl text-left">
            <Code>{`git clone https://github.com/asysurya/tagent.git
cd tagent && bash scripts/setup-ubuntu.sh
bun packages/cli/src/index.ts ~/my-project
# → http://localhost:4020`}</Code>
          </div>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/docs"
              className="rounded-lg bg-orange-500 px-5 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-orange-400"
            >
              Get started
            </Link>
            <Link
              href="/download"
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-5 py-2.5 text-sm font-semibold text-zinc-200 transition hover:border-zinc-500"
            >
              Downloads
            </Link>
            <Link
              href="/releases"
              className="rounded-lg px-5 py-2.5 text-sm font-semibold text-zinc-400 transition hover:text-zinc-200"
            >
              Changelog →
            </Link>
          </div>
        </div>
      </section>

      {/* screenshots */}
      <section className="mx-auto max-w-6xl px-4">
        <div className="relative rounded-xl border border-zinc-800 bg-zinc-900/40 p-2 shadow-2xl shadow-black/50">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/img-desktop.png"
            alt="Tagent web GUI on desktop — chat, file tree, editor and terminal"
            className="w-full rounded-lg border border-zinc-800/60"
            width={1600}
            height={900}
          />
        </div>
        <div className="mt-6 flex flex-col items-center gap-6 sm:flex-row sm:justify-center">
          <figure className="w-56">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/img-mobile-files.png"
              alt="Tagent mobile layout — files tab"
              className="w-full rounded-xl border border-zinc-800"
              width={390}
              height={844}
            />
            <figcaption className="mt-2 text-center text-xs text-zinc-500">
              Files &amp; editor on a phone
            </figcaption>
          </figure>
          <figure className="w-56">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/img-mobile-chat.png"
              alt="Tagent mobile layout — chat tab"
              className="w-full rounded-xl border border-zinc-800"
              width={390}
              height={844}
            />
            <figcaption className="mt-2 text-center text-xs text-zinc-500">
              Chat with tool cards on a phone
            </figcaption>
          </figure>
          <div className="max-w-xs text-sm text-zinc-400">
            <p className="font-semibold text-zinc-200">Same engine, phone-sized.</p>
            <p className="mt-1">
              Install Ubuntu with <span className="text-zinc-200">UserLAnd</span> from the
              Play Store (no root), clone Tagent, and open{" "}
              <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-orange-300">localhost:4020</code>{" "}
              in Chrome. Bottom tabs: Chat, Files, Terminal, Memory, Skills.
            </p>
            <Link href="/docs#userland" className="mt-3 inline-block text-sm font-medium text-orange-400 hover:text-orange-300">
              Phone setup guide →
            </Link>
          </div>
        </div>
      </section>

      {/* features */}
      <section className="mx-auto max-w-6xl px-4 py-24">
        <h2 className="text-center text-3xl font-bold tracking-tight">Everything an agent needs</h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-zinc-400">
          A complete loop with the safety rails on — inspired by the best of opencode,
          rebuilt as an open platform you fully control.
        </p>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 transition-colors hover:border-zinc-700"
            >
              <div className="text-2xl">{f.icon}</div>
              <h3 className="mt-3 font-semibold text-zinc-100">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* architecture */}
      <section className="border-y border-zinc-800/60 bg-zinc-900/30">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-20 lg:grid-cols-2">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">One process. No cloud required.</h2>
            <p className="mt-4 text-zinc-400">
              The daemon is a single Bun process: agent engine, websocket API, and the
              pre-built web GUI served as static files. Nothing leaves your machine —
              API keys live in <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-orange-300">~/.tagent/config.json</code>,
              sessions in your workspace. Remote relay mode is on the roadmap, never required.
            </p>
            <ul className="mt-5 space-y-2 text-sm text-zinc-300">
              <li>⚡ <b>Bun runtime</b> — no native compilation, no node-gyp</li>
              <li>📦 <b>GUI ships pre-built</b> — git clone &amp; run, no Next.js toolchain</li>
              <li>🔒 <b>localhost-bound</b> by default; LAN mode behind a flag</li>
              <li>↕️ <b>Version-aware</b> — the CLI checks for updates and warns when stale, but never blocks you</li>
            </ul>
          </div>
          <div className="overflow-x-auto">
            <pre className="mono rounded-xl border border-zinc-800 bg-zinc-950/70 p-5 text-xs leading-relaxed text-zinc-400"><code>{`┌─ Browser (desktop or phone) ──────────┐
│  chat · tool cards · permissions      │
│  file tree · editor · terminal         │
└──────────────┬─────────────────────────┘
               │  websocket @ /socket
┌─ Tagent daemon (Bun, localhost:4020) ▼┐
│  agent loop · tools · subagents        │
│  sessions · checkpoints · permissions   │
│  plugins · storage adapters · GUI       │
└─────────────────────────────────────────┘
      │                    │
  your keys            your files
  (BYOK, local)     (workspace-jailed)`}</code></pre>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-4 py-24 text-center">
        <h2 className="text-3xl font-bold tracking-tight">Take the agent for a spin</h2>
        <p className="mx-auto mt-3 max-w-xl text-zinc-400">
          The repo includes a demo workspace with planted bugs — a five-minute way to
          watch the loop read, patch, and verify real code.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link href="/docs" className="rounded-lg bg-orange-500 px-5 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-orange-400">
            Read the docs
          </Link>
          <a
            href="https://github.com/asysurya/tagent"
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-5 py-2.5 text-sm font-semibold text-zinc-200 hover:border-zinc-500"
          >
            Star on GitHub
          </a>
        </div>
      </section>
    </>
  )
}
