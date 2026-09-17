'use client'

import { useState } from 'react'

export function Copy({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        })
      }}
      className="absolute right-2 top-2 rounded-md border border-zinc-700 bg-zinc-900/90 px-2 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
      aria-label={label ?? 'copy to clipboard'}
      type="button"
    >
      {done ? '✓ copied' : 'copy'}
    </button>
  )
}

/** Terminal-looking code block with a copy button */
export function Code({ children }: { children: string }) {
  return (
    <div className="relative">
      <Copy text={children} />
      <pre className="pretty-scroll overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/70 p-4 pr-16 text-[13px] leading-relaxed text-zinc-200">
        <code>{children}</code>
      </pre>
    </div>
  )
}
