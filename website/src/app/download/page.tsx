import type { Metadata } from "next"
import Link from "next/link"
import { Code } from "@/components/code"
import { RELEASES, LATEST } from "@/data/releases"

export const metadata: Metadata = {
  title: "Download — Tagent",
  description: "Get Tagent for your platform: Linux, macOS, Windows (WSL2), Android — plus source archives per release.",
}

const PLATFORMS = [
  {
    name: "Linux",
    icon: "🐧",
    tag: "laptop & desktop",
    arch: "x64 · arm64 (incl. Raspberry Pi)",
    body: "Ubuntu 20.04+, Debian, and friends. One script installs Bun, dependencies and gets you running — the web GUI ships pre-built, nothing to compile.",
    code: `git clone https://github.com/asysurya/tagent.git
cd tagent && bash scripts/setup-ubuntu.sh
bun link && tagent start ~/my-project`,
    link: "/docs",
    linkLabel: "Full install docs",
  },
  {
    name: "macOS",
    icon: "🍎",
    tag: "Apple silicon & Intel",
    arch: "arm64 · x64",
    body: "Same flow, Homebrew-installed git is enough. The setup script handles macOS; xdg-open is replaced by `open` automatically.",
    code: `git clone https://github.com/asysurya/tagent.git
cd tagent && bash scripts/setup-ubuntu.sh
bun link && tagent start ~/my-project`,
    link: "/docs",
    linkLabel: "Full install docs",
  },
  {
    name: "Windows",
    icon: "🪟",
    tag: "via WSL2",
    arch: "x64 · arm64",
    body: "Install Ubuntu through WSL2, then follow the Linux steps inside it. Open http://localhost:4020 in any Windows browser — WSL2 forwards localhost automatically.",
    code: `wsl --install -d Ubuntu   # then, inside Ubuntu:
git clone https://github.com/asysurya/tagent.git
cd tagent && bash scripts/setup-ubuntu.sh`,
    link: "https://learn.microsoft.com/windows/wsl/install",
    linkLabel: "WSL2 setup guide ↗",
  },
  {
    name: "Android",
    icon: "📱",
    tag: "UserLAnd — no root",
    arch: "Android 7+",
    body: "Real Ubuntu via proot from the Play Store. The GUI has a dedicated phone layout (bottom tabs). Open localhost:4020 in Chrome on the same phone.",
    code: `# inside the UserLAnd Ubuntu session:
sudo apt-get install -y git curl
git clone https://github.com/asysurya/tagent.git
cd tagent && bash scripts/setup-ubuntu.sh
bun link && tagent start ~/my-project --no-open`,
    link: "/docs#userland",
    linkLabel: "Phone setup guide",
  },
]

export default function DownloadPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-12">
      <h1 className="text-4xl font-bold tracking-tight">Download</h1>
      <p className="mt-3 max-w-2xl text-zinc-400">
        Current release <span className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-0.5 font-mono text-sm text-orange-300">v{LATEST}</span>.
        Tagent is distributed as source — the GUI comes pre-built, so every platform below is a
        clone-and-run. No binaries to trust, no installers.
      </p>

      <div className="mt-10 grid gap-5 lg:grid-cols-2">
        {PLATFORMS.map((p) => (
          <div key={p.name} className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/30 p-6">
            <div className="flex items-center gap-3">
              <span className="text-3xl">{p.icon}</span>
              <div>
                <h2 className="text-xl font-bold text-zinc-100">{p.name}</h2>
                <p className="text-xs text-zinc-500">{p.tag}</p>
              </div>
              <span className="ml-auto rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[11px] text-zinc-400">{p.arch}</span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-zinc-400">{p.body}</p>
            <div className="mt-4">
              <Code>{p.code}</Code>
            </div>
            <Link
              href={p.link}
              className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-orange-400 hover:text-orange-300"
            >
              {p.linkLabel} →
            </Link>
          </div>
        ))}
      </div>

      {/* source archives per release */}
      <section className="mt-16">
        <h2 className="text-2xl font-bold tracking-tight">Source archives</h2>
        <p className="mt-2 text-zinc-400">
          Per-release snapshots straight from the git tags — useful for pinning or offline installs:
        </p>
        <div className="mt-5 overflow-hidden rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/60 text-left text-xs uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-2.5 font-medium">Version</th>
                <th className="px-4 py-2.5 font-medium">Date</th>
                <th className="px-4 py-2.5 font-medium">Highlights</th>
                <th className="px-4 py-2.5 font-medium text-right">Download</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70">
              {RELEASES.map((r, i) => (
                <tr key={r.version} className="bg-zinc-900/30 hover:bg-zinc-900/60">
                  <td className="px-4 py-3">
                    <span className="font-mono font-semibold text-zinc-100">v{r.version}</span>
                    {i === 0 && <span className="ml-2 rounded-full border border-orange-500/40 bg-orange-500/10 px-2 py-0.5 text-[10px] font-semibold text-orange-300">latest</span>}
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
