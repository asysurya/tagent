'use client'

import { useEffect, useRef } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Save, Undo2 } from 'lucide-react'
import { useTagent } from '@/lib/tagent/store'
import { cn } from '@/lib/utils'

export function FileEditor() {
  const buffer = useTagent((s) => s.fileBuffer)
  const openFile = useTagent((s) => s.openFile)
  const saveFile = useTagent((s) => s.saveFile)
  const undo = useTagent((s) => s.undo)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // reload saved content when switching files
  useEffect(() => {
    const ta = taRef.current
    if (ta) ta.value = buffer?.content ?? ''
  }, [buffer?.path, buffer?.content])

  if (!buffer) {
    return (
      <div className="flex-1 grid place-items-center">
        <p className="text-xs text-zinc-600">Select a file to view & edit</p>
      </div>
    )
  }

  const lines = buffer.content.split('\n').length

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-zinc-800/60">
        <span className="font-mono text-[11px] text-zinc-300 truncate flex-1" title={buffer.path}>{buffer.path}</span>
        {buffer.binary && (
          <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-zinc-700 text-zinc-500 shrink-0">binary</Badge>
        )}
        <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-zinc-700 text-zinc-500 shrink-0">{lines} lines</Badge>
        <Button
          size="sm" variant="ghost" className="h-7 w-7 p-0 text-zinc-400"
          title="Undo agent changes (checkpoint)"
          aria-label="Undo agent changes (checkpoint)"
          onClick={() => void undo()}
        >
          <Undo2 className="size-3.5" />
        </Button>
        <Button
          size="sm"
          className={cn('h-7 px-2.5 text-[10px] gap-1 shrink-0', buffer.dirty
            ? 'bg-orange-500 hover:bg-orange-400 text-zinc-950'
            : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700')}
          disabled={!buffer.dirty || buffer.binary}
          onClick={() => void saveFile()}
        >
          <Save className="size-3" /> save
        </Button>
      </div>
      <div className="flex-1 min-h-0 relative">
        <textarea
          ref={taRef}
          spellCheck={false}
          defaultValue={buffer.content}
          onChange={(e) => {
            const v = e.target.value
            useTagent.setState((s) => ({
              fileBuffer: s.fileBuffer && s.fileBuffer.path === buffer.path
                ? { ...s.fileBuffer, content: v, dirty: true }
                : s.fileBuffer,
            }))
          }}
          className="absolute inset-0 w-full h-full resize-none bg-zinc-950/80 text-zinc-300 font-mono text-[12px] leading-5 p-3 focus:outline-none focus:ring-1 focus:ring-orange-500/40 pretty-scroll"
          readOnly={buffer.binary}
        />
      </div>
    </div>
  )
}
