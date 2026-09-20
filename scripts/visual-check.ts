#!/usr/bin/env bun
/** visual-check.ts — render the app TUI in a real PTY and snapshot frames */
import { EventEmitter } from 'node:events'
import { TuiApp, setAppColor, type AppIO } from '../packages/cli/src/tui-app'
import type { AgentHost } from '../packages/cli/src/host'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const strip = (s: string) => s.replace(/\x1b\[[0-9;:<>?]*[A-Za-z~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')

class FakeHost {
  root = process.cwd()
  bus = new EventEmitter()
  sent: string[] = []
  cfg = { version: 1, defaultProvider: 'zai', defaultModel: 'glm-4.7', apiKeys: {}, customProviders: [], permissions: { defaultMode: 'ask', tools: {} }, tools: {} }
  sanitizeConfig() { return { defaultModel: this.cfg.defaultModel, defaultProvider: this.cfg.defaultProvider } }
  listSessions(): unknown[] { return [] }
  async pluginCommandRun(cmd: string) { return { ok: false, error: `no plugin command named ${cmd}` } }
  settingsSave(patch: Record<string, unknown>) { Object.assign(this.cfg, patch); return { ok: true, config: this.sanitizeConfig() } }
  async providersRefresh() { return { ok: true, updated: [], failed: [] } }
  async chatSend(text: string) { this.sent.push(text); return { turns: 1, toolCalls: 0, finished: 'complete' } }
  interrupt() {}
}

// direct approach instead:
async function direct() {
  setAppColor(false)
  const host = new FakeHost()
  const out = { isTTY: true, columns: 90, rows: 28, chunks: [] as string[], write(s: string) { this.chunks.push(s) } }
  const input = { isTTY: true, isRaw: undefined, handlers: [] as ((b: Buffer) => void)[], setRawMode(m: boolean) { this.isRaw = m }, resume() {}, on(_e: 'data', f: (b: Buffer) => void) { this.handlers.push(f) }, removeListener(_e: 'data', f: (b: Buffer) => void) { this.handlers = this.handlers.filter((h) => h !== f) } }
  const app = new TuiApp(host as unknown as AgentHost, { workspaceRoot: '/tmp', updateCheck: false, io: { input: input as never, output: out as never } as AppIO })
  void app.start()
  await sleep(80)

  console.log('=== FRAME 1: idle with palette open (/) ===')
  app.feed('/')
  await sleep(60)
  app.renderNow()
  console.log(app.lastFrame.map(strip).join('\n'))

  console.log('\n=== FRAME 2: provider picker (via /model) ===')
  app.feed('\x1b')
  await sleep(120) // let the 50ms esc-disambiguation timer flush first
  void (app as unknown as { modelPickerFlow: () => Promise<void> }).modelPickerFlow()
  await sleep(60)
  app.renderNow()
  console.log(app.lastFrame.map(strip).join('\n'))

  console.log('\n=== FRAME 3: provider picker after searching "zz" (no matches + CTA) ===')
  app.feed('zz')
  await sleep(60)
  app.renderNow()
  console.log(app.lastFrame.map(strip).join('\n'))

  app.exit()
  await sleep(50)
  app.destroy()
}
void direct()
