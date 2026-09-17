import type { Metadata } from "next"
import Link from "next/link"
import "./globals.css"

export const metadata: Metadata = {
  title: "Tagent — terminal-native coding agent with a web GUI",
  description:
    "An open agent platform: agent loop, subagents, skills, memory, permissions, checkpoints, plugins, multi-provider BYOK — on your machine, in your browser, even on your phone.",
  metadataBase: new URL("https://tagent.vercel.app"),
  openGraph: {
    title: "Tagent",
    description: "Terminal-native coding agent with a web GUI. Runs on your machine — even your phone.",
    images: ["/img-desktop.png"],
  },
}

function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-zinc-800/70 bg-zinc-950/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="" className="h-6 w-6" />
          <span>tagent</span>
        </Link>
        <nav className="ml-auto flex items-center gap-1 text-sm text-zinc-400">
          <Link className="rounded-md px-3 py-1.5 hover:bg-zinc-800/70 hover:text-zinc-200" href="/docs">Docs</Link>
          <Link className="rounded-md px-3 py-1.5 hover:bg-zinc-800/70 hover:text-zinc-200" href="/releases">Releases</Link>
          <Link className="rounded-md px-3 py-1.5 hover:bg-zinc-800/70 hover:text-zinc-200" href="/download">Download</Link>
          <a
            className="ml-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 font-medium text-zinc-200 hover:border-orange-500/60 hover:text-orange-300"
            href="https://github.com/asysurya/tagent"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </nav>
      </div>
    </header>
  )
}

function Footer() {
  return (
    <footer className="border-t border-zinc-800/70">
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-4 px-4 py-10 text-sm text-zinc-500 sm:flex-row">
        <div>
          <div className="font-semibold text-zinc-300">⚡ Tagent</div>
          <p className="mt-1 max-w-md">
            Open agent platform — engine on your machine, browser as the cockpit.
            MIT licensed.
          </p>
        </div>
        <div className="flex gap-10">
          <div className="flex flex-col gap-1.5">
            <span className="font-medium text-zinc-400">Product</span>
            <Link className="hover:text-zinc-200" href="/docs">Docs</Link>
            <Link className="hover:text-zinc-200" href="/releases">Releases</Link>
            <Link className="hover:text-zinc-200" href="/download">Download</Link>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="font-medium text-zinc-400">Community</span>
            <a className="hover:text-zinc-200" href="https://github.com/asysurya/tagent" target="_blank" rel="noreferrer">GitHub</a>
            <a className="hover:text-zinc-200" href="https://github.com/asysurya/tagent/issues" target="_blank" rel="noreferrer">Issues</a>
            <a className="hover:text-zinc-200" href="https://github.com/asysurya/tagent/blob/main/CONTRIBUTING.md" target="_blank" rel="noreferrer">Contributing</a>
          </div>
        </div>
      </div>
    </footer>
  )
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="flex min-h-dvh flex-col antialiased">
        <Nav />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  )
}
