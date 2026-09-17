'use client'

import { useEffect } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { Toaster } from 'sonner'
import { useTagent } from '@/lib/tagent/store'
import { TopBar } from './topbar'
import { Sidebar } from './sidebar'
import { ChatPanel } from './chat-panel'
import { RightPanel } from './right-panel'
import { MobileShell } from './mobile-shell'
import { PermissionDialog } from './permission-dialog'
import { SettingsDialog } from './settings-dialog'

export function TagentApp() {
  const boot = useTagent((s) => s.boot)
  const connection = useTagent((s) => s.connection)

  useEffect(() => {
    void boot()
  }, [boot])

  return (
    <div className="h-dvh flex flex-col bg-zinc-950 text-zinc-200 overflow-hidden">
      <TopBar />
      <div className="flex-1 min-h-0 hidden md:block">
        <PanelGroup direction="horizontal">
          <Panel id="sidebar" order={1} defaultSize={17} minSize={12} maxSize={26} className="min-w-0">
            <Sidebar />
          </Panel>
          <PanelResizeHandle className="w-px bg-zinc-800/60 hover:bg-orange-500/60 transition-colors data-[resize-handle-active]:bg-orange-500" />
          <Panel id="chat" order={2} defaultSize={49} minSize={30} className="min-w-0">
            <ChatPanel />
          </Panel>
          <PanelResizeHandle className="w-px bg-zinc-800/60 hover:bg-orange-500/60 transition-colors data-[resize-handle-active]:bg-orange-500" />
          <Panel id="right" order={3} defaultSize={34} minSize={22} maxSize={55} className="min-w-0">
            <RightPanel />
          </Panel>
        </PanelGroup>
      </div>
      {/* mobile: tabbed phone layout (UserLAnd on Android, small windows) */}
      <div className="flex-1 min-h-0 md:hidden">
        <MobileShell />
      </div>

      <PermissionDialog />
      <SettingsDialog />

      {connection === 'demo' && (
        <div className="px-3 py-1 text-[11px] bg-amber-500/10 text-amber-300 border-t border-amber-500/20 text-center">
          demo mode — daemon unreachable; start it with{' '}
          <code className="text-amber-200">bun mini-services/tagent-daemon</code> for a live agent
        </div>
      )}
      <Toaster
        richColors
        position="bottom-right"
        theme="dark"
        toastOptions={{ style: { background: '#18181b', border: '1px solid #27272a', color: '#e4e4e7' } }}
      />
    </div>
  )
}
