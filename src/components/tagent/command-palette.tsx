'use client'

import { useEffect } from 'react'
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator,
} from '@/components/ui/command'
import { Bot, Brain, Files, ListChecks, RotateCcw, Settings, Sparkles, Terminal, Plus, BookOpen } from 'lucide-react'
import { useTagent } from '@/lib/tagent/store'

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const st = useTagent()

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onOpenChange(!open)
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [open, onOpenChange])

  const run = (fn: () => void) => {
    onOpenChange(false)
    fn()
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} className="bg-zinc-900 border-zinc-800">
      <CommandInput placeholder="Type a command…" className="font-mono" />
      <CommandList className="pretty-scroll">
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Session">
          <CommandItem className="text-zinc-300" onSelect={() => run(() => void st.newSession())}>
            <Plus className="size-4" /> New session
          </CommandItem>
          <CommandItem className="text-zinc-300" onSelect={() => run(() => void st.setMode('plan'))}>
            <ListChecks className="size-4" /> Switch to plan mode (read-only)
          </CommandItem>
          <CommandItem className="text-zinc-300" onSelect={() => run(() => void st.setMode('build'))}>
            <Sparkles className="size-4" /> Switch to build mode
          </CommandItem>
          <CommandItem className="text-zinc-300" onSelect={() => run(() => void st.undo())}>
            <RotateCcw className="size-4" /> Undo last checkpoint
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Panels">
          <CommandItem className="text-zinc-300" onSelect={() => run(() => st.setRightTab('files'))}>
            <Files className="size-4" /> Open files
          </CommandItem>
          <CommandItem className="text-zinc-300" onSelect={() => run(() => st.setRightTab('terminal'))}>
            <Terminal className="size-4" /> Open terminal
          </CommandItem>
          <CommandItem className="text-zinc-300" onSelect={() => run(() => st.setRightTab('memory'))}>
            <Brain className="size-4" /> Open memory
          </CommandItem>
          <CommandItem className="text-zinc-300" onSelect={() => run(() => st.setRightTab('skills'))}>
            <BookOpen className="size-4" /> Open skills
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Prompt ideas">
          <CommandItem className="text-zinc-300" onSelect={() => run(() => void st.send('Explore the workspace and explain what this project does.'))}>
            <Bot className="size-4" /> Explore the workspace and explain it
          </CommandItem>
          <CommandItem className="text-zinc-300" onSelect={() => run(() => void st.send('Review the code in this workspace and list issues by severity.'))}>
            <Bot className="size-4" /> Review code quality
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="System">
          <CommandItem className="text-zinc-300" onSelect={() => onOpenChange(false)}>
            <Settings className="size-4" /> (open settings from the toolbar)
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
