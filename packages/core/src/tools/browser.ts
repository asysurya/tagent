import fs from 'node:fs'
import path from 'node:path'
import type { ToolDefinition } from '../types'
import { ensureDir, trunc } from '../util'

/**
 * Browser automation tool — powered by Playwright when installed.
 * The test loop: the agent serves the project, drives the UI (open / click /
 * type), reads the resulting page state (aria snapshot + console errors),
 * switches viewports (desktop / tablet / mobile), takes screenshots for visual
 * judgment, and runs a deterministic UI audit (overflow, typography, contrast,
 * tap targets).
 *
 * Playwright is NOT bundled (heavy download). Users opt in:
 *   bun add playwright && bunx playwright install chromium
 * or connect to a local Chrome via CDP (browser_url = ws://…/devtools/browser).
 */

const VIEWPORTS: Record<string, { width: number; height: number }> = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
}

export const browserTool: ToolDefinition = {
  name: 'browser',
  description:
    'Drive a real browser (Chromium via Playwright) to TEST the app: open pages, click buttons, fill inputs, ' +
    'read the resulting page state, screenshot, and audit responsiveness/typography/contrast. ' +
    'Every click/type returns the new page snapshot so you can SEE the result. ' +
    'Requires `bun add playwright && bunx playwright install chromium` (Settings → Tools → enable browser).',
  risk: 'high',
  params: {
    action:
      'string (required) — "open" (url) | "click" (selector) | "type" (selector,value) | "screenshot" | "snapshot" | "viewport" (name|width,height) | "audit" | "console" | "network" | "errors" | "evaluate" (code) | "close"',
    url: 'string — for open (http://host:port/path)',
    selector: 'string — CSS selector for click/type',
    value: 'string — text to type',
    viewport: 'string — "desktop" (1280×800) | "tablet" (768×1024) | "mobile" (390×844) — default desktop',
    fullPage: 'boolean — screenshot the whole scrollable page (default false)',
    code: 'string — JS to evaluate in the page',
  },
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['open', 'click', 'type', 'screenshot', 'snapshot', 'viewport', 'audit', 'console', 'network', 'errors', 'evaluate', 'close'],
        description: 'Browser action',
      },
      url: { type: 'string', description: 'URL (for open)' },
      selector: { type: 'string', description: 'CSS selector (for click/type)' },
      value: { type: 'string', description: 'Text to type (for type)' },
      viewport: { type: 'string', description: 'desktop | tablet | mobile (for viewport)' },
      width: { type: 'number', description: 'custom viewport width (with height)' },
      height: { type: 'number', description: 'custom viewport height (with width)' },
      fullPage: { type: 'boolean', description: 'full-page screenshot (default false)' },
      code: { type: 'string', description: 'JS to evaluate in the page (for evaluate)' },
    },
    required: ['action'],
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
    const shots = path.join(ctx.workspaceRoot, '.tagent', 'test', 'shots')
    const action = String(input.action ?? '')
    const st = await browserState(pw)
    try {
      switch (action) {
        case 'open': {
          let url = String(input.url ?? '')
          if (!url) return 'Error: url is required for open'
          if (!/^[a-z]+:\/\//i.test(url)) url = `http://${url}`
          st.consoleMark = st.consoleLog.length
          st.networkMark = st.networkLog.length
          await st.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
          await settle(st)
          const title = await st.page.title()
          const vp = await st.page.viewportSize()
          const snap = await ariaSnapshot(st, 2_500)
          return [
            `Opened ${url}`,
            `Title: ${title}`,
            `Viewport: ${vp ? `${vp.width}×${vp.height}` : '?'}`,
            snap,
            await errorDigest(st),
          ].filter(Boolean).join('\n')
        }
        case 'click': {
          const selector = String(input.selector ?? '')
          if (!selector) return 'Error: selector is required for click'
          const cMark = st.consoleLog.length
          await st.page.click(selector, { timeout: 10_000 })
          await settle(st)
          const snap = await ariaSnapshot(st, 1_800)
          return [`Clicked ${selector}`, snap, await errorDigest(st, cMark)].filter(Boolean).join('\n')
        }
        case 'type': {
          const selector = String(input.selector ?? '')
          if (!selector) return 'Error: selector is required for type'
          await st.page.fill(selector, String(input.value ?? ''))
          return `Typed into ${selector}`
        }
        case 'screenshot': {
          ensureDir(shots)
          const vp = (await st.page.viewportSize()) ?? { width: 0, height: 0 }
          const label = st.viewportName ?? `${vp.width}x${vp.height}`
          const file = path.join(shots, `shot-${label}-${Date.now()}.png`)
          await st.page.screenshot({ path: file, fullPage: input.fullPage === true })
          const kb = (fs.statSync(file).size / 1024).toFixed(0)
          const rel = path.relative(ctx.workspaceRoot, file)
          return `Screenshot saved: ${rel} (${vp.width}×${vp.height}${input.fullPage === true ? ' full page' : ''}, ${kb}KB)\n[IMAGE:${file}]`
        }
        case 'snapshot': {
          return (await ariaSnapshot(st, 8_000)) || '(empty page)'
        }
        case 'viewport': {
          const name = String(input.viewport ?? '').toLowerCase()
          const customW = Number(input.width ?? 0)
          const customH = Number(input.height ?? 0)
          let size: { width: number; height: number } | undefined
          if (VIEWPORTS[name]) size = VIEWPORTS[name]
          else if (customW > 0 && customH > 0) size = { width: customW, height: customH }
          else return `Error: pass viewport=desktop|tablet|mobile or width+height (got "${input.viewport ?? ''}")`
          await st.page.setViewportSize(size)
          st.viewportName = VIEWPORTS[name] ? name : `${size.width}x${size.height}`
          await settle(st)
          return [
            `Viewport set to ${st.viewportName} (${size.width}×${size.height}) — media queries re-evaluated live.`,
            'Take a screenshot and/or run audit at this size next.',
          ].join('\n')
        }
        case 'audit': {
          const a = await st.page.evaluate(AUDIT_SCRIPT)
          return renderAudit(a)
        }
        case 'console': {
          const lines = st.consoleLog.slice(-50).map((l) => `[${l.type}] ${trunc(l.text, 200)}`)
          return lines.length ? lines.join('\n') : '(no console messages)'
        }
        case 'network': {
          const lines = st.networkLog.slice(-40).map((l) => `[${l.status ?? '…'}] ${l.url}`)
          return lines.length ? lines.join('\n') : '(no requests captured)'
        }
        case 'errors': {
          return (await errorDigest(st)) || '(no console errors, no failed requests)'
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
      const msg = (e as Error).message ?? ''
      if (/Executable doesn't exist|browserType\.launch|Failed to launch/i.test(msg)) {
        return `Browser error: ${msg}\nChromium is not installed for playwright. Run once in this workspace:\n  bun add playwright && bunx playwright install chromium`
      }
      return `Browser error: ${msg}`
    }
  },
}

/* ---------------- shared browser state (per daemon process) ---------------- */

type BrowserState = {
  browser: any
  page: any
  consoleLog: { type: string; text: string }[]
  networkLog: { url: string; status?: number }[]
  /** digest boundary — "since open" */
  consoleMark: number
  networkMark: number
  viewportName?: string
  close(): Promise<void>
}

let _state: Promise<BrowserState> | null = null

/** Lazily launch chromium once per process; every call awaits the same state. */
function browserState(pw: any): Promise<BrowserState> {
  if (_state) return _state
  _state = (async () => {
    const consoleLog: BrowserState['consoleLog'] = []
    const networkLog: BrowserState['networkLog'] = []
    const browser = await pw.chromium.launch({ headless: true })
    const ctx = await browser.newContext({ viewport: VIEWPORTS.desktop })
    const page = await ctx.newPage()
    page.on('console', (msg: any) => consoleLog.push({ type: msg.type(), text: msg.text() }))
    page.on('response', (res: any) => networkLog.push({ url: res.url(), status: res.status() }))
    page.on('pageerror', (err: Error) => consoleLog.push({ type: 'pageerror', text: err.message }))
    return {
      browser,
      page,
      consoleLog,
      networkLog,
      consoleMark: 0,
      networkMark: 0,
      viewportName: 'desktop',
      async close() {
        try {
          await browser.close()
        } catch { /* noop */ }
        _state = null
      },
    }
  })()
  return _state
}

/* ---------------- helpers ---------------- */

/** let SPAs settle after an interaction — fixed delay, HMR websockets make networkidle useless */
function settle(st: BrowserState): Promise<any> {
  return st.page.waitForTimeout(600)
}

/** Textual page tree — the agent's eyes. */
async function ariaSnapshot(st: BrowserState, cap: number): Promise<string> {
  const page = st.page
  try {
    // ariaSnapshot lives on Locator (playwright ≥ 1.49); body covers the page
    const loc = typeof page.locator === 'function' ? page.locator('body') : null
    if (!loc || typeof loc.ariaSnapshot !== 'function') {
      return '(ariaSnapshot needs playwright ≥ 1.49 — run: bun add playwright@latest)'
    }
    const yaml: string = await loc.ariaSnapshot()
    if (!yaml?.trim()) return '(empty page)'
    return trunc(yaml, cap)
  } catch (e) {
    return `(snapshot failed: ${(e as Error).message})`
  }
}

/** errors + failed requests since `from` (default: since last open) */
async function errorDigest(st: BrowserState, from?: number): Promise<string> {
  const cMark = from ?? st.consoleMark
  const errs = st.consoleLog
    .slice(cMark)
    .filter((l) => l.type === 'error' || l.type === 'pageerror')
    .map((l) => `[console.${l.type}] ${trunc(l.text, 250)}`)
  const bad = st.networkLog
    .slice(from !== undefined ? from : st.networkMark)
    .filter((l) => (l.status ?? 0) >= 400)
    .map((l) => `[HTTP ${l.status}] ${trunc(l.url, 200)}`)
  const out = [...errs.slice(0, 15), ...bad.slice(0, 15)]
  return out.length ? `\n⚠ errors since last action:\n${out.join('\n')}` : ''
}

/* ---------------- the deterministic UI audit ---------------- */

/**
 * Runs in the PAGE (serialized by Playwright) — DOM globals are shadowed as
 * `any` because the host (node) build has no DOM lib. No external references.
 * Measures: overflow, typography, small text, heading structure, tap targets,
 * images without alt, meta viewport, contrast sampling.
 */
const AUDIT_SCRIPT = () => {
  const g = globalThis as any
  const document = g.document
  const window = g.window
  const getComputedStyle = g.getComputedStyle
  const doc = document.documentElement
  const vw = window.innerWidth
  const describe = (el: any) =>
    `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${
      typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''
    }`

  // --- horizontal overflow + offenders ---
  const overflowX = doc.scrollWidth > doc.clientWidth + 1
  const offenders: string[] = []
  if (overflowX) {
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.right > doc.clientWidth + 8 && offenders.length < 5) {
        offenders.push(`${describe(el)} (right edge ${Math.round(r.right)} > viewport ${doc.clientWidth})`)
      }
    }
  }

  // --- typography map ---
  const styles = new Map<string, { count: number; size: number }>()
  const smallText: string[] = []
  const sel = 'body, h1, h2, h3, h4, h5, h6, p, button, a, small, input, [role=button]'
  for (const el of document.body.querySelectorAll(sel)) {
    if (!el.textContent && !el.value) continue
    const cs = getComputedStyle(el)
    const key = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim() || '(default)'
    const e = styles.get(key) ?? { count: 0, size: Math.round(parseFloat(cs.fontSize)) }
    e.count++
    styles.set(key, e)
    const size = parseFloat(cs.fontSize)
    if (size > 0 && size < 12 && el.textContent?.trim() && smallText.length < 5) {
      smallText.push(`${describe(el)} — ${size}px "${el.textContent.trim().slice(0, 30)}"`)
    }
  }

  // --- headings ---
  const hs = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h: any) => Number(h.tagName[1]))
  let headingSkip = false
  for (let i = 1; i < hs.length; i++) if (hs[i] - hs[i - 1] > 1) headingSkip = true

  // --- tap targets (mobile viewports) ---
  let tapIssues: string[] = []
  if (vw < 768) {
    const targets = document.querySelectorAll('a, button, [role=button], input, select, textarea, summary')
    for (const el of targets) {
      if (tapIssues.length >= 8) break
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.width < 24 || r.height < 24) {
        tapIssues.push(`${describe(el)} (${Math.round(r.width)}×${Math.round(r.height)}px < 24×24)`)
      }
    }
  }

  // --- images without alt ---
  const noAlt: string[] = []
  for (const img of document.images) {
    if (!img.getAttribute('alt') && img.getClientRects().length && noAlt.length < 5) {
      noAlt.push(`${img.currentSrc?.split('/').pop()?.slice(0, 60) || 'inline image'}`)
    }
  }

  // --- contrast sampling (WCAG) ---
  const lum = (rgb: string) => {
    const m = rgb.match(/\d+(\.\d+)?/g)?.map(Number) ?? [255, 255, 255]
    const f = (v: number) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2])
  }
  const contrastIssues: string[] = []
  const textEls = [...document.querySelectorAll('p, a, button, li, span, label')].filter(
    (el: any) => (el.childNodes.length && [...el.childNodes].some((n: any) => n.nodeType === 3 && n.textContent?.trim())) &&
      el.offsetParent !== null,
  )
  for (const el of textEls.slice(0, 24)) {
    if (contrastIssues.length >= 6) break
    let node: any = el
    let bg = ''
    while (node && node !== doc) {
      bg = getComputedStyle(node).backgroundColor
      if (bg && !/rgba?\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)/.test(bg)) break
      node = node.parentElement
    }
    if (!bg || /rgba?\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)/.test(bg)) bg = 'rgb(255,255,255)'
    const fg = getComputedStyle(el).color
    const l1 = lum(fg)
    const l2 = lum(bg)
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    const size = parseFloat(getComputedStyle(el).fontSize)
    const bold = parseInt(getComputedStyle(el).fontWeight) >= 700
    if (ratio < (size >= 24 || bold ? 3 : 4.5)) {
      contrastIssues.push(`${describe(el)} — ${ratio.toFixed(2)}:1 "${el.textContent?.trim().slice(0, 24)}"`)
    }
  }

  return {
    title: document.title,
    lang: doc.lang || null,
    viewport: { width: vw, height: window.innerHeight, pageHeight: doc.scrollHeight },
    horizontalOverflow: { present: overflowX, offenders },
    typography: {
      families: [...styles.entries()].map(([k, v]) => `${k} ×${v.count} (~${v.size}px)`).slice(0, 8),
      bodySize: Math.round(parseFloat(getComputedStyle(document.body).fontSize)),
      smallText,
    },
    headings: { h1Count: document.querySelectorAll('h1').length, levels: hs, skippedLevels: headingSkip },
    tapTargets: { issues: tapIssues },
    imagesNoAlt: noAlt,
    metaViewport: !!document.querySelector('meta[name="viewport"]'),
    contrastIssues,
    interactiveCount: document.querySelectorAll('a, button, [role=button], input, select, textarea').length,
  }
}

function renderAudit(a: any): string {
  const vp = a?.viewport ?? {}
  const lines: string[] = [
    `UI audit @ ${vp.width}×${vp.height} (page height ${vp.pageHeight}px)`,
    `title: ${a?.title ?? '?'}${a?.lang ? ` · lang=${a.lang}` : ''}`,
  ]
  const f = a?.typography?.families ?? []
  lines.push(`fonts: ${f.length ? f.join(' | ') : '(none detected)'} · body ${a?.typography?.bodySize ?? '?'}px`)
  if (a?.horizontalOverflow?.present) {
    lines.push(`⚠ HORIZONTAL OVERFLOW (scrollWidth > viewport) — offenders:`)
    for (const o of a.horizontalOverflow.offenders) lines.push(`   ${o}`)
  } else {
    lines.push('✓ no horizontal overflow')
  }
  if (a?.typography?.smallText?.length) {
    lines.push(`⚠ tiny text (<12px): ${a.typography.smallText.join(' · ')}`)
  }
  if (a?.headings) {
    lines.push(`headings: h1×${a.headings.h1Count} levels=[${a.headings.levels?.join(',') ?? ''}]${a.headings.skippedLevels ? ' ⚠ SKIPPED heading level' : ''}`)
  }
  if (a?.tapTargets?.issues?.length) {
    lines.push(`⚠ small tap targets: ${a.tapTargets.issues.join(' · ')}`)
  } else if (vp.width < 768) {
    lines.push('✓ tap targets ≥ 24×24')
  }
  if (a?.imagesNoAlt?.length) lines.push(`⚠ images without alt: ${a.imagesNoAlt.join(' · ')}`)
  lines.push(a?.metaViewport ? '✓ meta viewport present' : '⚠ meta viewport MISSING — mobile will not scale correctly')
  if (a?.contrastIssues?.length) {
    lines.push(`⚠ low contrast (<4.5:1): ${a.contrastIssues.join(' · ')}`)
  } else {
    lines.push('✓ contrast sampled OK')
  }
  lines.push(`interactive elements: ${a?.interactiveCount ?? 0}`)
  return lines.join('\n')
}
