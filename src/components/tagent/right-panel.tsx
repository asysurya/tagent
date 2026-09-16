'use client'

import { BookOpen, Brain, Files, Terminal } from 'lucide-react'
import { useTagent } from '@/lib/tagent/store'
import { cn } from '@/lib/utils'
import { FileTree } from './file-tree'
import { FileEditor } from './file-editor'
import { TerminalPanel } from './terminal-panel'
import { MemoryPanel } from './memory-panel'
import { SkillsPanel } from './skills-panel'

const TABS = [
  { id: 'files', label: 'Files', icon: Files },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'skills', label: 'Skills', icon: BookOpen },
] as const

export function RightPanel() {
  const tab = useTagent((s) => s.rightTab)
  const setRightTab = useTagent((s) => s.setRightTab)
  const toggleRight = useTagent((s) => s.toggleRight)
  const open = useTagent((s) => s.rightOpen)

  return (
    <div className={cn(
      'h-full flex flex-col bg-zinc-950/60 border-l border-zinc-800/60 min-w-0 transition-[margin] duration-200',
      !open && 'md:-mr-full md:absolute md:right-0 md:top-0 md:bottom-0 md:w-1/3 md:z-30 md:hidden',
    )}>
      {/* tab bar */}
      <div className="h-9 shrink-0 flex items-stretch border-b border-zinc-800/60">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setRightTab(t.id)}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 text-[11px] font-medium transition-colors relative',
              tab === t.id ? 'text-orange-300' : 'text-zinc-500 hover:text-zinc-300',
            )}
          >
            <t.icon className="size-3.5" />
            <span className="hidden sm:inline">{t.label}</span>
            {tab === t.id && <span className="absolute bottom-0 left-3 right-3 h-px bg-orange-500" />}
          </button>
        ))}
        <button
          className="px-2.5 text-zinc-600 hover:text-zinc-300 border-l border-zinc-800/60"
          onClick={toggleRight}
          title="Hide panel"
        >
          ×
        </button>
      </div>

      {/* content */}
      <div className="flex-1 min-h-0 flex">
        {tab === 'files' && (
          <div className="flex-1 flex min-h-0">
            <div className="w-52 min-w-40 border-r border-zinc-800/50 h-full">
              <FileTree />
            </div>
            <div className="flex-1 flex flex-col min-w-0">
              <FileEditor />
            </div>
          </div>
        )}
        {tab === 'terminal' && <div className="flex-1 min-h-0"><TerminalPanel /></div>}
        {tab === 'memory' && <div className="flex-1 min-h-0"><MemoryPanel /></div>}
        {tab === 'skills' && <div className="flex-1 min-h-0"><SkillsPanel /></div>}
      </div>
    </div>
  )
}
