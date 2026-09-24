'use client'

import { memo } from 'react'
import type { SourceDirNode, SourceNode } from '@/data/source-snapshot'

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`shrink-0 text-zinc-500 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-orange-300/80">
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-zinc-500">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </svg>
  )
}

interface TreeProps {
  root: SourceDirNode
  expanded: Set<string>
  selected: string | null
  onToggle: (path: string) => void
  onSelect: (path: string) => void
}

interface RowProps {
  node: SourceNode
  depth: number
  expanded: Set<string>
  selected: string | null
  onToggle: (path: string) => void
  onSelect: (path: string) => void
}

function Row({ node, depth, expanded, selected, onToggle, onSelect }: RowProps) {
  if (node.type === 'dir') {
    const open = expanded.has(node.path)
    return (
      <div>
        <button
          type="button"
          onClick={() => onToggle(node.path)}
          aria-expanded={open}
          className="flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left text-[13px] text-zinc-300 transition-colors hover:bg-zinc-800/60 hover:text-zinc-100"
          style={{ paddingLeft: depth * 12 + 6 }}
        >
          <Chevron open={open} />
          <FolderIcon />
          <span className="truncate">{node.name}</span>
        </button>
        {open && (
          <div role="group">
            {node.children.map((c) => (
              <Row key={c.path} node={c} depth={depth + 1} expanded={expanded} selected={selected} onToggle={onToggle} onSelect={onSelect} />
            ))}
          </div>
        )}
      </div>
    )
  }
  const isSel = node.path === selected
  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={isSel}
      onClick={() => onSelect(node.path)}
      title={node.path}
      className={`flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left text-[13px] transition-colors ${
        isSel ? 'bg-orange-500/10 text-orange-200' : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100'
      }`}
      style={{ paddingLeft: depth * 12 + 18 }}
    >
      <FileIcon />
      <span className="truncate">{node.name}</span>
    </button>
  )
}

/** The collapsible file tree — rows are cheap and memoized as one unit. */
export const FileTree = memo(function FileTree({ root, expanded, selected, onToggle, onSelect }: TreeProps) {
  return (
    <div role="tree" aria-label="Source files" className="pretty-scroll min-h-0 flex-1 overflow-y-auto pb-4 pr-1">
      {root.children.map((c) => (
        <Row key={c.path} node={c} depth={0} expanded={expanded} selected={selected} onToggle={onToggle} onSelect={onSelect} />
      ))}
    </div>
  )
})
