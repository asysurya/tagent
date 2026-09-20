import type { Metadata } from "next"
import Link from "next/link"
import { Code } from "@/components/code"
import { IconCheck } from "@/components/icons"
import { RELEASES, LATEST } from "@/data/releases"
import { DOWNLOAD_TARGETS, NATIVE_TARGETS, releaseAsset } from "./downloads"
import { DownloadPicker } from "./download-picker"

export const metadata: Metadata = {
  title: "Download — Tagent",
  description:
    "Get Tagent as a single-file binary for Windows, Linux and macOS — download it, run it, that's the whole install. The web GUI is embedded in the file.",
}

const REQUIREMENTS = [
  { icon: "🪟", name: "Windows", detail: "Full binary: Windows 10 or later · 64-bit or ARM64 · Git for Windows for the bash tool. Windows 7/8 or 32-bit? Use the native edition below." },
  { icon: "🍎", name: "macOS", detail: "macOS 11 or later · Apple silicon or Intel" },
  { icon: "🐧", name: "Linux", detail: "x86-64 or ARM64 · glibc (Ubuntu 20.04+, Debian, Fedora…) — or the static native edition for any distro" },
]

const PLATFORM_GUIDES = [
  {
    name: "Windows",
    icon: "🪟",
    body: "Download the .exe and run it — nothing to install. Use Windows Terminal for the best TUI experience. The bash tool needs Git for Windows (doctor checks it for you).",
    code: `# PowerShell — download, verify, run
curl.exe -LO https://github.com/asysurya/tagent/releases/download/v${LATEST}/tagent-v${LATEST}-windows-x64.exe
certutil -hashfile tagent-v${LATEST}-windows-x64.exe SHA256
.\\tagent-v${LATEST}-windows-x64.exe doctor
.\\tagent-v${LATEST}-windows-x64.exe start C:\\Users\\you\\my-project`,
    note: "SmartScreen may warn on first run (the binary is unsigned) — “More info → Run anyway”. Keep the exe anywhere you like, or drop it in a folder that is on PATH.",
  },
  {
    name: "Windows 7 / 8 / 32-bit (native edition)",
    icon: "🪟",
    body: "On Windows 7, 8, 8.1 or any 32-bit machine, take the Go port instead — it is the reason it exists. Download the .exe and run it from cmd or PowerShell; it reads the same ~/.tagent/config.json.",
    code: `# cmd / PowerShell — 32-bit & Windows 7/8 build
curl.exe -LO https://github.com/asysurya/tagent/releases/download/v${LATEST}/tagent-native-windows-386.exe
.\\tagent-native-windows-386.exe doctor
.\\tagent-native-windows-386.exe`,
    note: "~10–15 MB, pure Go, no runtime at all. It is the lightweight core agent — see the honest comparison in the native edition section above for what it does not include.",
  },
  {
    name: "macOS",
    icon: "🍎",
    body: "One file, both the TUI and the browser GUI inside. First launch on Apple silicon needs Rosetta 2 only if you picked the Intel build.",
    code: `# download, make it executable, run
curl -LO https://github.com/asysurya/tagent/releases/download/v${LATEST}/tagent-v${LATEST}-macos-arm64
chmod +x tagent-v${LATEST}-macos-arm64
./tagent-v${LATEST}-macos-arm64 doctor
./tagent-v${LATEST}-macos-arm64 start ~/my-project`,
    note: "Gatekeeper may warn because the binary is unsigned: right-click the file → Open → Open (once). After that it runs normally.",
  },
  {
    name: "Linux",
    icon: "🐧",
    body: "A plain dynamically-linked binary — works on Ubuntu, Debian, Fedora and friends. The ARM64 build covers Raspberry Pi 5 and ARM servers/mini-PCs.",
    code: `# download, make it executable, run
curl -LO https://github.com/asysurya/tagent/releases/download/v${LATEST}/tagent-v${LATEST}-linux-x64
chmod +x tagent-v${LATEST}-linux-x64
./tagent-v${LATEST}-linux-x64 doctor
./tagent-v${LATEST}-linux-x64 start ~/my-project`,
    note: "Optional: put it on PATH — mv tagent-v*-linux-x64 ~/.local/bin/tagent — then `tagent start` works from anywhere.",
  },
]

export default function DownloadPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-12">
      <h1 className="text-4xl font-bold tracking-tight">Download</h1>
      <p className="mt-3 max-w-2xl text-zinc-400">
        Current release <span className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-0.5 font-mono text-sm text-orange-300">v{LATEST}</span>.
        Tagent ships as a <strong className="text-zinc-200">single self-contained file</strong> — like the Node.js
        and Python downloads. No runtime, no package manager, no installer: download, run, done.
        The full agent and the web GUI are inside the file (it self-extracts on first launch), and a{" "}
        <a className="font-semibold text-orange-400 hover:text-orange-300" href="#native-edition">native (Go) edition</a>{" "}
        below covers Windows 7/8 and 32-bit machines.
      </p>

      {/* big auto-detected download */}
      <DownloadPicker />

      {/* every platform */}
      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight">All downloads</h2>
        <p className="mt-2 text-zinc-400">
          Binaries for v{LATEST} — the file names carry the version, so upgrades live side by side.
        </p>
        <div className="mt-5 overflow-x-auto rounded-lg border border-zinc-800 pretty-scroll">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/60 text-left text-xs uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-2.5 font-medium">File</th>
                <th className="px-4 py-2.5 font-medium">Platform</th>
                <th className="px-4 py-2.5 font-medium">Notes</th>
                <th className="px-4 py-2.5 text-right font-medium">Download</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70">
              {DOWNLOAD_TARGETS.map((d) => (
                <tr key={d.file} className="bg-zinc-900/30 hover:bg-zinc-900/60">
                  <td className="px-4 py-3 font-mono text-xs text-zinc-300">{d.file}</td>
                  <td className="px-4 py-3">
                    <span className="font-semibold text-zinc-100">{d.label}</span>
                    <span className="ml-2 text-xs text-zinc-500">{d.sub}</span>
                  </td>
                  <td className="max-w-xs px-4 py-3 text-xs text-zinc-500">{d.note ?? "—"}</td>
                  <td className="px-4 py-3 text-right">
                    <a className="font-medium text-orange-400 hover:text-orange-300" href={releaseAsset(LATEST, d.file)}>
                      download ↓
                    </a>
                  </td>
                </tr>
              ))}
              <tr className="bg-zinc-900/30 hover:bg-zinc-900/60">
                <td className="px-4 py-3 font-mono text-xs text-zinc-300">SHA256SUMS.txt</td>
                <td className="px-4 py-3 text-zinc-400">all of the above</td>
                <td className="px-4 py-3 text-xs text-zinc-500">verify downloads: sha256sum --check SHA256SUMS.txt</td>
                <td className="px-4 py-3 text-right">
                  <a className="font-medium text-orange-400 hover:text-orange-300" href={releaseAsset(LATEST, "SHA256SUMS.txt")}>
                    download ↓
                  </a>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* native edition (Go) */}
      <section className="mt-14 scroll-mt-8" id="native-edition">
        <h2 className="text-2xl font-bold tracking-tight">Native edition (Go)</h2>
        <p className="mt-2 max-w-3xl text-zinc-400">
          The agent core rewritten in pure Go — stdlib only, <code className="rounded bg-zinc-800 px-1 text-xs">CGO_ENABLED=0</code>,
          compiled with Go 1.21 (the last toolchain that still targets Windows 7/8). Truly static single
          files of ~10–15&nbsp;MB that run on machines the full binaries cannot:
          <span className="text-zinc-200"> Windows 7, 8, 8.1 — including 32-bit (x86) machines</span>.
        </p>
        <div className="mt-5 overflow-x-auto rounded-lg border border-zinc-800 pretty-scroll">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/60 text-left text-xs uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-2.5 font-medium">File</th>
                <th className="px-4 py-2.5 font-medium">Platform</th>
                <th className="px-4 py-2.5 font-medium">Notes</th>
                <th className="px-4 py-2.5 text-right font-medium">Download</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70">
              {NATIVE_TARGETS.map((d) => (
                <tr key={d.file} className="bg-zinc-900/30 hover:bg-zinc-900/60">
                  <td className="px-4 py-3 font-mono text-xs text-zinc-300">{d.file}</td>
                  <td className="px-4 py-3">
                    <span className="font-semibold text-zinc-100">{d.label}</span>
                    <span className="ml-2 text-xs text-zinc-500">{d.sub}</span>
                  </td>
                  <td className="max-w-xs px-4 py-3 text-xs text-zinc-500">{d.note ?? "—"}</td>
                  <td className="px-4 py-3 text-right">
                    <a className="font-medium text-orange-400 hover:text-orange-300" href={releaseAsset(LATEST, d.file)}>
                      download ↓
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-sm text-zinc-500">
          Same deal as everything else: no install, download and run. Windows — run the .exe from cmd or
          PowerShell. Linux — <code className="rounded bg-zinc-800 px-1 text-xs">chmod +x</code> then run. It reads
          the same <code className="rounded bg-zinc-800 px-1 text-xs">~/.tagent/config.json</code>.
        </p>
        <div className="mt-6 grid gap-5 lg:grid-cols-2">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6">
            <h3 className="text-lg font-bold text-zinc-100">Native edition — old &amp; limited machines</h3>
            <p className="mt-1 text-xs text-zinc-500">tagent-native-* · ~10–15 MB · pure Go, no runtime at all</p>
            <ul className="mt-4 space-y-2.5 text-sm text-zinc-400">
              {[
                "Windows 7, 8, 8.1, 10, 11 — 32-bit and 64-bit",
                "REPL + one-shot run, conversation sessions",
                "OpenAI-compatible providers: zai, openrouter, groq, openai built in — plus any custom endpoint",
                "Multi-key provider fallback chain (ordered, auto-failover)",
                "5 workspace-jailed tools: read_file, write_file, edit_file, list_files, bash",
                "TAGENT_TLS_SKIP=1 escape hatch for networks with broken TLS interception",
              ].map((t) => (
                <li key={t} className="flex gap-2.5">
                  <IconCheck className="mt-0.5 size-4 shrink-0 text-orange-400" width={16} height={16} />
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6">
            <h3 className="text-lg font-bold text-zinc-100">Full binary — everything else</h3>
            <p className="mt-1 text-xs text-zinc-500">tagent-v*-* · 60–95 MB · Bun-compiled, GUI embedded</p>
            <ul className="mt-4 space-y-2.5 text-sm text-zinc-400">
              {[
                "Windows 10+, macOS 11+, Linux — 64-bit / ARM64 only",
                "The 40-provider catalog + live model discovery",
                "MCP servers, plugins, custom subagents",
                "The browser web GUI, embedded in the file",
                "Relay live-share, smart cache, diagnostics",
              ].map((t) => (
                <li key={t} className="flex gap-2.5">
                  <IconCheck className="mt-0.5 size-4 shrink-0 text-orange-400" width={16} height={16} />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="mt-4 text-xs text-zinc-500">
          Honest trade-off: the native edition has no MCP, plugins, browser GUI, relay, subagents or smart
          cache — it is the lightweight agent for old or limited machines, not a replacement for the full
          binary. Not sure? Take the full binary if your OS can run it.
        </p>
      </section>

      {/* per-platform quickstarts — min-w-0 lets the cards shrink inside the
          grid; without it the grid track sizes to the code block's longest
          line and the page overflows on phones */}
      <section className="mt-14 grid gap-5">
        {PLATFORM_GUIDES.map((p) => (
          <div key={p.name} className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/30 p-6">
            <div className="flex items-center gap-3">
              <span className="text-3xl">{p.icon}</span>
              <div>
                <h3 className="text-xl font-bold text-zinc-100">{p.name}</h3>
              </div>
              <span className="ml-auto rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[11px] text-zinc-400">
                download → run
              </span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-zinc-400">{p.body}</p>
            <div className="mt-4">
              <Code>{p.code}</Code>
            </div>
            <p className="mt-3 text-xs text-zinc-500">{p.note}</p>
          </div>
        ))}
      </section>

      {/* requirements */}
      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight">System requirements</h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          {REQUIREMENTS.map((r) => (
            <div key={r.name} className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5">
              <div className="flex items-center gap-2">
                <span className="text-2xl">{r.icon}</span>
                <h3 className="font-bold text-zinc-100">{r.name}</h3>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-zinc-500">{r.detail}</p>
            </div>
          ))}
        </div>
        <p className="mt-4 text-sm text-zinc-500">
          The full binaries embed Tagent&apos;s runtime, which needs these minimum versions —
          Windows 7/8 and 32-bit systems are <span className="text-zinc-300">not supported</span> by it.
          That is exactly what the{" "}
          <a className="text-orange-400 hover:text-orange-300" href="#native-edition">
            native edition
          </a>{" "}
          above is for: <span className="text-zinc-300">tagent-native-windows-386.exe</span> runs on
          Windows 7, 8, 8.1, 10 and 11, including 32-bit machines.
        </p>
      </section>

      {/* other ways to run */}
      <section className="mt-14">
        <h2 className="text-2xl font-bold tracking-tight">No binary for your machine?</h2>
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col rounded-xl border border-zinc-800 bg-zinc-900/30 p-6">
            <div className="flex items-center gap-3">
              <span className="text-3xl">📦</span>
              <div>
                <h3 className="text-xl font-bold text-zinc-100">From source</h3>
                <p className="text-xs text-zinc-500">any Linux/macOS box with git</p>
              </div>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-zinc-400">
              Clone and run — the GUI ships pre-built in the repo, so it is still a two-command install.
              Same engine, same sessions, update with git pull.
            </p>
            <div className="mt-4">
              <Code>{`git clone https://github.com/asysurya/tagent.git
cd tagent && bash scripts/setup-ubuntu.sh
bun link && tagent start ~/my-project`}</Code>
            </div>
          </div>
          <div className="flex min-w-0 flex-col rounded-xl border border-zinc-800 bg-zinc-900/30 p-6">
            <div className="flex items-center gap-3">
              <span className="text-3xl">📱</span>
              <div>
                <h3 className="text-xl font-bold text-zinc-100">Android (UserLAnd)</h3>
                <p className="text-xs text-zinc-500">no root · Ubuntu via proot</p>
              </div>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-zinc-400">
              Real Ubuntu from the Play Store, then the source install above inside it.
              The GUI has a dedicated phone layout (bottom tabs) — open localhost:4020 in Chrome on the same phone.
            </p>
            <Link
              href="/docs#userland"
              className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-orange-400 hover:text-orange-300"
            >
              Phone setup guide →
            </Link>
          </div>
        </div>
      </section>

      {/* source archives per release */}
      <section className="mt-16">
        <h2 className="text-2xl font-bold tracking-tight">Source archives</h2>
        <p className="mt-2 text-zinc-400">
          Per-release snapshots straight from the git tags — useful for pinning or offline installs:
        </p>
        <div className="mt-5 overflow-x-auto rounded-lg border border-zinc-800 pretty-scroll">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/60 text-left text-xs uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-2.5 font-medium">Version</th>
                <th className="px-4 py-2.5 font-medium">Date</th>
                <th className="px-4 py-2.5 font-medium">Highlights</th>
                <th className="px-4 py-2.5 font-medium text-right">Download</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70">
              {RELEASES.filter((r) => !r.unreleased).map((r) => (
                <tr key={r.version} className="bg-zinc-900/30 hover:bg-zinc-900/60">
                  <td className="px-4 py-3">
                    <span className="font-mono font-semibold text-zinc-100">v{r.version}</span>
                    {r.version === LATEST && <span className="ml-2 rounded-full border border-orange-500/40 bg-orange-500/10 px-2 py-0.5 text-[10px] font-semibold text-orange-300">latest</span>}
                  </td>
                  <td className="px-4 py-3 text-zinc-500">{r.date}</td>
                  <td className="max-w-xs truncate px-4 py-3 text-zinc-400" title={r.title}>{r.title}</td>
                  <td className="px-4 py-3 text-right">
                    <a className="text-orange-400 hover:text-orange-300" href={`https://github.com/asysurya/tagent/archive/refs/tags/v${r.version}.zip`}>zip</a>
                    <span className="mx-1 text-zinc-700">·</span>
                    <a className="text-orange-400 hover:text-orange-300" href={`https://github.com/asysurya/tagent/archive/refs/tags/v${r.version}.tar.gz`}>tar.gz</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-sm text-zinc-500">
          Archives contain the pre-built GUI (<span className="font-mono text-xs">gui-dist/</span>), so after
          extracting you only need <code className="rounded bg-zinc-800 px-1 text-xs">bash scripts/setup-ubuntu.sh</code>.
        </p>
      </section>
    </div>
  )
}
