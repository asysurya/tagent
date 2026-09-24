'use client'

import { useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ChevronRight, File as FileIcon, Folder, FolderOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTagent } from '@/lib/tagent/store'
import type { FileNode } from '@/lib/tagent/types'

function Node({ node, depth }: { node: FileNode; depth: number }) {
  const [open, setOpen] = useState(depth === 0)
  const openFile = useTagent((s) => s.openFile)
  const activePath = useTagent((s) => s.fileBuffer?.path)
  const isDir = node.type === 'dir'

  if (isDir) {
    return (
      <div>
        <button
          type="button"
          className="w-full flex items-center gap-1 py-1.5 md:py-0.5 text-left hover:bg-zinc-900 rounded px-1"
          style={{ paddingLeft: depth * 12 + 4 }}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRight className={cn('size-3 text-zinc-600 transition-transform', open && 'rotate-90')} />
          {open ? <FolderOpen className="size-3.5 text-orange-400/80" /> : <Folder className="size-3.5 text-orange-400/60" />}
          <span className="text-xs text-zinc-300 truncate">{node.name}</span>
        </button>
        {open && node.children?.map((c) => <Node key={c.path} node={c} depth={depth + 1} />)}
      </div>
    )
  }

  return (
    <button
      type="button"
      className={cn('w-full flex items-center gap-1.5 py-1.5 md:py-0.5 text-left hover:bg-zinc-900 rounded px-1',
        activePath === node.path && 'bg-orange-500/10')}
      style={{ paddingLeft: depth * 12 + 6 }}
      onClick={() => void openFile(node.path)}
    >
      <FileIcon className={cn('size-3 shrink-0', activePath === node.path ? 'text-orange-400' : 'text-zinc-600')} />
      <span className={cn('text-xs truncate', activePath === node.path ? 'text-orange-200' : 'text-zinc-400')}>
        {node.name}
      </span>
    </button>
  )
}

export function FileTree() {
  const tree = useTagent((s) => s.fileTree)
  return (
    <ScrollArea className="h-full pretty-scroll">
      <div className="p-2 space-y-0.5">
        {tree ? <Node node={tree} depth={0} /> : (
          <p className="text-xs text-zinc-600 px-2 py-4 text-center animate-pulse">loading…</p>
        )}
      </div>
    </ScrollArea>
  )
}
