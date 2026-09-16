'use client'

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Loader2, Terminal as TerminalIcon } from 'lucide-react'
import { useTagent } from '@/lib/tagent/store'

export function TerminalPanel() {
  const output = useTagent((s) => s.terminalOutput)
  const runTerminal = useTagent((s) => s.runTerminal)
  const config = useTagent((s) => s.config)
  const [cmd, setCmd] = useState('')
  const [busy, setBusy] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const bashOn = config?.tools.bash ?? false

  const run = async () => {
    if (!cmd.trim() || busy) return
    setBusy(true)
    setCmd('')
    await runTerminal(cmd.trim())
    setBusy(false)
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }))
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <ScrollArea className="flex-1 pretty-scroll">
        <div className="p-3 font-mono text-[11.5px] leading-5">
          {output.length === 0 ? (
            <p className="text-zinc-600">
              {bashOn
                ? 'Run shell commands in the workspace root.\nOutput is not interactive — good for ls, cat, git status, tests.'
                : 'Terminal is disabled in this environment.\nEnable it in Settings → Permissions.'}
            </p>
          ) : (
            output.map((line, i) => (
              <pre
                key={i}
                className={
                  line.startsWith('$')
                    ? 'text-orange-400 whitespace-pre-wrap'
                    : 'text-zinc-300 whitespace-pre-wrap'
                }
              >
                {line}
              </pre>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
      <div className="shrink-0 border-t border-zinc-800/60 p-2 flex gap-2">
        <div className="flex-1 flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 focus-within:border-orange-500/50">
          <span className="pl-2 text-orange-400 font-mono text-xs">$</span>
          <input
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void run()}
            disabled={!bashOn || busy}
            placeholder={bashOn ? 'ls -la' : 'disabled'}
            className="flex-1 bg-transparent py-1.5 pr-2 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
          />
        </div>
        <Button size="sm" className="h-8 px-2.5 text-xs bg-orange-500 hover:bg-orange-400 text-zinc-950" disabled={!cmd.trim() || busy || !bashOn} onClick={() => void run()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <TerminalIcon className="size-3.5" />}
        </Button>
      </div>
    </div>
  )
}
