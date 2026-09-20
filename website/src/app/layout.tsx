import type { Metadata, Viewport } from "next"
import Link from "next/link"
import "./globals.css"
import { IconExternal, IconTerminal } from "@/components/icons"
import { MobileNav } from "@/components/mobile-nav"

export const metadata: Metadata = {
  title: "Tagent — terminal-native coding agent with a web GUI",
  description:
    "An open agent platform: agent loop, subagents, MCP servers, plugins, skills, memory, GitHub sync, permissions, checkpoints — on your machine, in your browser, even on your phone.",
  metadataBase: new URL("https://tagent-website.vercel.app"),
  openGraph: {
    title: "Tagent",
    description: "Terminal-native coding agent with a web GUI. Runs on your machine — even your phone.",
    images: ["/img-desktop.png"],
  },
  twitter: {
    card: "summary_large_image",
  },
}

export const viewport: Viewport = {
  themeColor: "#09090b",
}

function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-zinc-800/70 bg-zinc-950/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
        <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight group">
          <span className="relative">
            <img src="/logo.svg" alt="Tagent logo" className="h-7 w-7 rounded-[6px] transition-transform group-hover:scale-105" width={28} height={28} />
          </span>
          <span className="text-zinc-100">tagent</span>
          <span className="hidden sm:inline-flex items-center gap-1 rounded-full border border-orange-500/25 bg-orange-500/10 px-2 py-0.5 text-[10px] font-medium text-orange-300">
            <IconTerminal className="size-2.5" /> terminal-native
          </span>
        </Link>
        <nav className="ml-auto hidden items-center gap-1 text-sm text-zinc-400 sm:flex" aria-label="Main">
          <Link className="rounded-md px-3 py-1.5 hover:bg-zinc-800/70 hover:text-zinc-200" href="/docs">Docs</Link>
          <Link className="rounded-md px-3 py-1.5 hover:bg-zinc-800/70 hover:text-zinc-200" href="/releases">Releases</Link>
          <Link className="rounded-md px-3 py-1.5 hover:bg-zinc-800/70 hover:text-zinc-200" href="/download">Download</Link>
          <a
            className="ml-2 inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 font-medium text-zinc-200 hover:border-orange-500/60 hover:text-orange-300"
            href="https://github.com/asysurya/tagent"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
            <IconExternal className="size-3" />
          </a>
        </nav>
        <MobileNav />
      </div>
    </header>
  )
}

function Footer() {
  return (
    <footer className="border-t border-zinc-800/70">
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-4 py-10 text-sm text-zinc-500 sm:flex-row">
        <div>
          <div className="flex items-center gap-2">
            <img src="/logo.svg" alt="" className="h-5 w-5 rounded-[4px]" width={20} height={20} />
            <span className="font-semibold text-zinc-300">Tagent</span>
          </div>
          <p className="mt-2 max-w-md leading-relaxed">
            Open agent platform — engine on your machine, browser as the cockpit.
            MCP servers, plugins, subagents, BYOK providers. MIT licensed.
          </p>
          <p className="mt-3 text-xs text-zinc-600">© {new Date().getFullYear()} Tagent — MIT licensed.</p>
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
