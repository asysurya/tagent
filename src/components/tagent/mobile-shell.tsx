'use client'

/**
 * MobileShell — phone-first layout (UserLAnd on Android, small windows, etc).
 *
 * One screen at a time with a thumb-friendly bottom tab bar. Reuses the exact
 * same panels as the desktop layout (ChatPanel, FileTree, FileEditor,
 * TerminalPanel, MemoryPanel, SkillsPanel) so feature parity is automatic.
 */
import { useState } from 'react'
import { ArrowLeft, BookOpen, Brain, Files, MessageSquare, Terminal } from 'lucide-react'
import { useTagent } from '@/lib/tagent/store'
import { cn } from '@/lib/utils'
import { ChatPanel } from './chat-panel'
import { FileTree } from './file-tree'
import { FileEditor } from './file-editor'
import { TerminalPanel } from './terminal-panel'
import { MemoryPanel } from './memory-panel'
import { SkillsPanel } from './skills-panel'

type MobileTab = 'chat' | 'files' | 'terminal' | 'memory' | 'skills'

const TABS: { id: MobileTab; label: string; icon: typeof Files }[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'files', label: 'Files', icon: Files },
  { id: 'terminal', label: 'Term', icon: Terminal },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'skills', label: 'Skills', icon: BookOpen },
]

export function MobileShell() {
  const [tab, setTab] = useState<MobileTab>('chat')
  const fileBuffer = useTagent((s) => s.fileBuffer)
  const closeFile = useTagent((s) => s.closeFile)

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* content */}
      <div className="flex-1 min-h-0 flex flex-col">
        {tab === 'chat' && <ChatPanel />}
        {tab === 'files' && (
          fileBuffer ? (
            <div className="flex flex-col h-full">
              <button
                type="button"
                aria-label="Close file and go back to the file tree"
                onClick={() => closeFile()}
                className="shrink-0 flex items-center gap-1.5 px-3 h-9 text-[11px] font-medium text-zinc-400 hover:text-zinc-200 border-b border-zinc-800/60 bg-zinc-950/80"
              >
                <ArrowLeft className="size-3.5 shrink-0" />
                <span className="truncate text-orange-300/80" title={fileBuffer.path}>{fileBuffer.path}</span>
              </button>
              <div className="flex-1 min-h-0">
                <FileEditor />
              </div>
            </div>
          ) : (
            <FileTree />
          )
        )}
        {tab === 'terminal' && <TerminalPanel />}
        {tab === 'memory' && <MemoryPanel />}
        {tab === 'skills' && <SkillsPanel />}
      </div>

      {/* bottom tab bar — thumb zone, safe-area aware for notched phones */}
      <nav
        className="shrink-0 flex items-stretch border-t border-zinc-800/80 bg-zinc-950/95 backdrop-blur"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-current={tab === t.id ? 'page' : undefined}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5 py-2 text-[9px] font-medium transition-colors',
              tab === t.id ? 'text-orange-300' : 'text-zinc-500 active:text-zinc-300',
            )}
          >
            <t.icon className={cn('size-4', tab === t.id && 'drop-shadow-[0_0_6px_rgba(249,115,22,0.45)]')} />
            <span className="truncate max-w-full">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}
