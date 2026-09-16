import path from 'node:path'
import type { ToolDefinition } from '../types'
import { ensureDir, trunc } from '../util'

/**
 * Browser automation tool — powered by Playwright when installed.
 * The e2e loop: the agent navigates, interacts, and reads console/network
 * errors as test signals, then fixes code and re-verifies.
 *
 * Playwright is NOT bundled (heavy download). Users opt in:
 *   bun add playwright && bunx playwright install chromium
 * or connect to a local Chrome via CDP (browser_url = ws://…/devtools/browser).
 */
export const browserTool: ToolDefinition = {
  name: 'browser',
  description:
    'Drive a real browser (Chromium via Playwright) for testing and verification: navigate, click, type, screenshot, read console/network errors. Requires `bun add playwright && bunx playwright install chromium` (Settings → Tools → enable browser).',
  risk: 'high',
  params: {
    action:
      'string (required) — "open" (url) | "click" (selector) | "type" (selector,value) | "screenshot" | "console" | "network" | "evaluate" (code) | "close"',
    url: 'string — for open',
    selector: 'string — CSS selector for click/type',
    value: 'string — text to type',
    code: 'string — JS to evaluate in the page',
  },
  async run(input, ctx) {
    if (!ctx.config.tools.browser) {
      return 'Error: the browser tool is disabled. Enable it in Settings → Tools (requires: bun add playwright && bunx playwright install chromium).'
    }
    let pw: any
    try {
      pw = await import('playwright')
    } catch {
      return 'Error: playwright is not installed. Run: bun add playwright && bunx playwright install chromium'
    }
    const shots = path.join(ctx.workspaceRoot, '.tagent', 'browser')
    const action = String(input.action ?? '')
    // module-level browser/page state
    const st = browserState(pw)
    try {
      switch (action) {
        case 'open': {
          await st.page.goto(String(input.url ?? ''), { waitUntil: 'domcontentloaded', timeout: 30_000 })
          const title = await st.page.title()
          return `Opened ${input.url}\nTitle: ${title}`
        }
        case 'click': {
          await st.page.click(String(input.selector ?? ''), { timeout: 10_000 })
          return `Clicked ${input.selector}`
        }
        case 'type': {
          await st.page.fill(String(input.selector ?? ''), String(input.value ?? ''))
          return `Typed into ${input.selector}`
        }
        case 'screenshot': {
          ensureDir(shots)
          const file = path.join(shots, `shot-${Date.now()}.png`)
          await st.page.screenshot({ path: file })
          return `Screenshot saved: ${path.relative(ctx.workspaceRoot, file)}`
        }
        case 'console': {
          const lines = st.consoleLog.slice(-50).map((l) => `[${l.type}] ${trunc(l.text, 200)}`)
          return lines.length ? lines.join('\n') : '(no console messages)'
        }
        case 'network': {
          const lines = st.networkLog.slice(-40).map((l) => `[${l.status ?? '…'}] ${l.url}`)
          return lines.length ? lines.join('\n') : '(no requests captured)'
        }
        case 'evaluate': {
          const result = await st.page.evaluate(String(input.code ?? 'null'))
          return typeof result === 'string' ? trunc(result, 8_000) : JSON.stringify(result, null, 1).slice(0, 8_000)
        }
        case 'close': {
          await st.close()
          return 'Browser closed.'
        }
        default:
          return `Error: unknown action "${action}"`
      }
    } catch (e) {
      return `Browser error: ${(e as Error).message}`
    }
  },
}

/* ---------------- shared browser state (per daemon process) ---------------- */

type BrowserState = {
  browser: any
  page: any
  consoleLog: { type: string; text: string }[]
  networkLog: { url: string; status?: number }[]
  close(): Promise<void>
}

let _state: BrowserState | null = null

function browserState(pw: any): BrowserState {
  if (_state) return _state
  const consoleLog: BrowserState['consoleLog'] = []
  const networkLog: BrowserState['networkLog'] = []
  const browser = pw.chromium.launch({ headless: true })
  const page = (async () => {
    const b = await browser
    const ctx = b.newContext()
    const p = await ctx.newPage()
    p.on('console', (msg: any) => consoleLog.push({ type: msg.type(), text: msg.text() }))
    p.on('response', (res: any) => networkLog.push({ url: res.url(), status: res.status() }))
    p.on('pageerror', (err: Error) => consoleLog.push({ type: 'pageerror', text: err.message }))
    return p
  })()
  const state: BrowserState = {
    get browser() { return browser },
    get page() { return page },
    consoleLog,
    networkLog,
    async close() {
      try {
        const b = await browser
        await b.close()
      } catch { /* noop */ }
      _state = null
    },
  }
  _state = state
  return state
}
