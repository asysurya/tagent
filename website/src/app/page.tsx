import Link from "next/link"
import { Code } from "@/components/code"
import { RELEASES, LATEST } from "@/data/releases"
import {
  IconLoop, IconBot, IconShield, IconBrain, IconPlug, IconPuzzle, IconGlobe, IconPhone,
  IconNetwork, IconTerminal, IconZap, IconDownload, IconPackage, IconArrowRight,
  IconMonitor, IconKeyboard, IconRefresh, IconCheck,
} from "@/components/icons"

const FEATURES = [
  {
    icon: IconZap,
    title: "Smart cache",
    body: "The token economist — unchanged-file re-reads return a stub, read_files batches 12 paths in one turn, @path mentions attach files inline, and old tool outputs auto-compact. tagent cache shows the savings.",
    tag: "new",
  },
  {
    icon: IconNetwork,
    title: "MCP servers",
    body: "Plug the Model Context Protocol straight in — Context7, filesystem, memory, sequential-thinking or any stdio server. One command in the TUI, tools become native.",
    tag: "new",
  },
  {
    icon: IconLoop,
    title: "Agentic loop",
    body: "Prompt → model → tool actions → results → repeat. Native function-calling, turn budgets, interrupt & steer any time.",
  },
  {
    icon: IconBot,
    title: "Subagents",
    body: "The task tool spawns isolated explore/general agents with their own budget — research while you keep building.",
  },
  {
    icon: IconShield,
    title: "Permissions",
    body: "Every write asks first — arrow-key prompt in the TUI, dialog in the GUI. Per-tool ask/allow/deny, remembered once, per session, or always.",
  },
  {
    icon: IconBrain,
    title: "Memory & skills",
    body: "AGENTS.md + durable facts injected into every prompt; SKILL.md playbooks with progressive disclosure.",
  },
  {
    icon: IconPlug,
    title: "Multi-provider BYOK",
    body: "Z.ai, OpenAI, Anthropic, Google, OpenRouter, Groq, Ollama — or any OpenAI-compatible endpoint. Your keys stay local.",
  },
  {
    icon: IconPuzzle,
    title: "Plugins",
    body: "Hook into the loop, add custom agent tools and slash commands — hot-reloading .mjs files in .tagent/plugins/.",
    tag: "new",
  },
  {
    icon: IconGlobe,
    title: "Web & browser tools",
    body: "web_fetch and ddg_search work with zero API keys; an optional Playwright browser tool gives the agent eyes.",
  },
  {
    icon: IconPhone,
    title: "Runs on a phone",
    body: "Ubuntu via UserLAnd (no root) — the GUI has a dedicated mobile layout with bottom tabs. localhost:4020 in Chrome.",
  },
]

function FeatureCard({ icon: Icon, title, body, tag }: (typeof FEATURES)[number]) {
  return (
    <div className="group rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 transition-colors hover:border-orange-500/30 hover:bg-zinc-900/70">
      <div className="flex items-start justify-between">
        <div className="flex size-9 items-center justify-center rounded-lg border border-orange-500/25 bg-orange-500/10 text-orange-400">
          <Icon className="size-4.5" width={18} height={18} />
        </div>
        {tag && (
          <span className="rounded-full border border-orange-500/30 bg-orange-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-300">
            {tag}
          </span>
        )}
      </div>
      <h3 className="mt-3.5 font-semibold text-zinc-100">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-zinc-400">{body}</p>
    </div>
  )
}

export default function Home() {
  const [newest] = RELEASES
  return (
    <>
      {/* hero */}
      <section className="relative overflow-hidden">
        <div className="hero-grid absolute inset-0" aria-hidden />
        <div className="glow absolute -top-32 left-1/2 h-96 w-[52rem] -translate-x-1/2" aria-hidden />
        <div className="relative mx-auto max-w-6xl px-4 pb-20 pt-20 text-center sm:pt-28">
          <div className="mx-auto mb-6 w-fit">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.svg" alt="Tagent" className="h-20 w-20 rounded-2xl shadow-2xl shadow-orange-500/20" width={80} height={80} />
          </div>
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1 text-xs text-zinc-400">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-orange-500" />
            </span>
            v{LATEST} is out — {newest.title.toLowerCase()}
          </div>
          <h1 className="mx-auto max-w-3xl text-4xl font-bold tracking-tight text-zinc-100 sm:text-6xl">
            The coding agent that lives in your{" "}
            <span className="text-orange-400">terminal</span>, driven from your{" "}
            <span className="text-orange-400">browser</span>.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-zinc-400">
            Tagent runs the engine on your machine — loop, subagents, MCP servers,
            plugins, skills, memory, permissions. One self-contained binary (web GUI
            included) for Windows, macOS and Linux. The TUI is the interface
            (terminal or phone), the web GUI is the companion. Open source, BYOK.
          </p>

          <div className="mx-auto mt-8 max-w-xl text-left">
            <Code>{`# 1 — download one file for your platform (see Download)
# 2 — run it. that's the whole install
./tagent start ~/my-project        # full TUI
./tagent start --web-gui           # TUI + browser GUI`}</Code>
          </div>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/download"
              className="inline-flex items-center gap-2 rounded-lg bg-orange-500 px-5 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-orange-400"
            >
              <IconDownload className="size-4" width={16} height={16} />
              Download v{LATEST}
            </Link>
            <Link
              href="/docs"
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-5 py-2.5 text-sm font-semibold text-zinc-200 transition hover:border-zinc-500"
            >
              Get started
              <IconArrowRight className="size-4" width={16} height={16} />
            </Link>
            <Link
              href="/releases"
              className="inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold text-zinc-400 transition hover:text-zinc-200"
            >
              <IconRefresh className="size-4" width={16} height={16} />
              Changelog
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
            <p className="mt-1 leading-relaxed">
              Install Ubuntu with <span className="text-zinc-200">UserLAnd</span> from the
              Play Store (no root), clone Tagent, and open{" "}
              <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-orange-300">localhost:4020</code>{" "}
              in Chrome. Bottom tabs: Chat, Files, Terminal, Memory, Skills.
            </p>
            <Link href="/docs#userland" className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-orange-400 hover:text-orange-300">
              Phone setup guide
              <IconArrowRight className="size-3.5" width={14} height={14} />
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
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <FeatureCard key={f.title} {...f} />
          ))}
        </div>
      </section>

      {/* two interfaces */}
      <section className="border-y border-zinc-800/60 bg-zinc-900/30">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-20 md:grid-cols-2">
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-6">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-lg border border-orange-500/25 bg-orange-500/10 text-orange-400">
                <IconTerminal className="size-5" width={20} height={20} />
              </div>
              <div>
                <h3 className="font-semibold text-zinc-100">TUI — the primary interface</h3>
                <p className="text-xs text-zinc-500">interactive, app-like, arrow keys</p>
              </div>
            </div>
            <ul className="mt-4 space-y-2.5 text-sm text-zinc-400">
              {[
                "Arrow-key menus everywhere — model picker, sessions, permissions, y/N confirms",
                "Type-to-filter across 40+ providers and hundreds of models",
                "Slash commands: /mcp, /plugins, /update, /model, /sessions, /auth…",
                "Streams tokens live, queues your next message mid-run",
              ].map((t) => (
                <li key={t} className="flex gap-2.5">
                  <IconCheck className="mt-0.5 size-4 shrink-0 text-orange-400" width={16} height={16} />
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-6">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-lg border border-orange-500/25 bg-orange-500/10 text-orange-400">
                <IconMonitor className="size-5" width={20} height={20} />
              </div>
              <div>
                <h3 className="font-semibold text-zinc-100">Web GUI — the cockpit</h3>
                <p className="text-xs text-zinc-500">same engine, same sessions, browser</p>
              </div>
            </div>
            <ul className="mt-4 space-y-2.5 text-sm text-zinc-400">
              {[
                "Chat with tool cards, streaming, live todos and subagent timeline",
                "File tree, editor, terminal — workspace in a tab",
                "Settings: providers, MCP servers, plugins, permissions",
                "Mobile layout with bottom tabs; live relay to share a session",
              ].map((t) => (
                <li key={t} className="flex gap-2.5">
                  <IconCheck className="mt-0.5 size-4 shrink-0 text-orange-400" width={16} height={16} />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* architecture */}
      <section className="mx-auto max-w-6xl px-4 py-20">
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">One process. No cloud required.</h2>
            <p className="mt-4 leading-relaxed text-zinc-400">
              The daemon is a single Bun process: agent engine, websocket API, and the
              pre-built web GUI served as static files. Nothing leaves your machine —
              API keys live in{" "}
              <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-orange-300">~/.tagent/config.json</code>,
              sessions in your workspace. Remote relay mode is on the roadmap, never required.
            </p>
            <ul className="mt-5 space-y-2.5 text-sm text-zinc-300">
              {[
                [<IconZap key="z" className="size-4 text-orange-400" width={16} height={16} />, <b key="b">Bun runtime</b>, " — no native compilation, no node-gyp"],
                [<IconPackage key="p" className="size-4 text-orange-400" width={16} height={16} />, <b key="b2">GUI ships pre-built</b>, " — git clone & run, no Next.js toolchain"],
                [<IconShield key="s" className="size-4 text-orange-400" width={16} height={16} />, <b key="b3">localhost-bound</b>, " by default; LAN mode behind a flag"],
                [<IconRefresh key="r" className="size-4 text-orange-400" width={16} height={16} />, <b key="b4">Self-updating</b>, " — checks on startup, y/N to update in place"],
              ].map(([icon, bold, rest], i) => (
                <li key={i} className="flex items-center gap-2.5">
                  {icon}
                  <span>{bold}{rest}</span>
                </li>
              ))}
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
│  mcp servers · plugins · GUI            │
└────────────────────────────────────────┘
      │                    │
  your keys            your files
  (BYOK, local)     (workspace-jailed)`}</code></pre>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative overflow-hidden border-t border-zinc-800/60">
        <div className="glow absolute -bottom-40 left-1/2 h-96 w-[52rem] -translate-x-1/2" aria-hidden />
        <div className="relative mx-auto max-w-6xl px-4 py-24 text-center">
          <h2 className="text-3xl font-bold tracking-tight">Take the agent for a spin</h2>
          <p className="mx-auto mt-3 max-w-xl text-zinc-400">
            The repo includes a demo workspace with planted bugs — a five-minute way to
            watch the loop read, patch, and verify real code.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link href="/download" className="inline-flex items-center gap-2 rounded-lg bg-orange-500 px-5 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-orange-400">
              <IconDownload className="size-4" width={16} height={16} />
              Download v{LATEST}
            </Link>
            <a
              href="https://github.com/asysurya/tagent"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-5 py-2.5 text-sm font-semibold text-zinc-200 hover:border-zinc-500"
            >
              Star on GitHub
            </a>
          </div>
        </div>
      </section>
    </>
  )
}
