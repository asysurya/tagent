"use client"

import { useState } from "react"
import Link from "next/link"
import { IconExternal } from "./icons"

const LINKS = [
  { href: "/docs", label: "Docs" },
  { href: "/releases", label: "Releases" },
  { href: "/download", label: "Download" },
  { href: "/source", label: "Source" },
]

/**
 * Hamburger nav for small screens — the full link row (logo + 3 links +
 * GitHub button) does not fit a 360px header, so below `sm` it collapses
 * into this button + dropdown.
 */
export function MobileNav() {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)

  return (
    <div className="ml-auto sm:hidden">
      <button
        type="button"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex size-9 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900 text-zinc-300 transition-colors hover:border-zinc-600 hover:text-zinc-100"
      >
        {open ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M4 6h16" />
            <path d="M4 12h16" />
            <path d="M4 18h16" />
          </svg>
        )}
      </button>

      {/* click-through catcher — closes the menu without navigating */}
      {open && (
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          onClick={close}
          className="fixed inset-0 z-40 cursor-default sm:hidden"
        />
      )}

      {open && (
        <div className="absolute inset-x-0 top-14 z-50 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur sm:hidden">
          <nav className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-3 text-sm" aria-label="Main">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={close}
                className="rounded-md px-3 py-2.5 text-zinc-300 hover:bg-zinc-800/70 hover:text-zinc-100"
              >
                {l.label}
              </Link>
            ))}
            <a
              href="https://github.com/asysurya/tagent"
              target="_blank"
              rel="noreferrer"
              onClick={close}
              className="mt-1 inline-flex items-center gap-1.5 rounded-md px-3 py-2.5 font-medium text-zinc-200 hover:bg-zinc-800/70"
            >
              GitHub
              <IconExternal className="size-3" width={12} height={12} />
            </a>
          </nav>
        </div>
      )}
    </div>
  )
}
